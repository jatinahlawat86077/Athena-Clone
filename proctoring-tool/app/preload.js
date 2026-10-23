const { contextBridge, ipcRenderer } = require('electron');

/**
 * Narrow ContextBridge interface exposing ONLY the required proctoring and exam controls:
 * 1. start/stop the timer
 * 2. register timer ticks
 * 3. register camera-snapshot requests
 * 4. save a snapshot
 * 5. close the completed quiz
 */
contextBridge.exposeInMainWorld('electronAPI', {
  // 1. Start / Stop timer & camera snapshot cycle
  startTimer: () => ipcRenderer.invoke('exam:start-timer'),
  stopTimer: () => ipcRenderer.invoke('exam:stop-timer'),

  // 2. Register timer ticks (invoked once per second by main process)
  onTimerTick: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const subscription = (_event, ...args) => callback(...args);
    ipcRenderer.on('timer-tick', subscription);
    return () => ipcRenderer.removeListener('timer-tick', subscription);
  },

  // 3. Register camera-snapshot requests (invoked once every 5 seconds by main process)
  onCameraSnapshotRequest: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const subscription = (_event, ...args) => callback(...args);
    ipcRenderer.on('camera-snapshot-request', subscription);
    return () => ipcRenderer.removeListener('camera-snapshot-request', subscription);
  },

  // 4. Save a snapshot to app/user-camera-snap/<timestamp>.jpg
  storeCameraSnapImageOnDisk: (arrayBuffer) => {
    return ipcRenderer.invoke('exam:save-snapshot', arrayBuffer);
  },

  // 5. Close the completed quiz window
  closeCompletedQuiz: () => {
    return ipcRenderer.invoke('exam:close-quiz');
  }
});
