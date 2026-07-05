const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    title: 'YuqingMonitor',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      preload: path.join(__dirname, 'preload.js')
    },
    autoHideMenuBar: true
  });

  mainWindow.loadFile('index.html');

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  await loadCookies();
  createWindow();
  registerExtractHandler();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', () => {
  if (mainWindow) {
    mainWindow.removeAllListeners('close');
    mainWindow.close();
  }
});

// ═══════════════════════════════════════════
//  内容解析 - 主进程 IPC Handler
// ═══════════════════════════════════════════

const COOKIE_FILE = path.join(app.getPath('userData'), 'cookies.json');
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
];

// BrowserWindow 并发限制
let bwSemaphore = 3;
const bwQueue = [];

async function acquireBW() {
  if (bwSemaphore > 0) { bwSemaphore--; return; }
  await new Promise(resolve => bwQueue.push(resolve));
}

function releaseBW() {
  if (bwQueue.length > 0) { bwQueue.shift()(); } else { bwSemaphore++; }
}

// Cookie 持久化
async function saveCookies() {
  try {
    const cookies = await session.defaultSession.cookies.get({});
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
  } catch (e) {}
}

async function loadCookies() {
  try {
    if (fs.existsSync(COOKIE_FILE)) {
      const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf-8'));
      for (const cookie of cookies) {
        try { await session.defaultSession.cookies.set(cookie); } catch (e) {}
      }
    }
  } catch (e) {}
}

function getRandomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// 检测是否为登录页
function isLoginPage(url, title, bodyText) {
  if (/\/(login|signin|passport|sign-in|sign_up|oauth)/i.test(url)) return true;
  if (/登录|请登录|立即登录|密码登录|账号登录/.test(bodyText.substring(0, 500))) return true;
  if (/登录|Sign\s?In|Log\s?In/i.test(title)) return true;
  return false;
}

// Node.js 内置 HTTP 请求（替代 axios）
function httpGet(url, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': getRandomUA(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      },
      timeout: timeout
    }, (res) => {
      // 处理重定向
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (!redirectUrl.startsWith('http')) {
          const u = new URL(url);
          redirectUrl = u.origin + redirectUrl;
        }
        httpGet(redirectUrl, timeout).then(resolve).catch(reject);
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求超时'));
    });

    req.on('error', reject);
  });
}

// 第①层：Node.js http 快速提取（纯正则，无依赖）
async function extractWithHttp(url) {
  const html = await httpGet(url, 8000);

  // 提取 title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';

  // 移除无用标签
  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '');

  // 提取 body 内容
  const bodyMatch = body.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (bodyMatch) body = bodyMatch[1];

  // 移除所有 HTML 标签，保留文本
  const bodyText = body
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 500);

  return { title, bodyText, isLogin: isLoginPage(url, title, bodyText) };
}

// 第②层：BrowserWindow 提取（SPA 页面）
async function extractWithBrowserWindow(url, showForLogin = false) {
  if (!showForLogin) await acquireBW();

  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      show: showForLogin,
      width: showForLogin ? 500 : 800,
      height: showForLogin ? 700 : 600,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        spellcheck: false
      }
    });

    // 拦截图片/视频等资源
    win.webContents.session.webRequest.onBeforeRequest(
      { urls: ['*://*/*'] },
      (details, cb) => {
        if (/\.(jpg|jpeg|png|gif|webp|svg|mp4|mp3|avi|mov|wmv|flv|woff|woff2|ttf|eot)(\?.*)?$/i.test(details.url)) {
          cb({ cancel: true });
        } else {
          cb({ cancel: false });
        }
      }
    );

    const cleanup = () => { if (!showForLogin) releaseBW(); };

    const timeout = setTimeout(() => {
      win.destroy();
      cleanup();
      reject(new Error('页面加载超时'));
    }, 15000);

    win.webContents.on('did-finish-load', async () => {
      try {
        const title = win.webContents.getTitle();
        const bodyText = await win.webContents.executeJavaScript('document.body.innerText');

        if (!showForLogin && isLoginPage(url, title, bodyText)) {
          clearTimeout(timeout);
          win.destroy();
          cleanup();
          resolve({ needLogin: true, title, bodyText });
          return;
        }

        clearTimeout(timeout);
        win.destroy();
        cleanup();
        resolve({ title, bodyText: (bodyText || '').substring(0, 500) });
      } catch (e) {
        clearTimeout(timeout);
        win.destroy();
        cleanup();
        reject(e);
      }
    });

    win.webContents.on('did-fail-load', (event, errorCode, errorDesc) => {
      clearTimeout(timeout);
      win.destroy();
      cleanup();
      reject(new Error(`加载失败 [${errorCode}]: ${errorDesc}`));
    });

    win.loadURL(url).catch(e => {
      clearTimeout(timeout);
      win.destroy();
      cleanup();
      reject(new Error(`loadURL失败: ${e.message}`));
    });
  });
}

// 第③层：弹窗登录（5 分钟超时）
async function loginAndWait(url) {
  return new Promise((resolve) => {
    const loginWin = new BrowserWindow({
      show: true,
      width: 500,
      height: 700,
      title: '请登录后继续（5分钟内完成）',
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });

    let resolved = false;
    const globalTimeout = setTimeout(() => {
      if (!resolved) { resolved = true; loginWin.destroy(); resolve(false); }
    }, 5 * 60 * 1000);

    loginWin.webContents.on('did-navigate', async (event, navUrl) => {
      if (!isLoginPage(navUrl, '', '') && !resolved) {
        resolved = true;
        clearTimeout(globalTimeout);
        await saveCookies();
        setTimeout(() => { loginWin.destroy(); resolve(true); }, 2000);
      }
    });

    loginWin.on('closed', () => {
      if (!resolved) { resolved = true; clearTimeout(globalTimeout); resolve(false); }
    });

    loginWin.loadURL(url);
  });
}

// 单个 URL 提取
async function extractSingleUrl(url) {
  // 第①层：http + cheerio
  try {
    const result = await extractWithHttp(url);
    if (result.isLogin) return { needLogin: true, url };
    if (result.bodyText && result.bodyText.length > 0) {
      return { status: 'success', text: result.bodyText.substring(0, 500), url };
    }
  } catch (e) {
    console.log(`[http失败] ${url}: ${e.message}`);
  }

  // 第②层：隐藏 BrowserWindow
  try {
    const result = await extractWithBrowserWindow(url, false);
    if (result.needLogin) return { needLogin: true, url };
    if (result.bodyText && result.bodyText.length > 0) {
      return { status: 'success', text: result.bodyText.substring(0, 500), url };
    }
  } catch (e) {
    console.log(`[BrowserWindow失败] ${url}: ${e.message}`);
  }

  return { status: 'fail', text: '', url };
}

// 并发控制器（立即弹窗登录版）
async function runWithConcurrency(tasks, concurrency, onProgress) {
  const results = [];
  let nextIdx = 0;
  let loginTriggered = false;
  let loginSuccess = false;

  async function worker() {
    while (true) {
      const idx = nextIdx++;
      if (idx >= tasks.length) return;

      const task = tasks[idx];

      // 登录成功后用 BrowserWindow 重试
      if (loginSuccess) {
        try {
          const result = await extractWithBrowserWindow(task.url, false);
          const finalResult = {
            rowIdx: task.rowIdx, url: task.url,
            status: result.bodyText ? 'success' : 'fail',
            text: result.bodyText || ''
          };
          results.push(finalResult);
          onProgress(finalResult);
          continue;
        } catch (e) {}
      }

      const result = await extractSingleUrl(task.url);
      result.rowIdx = task.rowIdx;

      if (result.needLogin) {
        if (!loginTriggered) {
          loginTriggered = true;
          if (mainWindow) {
            mainWindow.webContents.send('extract-progress', { message: '检测到需要登录，即将弹出登录窗口...' });
          }
          loginSuccess = await loginAndWait(task.url);
          if (loginSuccess) {
            if (mainWindow) {
              mainWindow.webContents.send('extract-progress', { message: '登录成功！正在重新提取...' });
            }
            try {
              const retry = await extractWithBrowserWindow(task.url, false);
              const finalResult = { rowIdx: task.rowIdx, url: task.url, status: retry.bodyText ? 'success' : 'fail', text: retry.bodyText || '' };
              results.push(finalResult);
              onProgress(finalResult);
            } catch (e) {
              const failResult = { rowIdx: task.rowIdx, url: task.url, status: 'fail', text: '' };
              results.push(failResult);
              onProgress(failResult);
            }
          } else {
            const failResult = { rowIdx: task.rowIdx, url: task.url, status: 'login', text: '' };
            results.push(failResult);
            onProgress(failResult);
          }
          continue;
        }
        const failResult = { rowIdx: task.rowIdx, url: task.url, status: 'login', text: '' };
        results.push(failResult);
        onProgress(failResult);
        continue;
      }

      results.push(result);
      onProgress(result);
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, tasks.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return results;
}

// 注册 IPC handler
function registerExtractHandler() {
  ipcMain.on('extract-url-content', async (event, tasks, concurrency) => {
    try {
      const results = await runWithConcurrency(tasks, concurrency, (progress) => {
        event.sender.send('extract-progress', progress);
      });
      await saveCookies();
      event.sender.send('extract-complete', results);
    } catch (e) {
      event.sender.send('extract-error', e.message);
    }
  });
}
