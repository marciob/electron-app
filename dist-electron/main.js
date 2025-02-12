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
      if (!audioCapture) {
        audioCapture = new SystemAudioCapture();
        console.log("Native module loaded successfully");
      }
    } catch (error) {
      console.error("Failed to load native module:", error);
      throw error;
    }
  };
  ipcMain.handle(
    "start-audio-capture",
    async (event, options) => {
      try {
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
      } catch (error) {
        console.error("Error starting audio capture:", error);
        throw error;
      }
    }
  );
  ipcMain.handle("stop-audio-capture", () => {
    try {
      if (audioCapture) {
        audioCapture.stopCapture();
        audioCapture = null;
      }
    } catch (error) {
      console.error("Error stopping audio capture:", error);
      throw error;
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
