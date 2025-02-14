const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const isDev = require("electron-is-dev");
const fs = require("fs");

// Ensure recordings directory exists
const recordingsDir = path.join(app.getPath("userData"), "recordings");
if (!fs.existsSync(recordingsDir)) {
  fs.mkdirSync(recordingsDir, { recursive: true });
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false, // Allow loading local files
    },
  });

  // Load the app
  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "../../dist/index.html"));
  }
}

// Handle saving audio file
ipcMain.handle("save-audio-file", async (event, buffer) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(recordingsDir, `recording-${timestamp}.webm`);

  fs.writeFileSync(filePath, Buffer.from(buffer));
  return filePath;
});

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
