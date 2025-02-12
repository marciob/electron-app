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

- (void)stopCaptureWithCompletion:(void (^)(void))completion {
    NSLog(@"Stopping audio capture...");
    
    // Ensure we're on the main queue for thread safety
    dispatch_async(dispatch_get_main_queue(), ^{
        // Immediately invalidate any pending data
        if (self.jsCallback) {
            self.jsCallback.Abort();
            self.jsCallback.Release();
            self.jsCallback = nullptr;
        }
        
        if (self.stream) {
            // Remove stream output before stopping
            if (@available(macOS 13.0, *)) {
                NSError *removeError = nil;
                [self.stream removeStreamOutput:self type:SCStreamOutputTypeAudio error:&removeError];
                if (removeError) {
                    NSLog(@"Error removing stream output: %@", removeError);
                }
            }
            
            // Stop the capture stream
            [self.stream stopCaptureWithCompletionHandler:^(NSError *error) {
                if (error) {
                    NSLog(@"Error stopping capture: %@", error);
                } else {
                    NSLog(@"Audio capture stopped successfully");
                }
                
                // Cleanup stream
                self.stream = nil;
                
                // Call completion handler on main queue
                dispatch_async(dispatch_get_main_queue(), ^{
                    if (completion) {
                        completion();
                    }
                });
            }];
        } else {
            // If no stream exists, just call completion
            if (completion) {
                completion();
            }
        }
    });
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

    // Calculate sample count correctly based on bytes per frame
    size_t bytesPerFrame = asbd->mBytesPerFrame;
    size_t sampleCount = CMBlockBufferGetDataLength(CMSampleBufferGetDataBuffer(sampleBuffer)) / bytesPerFrame;

    // Add validation
    if (CMBlockBufferGetDataLength(CMSampleBufferGetDataBuffer(sampleBuffer)) % bytesPerFrame != 0) {
        NSLog(@"⚠️ Invalid audio chunk: %zu bytes with %zu bytes/frame", CMBlockBufferGetDataLength(CMSampleBufferGetDataBuffer(sampleBuffer)), bytesPerFrame);
        return;
    }

    // Validate audio format
    if (asbd->mSampleRate != 48000.0) {
        NSLog(@"⚠️ Unexpected sample rate: %.1f Hz (expected 48000 Hz)", asbd->mSampleRate);
    }
    if (asbd->mChannelsPerFrame != 1) {
        NSLog(@"⚠️ Unexpected channel count: %d (expected 1)", (int)asbd->mChannelsPerFrame);
    }
    if (asbd->mBitsPerChannel != 16 && asbd->mBitsPerChannel != 32) {
        NSLog(@"⚠️ Unexpected bits per channel: %d (expected 16 or 32)", (int)asbd->mBitsPerChannel);
    }
    if (!(asbd->mFormatFlags & kAudioFormatFlagIsFloat) && asbd->mBitsPerChannel == 32) {
        NSLog(@"⚠️ Unexpected format: 32-bit non-float data");
    }

    // Log detailed format details with validation markers
    NSLog(@"Audio format details:%@%@%@", 
        asbd->mSampleRate != 48000.0 ? @" ⚠️" : @"",
        asbd->mChannelsPerFrame != 1 ? @" ⚠️" : @"",
        asbd->mBitsPerChannel != 16 && asbd->mBitsPerChannel != 32 ? @" ⚠️" : @"");
    NSLog(@"- Sample rate: %.1f Hz", asbd->mSampleRate);
    NSLog(@"- Channels: %d", (int)asbd->mChannelsPerFrame);
    NSLog(@"- Bits per channel: %d", (int)asbd->mBitsPerChannel);
    NSLog(@"- Format: %@", (asbd->mFormatFlags & kAudioFormatFlagIsFloat) ? @"float" : @"integer");
    NSLog(@"- Bytes per frame: %d", (int)asbd->mBytesPerFrame);
    NSLog(@"- Frames per packet: %d", (int)asbd->mFramesPerPacket);

    CMBlockBufferRef blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer);
    size_t length = CMBlockBufferGetDataLength(blockBuffer);
    
    void *buffer = malloc(length);
    if (!buffer) {
        NSLog(@"⚠️ Failed to allocate buffer for audio data");
        return;
    }
    
    CMBlockBufferCopyDataBytes(blockBuffer, 0, length, buffer);
    
    // Allocate buffer for converted samples
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
            int16_t maxLevel = 0;
            int16_t minLevel = 0;
            for (size_t i = 0; i < sampleCount; i++) {
                if (pcmBuffer[i] > maxLevel) maxLevel = pcmBuffer[i];
                if (pcmBuffer[i] < minLevel) minLevel = pcmBuffer[i];
            }
            NSLog(@"16-bit PCM levels - Max: %d, Min: %d", maxLevel, minLevel);
        }
    }
    
    free(buffer);

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
        
        // Create a promise to handle the async operation
        auto deferred = Napi::Promise::Deferred::New(env);
        
        try {
            if (!capturer) {
                deferred.Resolve(env.Undefined());
                return deferred.Promise();
            }

            // Store the deferred object in a shared pointer to keep it alive
            auto deferredPtr = std::make_shared<Napi::Promise::Deferred>(std::move(deferred));
            
            [capturer stopCaptureWithCompletion:^{
                // Resolve the promise on the JS thread
                deferredPtr->Resolve(deferredPtr->Env().Undefined());
            }];
            
            return deferredPtr->Promise();
        } catch (const std::exception& e) {
            deferred.Reject(Napi::Error::New(env, e.what()).Value());
            return deferred.Promise();
        }
    }
};

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    return SystemAudioCapture::Init(env, exports);
}

NODE_API_MODULE(systemAudio, Init) 