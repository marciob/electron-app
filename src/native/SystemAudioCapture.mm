#import <napi.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreMedia/CoreMedia.h>
#import <AudioToolbox/AudioToolbox.h>

@interface AudioCapturer : NSObject <SCStreamDelegate, SCStreamOutput>
@property (strong) SCStream *stream;
@property (nonatomic) Napi::ThreadSafeFunction jsCallback;
@end

@implementation AudioCapturer

- (void)startCapture {
    NSLog(@"Starting audio capture...");
    [SCShareableContent getShareableContentWithCompletionHandler:^(
        SCShareableContent *content, NSError *error
    ) {
        if (error) {
            NSLog(@"Error getting shareable content: %@", error);
            return;
        }
        
        if (content.displays.count == 0) {
            NSLog(@"No displays found");
            return;
        }

        SCContentFilter *filter = [[SCContentFilter alloc] 
            initWithDisplay:content.displays[0] 
            excludingWindows:@[]];
        
        SCStreamConfiguration *config = [[SCStreamConfiguration alloc] init];
        if (@available(macOS 13.0, *)) {
            config.capturesAudio = YES;
            config.excludesCurrentProcessAudio = YES;
            config.channelCount = 1;    // Mono audio
            NSLog(@"Configured audio capture with mono audio");
        }

        self.stream = [[SCStream alloc] 
            initWithFilter:filter 
            configuration:config 
            delegate:self];

        if (@available(macOS 13.0, *)) {
            NSError *streamError = nil;
            [self.stream addStreamOutput:self 
                type:SCStreamOutputTypeAudio 
                sampleHandlerQueue:dispatch_get_main_queue()
                error:&streamError];
                
            if (streamError) {
                NSLog(@"Error adding stream output: %@", streamError);
                return;
            }
            NSLog(@"Stream output added successfully");
        }
        
        [self.stream startCaptureWithCompletionHandler:^(NSError *error) {
            if (error) {
                NSLog(@"Capture error: %@", error);
                return;
            }
            NSLog(@"Audio capture started successfully");
        }];
    }];
}

- (void)stopCapture {
    NSLog(@"Stopping audio capture...");
    if (self.stream) {
        [self.stream stopCaptureWithCompletionHandler:^(NSError *error) {
            if (error) {
                NSLog(@"Error stopping capture: %@", error);
                return;
            }
            NSLog(@"Audio capture stopped successfully");
            self.stream = nil;
        }];
    }
    
    if (self.jsCallback) {
        self.jsCallback.Release();
    }
}

- (void)stream:(SCStream *)stream 
    didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer 
    ofType:(SCStreamOutputType)type API_AVAILABLE(macos(13.0)) {
    
    if (type != SCStreamOutputTypeAudio) return;

    // Get audio format details
    CMFormatDescriptionRef formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer);
    const AudioStreamBasicDescription *asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc);
    
    if (!asbd) {
        NSLog(@"Failed to get audio format description");
        return;
    }

    // Log format details
    NSLog(@"Received audio format: %d channels, %.1f Hz, %d bits", 
        (int)asbd->mChannelsPerFrame, 
        asbd->mSampleRate,
        (int)asbd->mBitsPerChannel);
    
    CMBlockBufferRef blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer);
    size_t length = CMBlockBufferGetDataLength(blockBuffer);
    void *buffer = malloc(length);
    
    CMBlockBufferCopyDataBytes(blockBuffer, 0, length, buffer);
    
    // Convert to 16-bit PCM for consistent handling in JS
    size_t sampleCount = length / (asbd->mBitsPerChannel / 8);
    int16_t *pcmBuffer = (int16_t *)malloc(sampleCount * sizeof(int16_t));
    
    if (asbd->mFormatID == kAudioFormatLinearPCM) {
        if (asbd->mBitsPerChannel == 32 && (asbd->mFormatFlags & kAudioFormatFlagIsFloat)) {
            float *floatBuffer = (float *)buffer;
            for (size_t i = 0; i < sampleCount; i++) {
                float sample = floatBuffer[i];
                sample = fmax(-1.0f, fmin(1.0f, sample)); // Clamp to [-1, 1]
                pcmBuffer[i] = (int16_t)(sample * 32767.0f);
            }
        } else if (asbd->mBitsPerChannel == 32 && !(asbd->mFormatFlags & kAudioFormatFlagIsFloat)) {
            int32_t *intBuffer = (int32_t *)buffer;
            for (size_t i = 0; i < sampleCount; i++) {
                pcmBuffer[i] = (int16_t)(intBuffer[i] >> 16);
            }
        } else if (asbd->mBitsPerChannel == 16) {
            memcpy(pcmBuffer, buffer, length);
        }
    }
    
    free(buffer);
    
    NSLog(@"Sending audio chunk of size: %zu bytes", sampleCount * sizeof(int16_t));

    self.jsCallback.BlockingCall([pcmBuffer, sampleCount, asbd](Napi::Env env, Napi::Function jsCallback) {
        auto audioBuffer = Napi::Buffer<int16_t>::Copy(env, pcmBuffer, sampleCount);
        auto formatObj = Napi::Object::New(env);
        formatObj.Set("sampleRate", Napi::Number::New(env, asbd->mSampleRate));
        formatObj.Set("channels", Napi::Number::New(env, asbd->mChannelsPerFrame));
        formatObj.Set("bitsPerChannel", Napi::Number::New(env, 16)); // We're always converting to 16-bit
        jsCallback.Call({audioBuffer, formatObj});
        free(pcmBuffer);
    });
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
        
        if (info.Length() < 1 || !info[0].IsFunction()) {
            Napi::TypeError::New(env, "Function expected as first argument")
                .ThrowAsJavaScriptException();
            return env.Undefined();
        }

        Napi::Function callback = info[0].As<Napi::Function>();
        capturer.jsCallback = Napi::ThreadSafeFunction::New(
            env, callback, "Audio Callback", 0, 1
        );
        
        [capturer startCapture];
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