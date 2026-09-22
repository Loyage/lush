import { app, BrowserWindow, dialog, ipcMain, shell, Notification } from 'electron';
import fs from 'node:fs';
import cp from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
app.setName('Lush');
app.setPath('userData', path.join(app.getPath('appData'), 'Lush', 'desktop'));
let host = null;
let hostUrl = null;
let mainWindow = null;
let quitting = false;
const noticeBanners = new Map();
const notificationFile = () => path.join(app.getPath('userData'), 'notifications.json');
function notificationsEnabled() {
  try { return JSON.parse(fs.readFileSync(notificationFile(), 'utf8')).enabled === true; } catch { return false; }
}
function trustedNoticeSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame
    || !hostUrl || new URL(event.senderFrame.url).origin !== new URL(hostUrl).origin) throw new Error('untrusted notification sender');
}
function closeNoticeBanners() {
  for (const banner of noticeBanners.values()) banner.close();
  noticeBanners.clear();
}

function stopHost() {
  if (host && !host.killed) host.kill('SIGTERM');
  host = null;
  hostUrl = null;
}

function startHost() {
  if (host && hostUrl) return Promise.resolve(hostUrl);
  const root = app.isPackaged ? app.getAppPath() : path.resolve(HERE, '../../..');
  const bun = process.env.LUSH_BUN_COMMAND || 'bun';
  const env = { ...process.env, LUSH_WEB_LAUNCHER: '1', LUSH_WEB_EPHEMERAL: '1' };
  delete env.LUSH_PROJECT;
  delete env.LUSH_HOME;
  host = cp.spawn(bun, [path.join(root, 'bin', 'lush-web'), '0'], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    let output = '';
    let errors = '';
    const timeout = setTimeout(() => reject(new Error(`桌面服务启动超时${errors ? `：${errors.trim()}` : ''}`)), 15000);
    const done = value => { clearTimeout(timeout); hostUrl = value; resolve(value); };
    host.stdout.setEncoding('utf8');
    host.stderr.setEncoding('utf8');
    host.stderr.on('data', chunk => { errors = (errors + chunk).slice(-2000); });
    host.stdout.on('data', chunk => {
      output += chunk;
      const line = output.split('\n').find(value => value.startsWith('LUSH_WEB_READY '));
      if (!line) return;
      try { done(JSON.parse(line.slice('LUSH_WEB_READY '.length)).url); }
      catch (error) { reject(error); }
    });
    host.once('error', error => { clearTimeout(timeout); reject(new Error(`无法启动 Bun：${error.message}`)); });
    host.once('exit', code => {
      host = null; hostUrl = null;
      if (!quitting) reject(new Error(`桌面服务已退出（${code ?? 'signal'}）${errors ? `：${errors.trim()}` : ''}`));
    });
  });
}

async function createWindow() {
  const url = await startHost();
  mainWindow = new BrowserWindow({
    width: 1440, height: 920, minWidth: 880, minHeight: 620,
    title: 'Lush', backgroundColor: '#111719',
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  const localOrigin = new URL(url).origin;
  mainWindow.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) closeNoticeBanners();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    try {
      if (new URL(target).origin === localOrigin) return { action: 'allow', overrideBrowserWindowOptions: { width: 1100, height: 800, title: 'Lush · 检验报告' } };
    } catch { /* 不是可导航 URL */ }
    if (/^https?:/.test(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => { closeNoticeBanners(); mainWindow = null; });
  await mainWindow.loadURL(url);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (!mainWindow) { void createWindow(); return; }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.on('before-quit', () => { quitting = true; stopHost(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
  app.whenReady().then(async () => {
    ipcMain.handle('lush:notification-settings', (event, enabled) => {
      trustedNoticeSender(event);
      const supported = Notification.isSupported();
      if (enabled !== undefined) {
        if (typeof enabled !== 'boolean') throw new Error('invalid notification preference');
        fs.mkdirSync(app.getPath('userData'), { recursive: true });
        const file = notificationFile();
        fs.writeFileSync(`${file}.tmp`, JSON.stringify({ enabled: enabled && supported }), { mode: 0o600 });
        fs.renameSync(`${file}.tmp`, file);
        if (!enabled) closeNoticeBanners();
      }
      return { enabled: supported && notificationsEnabled(), supported };
    });
    ipcMain.handle('lush:notice', (event, payload) => {
      trustedNoticeSender(event);
      if (!notificationsEnabled() || !Notification.isSupported()) return false;
      if (!payload || !['title','body','tag'].every(key => typeof payload[key] === 'string' && payload[key].length <= 4000)) throw new Error('invalid notification');
      const { title, body, tag } = payload;
      noticeBanners.get(tag)?.close();
      const banner = new Notification({ title, body });
      noticeBanners.set(tag, banner);
      const remove = () => { if (noticeBanners.get(tag) === banner) noticeBanners.delete(tag); };
      banner.on('close', remove); banner.on('failed', remove);
      banner.on('click', () => {
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show(); mainWindow.focus();
        mainWindow.webContents.send('lush:notice-open');
        banner.close();
      });
      banner.show(); return true;
    });
    ipcMain.handle('lush:choose-project', async () => {
      const result = await dialog.showOpenDialog(mainWindow, { title: '选择 Lush 项目目录', properties: ['openDirectory', 'createDirectory'] });
      return result.canceled ? null : result.filePaths[0];
    });
    try { await createWindow(); }
    catch (error) { dialog.showErrorBox('Lush 无法启动', `${error.message}\n\n请确认 Bun 已安装并在 PATH 中。`); app.quit(); }
  });
}
