#import <napi.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreMedia/CoreMedia.h>
#import <AudioToolbox/AudioToolbox.h>
#import <AVFoundation/AVFoundation.h>

@interface AudioMixer : NSObject {
@public
    AudioStreamBasicDescription _format;
    AudioUnit _mixerUnit;
}
- (instancetype)initWithFormat:(AudioStreamBasicDescription)format;
- (void)processSystemAudio:(const float*)systemBuffer mic:(const float*)micBuffer frames:(UInt32)frames output:(float*)outputBuffer;
- (void)cleanup;
@end

@implementation AudioMixer

- (instancetype)initWithFormat:(AudioStreamBasicDescription)format {
    if (self = [super init]) {
        _format = format;
        [self setupMixer];
    }
    return self;
}

- (void)setupMixer {
    AudioComponentDescription desc = {
        .componentType = kAudioUnitType_Mixer,
        .componentSubType = kAudioUnitSubType_MultiChannelMixer,
        .componentManufacturer = kAudioUnitManufacturer_Apple,
        .componentFlags = 0,
        .componentFlagsMask = 0
    };
    
    AudioComponent component = AudioComponentFindNext(NULL, &desc);
    AudioComponentInstanceNew(component, &_mixerUnit);
    
    AudioUnitInitialize(_mixerUnit);
    
    // Set mixer properties
    UInt32 busCount = 2;  // System audio and mic
    AudioUnitSetProperty(_mixerUnit,
                        kAudioUnitProperty_ElementCount,
                        kAudioUnitScope_Input,
                        0,
                        &busCount,
                        sizeof(busCount));
    
    // Set volumes for both inputs
    AudioUnitSetParameter(_mixerUnit,
                         kMultiChannelMixerParam_Volume,
                         kAudioUnitScope_Input,
                         0,  // System audio bus
                         0.7,  // 70% volume for system audio
                         0);
    
    AudioUnitSetParameter(_mixerUnit,
                         kMultiChannelMixerParam_Volume,
                         kAudioUnitScope_Input,
                         1,  // Mic bus
                         1.0,  // 100% volume for mic
                         0);
}

- (void)processSystemAudio:(const float*)systemBuffer mic:(const float*)micBuffer frames:(UInt32)frames output:(float*)outputBuffer {
    // Mix system audio and mic input with proper gain control
    for (UInt32 i = 0; i < frames; i++) {
        float systemSample = systemBuffer ? systemBuffer[i] : 0.0f;
        float micSample = micBuffer ? micBuffer[i] : 0.0f;
        
        // Apply soft clipping to prevent distortion
        float mixed = systemSample + micSample;
        if (mixed > 1.0f) {
            mixed = 1.0f - expf(-mixed);
        } else if (mixed < -1.0f) {
            mixed = -1.0f + expf(mixed);
        }
        
        outputBuffer[i] = mixed;
    }
}

- (void)cleanup {
    if (_mixerUnit) {
        AudioUnitUninitialize(_mixerUnit);
        AudioComponentInstanceDispose(_mixerUnit);
        _mixerUnit = NULL;
    }
}

@end

@interface AudioCapturer : NSObject <SCStreamDelegate, SCStreamOutput, AVCaptureAudioDataOutputSampleBufferDelegate>
@property (strong, nonatomic) SCStream *systemStream;
@property (strong, nonatomic) AVCaptureSession *micSession;
@property (strong, nonatomic) AudioMixer *audioMixer;
@property (nonatomic) Napi::ThreadSafeFunction jsCallback;
@property (strong, nonatomic) dispatch_queue_t audioQueue;
@property (strong, nonatomic) NSMutableData *systemAudioBuffer;
@property (strong, nonatomic) NSMutableData *micAudioBuffer;
@property (atomic) BOOL isCapturing;
@property (nonatomic) BOOL shouldCaptureMic;
@property (nonatomic) BOOL shouldCaptureSystem;
@end

@implementation AudioCapturer

- (instancetype)init {
    if (self = [super init]) {
        _audioQueue = dispatch_queue_create("com.audio.processing", DISPATCH_QUEUE_SERIAL);
        _systemAudioBuffer = [NSMutableData new];
        _micAudioBuffer = [NSMutableData new];
        _isCapturing = NO;
    }
    return self;
}

- (void)startCaptureWithOptions:(NSDictionary*)options {
    _shouldCaptureMic = [options[@"mic"] boolValue];
    _shouldCaptureSystem = [options[@"system"] boolValue];
    
    if (!_shouldCaptureMic && !_shouldCaptureSystem) {
        NSLog(@"❌ No capture sources specified");
        return;
    }
    
    _isCapturing = YES;
    
    // Initialize audio mixer with desired format
    AudioStreamBasicDescription format = {
        .mSampleRate = 48000.0,
        .mFormatID = kAudioFormatLinearPCM,
        .mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
        .mBytesPerPacket = 4,
        .mFramesPerPacket = 1,
        .mBytesPerFrame = 4,
        .mChannelsPerFrame = 1,
        .mBitsPerChannel = 32
    };
    
    _audioMixer = [[AudioMixer alloc] initWithFormat:format];
    
    if (_shouldCaptureSystem) {
        [self initializeSystemCapture];
    }
    
    if (_shouldCaptureMic) {
        [self initializeMicCapture];
    }
}

- (void)initializeSystemCapture {
    [SCShareableContent getShareableContentWithCompletionHandler:^(
        SCShareableContent *content, NSError *error
    ) {
        if (error) {
            NSLog(@"❌ Error getting shareable content: %@", error);
            return;
        }
        
        if (content.displays.count == 0) {
            NSLog(@"❌ No displays found");
            return;
        }

        SCContentFilter *filter = [[SCContentFilter alloc] 
            initWithDisplay:content.displays[0] 
            excludingWindows:@[]];
        
        SCStreamConfiguration *config = [[SCStreamConfiguration alloc] init];
        if (@available(macOS 13.0, *)) {
            config.capturesAudio = YES;
            config.excludesCurrentProcessAudio = YES;
            config.channelCount = 1;
            NSLog(@"📊 System stream configuration: channels=%d", (int)config.channelCount);
        }

        self.systemStream = [[SCStream alloc] 
            initWithFilter:filter 
            configuration:config 
            delegate:self];

        if (@available(macOS 13.0, *)) {
            NSError *streamError = nil;
            [self.systemStream addStreamOutput:self 
                type:SCStreamOutputTypeAudio 
                sampleHandlerQueue:self.audioQueue
                error:&streamError];
                
            if (streamError) {
                NSLog(@"❌ Error adding system stream output: %@", streamError);
                return;
            }
            NSLog(@"✅ System stream output added successfully");
        }
        
        [self.systemStream startCaptureWithCompletionHandler:^(NSError *error) {
            if (error) {
                NSLog(@"❌ System capture error: %@", error);
                return;
            }
            NSLog(@"✅ System audio capture started successfully");
        }];
    }];
}

- (void)initializeMicCapture {
    self.micSession = [[AVCaptureSession alloc] init];
    
    // Configure mic input
    AVCaptureDevice *microphone = [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeAudio];
    NSError *error = nil;
    AVCaptureDeviceInput *micInput = [AVCaptureDeviceInput deviceInputWithDevice:microphone error:&error];
    
    if (error) {
        NSLog(@"❌ Error creating mic input: %@", error);
        return;
    }
    
    if ([self.micSession canAddInput:micInput]) {
        [self.micSession addInput:micInput];
    }
    
    // Configure audio output
    AVCaptureAudioDataOutput *micOutput = [[AVCaptureAudioDataOutput alloc] init];
    [micOutput setSampleBufferDelegate:self queue:self.audioQueue];
    
    if ([self.micSession canAddOutput:micOutput]) {
        [self.micSession addOutput:micOutput];
    }
    
    // Start the session
    [self.micSession startRunning];
    NSLog(@"✅ Microphone capture started successfully");
}

- (void)captureOutput:(AVCaptureOutput *)output 
didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer 
       fromConnection:(AVCaptureConnection *)connection {
    if (!self.isCapturing) return;
    
    // Process microphone audio
    CMBlockBufferRef blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer);
    size_t length = CMBlockBufferGetDataLength(blockBuffer);
    float *micBuffer = (float*)malloc(length);
    
    CMBlockBufferCopyDataBytes(blockBuffer, 0, length, micBuffer);
    
    @synchronized (self.micAudioBuffer) {
        [self.micAudioBuffer appendBytes:micBuffer length:length];
    }
    
    free(micBuffer);
    
    [self processCombinedAudioIfReady];
}

- (void)stream:(SCStream *)stream 
didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer 
         ofType:(SCStreamOutputType)type {
    if (!self.isCapturing) return;
    
    if (@available(macOS 13.0, *)) {
        if (type != SCStreamOutputTypeAudio) return;
    } else {
        return; // Skip audio processing on older macOS versions
    }
    
    // Process system audio
    CMBlockBufferRef blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer);
    size_t length = CMBlockBufferGetDataLength(blockBuffer);
    float *systemBuffer = (float*)malloc(length);
    
    CMBlockBufferCopyDataBytes(blockBuffer, 0, length, systemBuffer);
    
    @synchronized (self.systemAudioBuffer) {
        [self.systemAudioBuffer appendBytes:systemBuffer length:length];
    }
    
    free(systemBuffer);
    
    [self processCombinedAudioIfReady];
}

- (void)processCombinedAudioIfReady {
    static const size_t BUFFER_SIZE = 960 * sizeof(float); // 20ms at 48kHz
    
    @synchronized (self.systemAudioBuffer) {
        @synchronized (self.micAudioBuffer) {
            if (self.systemAudioBuffer.length >= BUFFER_SIZE && 
                (!self.shouldCaptureMic || self.micAudioBuffer.length >= BUFFER_SIZE)) {
                
                float *outputBuffer = (float*)malloc(BUFFER_SIZE);
                float *systemData = (float*)self.systemAudioBuffer.bytes;
                float *micData = self.shouldCaptureMic ? (float*)self.micAudioBuffer.bytes : NULL;
                
                [self.audioMixer processSystemAudio:systemData 
                                              mic:micData 
                                          frames:960 
                                         output:outputBuffer];
                
                // Convert to 16-bit PCM
                int16_t *pcmBuffer = (int16_t*)malloc(960 * sizeof(int16_t));
                for (size_t i = 0; i < 960; i++) {
                    float sample = outputBuffer[i];
                    sample = fmax(-1.0f, fmin(1.0f, sample));
                    pcmBuffer[i] = (int16_t)(sample * 32767.0f);
                }
                
                // Send to JavaScript
                self.jsCallback.BlockingCall([pcmBuffer](Napi::Env env, Napi::Function jsCallback) {
                    auto audioBuffer = Napi::Buffer<int16_t>::Copy(env, pcmBuffer, 960);
                    auto formatObj = Napi::Object::New(env);
                    formatObj.Set("sampleRate", Napi::Number::New(env, 48000));
                    formatObj.Set("channels", Napi::Number::New(env, 1));
                    formatObj.Set("bitsPerChannel", Napi::Number::New(env, 16));
                    jsCallback.Call({audioBuffer, formatObj});
                    free(pcmBuffer);
                });
                
                free(outputBuffer);
                
                // Remove processed data
                [self.systemAudioBuffer replaceBytesInRange:NSMakeRange(0, BUFFER_SIZE) 
                                                withBytes:NULL 
                                                   length:0];
                                                   
                if (self.shouldCaptureMic) {
                    [self.micAudioBuffer replaceBytesInRange:NSMakeRange(0, BUFFER_SIZE) 
                                                 withBytes:NULL 
                                                    length:0];
                }
            }
        }
    }
}

- (void)stopCapture {
    self.isCapturing = NO;
    
    // Stop system audio capture
    if (self.systemStream) {
        [self.systemStream stopCaptureWithCompletionHandler:^(NSError *error) {
            if (error) {
                NSLog(@"❌ Error stopping system capture: %@", error);
            }
            self.systemStream = nil;
        }];
    }
    
    // Stop microphone capture
    if (self.micSession) {
        [self.micSession stopRunning];
        self.micSession = nil;
    }
    
    // Clear buffers
    @synchronized (self.systemAudioBuffer) {
        [self.systemAudioBuffer setLength:0];
    }
    @synchronized (self.micAudioBuffer) {
        [self.micAudioBuffer setLength:0];
    }
    
    // Clean up mixer
    if (self.audioMixer) {
        [self.audioMixer cleanup];
        self.audioMixer = nil;
    }
    
    // Release JS callback
    if (self.jsCallback) {
        self.jsCallback.Release();
    }
}

@end

class SystemAudioCapture : public Napi::ObjectWrap<SystemAudioCapture> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports) {
        Napi::Function func = DefineClass(env, "SystemAudioCapture", {
            InstanceMethod("startCapture", &SystemAudioCapture::StartCapture),
            InstanceMethod("stopCapture", &SystemAudioCapture::StopCapture)
        });

        Napi::FunctionReference* constructor = new Napi::FunctionReference();
        *constructor = Napi::Persistent(func);
        env.SetInstanceData(constructor);

        exports.Set("SystemAudioCapture", func);
        return exports;
    }

    SystemAudioCapture(const Napi::CallbackInfo& info) 
        : Napi::ObjectWrap<SystemAudioCapture>(info) {
        capturer = [[AudioCapturer alloc] init];
    }

private:
    AudioCapturer* capturer;

    Napi::Value StartCapture(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        
        if (info.Length() < 2 || !info[0].IsFunction() || !info[1].IsObject()) {
            Napi::TypeError::New(env, "Expected function and options object as arguments")
                .ThrowAsJavaScriptException();
            return env.Undefined();
        }

        Napi::Function callback = info[0].As<Napi::Function>();
        Napi::Object options = info[1].As<Napi::Object>();
        
        capturer.jsCallback = Napi::ThreadSafeFunction::New(
            env, callback, "Audio Callback", 0, 1
        );
        
        bool systemEnabled = options.Get("system").ToBoolean();
        bool micEnabled = options.Get("mic").ToBoolean();
        
        NSDictionary* captureOptions = @{
            @"system": @(systemEnabled),
            @"mic": @(micEnabled)
        };
        
        [capturer startCaptureWithOptions:captureOptions];
        return env.Undefined();
    }

    Napi::Value StopCapture(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        [capturer stopCapture];
        return env.Undefined();
    }
};

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    return SystemAudioCapture::Init(env, exports);
}

NODE_API_MODULE(systemAudio, Init) 