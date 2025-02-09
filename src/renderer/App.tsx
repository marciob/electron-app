import React from "react";

const App: React.FC = () => {
  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-gray-800 mb-4">Hello World</h1>
        <p className="text-gray-600">
          Welcome to your Electron React Application
        </p>
      </div>
    </div>
  );
};

export default App;
