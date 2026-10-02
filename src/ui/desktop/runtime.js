import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConnectionStore, isProjectPage, normalizeHostUrl, sameHost, sessionPartition } from './connections.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONNECTION_PAGE = new URL('./connection.html', import.meta.url).href;
const safeExternal = value => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
};

/** Electron is injected so window, IPC and lifecycle invariants can be tested without a display. */
export function createDesktop({ electron, userData, localHost, platform = process.platform, store = new ConnectionStore(userData) }) {
  const { app, BrowserWindow, dialog, ipcMain, shell, Notification, Menu } = electron;
  const windows = new Map(), banners = new Map(), sessions = new WeakSet();
  const localSupported = platform !== 'win32' && Boolean(localHost);
  let chooser = null, quitting = false, ready = false, localPending = null;

  function focus(win) {
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
  }
  function closeBanners(id = null) {
    for (const [key, entry] of banners) {
      if (id === null || entry.id === id) { entry.banner.close(); banners.delete(key); }
    }
  }
  function trusted(event, kind = 'workspace') {
    const entry = windows.get(event.sender.id);
    if (!entry || entry.kind !== kind || entry.window.isDestroyed() || event.senderFrame !== event.sender.mainFrame) throw new Error('untrusted desktop sender');
    const value = event.senderFrame.url;
    if (kind === 'chooser' ? value !== CONNECTION_PAGE : !sameHost(value, entry.hostUrl) || !isProjectPage(value)) throw new Error('untrusted desktop sender');
    return entry;
  }
  function secureSession(session) {
    if (sessions.has(session)) return;
    sessions.add(session);
    // Native notices use the narrow IPC channel. No remote media, geolocation, popups or downloads.
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    session.on('will-download', event => event.preventDefault());
  }
  function track(win, entry) {
    const contents = win.webContents;
    windows.set(contents.id, { ...entry, window: win });
    secureSession(contents.session);
    contents.on('will-attach-webview', event => event.preventDefault());
    const allowed = target => entry.kind === 'chooser' ? target === CONNECTION_PAGE : sameHost(target, entry.hostUrl);
    contents.on('will-navigate', (event, target) => { if (!allowed(target)) event.preventDefault(); });
    contents.on('will-redirect', (event, target, _inPlace, mainFrame) => { if (mainFrame && !allowed(target)) event.preventDefault(); });
    contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) closeBanners(contents.id); });
    contents.setWindowOpenHandler(({ url: target }) => {
      if (entry.kind !== 'chooser' && sameHost(target, entry.hostUrl)) {
        // Own every project popup too; previews get no preload and cannot access native IPC.
        void openWorkspace(entry.mode, entry.hostUrl, target, isProjectPage(target) ? 'workspace' : 'preview').catch(showError);
      } else if (entry.kind !== 'chooser' && safeExternal(target)) {
        void shell.openExternal(target).catch(showError);
      }
      return { action: 'deny' };
    });
    win.on('closed', () => {
      closeBanners(contents.id); windows.delete(contents.id);
      if (win === chooser) chooser = null;
    });
    return win;
  }
  function showError(error) { if (!quitting) dialog.showErrorBox('Lush 连接失败', error.message); }
  function windowOptions(mode, hostUrl, kind) {
    return { width: 1440, height: 920, minWidth: 880, minHeight: 620,
      title: mode === 'remote' ? `Lush · 远程 ${new URL(hostUrl).host}` : 'Lush · 本地', backgroundColor: '#111719',
      webPreferences: {
        ...(kind === 'workspace' ? { preload: path.join(HERE, 'preload.cjs'), additionalArguments: [`--lush-desktop-mode=${mode}`] } : {}),
        partition: sessionPartition(mode, hostUrl), contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false,
      } };
  }
  async function openWorkspace(mode, hostUrl, target = hostUrl, kind = 'workspace') {
    if (quitting) throw new Error('桌面正在退出');
    if (!sameHost(target, hostUrl)) throw new Error('目标不属于所选 Host');
    const win = track(new BrowserWindow(windowOptions(mode, hostUrl, kind)), { kind, mode, hostUrl,
      preferenceKey: mode === 'local' ? 'local' : normalizeHostUrl(hostUrl) });
    // Keep endpoint identity in the native title even when the remote document changes its title.
    win.on('page-title-updated', event => event.preventDefault());
    try { await win.loadURL(target); }
    catch (error) {
      win.destroy();
      throw new Error(`无法打开 ${hostUrl}：${error.message}。请检查 Host、HTTPS 证书或 SSH 隧道，然后重新连接；不会自动重发 Worker 操作。`);
    }
    return win;
  }
  async function openLocal() {
    if (quitting) throw new Error('桌面正在退出');
    if (!localSupported) throw new Error('此客户端不支持本地后台；请连接远程 Linux / macOS Lush Host。Windows 不会启动本地 Bun、Host 或 daemon。');
    if (localPending) return localPending;
    localPending = (async () => {
      if (!localHost) throw new Error('本地 Host 未配置');
      const url = await localHost.start();
      return await openWorkspace('local', url);
    })().finally(() => { localPending = null; });
    return localPending;
  }
  async function openRemote(value) {
    if (quitting) throw new Error('桌面正在退出');
    const url = normalizeHostUrl(value);
    store.remember(url); rebuildMenu();
    return await openWorkspace('remote', url);
  }
  function showConnections() {
    if (quitting) return null;
    if (chooser && !chooser.isDestroyed()) { focus(chooser); return chooser; }
    chooser = track(new BrowserWindow({ width: 720, height: 700, minWidth: 520, minHeight: 560,
      title: 'Lush · 连接', backgroundColor: '#111719', webPreferences: {
        preload: path.join(HERE, 'connection-preload.cjs'), contextIsolation: true, nodeIntegration: false,
        sandbox: true, webviewTag: false, partition: 'persist:lush-connections',
      } }), { kind: 'chooser' });
    void chooser.loadURL(CONNECTION_PAGE).catch(showError);
    return chooser;
  }
  function rebuildMenu() {
    const recent = store.list();
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { label: '连接', submenu: [
        { label: '连接远程 Host…', accelerator: 'CmdOrCtrl+Shift+O', click: showConnections },
        { label: localSupported ? '新建本地窗口' : '本地窗口不可用（请连接远程 Host）', enabled: localSupported,
          accelerator: 'CmdOrCtrl+Shift+N', click: () => { void openLocal().catch(showError); } },
        { label: '最近远程连接', enabled: recent.length > 0, submenu: recent.map(url => ({ label: url, click: () => { void openRemote(url).catch(showError); } })) },
        { type: 'separator' }, { role: 'close' }, ...(platform === 'darwin' ? [] : [{ role: 'quit' }]),
      ] },
      { role: 'editMenu' }, { label: '视图', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
      { role: 'windowMenu' },
    ]));
  }
  function installIPC() {
    ipcMain.handle('lush:connections-list', event => { trusted(event, 'chooser'); return store.list(); });
    ipcMain.handle('lush:connections-remove', (event, value) => { trusted(event, 'chooser'); store.remove(value); rebuildMenu(); return store.list(); });
    ipcMain.handle('lush:open-local', event => { trusted(event, 'chooser'); return openLocal().then(() => true); });
    ipcMain.handle('lush:open-remote', (event, value) => { trusted(event, 'chooser'); return openRemote(value).then(() => true); });
    ipcMain.handle('lush:choose-project', async event => {
      const entry = trusted(event);
      if (entry.mode !== 'local') throw new Error('remote windows cannot choose local directories');
      const result = await dialog.showOpenDialog(entry.window, { title: '选择 Lush 项目目录', properties: ['openDirectory', 'createDirectory'] });
      return result.canceled ? null : result.filePaths[0];
    });
    ipcMain.handle('lush:notification-settings', (event, enabled) => {
      const entry = trusted(event), supported = Notification.isSupported();
      if (enabled !== undefined) {
        store.setEnabled(entry.preferenceKey, enabled);
        if (!enabled) for (const row of windows.values()) if (row.preferenceKey === entry.preferenceKey) closeBanners(row.window.webContents.id);
      }
      return { enabled: supported && store.enabled(entry.preferenceKey), supported };
    });
    ipcMain.handle('lush:notice', (event, payload) => {
      const entry = trusted(event);
      if (!store.enabled(entry.preferenceKey) || !Notification.isSupported()) return false;
      if (!payload || !['title', 'body', 'tag'].every(key => typeof payload[key] === 'string' && payload[key].length <= 4000)) throw new Error('invalid notification');
      const target = payload.notice_id === undefined && payload.task_id === undefined ? null : { notice_id: payload.notice_id, task_id: payload.task_id };
      if (target && ![target.notice_id, target.task_id].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('invalid notification target');
      const sourcePath = new URL(event.senderFrame.url).pathname;
      const key = `${entry.preferenceKey}:${payload.tag}`;
      banners.get(key)?.banner.close();
      const banner = new Notification({ title: payload.title, body: payload.body });
      banners.set(key, { banner, id: event.sender.id });
      const remove = () => { if (banners.get(key)?.banner === banner) banners.delete(key); };
      banner.on('close', remove); banner.on('failed', remove);
      banner.on('click', () => {
        const win = entry.window;
        if (win.isDestroyed()) return;
        focus(win);
        if (target) win.webContents.send('lush:notice-open', { ...target, pathname: sourcePath });
        else win.webContents.send('lush:notice-open');
        banner.close();
      });
      banner.show(); return true;
    });
  }
  function dispose() { quitting = true; closeBanners(); localHost?.stop(); }
  function start() {
    if (!app.requestSingleInstanceLock()) { app.quit(); return Promise.resolve(); }
    app.on('second-instance', () => {
      if (!ready || quitting) return;
      const focused = BrowserWindow.getFocusedWindow();
      const win = focused || [...windows.values()].find(entry => entry.kind === 'workspace')?.window;
      if (win) focus(win); else showConnections();
    });
    app.on('before-quit', dispose);
    app.on('window-all-closed', () => { if (platform !== 'darwin') app.quit(); });
    return app.whenReady().then(() => {
      if (quitting) return;
      ready = true; installIPC(); rebuildMenu(); showConnections();
      app.on('activate', () => { if (!windows.size) showConnections(); });
    });
  }
  return { start, openLocal, openRemote, showConnections, dispose };
}
