import React, { useState, useEffect, useRef } from "react";
import { FaMicrophone, FaPlay, FaPause } from "react-icons/fa";
import { IoMdVolumeHigh } from "react-icons/io";
const { ipcRenderer } = window.require("electron");
const path = window.require("path");

interface Recording {
  path: string;
  name: string;
  isPlaying: boolean;
  timestamp: Date;
}

const AudioRecorder: React.FC = () => {
  const [isRecordingMic, setIsRecordingMic] = useState(false);
  const [isRecordingSystem, setIsRecordingSystem] = useState(false);
  const [timer, setTimer] = useState(0);
  const [recordings, setRecordings] = useState<Recording[]>([]);

  // Refs for recording
  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const audioChunks = useRef<Blob[]>([]);
  const audioElements = useRef<{ [key: string]: HTMLAudioElement }>({});

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

  const formatDate = (date: Date): string => {
    return date.toLocaleString();
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder.current = new MediaRecorder(stream, {
        mimeType: "audio/webm;codecs=opus",
      });
      audioChunks.current = [];

      mediaRecorder.current.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunks.current.push(event.data);
        }
      };

      mediaRecorder.current.onstop = async () => {
        const audioBlob = new Blob(audioChunks.current, {
          type: "audio/webm;codecs=opus",
        });
        const arrayBuffer = await audioBlob.arrayBuffer();
        const filePath = await ipcRenderer.invoke(
          "save-audio-file",
          Array.from(new Uint8Array(arrayBuffer))
        );

        if (filePath) {
          const timestamp = new Date();
          const newRecording: Recording = {
            path: filePath,
            name: `Recording ${formatDate(timestamp)}`,
            isPlaying: false,
            timestamp,
          };
          setRecordings((prev) => [...prev, newRecording]);

          // Create audio element for the new recording
          const audio = new Audio();
          audio.src = `file://${filePath}`;
          audio.addEventListener("ended", () => {
            setRecordings((prev) =>
              prev.map((rec) =>
                rec.path === filePath ? { ...rec, isPlaying: false } : rec
              )
            );
          });
          audioElements.current[filePath] = audio;
        }

        // Stop all tracks
        stream.getTracks().forEach((track) => track.stop());
      };

      // Start recording and request data every 1 second
      mediaRecorder.current.start(1000);
      setIsRecordingMic(true);
    } catch (error) {
      console.error("Error accessing microphone:", error);
      alert(
        "Error accessing microphone. Please make sure you have granted microphone permissions."
      );
    }
  };

  const stopRecording = () => {
    if (mediaRecorder.current && mediaRecorder.current.state !== "inactive") {
      mediaRecorder.current.stop();
      setIsRecordingMic(false);
    }
  };

  const handleMicClick = () => {
    if (!isRecordingMic) {
      startRecording();
    } else {
      stopRecording();
    }
  };

  const togglePlayback = (recording: Recording) => {
    const audio = audioElements.current[recording.path];
    if (!audio) {
      // If audio element doesn't exist, create it
      const newAudio = new Audio();
      newAudio.src = `file://${recording.path}`;
      newAudio.addEventListener("ended", () => {
        setRecordings((prev) =>
          prev.map((rec) =>
            rec.path === recording.path ? { ...rec, isPlaying: false } : rec
          )
        );
      });
      audioElements.current[recording.path] = newAudio;
      newAudio.play();
      setRecordings((prev) =>
        prev.map((rec) =>
          rec.path === recording.path
            ? { ...rec, isPlaying: true }
            : { ...rec, isPlaying: false }
        )
      );
      return;
    }

    if (recording.isPlaying) {
      audio.pause();
      audio.currentTime = 0;
    } else {
      // Stop all other playing audio
      recordings.forEach((rec) => {
        if (rec.isPlaying) {
          audioElements.current[rec.path].pause();
          audioElements.current[rec.path].currentTime = 0;
        }
      });
      audio.play().catch((error) => {
        console.error("Error playing audio:", error);
      });
    }

    setRecordings((prev) =>
      prev.map((rec) =>
        rec.path === recording.path
          ? { ...rec, isPlaying: !rec.isPlaying }
          : { ...rec, isPlaying: false }
      )
    );
  };

  return (
    <div className="max-w-2xl mx-auto p-6">
      <div className="flex flex-col items-center mb-8">
        <div className="flex items-center gap-4 mb-4">
          <div className="relative">
            <button
              className={`w-12 h-12 rounded-full flex items-center justify-center ${
                isRecordingMic ? "bg-red-500" : "bg-gray-200 hover:bg-gray-300"
              } transition-colors duration-200`}
              onClick={handleMicClick}
            >
              <FaMicrophone
                className={`text-xl ${
                  isRecordingMic ? "text-white" : "text-gray-700"
                }`}
              />
            </button>
            <span className="mt-2 block text-center text-sm text-gray-600">
              Microphone
            </span>
          </div>

          <div className="relative">
            <button
              className={`w-12 h-12 rounded-full flex items-center justify-center ${
                isRecordingSystem
                  ? "bg-red-500"
                  : "bg-gray-200 hover:bg-gray-300"
              } transition-colors duration-200`}
              onClick={() => setIsRecordingSystem(!isRecordingSystem)}
              disabled={true}
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

        {(isRecordingMic || isRecordingSystem) && (
          <div className="text-red-500 font-mono text-xl">
            {formatTime(timer)}
          </div>
        )}
      </div>

      <div className="mt-12">
        <h2 className="text-2xl font-semibold text-gray-700 mb-4">
          Recent Recordings
        </h2>
        {recordings.length === 0 ? (
          <p className="text-gray-500">No recordings yet.</p>
        ) : (
          <ul className="space-y-4">
            {recordings.map((recording) => (
              <li
                key={recording.path}
                className="flex items-center justify-between bg-gray-50 p-4 rounded-lg shadow-sm"
              >
                <div className="flex items-center gap-4">
                  <button
                    onClick={() => togglePlayback(recording)}
                    className={`w-8 h-8 rounded-full flex items-center justify-center ${
                      recording.isPlaying ? "bg-red-500" : "bg-blue-500"
                    } text-white hover:opacity-90 transition-opacity`}
                  >
                    {recording.isPlaying ? (
                      <FaPause size={12} />
                    ) : (
                      <FaPlay size={12} />
                    )}
                  </button>
                  <div className="flex flex-col">
                    <span className="text-gray-700 font-medium">
                      {path.basename(recording.path)}
                    </span>
                    <span className="text-gray-500 text-sm">
                      {formatDate(recording.timestamp)}
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

export default AudioRecorder;
