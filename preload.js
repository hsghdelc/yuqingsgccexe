const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 内容解析
  extractUrls: (tasks, concurrency, onProgress) => {
    return new Promise((resolve, reject) => {
      ipcRenderer.send('extract-url-content', tasks, concurrency);
      ipcRenderer.on('extract-progress', (event, data) => { onProgress(data); });
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
  },

  // 确认登录
  confirmLogin: (domain) => {
    ipcRenderer.send('confirm-login', { domain });
  },

  // 取消登录
  cancelLogin: (domain) => {
    ipcRenderer.send('cancel-login', { domain });
  },

  // 打开登录窗口
  openLoginWindow: (name, url) => {
    ipcRenderer.send('open-login-window', { name, url });
  },

  // 检查域名是否已登录
  checkDomainLogin: (domain) => {
    return ipcRenderer.invoke('check-domain-login', domain);
  },

  // 词库逆向 - 下载模板
  downloadReverseTemplate: () => {
    return new Promise((resolve, reject) => {
      ipcRenderer.send('download-reverse-template');
      ipcRenderer.on('template-downloaded', (event, result) => {
        ipcRenderer.removeAllListeners('template-downloaded');
        if (result.success) {
          resolve(result);
        } else {
          reject(new Error(result.error || '下载失败'));
        }
      });
    });
  },

  // 词库逆向 - 执行分析
  runLexiconReverse: (fileData, onProgress) => {
    const requestId = Date.now().toString();
    return new Promise((resolve, reject) => {
      ipcRenderer.send('run-lexicon-reverse', fileData, requestId);
      ipcRenderer.on('reverse-progress', (event, data) => {
        if (data.requestId === requestId) onProgress(data);
      });
      ipcRenderer.on('reverse-complete', (event, result) => {
        if (result.requestId === requestId) {
          ipcRenderer.removeAllListeners('reverse-progress');
          ipcRenderer.removeAllListeners('reverse-complete');
          if (result.success) {
            resolve(result);
          } else {
            reject(new Error(result.error || '分析失败'));
          }
        }
      });
    });
  }
});
