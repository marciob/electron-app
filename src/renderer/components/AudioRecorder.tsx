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

interface AudioChunk {
  data: Float32Array;
  timestamp: number; // Nanosecond precision
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
  const audioChunksRef = useRef<AudioChunk[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const recordingStartTimeRef = useRef<number>(0);
  const recordingSessionId = useRef(0);
  const sampleRate = 48000;

  const processAudioChunks = (chunks: AudioChunk[]) => {
    if (chunks.length === 0) {
      console.warn("No audio chunks to process");
      return new Float32Array(1);
    }

    // Sort chunks by hardware timestamp
    const sorted = [...chunks].sort((a, b) => a.timestamp - b.timestamp);

    // Calculate total duration using hardware timestamps
    const firstTimestamp = sorted[0].timestamp;
    const lastTimestamp = sorted[sorted.length - 1].timestamp;
    const totalDuration = (lastTimestamp - firstTimestamp) / 1e9;

    // Add minimal padding
    const paddingDuration = 0.02; // 20ms padding
    const totalSamples = Math.ceil(
      (totalDuration + paddingDuration) * sampleRate
    );

    console.log(
      `Processing audio chunks:`,
      `\n- Total chunks: ${chunks.length}`,
      `\n- Duration: ${totalDuration.toFixed(4)}s`,
      `\n- Samples: ${totalSamples}`,
      `\n- Sample rate: ${sampleRate}`
    );

    // Create buffer with padding
    const buffer = new Float32Array(totalSamples);
    let lastChunkEnd = 0;

    // Use gentler crossfading
    const FADE_DURATION = 0.005; // 5ms crossfade
    const FADE_SAMPLES = Math.floor(FADE_DURATION * sampleRate);

    for (let i = 0; i < sorted.length; i++) {
      const chunk = sorted[i];
      const chunkStart = Math.round(
        ((chunk.timestamp - firstTimestamp) / 1e9) * sampleRate
      );

      if (chunkStart < 0) continue;

      // Calculate overlap with previous chunk
      const overlap = lastChunkEnd - chunkStart;
      const processedData = new Float32Array(chunk.data);

      if (overlap > 0 && i > 0) {
        // Simple linear crossfade for overlapping regions
        const fadeLength = Math.min(overlap, FADE_SAMPLES);
        for (let j = 0; j < fadeLength; j++) {
          const fadeIn = j / fadeLength;
          const fadeOut = 1 - fadeIn;
          const pos = chunkStart + j;
          if (pos >= 0 && pos < buffer.length) {
            buffer[pos] = buffer[pos] * fadeOut + processedData[j] * fadeIn;
          }
        }

        // Copy remaining samples
        const remainingSamples = Math.min(
          processedData.length - fadeLength,
          buffer.length - (chunkStart + fadeLength)
        );
        if (remainingSamples > 0) {
          buffer.set(
            processedData.subarray(fadeLength, fadeLength + remainingSamples),
            chunkStart + fadeLength
          );
        }
      } else {
        // No crossfading for non-overlapping chunks
        const samplesToWrite = Math.min(
          processedData.length,
          buffer.length - chunkStart
        );
        if (samplesToWrite > 0) {
          buffer.set(processedData.subarray(0, samplesToWrite), chunkStart);
        }
      }

      lastChunkEnd = chunkStart + processedData.length;
    }

    // Simple peak normalization if needed
    let maxLevel = 0;
    for (let i = 0; i < buffer.length; i++) {
      maxLevel = Math.max(maxLevel, Math.abs(buffer[i]));
    }

    if (maxLevel > 1) {
      const scale = 0.99 / maxLevel;
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] *= scale;
      }
    }

    return buffer;
  };

  const handleAudioData = useCallback(
    (data: {
      buffer: Buffer;
      format: any;
      timestamp: number;
      sessionId: number;
    }) => {
      // Only check session ID match, not isRecording state
      if (data.sessionId !== recordingSessionId.current) {
        console.log(
          `Skipping chunk - Session mismatch: ${data.sessionId} vs ${recordingSessionId.current}`
        );
        return;
      }

      // Validate timestamp
      const timestamp =
        typeof data.timestamp === "number" ? data.timestamp : Date.now() * 1e6;

      // Convert buffer to Float32Array
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

      // Store chunk with timestamp
      audioChunksRef.current.push({
        data: float32Array,
        timestamp,
      });

      // Log timing information
      const firstChunk = audioChunksRef.current[0];
      const lastChunk =
        audioChunksRef.current[audioChunksRef.current.length - 1];

      if (firstChunk && lastChunk) {
        const hardwareDuration =
          (lastChunk.timestamp - firstChunk.timestamp) / 1e9;
        const wallClockDuration =
          (Date.now() - recordingStartTimeRef.current) / 1000;

        console.log(
          `Recording stats:`,
          `\n- Chunk size: ${float32Array.length} samples`,
          `\n- Timestamp: ${timestamp}`,
          `\n- Hardware duration: ${hardwareDuration.toFixed(4)}s`,
          `\n- Wall clock duration: ${wallClockDuration.toFixed(4)}s`,
          `\n- Drift: ${(hardwareDuration - wallClockDuration).toFixed(4)}s`,
          `\n- Chunks: ${audioChunksRef.current.length}`
        );
      }
    },
    [] // Remove isRecording from dependencies
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

  const cleanupRecording = async () => {
    // Stop audio capture first
    try {
      await window.electron.ipcRenderer.invoke("stop-audio-capture");
    } catch (error) {
      console.error("Error stopping capture:", error);
    }

    // Reset all state
    audioChunksRef.current = [];
    recordingStartTimeRef.current = 0;
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
    if (isProcessing) return;
    setIsProcessing(true);

    try {
      // Set recording state first to ensure we don't miss initial chunks
      setIsRecording(true);
      setIsRecordingSystem(true);
      recordingStartTimeRef.current = Date.now();

      // Reset all state
      audioChunksRef.current = [];
      recordingSessionId.current += 1;
      const currentSessionId = recordingSessionId.current;

      // Reset UI state
      setTimer(0);
      setAudioFormat({ sampleRate: 48000, channels: 1 });

      // Create new audio context
      if (audioContextRef.current) {
        await audioContextRef.current.close();
      }
      audioContextRef.current = new AudioContext({
        sampleRate: 48000,
      });

      console.log(
        `Starting new recording session ${currentSessionId}:`,
        `\n- Audio context sample rate: ${audioContextRef.current.sampleRate}Hz`
      );

      // Start the capture
      await window.electron.ipcRenderer.invoke("start-audio-capture", {
        sessionId: currentSessionId,
        system: true,
        mic: false,
      });
    } catch (error) {
      console.error("Failed to start recording:", error);
      await cleanupRecording();
      throw error;
    } finally {
      setIsProcessing(false);
    }
  };

  const stopRecording = async () => {
    if (!isRecording) return;
    setIsProcessing(true);

    try {
      await window.electron.ipcRenderer.invoke("stop-audio-capture");
      setIsRecording(false);
      setIsRecordingSystem(false);
      setTimer(0);

      if (audioChunksRef.current.length === 0) {
        throw new Error("No audio data was recorded");
      }

      // Process chunks with temporal alignment
      const alignedBuffer = processAudioChunks(audioChunksRef.current);

      if (alignedBuffer.length === 0) {
        throw new Error("Failed to process audio chunks");
      }

      // Create audio buffer with exact duration
      const audioBuffer = new AudioBuffer({
        length: Math.max(alignedBuffer.length, 1), // Ensure at least 1 sample
        numberOfChannels: 1,
        sampleRate: sampleRate,
      });

      // Copy the aligned data
      try {
        audioBuffer.getChannelData(0).set(alignedBuffer);
        console.log(
          `Created AudioBuffer:`,
          `\n- Length: ${audioBuffer.length} samples`,
          `\n- Duration: ${audioBuffer.duration.toFixed(4)}s`,
          `\n- Sample rate: ${audioBuffer.sampleRate}Hz`
        );
      } catch (error) {
        console.error("Error setting audio buffer data:", error);
        throw error;
      }

      // Convert to WAV and save
      const wavBlob = await audioBufferToWav(audioBuffer);
      const url = URL.createObjectURL(wavBlob);

      const newRecording: Recording = {
        id: Date.now(),
        blob: wavBlob,
        url,
        timestamp: new Date(),
        sampleRate,
        channels: 1,
      };

      setRecordings((prev) => [...prev, newRecording]);
      if (onRecordingComplete) {
        onRecordingComplete(wavBlob);
      }
    } catch (error) {
      console.error("Error stopping recording:", error);
    } finally {
      setIsProcessing(false);
      audioChunksRef.current = [];
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

    // Simple conversion without dithering or noise shaping
    const channelData = buffer.getChannelData(0);
    let offset = 44;

    for (let i = 0; i < channelData.length; i++) {
      const sample = Math.max(-1, Math.min(1, channelData[i]));
      const pcmValue = Math.floor(sample * 32767);
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
