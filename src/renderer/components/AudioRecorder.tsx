import React, { useState, useEffect } from "react";
import { FaMicrophone } from "react-icons/fa";
import { IoMdVolumeHigh } from "react-icons/io";

const AudioRecorder: React.FC = () => {
  const [isRecordingMic, setIsRecordingMic] = useState(false);
  const [isRecordingSystem, setIsRecordingSystem] = useState(false);
  const [timer, setTimer] = useState(0);

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

  return (
    <div className="max-w-2xl mx-auto p-6">
      <div className="flex flex-col items-center mb-8">
        <div className="flex items-center gap-4 mb-4">
          <div className="relative">
            <button
              className={`w-12 h-12 rounded-full flex items-center justify-center ${
                isRecordingMic ? "bg-red-500" : "bg-gray-200 hover:bg-gray-300"
              } transition-colors duration-200`}
              onClick={() => setIsRecordingMic(!isRecordingMic)}
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
        <p className="text-gray-500">No recordings yet.</p>
      </div>
    </div>
  );
};

export default AudioRecorder;
