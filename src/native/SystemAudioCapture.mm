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
            // Let system handle sample rate
            NSLog(@"Configured audio capture with system default sample rate and mono audio");
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
    if (self.jsCallback) {
        self.jsCallback.Release();
        self.jsCallback = nullptr; // Prevent further calls
    }
    
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
}

- (void)stream:(SCStream *)stream 
    didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer 
    ofType:(SCStreamOutputType)type API_AVAILABLE(macos(13.0)) {
    
    if (type != SCStreamOutputTypeAudio || !self.jsCallback) return;

    // Get audio format details
    CMFormatDescriptionRef formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer);
    const AudioStreamBasicDescription *asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc);
    
    if (!asbd) {
        NSLog(@"Failed to get audio format description");
        return;
    }

    // Log detailed format details
    NSLog(@"Audio format details: %d channels, %.1f Hz, %d bits, %@", 
        (int)asbd->mChannelsPerFrame, 
        asbd->mSampleRate,
        (int)asbd->mBitsPerChannel,
        (asbd->mFormatFlags & kAudioFormatFlagIsFloat) ? @"float" : @"integer");
    
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
            
            // Log input levels
            float maxInput = 0.0f;
            float minInput = 0.0f;
            for (size_t i = 0; i < sampleCount; i++) {
                if (floatBuffer[i] > maxInput) maxInput = floatBuffer[i];
                if (floatBuffer[i] < minInput) minInput = floatBuffer[i];
            }
            NSLog(@"Float input levels - Max: %.6f, Min: %.6f", maxInput, minInput);
            
            // Convert float to 16-bit with fixed scaling and -3dB headroom
            const float maxAllowed = 0.7071f; // -3dB
            const float scale = 32767.0f;
            for (size_t i = 0; i < sampleCount; i++) {
                float sample = floatBuffer[i];
                // Apply -3dB headroom clipping
                if (sample > maxAllowed) sample = maxAllowed;
                if (sample < -maxAllowed) sample = -maxAllowed;
                pcmBuffer[i] = (int16_t)(sample * scale);
            }
            
            // Log output levels
            int16_t maxOutput = 0;
            int16_t minOutput = 0;
            for (size_t i = 0; i < sampleCount; i++) {
                if (pcmBuffer[i] > maxOutput) maxOutput = pcmBuffer[i];
                if (pcmBuffer[i] < minOutput) minOutput = pcmBuffer[i];
            }
            NSLog(@"PCM output levels - Max: %d, Min: %d", maxOutput, minOutput);
            
        } else if (asbd->mBitsPerChannel == 32 && !(asbd->mFormatFlags & kAudioFormatFlagIsFloat)) {
            int32_t *intBuffer = (int32_t *)buffer;
            
            // Log input levels
            int32_t maxInput = 0;
            int32_t minInput = 0;
            for (size_t i = 0; i < sampleCount; i++) {
                if (intBuffer[i] > maxInput) maxInput = intBuffer[i];
                if (intBuffer[i] < minInput) minInput = intBuffer[i];
            }
            NSLog(@"32-bit int input levels - Max: %d, Min: %d", maxInput, minInput);
            
            // Convert 32-bit int to 16-bit with -3dB headroom
            const float maxAllowed = 0.7071f;
            for (size_t i = 0; i < sampleCount; i++) {
                float normalizedSample = (float)(intBuffer[i] >> 16) / 32768.0f;
                if (normalizedSample > maxAllowed) normalizedSample = maxAllowed;
                if (normalizedSample < -maxAllowed) normalizedSample = -maxAllowed;
                pcmBuffer[i] = (int16_t)(normalizedSample * 32767.0f);
            }
            
            // Log output levels
            int16_t maxOutput = 0;
            int16_t minOutput = 0;
            for (size_t i = 0; i < sampleCount; i++) {
                if (pcmBuffer[i] > maxOutput) maxOutput = pcmBuffer[i];
                if (pcmBuffer[i] < minOutput) minOutput = pcmBuffer[i];
            }
            NSLog(@"PCM output levels - Max: %d, Min: %d", maxOutput, minOutput);
            
        } else if (asbd->mBitsPerChannel == 16) {
            // Direct copy for 16-bit audio
            memcpy(pcmBuffer, buffer, length);
            
            // Log levels for 16-bit input
            int16_t *inputBuffer = (int16_t *)buffer;
            int16_t maxLevel = 0;
            int16_t minLevel = 0;
            for (size_t i = 0; i < sampleCount; i++) {
                if (inputBuffer[i] > maxLevel) maxLevel = inputBuffer[i];
                if (inputBuffer[i] < minLevel) minLevel = inputBuffer[i];
            }
            NSLog(@"16-bit PCM levels - Max: %d, Min: %d", maxLevel, minLevel);
        }
    }
    
    free(buffer);
    
    NSLog(@"Processing audio chunk: %zu samples at %.1f Hz", sampleCount, asbd->mSampleRate);

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