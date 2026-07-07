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

      // ── 步骤 2：客户端分批调用 Dify 工作流 ──
      event.sender.send('reverse-progress', { requestId, percent: 15, message: '正在准备数据分批...' });

      // 将数据按 300 行一批拆分（每批保留表头）
      const headerRow = jsonData[0];
      const dataRows = jsonData.slice(1);
      const CHUNK_SIZE = 300;
      const chunks = [];
      for (let i = 0; i < dataRows.length; i += CHUNK_SIZE) {
        const chunkRows = dataRows.slice(i, i + CHUNK_SIZE);
        // 每批都带上表头
        const chunkText = [headerRow, ...chunkRows]
          .map(row => row.map(cell => String(cell || '')).join('\t'))
          .join('\n');
        chunks.push(chunkText);
      }

      const totalChunks = chunks.length;
      console.log(`[词库逆向] 共 ${dataRows.length} 行数据，分为 ${totalChunks} 批，每批 ${CHUNK_SIZE} 行`);

      // 调用单个批次的 Dify 工作流（streaming 模式）
      async function callDifyChunk(chunkText, chunkIndex, retries = 2) {
        const postData = JSON.stringify({
          inputs: { query: chunkText },
          response_mode: 'streaming',
          user: 'yuqing-user'
        });

        for (let attempt = 0; attempt <= retries; attempt++) {
          try {
            if (attempt > 0) {
              console.log(`[词库逆向] 第 ${chunkIndex + 1} 批重试第 ${attempt} 次`);
              await new Promise(r => setTimeout(r, 2000 * attempt)); // 退避等待
            }

            const result = await new Promise((resolve, reject) => {
              const req = https.request({
                hostname: 'api.dify.ai',
                path: '/v1/workflows/run',
                method: 'POST',
                headers: {
                  'Authorization': 'Bearer app-1ym5vAj6lBVAq9klfpVZJyRU',
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(postData)
                },
                timeout: 300000 // 单批 5 分钟超时
              }, (res) => {
                console.log(`[词库逆向] 第 ${chunkIndex + 1} 批 HTTP 响应:`, res.statusCode, 'headers:', JSON.stringify(res.headers).substring(0, 500));
                if (res.statusCode !== 200) {
                  let errData = '';
                  res.on('data', chunk => { errData += chunk; });
                  res.on('end', () => {
                    console.error(`[词库逆向] 第 ${chunkIndex + 1} 批 API 错误:`, res.statusCode, errData.substring(0, 300));
                    reject(new Error(`Dify API 返回 ${res.statusCode}`));
                  });
                  return;
                }

                let buffer = '';
                let finalResult = null;
                let nodeOutputs = []; // 收集所有 node_finished 的输出作为备用
                const receivedEvents = []; // 诊断日志
                let rawDataLog = ''; // 记录原始响应用于诊断

                function parseSSEPart(part) {
                  let eventType = '';
                  let eventData = '';
                  for (const line of part.split('\n')) {
                    if (line.startsWith('event: ')) eventType = line.substring(7).trim();
                    else if (line.startsWith('data: ')) eventData = line.substring(6);
                  }
                  // Dify 格式：event 类型在 JSON 内部的 "event" 字段
                  if (!eventType && eventData) {
                    try {
                      const parsed = JSON.parse(eventData);
                      if (parsed.event) eventType = parsed.event;
                    } catch (e) {}
                  }
                  return { eventType, eventData };
                }

                function processSSEEvent(eventType, eventData) {
                  if (!eventType || !eventData) return;
                  try {
                    const parsed = JSON.parse(eventData);
                    receivedEvents.push(eventType);
                    console.log(`[词库逆向] 第 ${chunkIndex + 1} 批 SSE 事件:`, eventType);

                    if (eventType === 'workflow_finished') {
                      finalResult = parsed;
                      // 检查是否有错误
                      if (parsed.data && parsed.data.error) {
                        console.error(`[词库逆向] 第 ${chunkIndex + 1} 批工作流错误:`, parsed.data.error);
                      }
                    } else if (eventType === 'node_finished') {
                      // 收集节点输出作为备用结果
                      if (parsed.data && parsed.data.outputs) {
                        nodeOutputs.push(parsed.data.outputs);
                        console.log(`[词库逆向] 第 ${chunkIndex + 1} 批节点完成:`, parsed.data.title || 'unknown');
                      }
                    }
                  } catch (e) {
                    console.warn('[词库逆向] SSE 事件解析失败:', part.substring(0, 200));
                  }
                }

                res.on('data', chunk => {
                  const chunkStr = chunk.toString().replace(/\r\n/g, '\n').replace(/\r/g, '\n');
                  rawDataLog += chunkStr;
                  console.log(`[词库逆向] 第 ${chunkIndex + 1} 批收到数据块 (${chunkStr.length} 字符):`, chunkStr.substring(0, 200));
                  buffer += chunkStr;
                  const parts = buffer.split('\n\n');
                  buffer = parts.pop();

                  for (const part of parts) {
                    if (!part.trim()) continue;
                    const { eventType, eventData } = parseSSEPart(part);
                    processSSEEvent(eventType, eventData);
                  }
                });

                res.on('end', () => {
                  console.log(`[词库逆向] 第 ${chunkIndex + 1} 批连接结束，原始数据总长度: ${rawDataLog.length} 字符`);

                  // 处理残留 buffer
                  if (buffer.trim()) {
                    const { eventType, eventData } = parseSSEPart(buffer);
                    processSSEEvent(eventType, eventData);
                  }

                  // 优先使用 SSE 解析到的结果
                  if (finalResult) {
                    resolve(finalResult);
                    return;
                  }

                  if (nodeOutputs.length > 0) {
                    // 备用方案：从 node_finished 的输出中提取结果
                    console.warn(`[词库逆向] 第 ${chunkIndex + 1} 批未收到 workflow_finished，尝试从 ${nodeOutputs.length} 个节点输出中提取结果`);
                    const fallbackResult = { data: { outputs: {} } };
                    for (const outputs of nodeOutputs) {
                      if (outputs.markdown_table) fallbackResult.data.outputs.markdown_table = outputs.markdown_table;
                      if (outputs.result) fallbackResult.data.outputs.result = outputs.result;
                      if (outputs.text) fallbackResult.data.outputs.text = outputs.text;
                    }
                    if (fallbackResult.data.outputs.markdown_table || fallbackResult.data.outputs.result || fallbackResult.data.outputs.text) {
                      resolve(fallbackResult);
                      return;
                    }
                  }

                  // 最终备用：尝试将整个响应解析为 JSON（兼容非 SSE 格式）
                  if (rawDataLog.trim()) {
                    // 先尝试直接在整个响应中搜索 markdown_table
                    const mtMatch = rawDataLog.match(/"markdown_table"\s*:\s*"((?:[^"\\]|\\[\s\S])*)"/);
                    if (mtMatch) {
                      try {
                        const mdContent = JSON.parse('"' + mtMatch[1] + '"');
                        console.log(`[词库逆向] 第 ${chunkIndex + 1} 批通过正则提取到 markdown_table (${mdContent.length} 字符)`);
                        resolve({ data: { outputs: { markdown_table: mdContent } } });
                        return;
                      } catch (e) {}
                    }

                    try {
                      const normalized = rawDataLog.trim().replace(/\r\n/g, '\n').replace(/\r/g, '\n');
                      const jsonObj = JSON.parse(normalized);
                      console.log(`[词库逆向] 第 ${chunkIndex + 1} 批响应为 JSON 格式，keys:`, Object.keys(jsonObj).join(', '));
                      // 兼容多种 JSON 结构
                      if (jsonObj.data && jsonObj.data.outputs) {
                        resolve(jsonObj);
                        return;
                      } else if (jsonObj.outputs) {
                        resolve({ data: jsonObj });
                        return;
                      } else if (jsonObj.markdown_table || jsonObj.result) {
                        resolve({ data: { outputs: { markdown_table: jsonObj.markdown_table, result: jsonObj.result } } });
                        return;
                      } else if (jsonObj.event === 'workflow_finished' && jsonObj.data) {
                        resolve(jsonObj);
                        return;
                      } else if (jsonObj.status === 'success' && jsonObj.markdown_table) {
                        resolve({ data: { outputs: { markdown_table: jsonObj.markdown_table } } });
                        return;
                      }
                      console.warn(`[词库逆向] 第 ${chunkIndex + 1} 批 JSON 结构不匹配，顶层 keys:`, Object.keys(jsonObj).join(', '));
                    } catch (e) {
                      console.warn(`[词库逆向] 第 ${chunkIndex + 1} 批响应非 JSON，解析错误:`, e.message);
                    }
                  }

                  // 将原始响应写入文件供诊断
                  try {
                    const debugPath = path.join(app.getPath('desktop'), 'dify-debug-response.txt');
                    fs.writeFileSync(debugPath, rawDataLog, 'utf-8');
                    console.log(`[词库逆向] 原始响应已保存到: ${debugPath}`);
                  } catch (e) {
                    console.warn('[词库逆向] 保存调试文件失败:', e.message);
                  }

                  reject(new Error(`第 ${chunkIndex + 1} 批工作流未返回结果（原始数据: ${rawDataLog.length}字符）`));
                });

                res.on('error', reject);
              });

              req.on('error', reject);
              req.on('timeout', () => {
                req.destroy();
                reject(new Error('单批请求超时'));
              });
              req.write(postData);
              req.end();
            });

            return result; // 成功，返回结果
          } catch (e) {
            console.error(`[词库逆向] 第 ${chunkIndex + 1} 批失败 (attempt ${attempt + 1}):`, e.message);
            if (attempt === retries) throw e; // 最后一次重试也失败，抛出错误
          }
        }
      }

      // 提取 Dify 结果中的 markdown
      function extractMarkdown(workflowResult) {
        if (workflowResult.data && workflowResult.data.outputs) {
          const o = workflowResult.data.outputs;
          return o.markdown_table || o.result || o.text || '';
        } else if (workflowResult.outputs) {
          const o = workflowResult.outputs;
          return o.markdown_table || o.result || o.text || '';
        }
        return '';
      }

      // 逐批调用并合并结果
      const allMarkdowns = [];
      for (let i = 0; i < totalChunks; i++) {
        const basePercent = 20;
        const chunkPercent = Math.round((i / totalChunks) * 70);
        event.sender.send('reverse-progress', {
          requestId,
          percent: basePercent + chunkPercent,
          message: `正在分析第 ${i + 1}/${totalChunks} 批（每批 ${CHUNK_SIZE} 行）...`
        });

        console.log(`[词库逆向] 开始处理第 ${i + 1}/${totalChunks} 批`);
        const workflowResult = await callDifyChunk(chunks[i], i);
        const md = extractMarkdown(workflowResult);

        if (md && md.trim()) {
          allMarkdowns.push(md.trim());
          console.log(`[词库逆向] 第 ${i + 1} 批完成，结果长度: ${md.trim().length}`);
        } else {
          console.warn(`[词库逆向] 第 ${i + 1} 批返回空结果`);
        }
      }

      // ── 步骤 3：合并所有批次结果 ──
      event.sender.send('reverse-progress', { requestId, percent: 92, message: '正在合并分析结果...' });

      let markdown = allMarkdowns.join('\n\n');

      // 如果有多个批次的结果，尝试去重（按关键词去重）
      if (allMarkdowns.length > 1) {
        try {
          // 解析 markdown 表格，按关键词去重
          const rows = [];
          const seenKeywords = new Set();
          for (const md of allMarkdowns) {
            const lines = md.split('\n');
            for (const line of lines) {
              // 匹配 markdown 表格行（以 | 开头，排除表头分隔行 |---|）
              if (line.startsWith('|') && !line.match(/^\|[\s-:]+\|/)) {
                const cols = line.split('|').map(c => c.trim()).filter(Boolean);
                if (cols.length >= 2) {
                  const keyword = cols[0];
                  if (!seenKeywords.has(keyword)) {
                    seenKeywords.add(keyword);
                    rows.push(line);
                  }
                }
              } else if (!line.startsWith('|') && line.trim()) {
                // 非表格行（如标题、说明等），直接保留
                rows.push(line);
              }
            }
          }
          if (rows.length > 0) {
            markdown = rows.join('\n');
          }
        } catch (e) {
          console.warn('[词库逆向] 结果去重失败，使用原始合并结果:', e.message);
        }
      }

      console.log('[词库逆向] 最终结果长度:', markdown.length, '字符');

      if (!markdown) {
        throw new Error('所有批次均未返回有效结果，请检查数据格式或稍后重试');
      }

      event.sender.send('reverse-progress', { requestId, percent: 100, message: '分析完成' });
      event.sender.send('reverse-complete', { requestId, success: true, markdown });

    } catch (e) {
      console.error('[词库逆向] 错误:', e.message);
      event.sender.send('reverse-complete', { requestId, success: false, error: e.message });
    }
  });
}
