import React, { useState, useEffect, useRef } from "react";
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

  useEffect(() => {
    // Initialize audio context
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }

    // Set up IPC listener for audio data
    const handleAudioData = (data: {
      buffer: Buffer;
      format: any;
      sessionId: number;
    }) => {
      console.log(
        `Received chunk - Session: ${data.sessionId},`,
        `Current session: ${recordingSessionId.current}`
      );

      setAudioFormat({
        sampleRate: data.format.sampleRate,
        channels: data.format.channels,
      });

      // Only process if session matches
      if (isRecording && data.sessionId === recordingSessionId.current) {
        // Convert 16-bit PCM to 32-bit float with fixed scaling
        const int16Array = new Int16Array(data.buffer.buffer);

        // Log input PCM levels
        let maxInputPCM = 0;
        let minInputPCM = 0;
        for (let i = 0; i < int16Array.length; i++) {
          if (int16Array[i] > maxInputPCM) maxInputPCM = int16Array[i];
          if (int16Array[i] < minInputPCM) minInputPCM = int16Array[i];
        }
        console.log(
          `Input PCM levels - Max: ${maxInputPCM}, Min: ${minInputPCM}`
        );

        const float32Array = new Float32Array(int16Array.length);

        // Direct conversion from 16-bit to float32 with fixed scaling
        const scale = 1.0 / 32768.0;
        for (let i = 0; i < int16Array.length; i++) {
          float32Array[i] = int16Array[i] * scale;
        }

        // Log float32 levels
        let maxFloat = 0;
        let minFloat = 0;
        for (let i = 0; i < float32Array.length; i++) {
          if (float32Array[i] > maxFloat) maxFloat = float32Array[i];
          if (float32Array[i] < minFloat) minFloat = float32Array[i];
        }
        console.log(
          `Converted float levels - Max: ${maxFloat.toFixed(
            6
          )}, Min: ${minFloat.toFixed(6)}`
        );

        audioChunksRef.current.push(float32Array);
      }
    };

    window.electron.ipcRenderer.on("audio-data", handleAudioData);

    return () => {
      window.electron.ipcRenderer.removeListener("audio-data", handleAudioData);
    };
  }, [isRecording]);

  useEffect(() => {
    let interval: NodeJS.Timeout | null = null;

    if (isRecordingMic || isRecordingSystem) {
      interval = setInterval(() => {
        // Calculate time from actual samples
        const totalSamples = audioChunksRef.current.reduce(
          (acc, chunk) => acc + chunk.length,
          0
        );
        const timeInSeconds = Math.floor(totalSamples / audioFormat.sampleRate);
        setTimer(timeInSeconds);
      }, 100); // Update more frequently for smoother display
    } else {
      setTimer(0);
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isRecordingMic, isRecordingSystem, audioFormat.sampleRate]);

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
      // Increment session ID
      recordingSessionId.current += 1;
      const currentSessionId = recordingSessionId.current;

      // Reset audio context
      cleanupAudioContext();
      audioContextRef.current = new AudioContext();

      // Reset audio chunks
      audioChunksRef.current = [];
      recordingStartTimeRef.current = Date.now();

      await window.electron.ipcRenderer.invoke("start-audio-capture", {
        sessionId: currentSessionId,
        system: true,
        mic: false,
      });
      setIsRecording(true);
      setIsRecordingSystem(true);
    } catch (error) {
      console.error("Failed to start recording:", error);
    } finally {
      setTimeout(() => setIsProcessing(false), 500); // 500ms cooldown
    }
  };

  const stopRecording = async () => {
    try {
      const currentSessionId = recordingSessionId.current;
      await window.electron.ipcRenderer.invoke("stop-audio-capture");
      setIsRecording(false);
      setIsRecordingSystem(false);

      // Check if we have any audio data
      if (audioChunksRef.current.length === 0) {
        throw new Error("No audio data was recorded");
      }

      // Calculate actual recording duration from samples
      const actualSamples = audioChunksRef.current.reduce(
        (acc, chunk) => acc + chunk.length,
        0
      );
      console.log("Actual samples:", actualSamples);

      // Combine all audio chunks
      const combinedArray = new Float32Array(actualSamples);
      let offset = 0;

      audioChunksRef.current.forEach((chunk) => {
        combinedArray.set(chunk, offset);
        offset += chunk.length;
      });

      // Log combined array levels before processing
      let maxCombined = 0;
      let minCombined = 0;
      for (let i = 0; i < combinedArray.length; i++) {
        if (combinedArray[i] > maxCombined) maxCombined = combinedArray[i];
        if (combinedArray[i] < minCombined) minCombined = combinedArray[i];
      }
      console.log(
        `Combined array levels - Max: ${maxCombined.toFixed(
          6
        )}, Min: ${minCombined.toFixed(6)}`
      );

      // Create audio buffer with actual samples
      const audioBuffer = new AudioBuffer({
        length: actualSamples,
        numberOfChannels: audioFormat.channels,
        sampleRate: audioFormat.sampleRate,
      });

      // Apply proper peak normalization
      const targetPeak = 0.8; // -2dB headroom
      let peakValue = 0;
      for (let i = 0; i < combinedArray.length; i++) {
        peakValue = Math.max(peakValue, Math.abs(combinedArray[i]));
      }

      // Apply normalization if needed
      if (peakValue > targetPeak) {
        const scaleFactor = targetPeak / peakValue;
        for (let i = 0; i < combinedArray.length; i++) {
          combinedArray[i] *= scaleFactor;
        }
      }

      // Set the normalized data
      audioBuffer.getChannelData(0).set(combinedArray);

      // Convert to WAV
      const wavBlob = await audioBufferToWav(audioBuffer);

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

      // Cleanup audio context after recording
      cleanupAudioContext();
    } catch (error) {
      console.error("Failed to stop recording:", error);
      alert(
        error instanceof Error ? error.message : "Failed to stop recording"
      );
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
