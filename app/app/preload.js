const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  extractUrls: (tasks, concurrency, onProgress) => {
    return new Promise((resolve, reject) => {
      ipcRenderer.send('extract-url-content', tasks, concurrency);

      ipcRenderer.on('extract-progress', (event, data) => {
        onProgress(data);
      });

      ipcRenderer.on('extract-complete', (event, results) => {
        ipcRenderer.removeAllListeners('extract-progress');
        ipcRenderer.removeAllListeners('extract-complete');
        ipcRenderer.removeAllListeners('extract-error');
        resolve(results);
      });

      ipcRenderer.on('extract-error', (event, error) => {
        ipcRenderer.removeAllListeners('extract-progress');
        ipcRenderer.removeAllListeners('extract-complete');
        ipcRenderer.removeAllListeners('extract-error');
        reject(new Error(error));
      });
    });
  }
});
