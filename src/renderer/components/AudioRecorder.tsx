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
}

const AudioRecorder: React.FC<AudioRecorderProps> = ({
  onRecordingComplete,
}) => {
  const [isRecording, setIsRecording] = useState(false);
  const [isRecordingMic, setIsRecordingMic] = useState(false);
  const [isRecordingSystem, setIsRecordingSystem] = useState(false);
  const [timer, setTimer] = useState(0);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const audioChunksRef = useRef<Float32Array[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    // Initialize audio context
    audioContextRef.current = new AudioContext();

    // Set up IPC listener for audio data
    const handleAudioData = (buffer: Buffer, format: any) => {
      console.log(
        "Received audio chunk:",
        buffer.byteLength,
        "Format:",
        format
      );
      if (isRecording) {
        // Convert 16-bit PCM to 32-bit float
        const int16Array = new Int16Array(buffer.buffer);
        const float32Array = new Float32Array(int16Array.length);

        for (let i = 0; i < int16Array.length; i++) {
          float32Array[i] = int16Array[i] / 32768.0; // Normalize to [-1, 1]
        }

        audioChunksRef.current.push(float32Array);
      }
    };

    window.electron.ipcRenderer.on("audio-data", handleAudioData);

    return () => {
      // Cleanup
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
      window.electron.ipcRenderer.removeListener("audio-data", handleAudioData);
    };
  }, [isRecording]);

  useEffect(() => {
    let interval: NodeJS.Timeout | null = null;

    if (isRecordingMic || isRecordingSystem) {
      interval = setInterval(() => {
        setTimer((prev) => prev + 1);
      }, 1000);
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

  const startRecording = async () => {
    try {
      audioChunksRef.current = []; // Reset chunks
      await window.electron.ipcRenderer.invoke("start-audio-capture", {
        system: isRecordingSystem,
        mic: isRecordingMic,
      });
      setIsRecording(true);
      setIsRecordingSystem(true);
    } catch (error) {
      console.error("Failed to start recording:", error);
    }
  };

  const stopRecording = async () => {
    try {
      await window.electron.ipcRenderer.invoke("stop-audio-capture");
      setIsRecording(false);
      setIsRecordingSystem(false);

      // Check if we have any audio data
      if (audioChunksRef.current.length === 0) {
        throw new Error("No audio data was recorded");
      }

      // Combine all audio chunks
      const totalLength = audioChunksRef.current.reduce(
        (acc, chunk) => acc + chunk.length,
        0
      );

      if (totalLength === 0) {
        throw new Error("Total audio length is 0");
      }

      const combinedArray = new Float32Array(totalLength);
      let offset = 0;

      audioChunksRef.current.forEach((chunk) => {
        combinedArray.set(chunk, offset);
        offset += chunk.length;
      });

      // Create audio buffer
      const audioBuffer = audioContextRef.current!.createBuffer(
        1, // mono
        combinedArray.length,
        44100 // sample rate
      );
      audioBuffer.getChannelData(0).set(combinedArray);

      // Convert to WAV
      const wavBlob = await audioBufferToWav(audioBuffer);

      // Create URL for the blob
      const url = URL.createObjectURL(wavBlob);

      // Add to recordings list
      const newRecording: Recording = {
        id: Date.now(),
        blob: wavBlob,
        url,
        timestamp: new Date(),
      };

      setRecordings((prev) => [newRecording, ...prev]);

      if (onRecordingComplete) {
        onRecordingComplete(wavBlob);
      }
    } catch (error) {
      console.error("Failed to stop recording:", error);
      alert(
        error instanceof Error ? error.message : "Failed to stop recording"
      );
    }
  };

  // Helper function to convert AudioBuffer to WAV blob
  const audioBufferToWav = (buffer: AudioBuffer): Promise<Blob> => {
    const numChannels = 1;
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

    // Write audio data
    const channelData = buffer.getChannelData(0);
    let offset = 44;
    for (let i = 0; i < channelData.length; i++) {
      const sample = Math.max(-1, Math.min(1, channelData[i]));
      view.setInt16(
        offset,
        sample < 0 ? sample * 0x8000 : sample * 0x7fff,
        true
      );
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
