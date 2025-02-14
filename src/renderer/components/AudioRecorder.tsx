import React, { useState, useEffect, useRef, useCallback } from "react";
import { FaMicrophone } from "react-icons/fa";
import { IoMdVolumeHigh } from "react-icons/io";

interface AudioRecorderProps {
  onRecordingComplete?: (blob: Blob) => void;
}

interface Recording {
  id: number;
  blob: Blob;
  url: string;
  timestamp: Date;
  sampleRate: number;
  channels: number;
}

const analyzeAudioBuffer = (buffer: Float32Array, chunkIndex: number) => {
  // Calculate basic audio metrics
  let peak = 0;
  let rms = 0;

  for (let i = 0; i < buffer.length; i++) {
    const abs = Math.abs(buffer[i]);
    peak = Math.max(peak, abs);
    rms += buffer[i] * buffer[i];
  }
  rms = Math.sqrt(rms / buffer.length);

  console.log(
    `📊 Chunk #${chunkIndex} analysis:`,
    `\n- Peak: ${peak.toFixed(4)}`,
    `\n- RMS: ${rms.toFixed(4)}`,
    `\n- Length: ${buffer.length} samples`
  );
};

const AudioRecorder: React.FC<AudioRecorderProps> = ({
  onRecordingComplete,
}) => {
  const [isRecording, setIsRecording] = useState(false);
  const [isRecordingMic, setIsRecordingMic] = useState(false);
  const [isRecordingSystem, setIsRecordingSystem] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [timer, setTimer] = useState(0);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [audioFormat, setAudioFormat] = useState<{
    sampleRate: number;
    channels: number;
  }>({ sampleRate: 44100, channels: 1 });
  const audioChunksRef = useRef<Float32Array[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const recordingStartTimeRef = useRef<number>(0);
  const recordingSessionId = useRef(0);
  const nonSilentDetectedRef = useRef(false);
  const processingQueueRef = useRef<Float32Array[]>([]);
  const processingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const processAudioChunk = useCallback((chunk: Float32Array) => {
    // Calculate RMS for debugging purposes
    let rms = 0;
    for (let i = 0; i < chunk.length; i++) {
      rms += chunk[i] * chunk[i];
    }
    rms = Math.sqrt(rms / chunk.length);

    // Set recording start time if this is the first chunk
    if (!recordingStartTimeRef.current) {
      recordingStartTimeRef.current = performance.now();
      console.log(`🎵 Recording started with first chunk, RMS: ${rms}`);
    }

    // Add chunk directly to audioChunksRef
    audioChunksRef.current.push(chunk);

    // Log chunk analysis
    analyzeAudioBuffer(chunk, audioChunksRef.current.length - 1);

    // Calculate total samples for logging
    const totalSamples = audioChunksRef.current.reduce(
      (acc, chunk) => acc + chunk.length,
      0
    );

    // Log processing status
    console.log(
      `Chunk processed - ` +
        `Size: ${chunk.length} samples, ` +
        `Total chunks: ${audioChunksRef.current.length}, ` +
        `Total samples: ${totalSamples}, ` +
        `Wall time: ${(
          (performance.now() - recordingStartTimeRef.current) /
          1000
        ).toFixed(3)}s, ` +
        `Theoretical: ${(totalSamples / 48000).toFixed(3)}s`
    );
  }, []);

  const handleAudioData = useCallback(
    (data: { buffer: Buffer; format: any; sessionId: number }) => {
      if (!isRecording || data.sessionId !== recordingSessionId.current) {
        return;
      }

      const timestamp = new Date().toISOString();
      const timeSinceStart = recordingStartTimeRef.current
        ? performance.now() - recordingStartTimeRef.current
        : "N/A";

      // Calculate chunk index including silent chunks
      const currentChunkIndex = audioChunksRef.current.length;

      console.log(
        `🔍 [Chunk ${currentChunkIndex}] Audio chunk received at ${timestamp}:`,
        `\n- Recording state: ${isRecording} (${
          isRecording ? "ACTIVE" : "INACTIVE"
        })`,
        `\n- Session match: ${data.sessionId} vs ${
          recordingSessionId.current
        } (${
          data.sessionId === recordingSessionId.current ? "MATCH" : "MISMATCH"
        })`,
        `\n- Buffer size: ${data.buffer.length} bytes`,
        `\n- Format:`,
        data.format,
        `\n- Time since start: ${
          typeof timeSinceStart === "number"
            ? `${timeSinceStart}ms`
            : timeSinceStart
        }`,
        `\n- nonSilentDetected: ${nonSilentDetectedRef.current}`
      );

      // Convert buffer to float32
      const int16Array = new Int16Array(
        data.buffer.buffer,
        data.buffer.byteOffset,
        data.buffer.length / 2
      );
      const float32Array = new Float32Array(int16Array.length);
      const scale = 1.0 / 32768.0;

      for (let i = 0; i < int16Array.length; i++) {
        float32Array[i] = int16Array[i] * scale;
      }

      processAudioChunk(float32Array);

      // Log statistics for debugging
      const totalSamples = audioChunksRef.current.reduce(
        (acc, chunk) => acc + chunk.length,
        0
      );
      const wallClockTime = nonSilentDetectedRef.current
        ? (performance.now() - recordingStartTimeRef.current) / 1000
        : 0;
      const theoreticalDuration = totalSamples / data.format.sampleRate;

      console.log(
        `Chunk processed - ` +
          `Size: ${float32Array.length} samples, ` +
          `Total chunks: ${audioChunksRef.current.length}, ` +
          `Total samples: ${totalSamples}, ` +
          `Wall time: ${wallClockTime.toFixed(3)}s, ` +
          `Theoretical: ${theoreticalDuration.toFixed(3)}s`
      );
    },
    [isRecording, processAudioChunk]
  );

  useEffect(() => {
    let cleanup = false;
    let eventHandler: ((data: any) => void) | null = null;

    const setupRecording = async () => {
      if (!isRecording || cleanup) return;

      try {
        console.log("📊 Recording setup - Pre-recording state check:");
        console.log(
          `- Audio chunks in memory: ${audioChunksRef.current.length}`
        );
        console.log(`- Previous session ID: ${recordingSessionId.current}`);
        console.log(`- Recording state: ${isRecording}`);
        console.log(`- Processing state: ${isProcessing}`);

        // Reset state
        nonSilentDetectedRef.current = false;
        audioChunksRef.current = [];
        processingQueueRef.current = [];
        recordingStartTimeRef.current = 0;
        recordingSessionId.current += 1;
        const currentSessionId = recordingSessionId.current;

        // Create new audio context
        if (audioContextRef.current) {
          try {
            const state = audioContextRef.current.state;
            if (state !== "closed") {
              await audioContextRef.current.close();
            }
          } catch (error) {
            console.warn("Warning: Error while closing audio context:", error);
          }
        }
        audioContextRef.current = new AudioContext({
          sampleRate: 48000,
        });

        // Remove any existing event listener
        if (eventHandler) {
          window.electron.ipcRenderer.removeListener(
            "audio-data",
            eventHandler
          );
        }

        // Create new event handler
        eventHandler = (data: any) => {
          if (!cleanup && isRecording && data.sessionId === currentSessionId) {
            handleAudioData(data);
          }
        };

        // Add new event listener
        window.electron.ipcRenderer.on("audio-data", eventHandler);

        // Start the capture with both system and mic
        console.log("🎬 Starting audio capture (system + mic)...");
        await window.electron.ipcRenderer.invoke("start-audio-capture", {
          sessionId: currentSessionId,
          system: true,
          mic: true,
        });

        if (!cleanup) {
          setAudioFormat({ sampleRate: 48000, channels: 1 });

          console.log("✅ Recording started successfully:", {
            timestamp: new Date().toISOString(),
            sessionId: currentSessionId,
            sampleRate: 48000,
          });
        }
      } catch (error) {
        console.error("❌ Failed to start recording:", error);
        if (!cleanup) {
          setIsRecording(false);
          setIsRecordingSystem(false);
        }
      }
    };

    setupRecording();

    return () => {
      cleanup = true;
      if (processingTimeoutRef.current) {
        clearTimeout(processingTimeoutRef.current);
      }
      if (eventHandler) {
        window.electron.ipcRenderer.removeListener("audio-data", eventHandler);
      }
      const stopCapture = async () => {
        // Only stop if we're not already in the process of stopping
        if (isRecording && !isProcessing) {
          console.log("🛑 Stopping capture in cleanup...");
          try {
            await window.electron.ipcRenderer.invoke("stop-audio-capture");
          } catch (error) {
            console.error("Error during cleanup:", error);
          }
        }
        if (audioContextRef.current) {
          try {
            await audioContextRef.current.close();
            audioContextRef.current = null;
          } catch (error) {
            console.error("Error closing audio context:", error);
          }
        }
      };
      stopCapture();
    };
  }, [isRecording, isProcessing, handleAudioData]);

  useEffect(() => {
    let interval: NodeJS.Timeout | null = null;

    if (isRecordingMic || isRecordingSystem) {
      const startTime = Date.now();
      interval = setInterval(() => {
        const elapsedTime = Math.floor((Date.now() - startTime) / 1000);
        setTimer(elapsedTime);
      }, 100);
    } else {
      setTimer(0);
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isRecordingMic, isRecordingSystem]);

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs
      .toString()
      .padStart(2, "0")}`;
  };

  const cleanupRecording = async () => {
    // Stop audio capture first
    try {
      await window.electron.ipcRenderer.invoke("stop-audio-capture");
    } catch (error) {
      console.error("Error stopping capture:", error);
    }

    // Reset all state
    audioChunksRef.current = [];
    processingQueueRef.current = [];
    recordingStartTimeRef.current = 0;
    nonSilentDetectedRef.current = false;
    setIsRecording(false);
    setIsRecordingSystem(false);
    setTimer(0);

    // Close audio context
    if (audioContextRef.current) {
      try {
        await audioContextRef.current.close();
        audioContextRef.current = null;
      } catch (error) {
        console.error("Error closing audio context:", error);
      }
    }
  };

  const startRecording = async () => {
    if (isProcessing || isRecording) return;
    setIsProcessing(true);
    try {
      // Clean up any existing state first
      audioChunksRef.current = [];
      processingQueueRef.current = [];
      recordingStartTimeRef.current = 0;
      nonSilentDetectedRef.current = false;

      setIsRecording(true);
      setIsRecordingSystem(true);
      setTimer(0);

      // Start capture with both system and mic
      await window.electron.ipcRenderer.invoke("start-audio-capture", {
        sessionId: recordingSessionId.current,
        system: true,
        mic: true,
      });
    } catch (error) {
      console.error("Failed to start recording:", error);
      setIsRecording(false);
      setIsRecordingSystem(false);
    } finally {
      setIsProcessing(false);
    }
  };

  const stopRecording = async () => {
    if (!isRecording) return;
    setIsProcessing(true);

    try {
      setIsRecording(false);
      setIsRecordingSystem(false);
      setTimer(0);

      // Process the recording only if we have data
      if (audioChunksRef.current.length > 0) {
        const recordingEndTime = performance.now();
        const recordingDuration =
          (recordingEndTime - recordingStartTimeRef.current) / 1000;
        console.log(
          `Recording stopped - Wall clock duration: ${recordingDuration.toFixed(
            2
          )}s`
        );

        // Calculate actual recording duration from samples
        const actualSamples = audioChunksRef.current.reduce(
          (acc, chunk) => acc + chunk.length,
          0
        );
        const theoreticalDuration = actualSamples / audioFormat.sampleRate;
        console.log(
          `Processing recording:`,
          `\n- Total chunks: ${audioChunksRef.current.length}`,
          `\n- Total samples: ${actualSamples}`,
          `\n- Sample rate: ${audioFormat.sampleRate}Hz`,
          `\n- Channels: ${audioFormat.channels}`,
          `\n- Theoretical duration: ${theoreticalDuration.toFixed(2)}s`,
          `\n- Wall clock duration: ${recordingDuration.toFixed(2)}s`,
          `\n- Duration difference: ${(
            theoreticalDuration - recordingDuration
          ).toFixed(2)}s`
        );

        // Create a new audio context for processing
        const processingContext = new AudioContext();
        console.log(
          `Processing context sample rate: ${processingContext.sampleRate}Hz`
        );

        // Combine all audio chunks
        const combinedArray = new Float32Array(actualSamples);
        let offset = 0;

        audioChunksRef.current.forEach((chunk, index) => {
          console.log(
            `Combining chunk ${index + 1}/${audioChunksRef.current.length}:`,
            `size: ${chunk.length} samples,`,
            `offset: ${offset}`
          );
          combinedArray.set(chunk, offset);
          offset += chunk.length;
        });

        // Create audio buffer with actual samples
        const audioBuffer = new AudioBuffer({
          length: actualSamples,
          numberOfChannels: audioFormat.channels,
          sampleRate: audioFormat.sampleRate,
        });

        console.log(
          `Created AudioBuffer:`,
          `\n- Length: ${audioBuffer.length} samples`,
          `\n- Duration: ${audioBuffer.duration.toFixed(2)}s`,
          `\n- Sample rate: ${audioBuffer.sampleRate}Hz`,
          `\n- Channels: ${audioBuffer.numberOfChannels}`
        );

        // Set the normalized data
        audioBuffer.getChannelData(0).set(combinedArray);

        // Convert to WAV
        const wavBlob = await audioBufferToWav(audioBuffer);
        console.log(`WAV blob size: ${wavBlob.size} bytes`);

        // Clean up processing context
        await processingContext.close();

        // Create URL for the blob
        const url = URL.createObjectURL(wavBlob);

        // Add to recordings list with format info
        const newRecording: Recording = {
          id: Date.now(),
          blob: wavBlob,
          url,
          timestamp: new Date(),
          sampleRate: audioFormat.sampleRate,
          channels: audioFormat.channels,
        };

        // Only update if we're still in the same session
        if (recordingSessionId.current === recordingSessionId.current) {
          setRecordings((prev) => [newRecording, ...prev]);

          if (onRecordingComplete) {
            onRecordingComplete(wavBlob);
          }
        }
      }
    } catch (error) {
      console.error("Failed to stop recording:", error);
      // Ensure states are reset even on error
      setIsRecording(false);
      setIsRecordingSystem(false);
      setTimer(0);
      alert(
        error instanceof Error ? error.message : "Failed to stop recording"
      );
    } finally {
      setIsProcessing(false);
      // Clear the audio chunks if we're not keeping the recording
      if (!isRecording) {
        audioChunksRef.current = [];
      }
    }
  };

  const audioBufferToWav = (buffer: AudioBuffer): Promise<Blob> => {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const format = 1; // PCM
    const bitDepth = 16;

    const dataLength = buffer.length * numChannels * (bitDepth / 8);
    const bufferLength = 44 + dataLength;
    const arrayBuffer = new ArrayBuffer(bufferLength);
    const view = new DataView(arrayBuffer);

    // WAV header
    const writeString = (view: DataView, offset: number, string: string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };

    writeString(view, 0, "RIFF");
    view.setUint32(4, bufferLength - 8, true);
    writeString(view, 8, "WAVE");
    writeString(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, format, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * (bitDepth / 8), true);
    view.setUint16(32, numChannels * (bitDepth / 8), true);
    view.setUint16(34, bitDepth, true);
    writeString(view, 36, "data");
    view.setUint32(40, dataLength, true);

    // Write audio data with dithering
    const channelData = buffer.getChannelData(0);
    let offset = 44;

    const dither = (sample: number) => {
      return sample + (Math.random() * 2 - 1) / 32768;
    };

    for (let i = 0; i < channelData.length; i++) {
      let sample = dither(channelData[i]);
      sample = Math.max(-1.0, Math.min(1.0, sample));
      const pcmValue = Math.round(sample * 32767);
      view.setInt16(offset, pcmValue, true);
      offset += 2;
    }

    return Promise.resolve(new Blob([arrayBuffer], { type: "audio/wav" }));
  };

  const formatTimestamp = (date: Date) => {
    return date.toLocaleTimeString();
  };

  const deleteRecording = (id: number) => {
    setRecordings((prev) => {
      const newRecordings = prev.filter((rec) => rec.id !== id);
      // Clean up URLs
      prev
        .filter((rec) => rec.id === id)
        .forEach((rec) => URL.revokeObjectURL(rec.url));
      return newRecordings;
    });
  };

  return (
    <div className="max-w-2xl mx-auto p-6">
      <div className="flex flex-col items-center mb-8">
        <button
          className={`relative flex items-center justify-center gap-2 px-6 py-3 text-lg font-medium rounded-lg transition-all duration-200 ${
            isRecording
              ? "bg-red-500 text-white hover:bg-red-600"
              : "bg-blue-500 text-white hover:bg-blue-600"
          } ${isProcessing ? "opacity-50 cursor-not-allowed" : ""}`}
          onClick={isRecording ? stopRecording : startRecording}
          disabled={isProcessing}
        >
          <div className="flex items-center gap-2">
            {isRecording ? (
              <>
                <div className="w-3 h-3 rounded-full bg-white animate-pulse" />
                Stop Recording
              </>
            ) : (
              <>
                <IoMdVolumeHigh className="text-xl" />
                <FaMicrophone className="text-xl" />
                <span>Record System + Mic</span>
              </>
            )}
          </div>
        </button>
        {isRecording && (
          <div className="mt-4 text-lg font-mono text-red-500">
            {formatTime(timer)}
          </div>
        )}
      </div>

      <div className="mt-8">
        <h2 className="text-2xl font-semibold text-gray-700 mb-4">
          Recent Recordings
        </h2>
        {recordings.length === 0 ? (
          <p className="text-gray-500">No recordings yet.</p>
        ) : (
          <div className="space-y-4">
            {recordings.map((recording) => (
              <div
                key={recording.id}
                className="bg-white rounded-lg shadow p-4 flex items-center justify-between"
              >
                <div className="flex items-center gap-4">
                  <span className="text-gray-600">
                    {formatTimestamp(recording.timestamp)}
                  </span>
                  <span className="text-sm text-gray-500">
                    {recording.sampleRate / 1000}kHz {recording.channels}ch
                  </span>
                  <audio controls src={recording.url} className="h-8" />
                </div>
                <button
                  onClick={() => deleteRecording(recording.id)}
                  className="text-red-500 hover:text-red-700"
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default AudioRecorder;
