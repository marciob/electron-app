import React from "react";
import AudioRecorder from "./components/AudioRecorder";

const App: React.FC = () => {
  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center">
      <AudioRecorder />
    </div>
  );
};

export default App;
