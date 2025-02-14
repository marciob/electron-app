"use strict";
const {
  app,
  BrowserWindow,
  systemPreferences,
  ipcMain,
  dialog
} = require("electron");
const path = require("path");
const isDev = require("electron-is-dev");
const { SystemAudioCapture } = require("bindings")("systemAudio");
let audioCapture = null;
let isCleaningUp = false;
function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload/index.js")
    }
  });
  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "../../dist/index.html"));
  }
  const requestPermissions = async () => {
    try {
      const screenCaptureStatus = await systemPreferences.getMediaAccessStatus(
        "screen"
      );
      if (screenCaptureStatus !== "granted") {
        const result = await dialog.showMessageBox({
          type: "warning",
          buttons: ["Open System Preferences", "Cancel"],
          defaultId: 0,
          message: "Screen Recording Permission Required",
          detail: "This app needs screen recording permission to capture system audio. Please enable it in System Preferences > Security & Privacy > Privacy > Screen Recording."
        });
        if (result.response === 0) {
          await systemPreferences.askForMediaAccess("screen");
        } else {
          throw new Error("Screen recording permission denied");
        }
      }
      const micStatus = await systemPreferences.getMediaAccessStatus(
        "microphone"
      );
      if (micStatus !== "granted") {
        await systemPreferences.askForMediaAccess("microphone");
      }
    } catch (error) {
      console.error("Error requesting permissions:", error);
      throw error;
    }
  };
  const initAudioCapture = () => {
    try {
      audioCapture = new SystemAudioCapture();
      console.log("New native module instance created");
    } catch (error) {
      console.error("Failed to load native module:", error);
      throw error;
    }
  };
  ipcMain.handle("stop-audio-capture", async () => {
    try {
      await stopExistingCapture();
    } catch (error) {
      console.error("Error stopping audio capture:", error);
      throw error;
    }
  });
  const stopExistingCapture = async () => {
    if (!audioCapture || isCleaningUp) {
      return;
    }
    isCleaningUp = true;
    console.log("Stopping previous capture instance");
    try {
      await Promise.race([
        audioCapture.stopCapture(),
        new Promise(
          (_, reject) => setTimeout(() => reject(new Error("Stop capture timeout")), 1e3)
        )
      ]);
      await new Promise((resolve) => setTimeout(resolve, 100));
      audioCapture = null;
      console.log("Capture instance cleanup completed");
    } catch (error) {
      console.error("Error stopping capture:", error);
      audioCapture = null;
    } finally {
      isCleaningUp = false;
    }
  };
  ipcMain.handle(
    "start-audio-capture",
    async (event, options) => {
      try {
        console.log("Starting new audio capture with options:", options);
        await requestPermissions();
        initAudioCapture();
        audioCapture.startCapture((buffer, format) => {
          if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send("audio-data", {
              buffer,
              format,
              sessionId: options.sessionId
            });
          }
        });
        console.log("Audio capture started successfully");
      } catch (error) {
        console.error("Error starting audio capture:", error);
        await stopExistingCapture();
        throw error;
      }
    }
  );
  mainWindow.on("closed", async () => {
    try {
      console.log("Window closing, cleaning up audio capture");
      await stopExistingCapture();
    } catch (error) {
      console.error("Error cleaning up audio capture:", error);
    }
  });
}
app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
//# sourceMappingURL=main.js.map
