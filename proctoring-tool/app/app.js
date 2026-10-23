const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
let timerInterval = null;
let cameraInterval = null;

// Ensure snapshots directory exists in app/user-camera-snap
const SNAP_DIR = path.join(__dirname, 'user-camera-snap');
if (!fs.existsSync(SNAP_DIR)) {
  fs.mkdirSync(SNAP_DIR, { recursive: true });
}

function clearActiveIntervals() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  if (cameraInterval) {
    clearInterval(cameraInterval);
    cameraInterval = null;
  }
}

function createWindow() {
  const isAdmin = process.argv.includes('--admin');

  const windowOptions = {
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: process.env.NODE_ENV === 'development' || process.env.ELECTRON_DEV === 'true'
    }
  };

  if (isAdmin) {
    // Admin window: approximately 1100x900, normal window mode
    windowOptions.width = 1100;
    windowOptions.height = 900;
    windowOptions.minWidth = 900;
    windowOptions.minHeight = 700;
    windowOptions.fullscreen = false;
    windowOptions.kiosk = false;
    windowOptions.title = 'ALSI Athena — Examiner Console';
  } else {
    // Student window: 1000x1000, fullscreen and kiosk mode
    windowOptions.width = 1000;
    windowOptions.height = 1000;
    windowOptions.fullscreen = true;
    windowOptions.kiosk = true;
    windowOptions.title = 'ALSI Athena — Secure Student Assessment';
  }

  mainWindow = new BrowserWindow(windowOptions);

  const loadUrl = isAdmin
    ? 'http://localhost:5173/#examiner'
    : 'http://localhost:5173';

  mainWindow.loadURL(loadUrl);

  if (windowOptions.webPreferences.devTools && process.env.ELECTRON_OPEN_DEVTOOLS === 'true') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Stop all timer/camera intervals when the window closes
  mainWindow.on('closed', () => {
    clearActiveIntervals();
    mainWindow = null;
  });
}

// IPC Handlers

// Start timer and camera intervals while exam is active
ipcMain.handle('exam:start-timer', () => {
  clearActiveIntervals();

  if (!mainWindow || mainWindow.isDestroyed()) return { success: false };

  // 1-second timer tick
  timerInterval = setInterval(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('timer-tick');
    }
  }, 1000);

  // 5-second camera snapshot request
  cameraInterval = setInterval(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('camera-snapshot-request');
    }
  }, 5000);

  return { success: true };
});

// Stop timer and camera intervals
ipcMain.handle('exam:stop-timer', () => {
  clearActiveIntervals();
  return { success: true };
});

// Store camera snapshot on disk: app/user-camera-snap/<timestamp>.jpg
ipcMain.handle('exam:save-snapshot', async (_event, arrayBuffer) => {
  if (!arrayBuffer) {
    throw new Error('No image buffer provided for snapshot');
  }

  try {
    const timestamp = Date.now();
    const filePath = path.join(SNAP_DIR, `${timestamp}.jpg`);
    const buffer = Buffer.from(arrayBuffer);

    await fs.promises.writeFile(filePath, buffer);
    return { success: true, timestamp };
  } catch (err) {
    console.error('Failed to save snapshot to disk:', err);
    // Return IPC rejection on write failure
    throw new Error(`Snapshot disk write failure: ${err.message}`);
  }
});

// Close completed quiz window
ipcMain.handle('exam:close-quiz', () => {
  clearActiveIntervals();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close();
  }
  return { success: true };
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  clearActiveIntervals();
  if (process.platform !== 'darwin') {
    app.quit();
  } else {
    // For this kiosk application, closing the exam window terminates the electron process
    app.quit();
  }
});
