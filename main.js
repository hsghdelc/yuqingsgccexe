const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

// 全局异常处理，防止未捕获的异常导致进程崩溃
process.on('uncaughtException', (error) => {
  console.error('未捕获的异常:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('未处理的 Promise 拒绝:', reason);
});

let mainWindow;
let loginWindow = null;

// 使用持久化分区，确保登录状态在窗口关闭后仍然保留
const WEB_PARTITION = 'persist:web-extract';
function getWebSession() {
  return session.fromPartition(WEB_PARTITION);
}

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
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  await loadCookies();
  createWindow();
  registerHandlers();
});

app.on('window-all-closed', () => { app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('before-quit', () => {
  // 解决挂起的登录 Promise，防止内存泄漏
  if (pendingLoginResolve) {
    pendingLoginResolve({ success: false });
    pendingLoginResolve = null;
  }
  if (loginWindow) { loginWindow.destroy(); loginWindow = null; }
  if (mainWindow) { mainWindow.removeAllListeners('close'); mainWindow.close(); }
});

// ═══════════════════════════════════════════
//  常量与工具
// ═══════════════════════════════════════════

const COOKIE_FILE = path.join(app.getPath('userData'), 'cookies.json');
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
];

let bwSemaphore = 3;
const bwQueue = [];
async function acquireBW() { if (bwSemaphore > 0) { bwSemaphore--; return; } await new Promise(r => bwQueue.push(r)); }
function releaseBW() { if (bwQueue.length > 0) { bwQueue.shift()(); } else { bwSemaphore++; } }
function getRandomUA() { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }

// ═══════════════════════════════════════════
//  Cookie 持久化（使用持久化分区）
// ═══════════════════════════════════════════

async function saveCookies() {
  try {
    const webSession = getWebSession();
    const cookies = await webSession.cookies.get({});
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
  } catch (e) {
    console.error('保存Cookie失败:', e.message);
  }
}

async function loadCookies() {
  try {
    if (fs.existsSync(COOKIE_FILE)) {
      const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf-8'));
      const webSession = getWebSession();
      for (const cookie of cookies) {
        try { await webSession.cookies.set(cookie); } catch (e) {}
      }
    }
  } catch (e) {
    console.error('加载Cookie失败:', e.message);
  }
}

// ═══════════════════════════════════════════
//  登录页检测
// ═══════════════════════════════════════════

function isLoginPage(url, title, bodyText) {
  if (/\/(login|signin|passport|sign-in|sign_up|oauth|logon)/i.test(url)) return true;
  if (/登录|Sign\s?In|Log\s?In|账号登录|用户登录/i.test(title)) return true;
  const sample = (bodyText || '').substring(0, 1000);
  if (/请登录|立即登录|密码登录|账号登录|手机号登录|扫码登录/.test(sample)) return true;
  if (/type=["']password["']/.test(sample) && /type=["']text["']/.test(sample)) return true;
  return false;
}

async function isDomainLoggedIn(domain) {
  try {
    const webSession = getWebSession();
    const cookies = await webSession.cookies.get({ domain });
    return cookies.length > 0;
  } catch (e) { return false; }
}

// ═══════════════════════════════════════════
//  HTTP 请求
// ═══════════════════════════════════════════

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
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (!redirectUrl.startsWith('http')) {
          const u = new URL(url);
          redirectUrl = u.origin + redirectUrl;
        }
        httpGet(redirectUrl, timeout).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    req.on('error', reject);
  });
}

// ═══════════════════════════════════════════
//  提取逻辑
// ═══════════════════════════════════════════

// 第①层：HTTP 快速提取
async function extractWithHttp(url) {
  const html = await httpGet(url, 8000);
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';
  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '');
  const bodyMatch = body.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (bodyMatch) body = bodyMatch[1];
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

// 第②层：BrowserWindow 提取（使用持久化分区，共享登录状态）
async function extractWithBrowserWindow(url) {
  await acquireBW();
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      show: false,
      width: 800,
      height: 600,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        spellcheck: false,
        partition: WEB_PARTITION  // 使用持久化分区，自动共享 Cookie
      }
    });
    const cleanup = () => { releaseBW(); };
    const timeout = setTimeout(() => { win.destroy(); cleanup(); reject(new Error('页面加载超时')); }, 15000);

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

    win.webContents.on('did-finish-load', async () => {
      try {
        const title = win.webContents.getTitle();
        const bodyText = await win.webContents.executeJavaScript('document.body.innerText');
        if (isLoginPage(url, title, bodyText)) {
          clearTimeout(timeout); win.destroy(); cleanup();
          resolve({ needLogin: true, title, bodyText: (bodyText || '').substring(0, 500) });
          return;
        }
        clearTimeout(timeout); win.destroy(); cleanup();
        resolve({ title, bodyText: (bodyText || '').substring(0, 500) });
      } catch (e) { clearTimeout(timeout); win.destroy(); cleanup(); reject(e); }
    });
    win.webContents.on('did-fail-load', (ev, code, desc) => { clearTimeout(timeout); win.destroy(); cleanup(); reject(new Error(`加载失败: ${desc}`)); });
    win.loadURL(url).catch(e => { clearTimeout(timeout); win.destroy(); cleanup(); reject(e); });
  });
}

// 前置登录窗口（使用持久化分区）
function openLoginWindow(name, url) {
  if (loginWindow) { loginWindow.destroy(); loginWindow = null; }
  loginWindow = new BrowserWindow({
    show: true,
    width: 600,
    height: 750,
    title: `登录 ${name}`,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      partition: WEB_PARTITION  // 使用持久化分区
    }
  });
  loginWindow.on('closed', () => { loginWindow = null; });
  loginWindow.loadURL(url);
}

// 单个 URL 提取
async function extractSingleUrl(url) {
  try {
    const result = await extractWithHttp(url);
    if (result.isLogin) return { needLogin: true, url };
    if (result.bodyText && result.bodyText.length > 0) {
      return { status: 'success', text: result.bodyText.substring(0, 500), url };
    }
  } catch (e) {}

  try {
    const result = await extractWithBrowserWindow(url);
    if (result.needLogin) return { needLogin: true, url };
    if (result.bodyText && result.bodyText.length > 0) {
      return { status: 'success', text: result.bodyText.substring(0, 500), url };
    }
  } catch (e) {}

  return { status: 'fail', text: '', url };
}

// ═══════════════════════════════════════════
//  并发控制器
// ═══════════════════════════════════════════

async function runWithConcurrency(tasks, concurrency, onProgress) {
  const results = [];
  let nextIdx = 0;
  let loginDomains = new Set();
  let loginSuccessDomains = new Set();

  async function worker() {
    while (true) {
      const idx = nextIdx++;
      if (idx >= tasks.length) return;
      const task = tasks[idx];
      const domain = new URL(task.url).hostname;

      // 如果该域名已登录成功，直接提取
      if (loginSuccessDomains.has(domain)) {
        try {
          const result = await extractWithBrowserWindow(task.url);
          const finalResult = { rowIdx: task.rowIdx, url: task.url, status: result.bodyText ? 'success' : 'fail', text: result.bodyText || '' };
          results.push(finalResult);
          onProgress(finalResult);
          continue;
        } catch (e) {}
      }

      const result = await extractSingleUrl(task.url);
      result.rowIdx = task.rowIdx;

      if (result.needLogin) {
        if (loginDomains.has(domain)) {
          const failResult = { rowIdx: task.rowIdx, url: task.url, status: 'login', text: '' };
          results.push(failResult);
          onProgress(failResult);
          continue;
        }

        await waitForLoginTurn();
        try {
          if (loginSuccessDomains.has(domain)) {
            try {
              const result = await extractWithBrowserWindow(task.url);
              const finalResult = { rowIdx: task.rowIdx, url: task.url, status: result.bodyText ? 'success' : 'fail', text: result.bodyText || '' };
              results.push(finalResult);
              onProgress(finalResult);
            } catch (e) {
              const failResult = { rowIdx: task.rowIdx, url: task.url, status: 'fail', text: '' };
              results.push(failResult);
              onProgress(failResult);
            }
            continue;
          }

          if (loginDomains.has(domain)) {
            const failResult = { rowIdx: task.rowIdx, url: task.url, status: 'login', text: '' };
            results.push(failResult);
            onProgress(failResult);
            continue;
          }

          loginDomains.add(domain);
          if (mainWindow) {
            mainWindow.webContents.send('extract-progress', {
              message: `检测到需要登录: ${domain}`,
              needLogin: true,
              domain: domain,
              url: task.url
            });
          }

          const loginResult = await new Promise(resolve => { pendingLoginResolve = resolve; });

          if (loginResult.success) {
            loginSuccessDomains.add(domain);
            await saveCookies();
            try {
              const retry = await extractWithBrowserWindow(task.url);
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
        } finally {
          releaseLoginLock();
        }
        continue;
      }

      results.push(result);
      onProgress(result);
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, tasks.length); i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

let pendingLoginResolve = null;
let loginLock = false;
const loginQueue = [];
async function waitForLoginTurn() { if (!loginLock) { loginLock = true; return; } await new Promise(r => loginQueue.push(r)); }
function releaseLoginLock() { if (loginQueue.length > 0) { loginQueue.shift()(); } else { loginLock = false; } }

// ═══════════════════════════════════════════
//  IPC Handler
// ═══════════════════════════════════════════

function registerHandlers() {
  // 内容解析
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

  // 确认登录完成
  ipcMain.on('confirm-login', async (event, data) => {
    try {
      if (loginWindow) {
        loginWindow.destroy();
        loginWindow = null;
      }
      await saveCookies();
      if (pendingLoginResolve) {
        pendingLoginResolve({ success: true, domain: data.domain });
        pendingLoginResolve = null;
      }
    } catch (e) {
      console.error('确认登录处理失败:', e.message);
    }
  });

  // 取消登录
  ipcMain.on('cancel-login', (event, data) => {
    try {
      if (loginWindow) {
        loginWindow.destroy();
        loginWindow = null;
      }
      if (pendingLoginResolve) {
        pendingLoginResolve({ success: false, domain: data.domain });
        pendingLoginResolve = null;
      }
    } catch (e) {
      console.error('取消登录处理失败:', e.message);
    }
  });

  // 前置登录
  ipcMain.on('open-login-window', (event, data) => {
    openLoginWindow(data.name, data.url);
  });

  // 检查域名是否已登录
  ipcMain.handle('check-domain-login', async (event, domain) => {
    return await isDomainLoggedIn(domain);
  });

  // ═══════════════════════════════════════════
  //  词库逆向 - Dify API
  // ═══════════════════════════════════════════

  // 下载模板文件
  ipcMain.on('download-reverse-template', async (event) => {
    try {
      const { dialog } = require('electron');
      const XLSX = require(app.getAppPath() + '/node_modules/xlsx');

      const data = [
        ['content', 'label'],
        ['国家电网招聘内定萝卜坑', 1],
        ['国网春招流程公平透明', 0]
      ];

      const ws = XLSX.utils.aoa_to_sheet(data);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, '模板');
      const wbuf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });

      const savePath = dialog.showSaveDialogSync(mainWindow, {
        defaultPath: '词库逆向模板.xlsx',
        filters: [{ name: 'Excel Files', extensions: ['xlsx'] }]
      });

      if (savePath) {
        fs.writeFileSync(savePath, Buffer.from(wbuf));
        event.sender.send('template-downloaded', { success: true });
      } else {
        event.sender.send('template-downloaded', { success: false, error: '用户取消' });
      }
    } catch (e) {
      console.error('下载模板失败:', e.message);
      event.sender.send('template-downloaded', { success: false, error: e.message });
    }
  });

  // 执行词库逆向分析
  ipcMain.on('run-lexicon-reverse', async (event, fileData, requestId) => {
    try {
      // ── 步骤 1：本地读取 Excel 并转为文本 ──
      event.sender.send('reverse-progress', { requestId, percent: 10, message: '正在解析 Excel 文件...' });

      const XLSX = require(app.getAppPath() + '/node_modules/xlsx');
      const wb = XLSX.read(new Uint8Array(fileData), { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const jsonData = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

      // 转为纯文本（每行用换行分隔，每列用制表符分隔）
      let textContent = '';
      for (const row of jsonData) {
        textContent += row.map(cell => String(cell || '')).join('\t') + '\n';
      }
      textContent = textContent.trim();

      console.log('[词库逆向] Excel 行数:', jsonData.length);
      console.log('[词库逆向] 文本长度:', textContent.length, '字符');
      console.log('[词库逆向] 前200字:', textContent.substring(0, 200));

      if (!textContent) {
        throw new Error('文件内容为空');
      }

      // ── 步骤 2：调用 Dify 工作流（传递纯文本）──
      event.sender.send('reverse-progress', { requestId, percent: 30, message: '正在调用 AI 分析（可能需要几分钟）...' });

      const postData = JSON.stringify({
        inputs: {
          query: textContent
        },
        response_mode: 'blocking',
        user: 'yuqing-user'
      });

      console.log('[词库逆向] 请求数据大小:', Buffer.byteLength(postData), '字节');

      const workflowResult = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.dify.ai',
          path: '/v1/workflows/run',
          method: 'POST',
          headers: {
            'Authorization': 'Bearer app-1ym5vAj6lBVAq9klfpVZJyRU',
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
          }
        }, (res) => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            console.log('[词库逆向] 响应状态码:', res.statusCode);
            console.log('[词库逆向] 响应前500字:', data.substring(0, 500));
            try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('响应解析失败')); }
          });
          res.on('error', reject);
        });
        req.on('error', reject);
        req.write(postData);
        req.end();
      });

      // ── 步骤 3：提取结果 ──
      event.sender.send('reverse-progress', { requestId, percent: 90, message: '正在解析结果...' });

      let markdown = '';

      if (workflowResult.data && workflowResult.data.outputs) {
        markdown = workflowResult.data.outputs.result || workflowResult.data.outputs.text || '';
      } else if (workflowResult.outputs) {
        markdown = workflowResult.outputs.result || workflowResult.outputs.text || '';
      }

      if (markdown) markdown = markdown.trim();

      console.log('[词库逆向] 结果长度:', markdown ? markdown.length : 0);

      if (!markdown) {
        console.error('[词库逆向] 完整响应:', JSON.stringify(workflowResult).substring(0, 1000));
        throw new Error('Dify 未返回有效结果，请检查控制台日志');
      }

      event.sender.send('reverse-progress', { requestId, percent: 100, message: '分析完成' });
      event.sender.send('reverse-complete', { requestId, success: true, markdown });

    } catch (e) {
      console.error('[词库逆向] 错误:', e.message);
      event.sender.send('reverse-complete', { requestId, success: false, error: e.message });
    }
  });
}
