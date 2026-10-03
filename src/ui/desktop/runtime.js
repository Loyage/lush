import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { ConnectionStore, isProjectPage, normalizeHostUrl, sameHost, sessionPartition } from './connections.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONNECTION_PAGE = new URL('./connection.html', import.meta.url).href;
const safeExternal = value => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
};

/** Electron is injected so window, IPC and lifecycle invariants can be tested without a display. */
export function createDesktop({ electron, userData, localHost, sshManager = null, sshError = null, platform = process.platform, store = new ConnectionStore(userData) }) {
  const { app, BrowserWindow, dialog, ipcMain, shell, Notification, Menu } = electron;
  const windows = new Map(), banners = new Map(), sessions = new WeakSet();
  const localSupported = platform !== 'win32' && Boolean(localHost);
  let chooser = null, quitting = false, ready = false, localPending = null;
  const sshInFlight = new Map(), sshProfiles = new Map();

  function requireSSH() {
    if (!sshManager) throw new Error(sshError || '此客户端未提供 SSH 管理器，请升级客户端或使用手工隧道连接');
    if (quitting) throw new Error('桌面正在退出');
    return sshManager;
  }
  function sshProfile(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['id', 'alias'].includes(key))
      || typeof value.alias !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,252}$/.test(value.alias)
      || (value.id !== undefined && (typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.id)))) {
      throw new Error('请输入 SSH 配置中的 Host 别名；不接受密码、命令或附加 SSH 参数');
    }
    return { id: value.id || randomUUID().replaceAll('-', ''), alias: value.alias };
  }
  function cancelSSH(entry) {
    entry.sshPlan = null;
    const operation = entry.sshOperation;
    if (!operation) return Promise.resolve();
    operation.cancelled = true;
    return Promise.resolve().then(() => sshManager?.disconnect(operation.profile.id));
  }
  function beginSSH(entry, profile) {
    if (entry.sshOperation || sshInFlight.has(profile.id)) throw new Error('SSH 操作正在进行或取消，请稍后重试');
    const operation = { profile, cancelled: false };
    entry.sshOperation = operation; sshInFlight.set(profile.id, operation);
    return operation;
  }
  function finishSSH(entry, operation) {
    if (entry.sshOperation === operation) entry.sshOperation = null;
    if (sshInFlight.get(operation.profile.id) === operation) sshInFlight.delete(operation.profile.id);
  }
  function checkSSHOperation(entry, operation) {
    if (operation.cancelled || quitting || entry.window.isDestroyed() || entry.window.webContents.mainFrame.url !== CONNECTION_PAGE) {
      throw new Error('SSH 操作已取消；不会自动重发 Worker 操作');
    }
  }
  async function inspectSSH(entry, value) {
    const manager = requireSSH();
    let profile = sshProfile(value);
    const operation = beginSSH(entry, profile);
    entry.sshPlan = null;
    try {
      const records = await manager.list();
      checkSSHOperation(entry, operation);
      if (!Array.isArray(records)) throw new Error('SSH 连接记录格式错误');
      if (value.id !== undefined) {
        const saved = records.find(row => row?.id === profile.id), knownAlias = sshProfiles.get(profile.id);
        if ((saved && saved.alias !== profile.alias) || (knownAlias && knownAlias !== profile.alias)) {
          throw new Error('SSH 连接身份不能替换服务器，请按新别名重新预检');
        }
        if (!saved && !knownAlias) throw new Error('未知 SSH 连接身份，请仅填写别名重新预检');
      }
      const existing = records.find(row => row?.alias === profile.alias);
      if (existing) {
        if (typeof existing.id !== 'string') throw new Error('SSH 连接记录缺少稳定身份');
        const resolved = sshProfile({ id: existing.id, alias: existing.alias });
        if (value.id !== undefined && value.id !== resolved.id) throw new Error('SSH 服务器已有连接身份，请重新读取连接记录');
        if (sshInFlight.has(resolved.id) && sshInFlight.get(resolved.id) !== operation) throw new Error('SSH 操作正在进行或取消，请稍后重试');
        sshInFlight.delete(profile.id);
        profile = resolved; operation.profile = resolved; sshInFlight.set(resolved.id, operation);
      }
      const knownAlias = sshProfiles.get(profile.id);
      if (knownAlias && knownAlias !== profile.alias) throw new Error('SSH 连接身份不能替换服务器，请重新读取连接记录');
      sshProfiles.set(profile.id, profile.alias);
      const result = await manager.inspect(profile);
      checkSSHOperation(entry, operation);
      if (!result || result.profile?.id !== profile.id || result.profile?.alias !== profile.alias) throw new Error('SSH 预检返回的服务器身份不匹配');
      const serialized = JSON.stringify({ plan: result.plan ?? {}, warnings: result.warnings ?? [] });
      if (serialized.length > 65536) throw new Error('SSH 安装计划过大，请检查后台');
      const details = JSON.parse(serialized), confirmation = randomUUID();
      const inspection = { profile, ready: result.ready === true, requiresInstall: result.requiresInstall === true, ...details };
      // Authorization is kept here, never reconstructed from renderer-supplied plans or profiles.
      if (inspection.ready || inspection.requiresInstall) entry.sshPlan = { ...inspection, confirmation };
      return { ...inspection, confirmation: entry.sshPlan?.confirmation ?? null };
    } finally { finishSSH(entry, operation); }
  }
  async function connectSSH(entry, value) {
    const manager = requireSSH(), inspection = entry.sshPlan;
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['confirmation', 'install'].includes(key))
      || typeof value.install !== 'boolean' || !inspection || value.confirmation !== inspection.confirmation) {
      throw new Error('请先预检当前服务器，再确认本次连接或安装计划');
    }
    if (inspection.requiresInstall && !value.install) throw new Error('首次安装需要明确确认安装计划');
    const operation = beginSSH(entry, inspection.profile);
    entry.sshPlan = null; // One use, including failed attempts. Retry must perform another inspection.
    let win = null;
    try {
      const result = await manager.connect(inspection.profile, { install: inspection.requiresInstall && value.install });
      checkSSHOperation(entry, operation);
      if (result.profile?.id !== inspection.profile.id || result.profile?.alias !== inspection.profile.alias) throw new Error('SSH 连接返回的服务器身份不匹配');
      const url = normalizeHostUrl(result.url), endpoint = new URL(url);
      if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1') throw new Error('受管 SSH 隧道必须使用本机 IPv4 回环入口');
      win = await openWorkspace('remote', url, url, 'workspace', inspection.profile);
      checkSSHOperation(entry, operation);
      return { profile: inspection.profile, url };
    } catch (error) {
      win?.destroy();
      await Promise.resolve().then(() => manager.disconnect(inspection.profile.id)).catch(() => {});
      throw error;
    } finally { finishSSH(entry, operation); }
  }
  async function listSSH() {
    if (!sshManager) return [];
    const records = await requireSSH().list();
    if (!Array.isArray(records)) throw new Error('SSH 连接记录格式错误');
    return records.slice(0, 100).map(row => {
      if (!row || typeof row.id !== 'string') throw new Error('SSH 连接记录缺少稳定身份');
      const profile = sshProfile({ id: row.id, alias: row.alias });
      return { ...profile, connected: row.connected === true };
    });
  }

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
    contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (!mainFrame || inPlace) return;
      closeBanners(contents.id);
      if (entry.kind === 'chooser') void cancelSSH(windows.get(contents.id)).catch(showError);
    });
    contents.setWindowOpenHandler(({ url: target }) => {
      if (entry.kind !== 'chooser' && sameHost(target, entry.hostUrl)) {
        // Own every project popup too; previews get no preload and cannot access native IPC.
        void openWorkspace(entry.mode, entry.hostUrl, target, isProjectPage(target) ? 'workspace' : 'preview', entry.sshProfile).catch(showError);
      } else if (entry.kind !== 'chooser' && safeExternal(target)) {
        void shell.openExternal(target).catch(showError);
      }
      return { action: 'deny' };
    });
    win.on('closed', () => {
      if (entry.kind === 'chooser') void cancelSSH(windows.get(contents.id)).catch(showError);
      closeBanners(contents.id); windows.delete(contents.id);
      if (win === chooser) chooser = null;
    });
    return win;
  }
  function showError(error) { if (!quitting) dialog.showErrorBox('Lush 连接失败', error.message); }
  function windowOptions(mode, hostUrl, kind, sshProfile = null) {
    return { width: 1440, height: 920, minWidth: 880, minHeight: 620,
      title: sshProfile ? `Lush · SSH ${sshProfile.alias} · ${new URL(hostUrl).host}` : mode === 'remote' ? `Lush · 远程 ${new URL(hostUrl).host}` : 'Lush · 本地', backgroundColor: '#111719',
      webPreferences: {
        ...(kind === 'workspace' ? { preload: path.join(HERE, 'preload.cjs'), additionalArguments: [`--lush-desktop-mode=${mode}`] } : {}),
        partition: sshProfile ? `persist:lush-ssh-${createHash('sha256').update(`${sshProfile.id}:${sshProfile.alias}`).digest('hex')}` : sessionPartition(mode, hostUrl),
        contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false,
      } };
  }
  async function openWorkspace(mode, hostUrl, target = hostUrl, kind = 'workspace', sshProfile = null) {
    if (quitting) throw new Error('桌面正在退出');
    if (!sameHost(target, hostUrl)) throw new Error('目标不属于所选 Host');
    const win = track(new BrowserWindow(windowOptions(mode, hostUrl, kind, sshProfile)), { kind, mode, hostUrl, sshProfile,
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
        { label: '连接远程 Host / SSH…', accelerator: 'CmdOrCtrl+Shift+O', click: showConnections },
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
    ipcMain.handle('lush:ssh-list', event => { trusted(event, 'chooser'); return listSSH(); });
    ipcMain.handle('lush:ssh-inspect', (event, value) => inspectSSH(trusted(event, 'chooser'), value));
    ipcMain.handle('lush:ssh-connect', (event, value) => connectSSH(trusted(event, 'chooser'), value));
    ipcMain.handle('lush:ssh-cancel', event => cancelSSH(trusted(event, 'chooser')).then(() => true));
    ipcMain.handle('lush:ssh-disconnect', async (event, id) => {
      const entry = trusted(event, 'chooser'), manager = requireSSH();
      const records = await listSSH();
      if (!records.some(row => row.id === id) && entry.sshOperation?.profile.id !== id && entry.sshPlan?.profile.id !== id) throw new Error('未知 SSH 连接');
      if (entry.sshOperation?.profile.id === id || entry.sshPlan?.profile.id === id) await cancelSSH(entry);
      await manager.disconnect(id);
      return true;
    });
    ipcMain.handle('lush:choose-project', async event => {
      const entry = trusted(event);
      if (entry.mode !== 'local') throw new Error('remote windows cannot choose local directories');
      const result = await dialog.showOpenDialog(entry.window, { title: '选择 Lush 项目目录', properties: ['openDirectory', 'createDirectory'] });
      return result.canceled ? null : result.filePaths[0];
    });
    ipcMain.handle('lush:ui-preferences', (event, change) => {
      const entry = trusted(event);
      if (entry.mode !== 'local') throw new Error('remote windows cannot access local UI preferences');
      const projectFor = row => {
        const url = row.window.webContents.mainFrame.url;
        if (!sameHost(url, row.hostUrl)) throw new Error('untrusted desktop preference page');
        const pathname = new URL(url).pathname;
        if (pathname === '/') return null;
        const id = /^\/p\/([a-f0-9]{16})\/?$/.exec(pathname)?.[1];
        if (!id) throw new Error('untrusted desktop preference page');
        return id;
      };
      const result = store.uiPreferences(projectFor(entry), change);
      if (change !== undefined) for (const row of windows.values()) {
        if (row.kind !== 'workspace' || row.mode !== 'local' || row.window.isDestroyed()) continue;
        try { row.window.webContents.send('lush:ui-preferences-changed', store.uiPreferences(projectFor(row))); }
        catch { /* A closing/navigated window must not turn a committed write into failure. */ }
      }
      return result;
    });
    ipcMain.handle('lush:notice-preferences', (event, value) => {
      const entry = trusted(event);
      return store.noticePreferences(entry.preferenceKey, value);
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
  function dispose() {
    if (quitting) return;
    quitting = true;
    for (const entry of windows.values()) if (entry.kind === 'chooser') void cancelSSH(entry).catch(() => {});
    closeBanners(); localHost?.stop();
    try { Promise.resolve(sshManager?.dispose()).catch(() => {}); } catch { /* Exiting must not strand owned local cleanup. */ }
  }
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
