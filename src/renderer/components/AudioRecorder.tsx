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

  const handleAudioData = useCallback(
    (data: { buffer: Buffer; format: any; sessionId: number }) => {
      // Add early rejection for stale chunks
      if (data.sessionId < recordingSessionId.current) {
        console.log(`Rejecting stale chunk from session ${data.sessionId}`);
        return;
      }

      // Add buffer validation
      if (!data.buffer || data.buffer.length === 0) {
        console.error("Received empty audio buffer");
        return;
      }

      // Validate sample count
      const expectedBytesPerSample = data.format.bitsPerChannel / 8;
      if (data.buffer.length % expectedBytesPerSample !== 0) {
        console.error(
          `Invalid buffer length: ${data.buffer.length} bytes for ${expectedBytesPerSample} bytes/sample`
        );
        return;
      }

      // Early return if not recording or session mismatch
      if (!isRecording || data.sessionId !== recordingSessionId.current) {
        console.log(
          `Skipping audio chunk - Recording: ${isRecording}, ` +
            `Session current: ${recordingSessionId.current}, ` +
            `Chunk session: ${data.sessionId}`
        );
        return;
      }

      // Update format state if needed
      if (
        data.format.sampleRate !== audioFormat.sampleRate ||
        data.format.channels !== audioFormat.channels
      ) {
        setAudioFormat({
          sampleRate: data.format.sampleRate,
          channels: data.format.channels,
        });
      }

      // Convert buffer using correct byte interpretation
      const bytesPerSample = data.format.bitsPerChannel / 8;
      const sampleCount = data.buffer.length / bytesPerSample;

      console.log(
        `Processing chunk - Bytes: ${data.buffer.length}, ` +
          `Bytes per sample: ${bytesPerSample}, ` +
          `Sample count: ${sampleCount}, ` +
          `Sample rate: ${data.format.sampleRate}Hz, ` +
          `Channels: ${data.format.channels}`
      );

      // Create Int16Array from the buffer
      const int16Array = new Int16Array(
        data.buffer.buffer,
        data.buffer.byteOffset,
        sampleCount
      );

      // Convert to float32 for consistent processing
      const float32Array = new Float32Array(sampleCount);
      const scale = 1.0 / 32768.0; // Convert from Int16 range to [-1, 1]

      for (let i = 0; i < sampleCount; i++) {
        float32Array[i] = int16Array[i] * scale;
      }

      // Log buffer statistics
      let maxSample = 0;
      let minSample = 0;
      for (let i = 0; i < float32Array.length; i++) {
        if (float32Array[i] > maxSample) maxSample = float32Array[i];
        if (float32Array[i] < minSample) minSample = float32Array[i];
      }

      console.log(
        `Chunk statistics - ` +
          `Max: ${maxSample.toFixed(6)}, ` +
          `Min: ${minSample.toFixed(6)}, ` +
          `Duration: ${(sampleCount / data.format.sampleRate).toFixed(3)}s`
      );

      // Store the converted buffer
      audioChunksRef.current.push(float32Array);

      // Log accumulated buffer info
      const totalSamples = audioChunksRef.current.reduce(
        (acc, chunk) => acc + chunk.length,
        0
      );

      const wallClockTime = (Date.now() - recordingStartTimeRef.current) / 1000;
      const theoreticalDuration = totalSamples / data.format.sampleRate;

      console.log(
        `Recording progress - ` +
          `Total chunks: ${audioChunksRef.current.length}, ` +
          `Total samples: ${totalSamples}, ` +
          `Theoretical duration: ${theoreticalDuration.toFixed(2)}s, ` +
          `Wall clock time: ${wallClockTime.toFixed(2)}s, ` +
          `Drift: ${(theoreticalDuration - wallClockTime).toFixed(3)}s`
      );
    },
    [isRecording, audioFormat]
  );

  useEffect(() => {
    window.electron.ipcRenderer.on("audio-data", handleAudioData);
    return () => {
      window.electron.ipcRenderer.removeListener("audio-data", handleAudioData);
    };
  }, [handleAudioData]);

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

  const cleanupAudioContext = () => {
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
  };

  const startRecording = async () => {
    if (isProcessing) return;
    setIsProcessing(true);

    try {
      // Force reset before any operations
      recordingSessionId.current += 1;
      const currentSessionId = recordingSessionId.current;

      // Reset all state variables aggressively
      audioChunksRef.current = [];
      recordingStartTimeRef.current = Date.now();

      // Reset UI state
      setTimer(0);
      setIsRecording(false);
      setIsRecordingSystem(false);
      setAudioFormat({ sampleRate: 48000, channels: 1 });

      // Force cleanup of audio context
      if (audioContextRef.current) {
        try {
          await audioContextRef.current.close();
        } catch (error) {
          console.warn("Error closing audio context:", error);
        }
        audioContextRef.current = null;
      }

      // Create new context with explicit sample rate
      audioContextRef.current = new AudioContext({
        sampleRate: 48000, // Force 48kHz to match native audio
      });

      console.log(
        `New recording session ${currentSessionId}:`,
        `\n- Start time: ${new Date(
          recordingStartTimeRef.current
        ).toISOString()}`,
        `\n- Audio context sample rate: ${audioContextRef.current.sampleRate}Hz`,
        `\n- Initial format: 48000Hz, 1 channel`
      );

      // Start the capture
      await window.electron.ipcRenderer.invoke("start-audio-capture", {
        sessionId: currentSessionId,
        system: true,
        mic: false,
      });

      // Update recording state
      setIsRecording(true);
      setIsRecordingSystem(true);

      console.log(`Recording started - Session ID: ${currentSessionId}`);
    } catch (error) {
      console.error("Failed to start recording:", error);

      // Aggressive cleanup on error
      audioChunksRef.current = [];
      recordingStartTimeRef.current = 0;
      recordingSessionId.current = Math.max(0, recordingSessionId.current);

      // Reset audio context
      if (audioContextRef.current) {
        try {
          await audioContextRef.current.close();
        } catch (e) {
          console.warn("Error closing audio context during cleanup:", e);
        }
        audioContextRef.current = null;
      }

      // Reset all state
      setIsRecording(false);
      setIsRecordingSystem(false);
      setTimer(0);
      setAudioFormat({ sampleRate: 48000, channels: 1 });

      throw error;
    } finally {
      setIsProcessing(false);
    }
  };

  const stopRecording = async () => {
    if (!isRecording) return;

    // Set processing state to prevent multiple stops
    setIsProcessing(true);

    try {
      const recordingEndTime = Date.now();
      const recordingDuration =
        (recordingEndTime - recordingStartTimeRef.current) / 1000;
      console.log(
        `Recording stopped - Wall clock duration: ${recordingDuration.toFixed(
          2
        )}s`
      );

      // Stop the capture first
      const currentSessionId = recordingSessionId.current;
      await window.electron.ipcRenderer.invoke("stop-audio-capture");

      // Reset recording states immediately
      setIsRecording(false);
      setIsRecordingSystem(false);
      setTimer(0);

      // Check if we have any audio data
      if (audioChunksRef.current.length === 0) {
        throw new Error("No audio data was recorded");
      }

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
      if (currentSessionId === recordingSessionId.current) {
        setRecordings((prev) => [newRecording, ...prev]);

        if (onRecordingComplete) {
          onRecordingComplete(wavBlob);
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
        <div className="flex items-center gap-4 mb-4">
          <div className="relative">
            <button
              className={`w-12 h-12 rounded-full flex items-center justify-center ${
                isRecordingSystem
                  ? "bg-red-500"
                  : "bg-gray-200 hover:bg-gray-300"
              } transition-colors duration-200`}
              onClick={isRecording ? stopRecording : startRecording}
            >
              <IoMdVolumeHigh
                className={`text-xl ${
                  isRecordingSystem ? "text-white" : "text-gray-700"
                }`}
              />
            </button>
            <span className="mt-2 block text-center text-sm text-gray-600">
              System Audio
            </span>
          </div>
        </div>

        {isRecordingSystem && (
          <div className="text-red-500 font-mono text-xl animate-pulse">
            Recording... {formatTime(timer)}
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
