import { test, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createDesktop } from '../../src/ui/desktop/runtime.js';

function fixture(platform = 'linux') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-desktop-runtime-'));
  const all = [], notices = [], handlers = new Map(), sessions = new Map(), errors = [], external = [];
  let starts = 0, stops = 0, picks = 0, failNext = false, template, localUrl = 'http://127.0.0.1:4318/';
  const app = new EventEmitter();
  Object.assign(app, { requestSingleInstanceLock: () => true, whenReady: async () => {}, quit: () => app.emit('before-quit') });
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; this.focused = false;
      const contents = this.webContents = new EventEmitter(); contents.id = all.length + 1;
      contents.mainFrame = { url: 'about:blank' };
      if (!sessions.has(options.webPreferences.partition)) {
        const session = new EventEmitter();
        session.setPermissionRequestHandler = fn => { session.request = fn; };
        session.setPermissionCheckHandler = fn => { session.check = fn; };
        sessions.set(options.webPreferences.partition, session);
      }
      contents.session = sessions.get(options.webPreferences.partition);
      contents.setWindowOpenHandler = fn => { contents.openHandler = fn; };
      contents.send = (...args) => { contents.sent = args; };
      all.push(this);
    }
    async loadURL(url) { if (failNext) { failNext = false; throw new Error('test network failure'); } this.webContents.mainFrame.url = url; }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    show() { this.shown = true; }
    focus() { this.focused = true; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    static getFocusedWindow() { return all.find(win => win.focused && !win.destroyed); }
  }
  class Notification extends EventEmitter {
    constructor(payload) { super(); this.payload = payload; notices.push(this); }
    static isSupported() { return true; }
    show() { this.shown = true; }
    close() { this.closed = true; this.emit('close'); }
  }
  const electron = { app, BrowserWindow, Notification,
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    Menu: { buildFromTemplate: value => value, setApplicationMenu: value => { template = value; } },
    shell: { openExternal: async url => external.push(url) },
    dialog: { showErrorBox: (...args) => errors.push(args), showOpenDialog: async () => { picks++; return { canceled: false, filePaths: ['/local/project'] }; } },
  };
  const desktop = createDesktop({ electron, userData: dir, platform, localHost: { start: async () => { starts++; return localUrl; }, stop: () => { stops++; } } });
  const event = (win, frame = win.webContents.mainFrame) => ({ sender: win.webContents, senderFrame: frame });
  const invoke = async (name, win, ...args) => handlers.get(name)(event(win), ...args);
  return { desktop, all, notices, errors, external, event, handlers, invoke, electron,
    stats: () => ({ starts, stops, picks, template }), fail: () => { failNext = true; },
    changeLocalUrl: url => { localUrl = url; },
    close: () => { desktop.dispose(); for (const win of all) if (!win.isDestroyed()) win.destroy(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('connection page starts without Bun, then local and multiple remote windows coexist safely', async () => {
  const f = fixture();
  try {
    await f.desktop.start(); const chooser = f.all[0];
    expect(f.stats().starts).toBe(0);
    expect(chooser.webContents.mainFrame.url).toEndWith('/connection.html');
    await f.invoke('lush:open-remote', chooser, 'https://one.example.com');
    const remote = f.all[1];
    const local = await f.desktop.openLocal();
    const other = await f.desktop.openRemote('https://two.example.com');
    expect(f.stats().starts).toBe(1);
    expect(remote.destroyed).toBe(false); expect(local.destroyed).toBe(false);
    expect(remote.options.webPreferences.partition).not.toBe(other.options.webPreferences.partition);
    expect(remote.options.webPreferences.partition).not.toBe(local.options.webPreferences.partition);
    for (const win of f.all) {
      expect(win.options.webPreferences).toMatchObject({ sandbox: true, nodeIntegration: false, contextIsolation: true, webviewTag: false });
      expect(win.webContents.session.check()).toBe(false);
      let permitted; win.webContents.session.request(null, 'media', result => { permitted = result; }); expect(permitted).toBe(false);
    }
    expect(remote.options.webPreferences.additionalArguments).toEqual(['--lush-desktop-mode=remote']);
    expect(local.options.webPreferences.additionalArguments).toEqual(['--lush-desktop-mode=local']);
    expect(await f.invoke('lush:choose-project', local)).toBe('/local/project');
    await expect(f.invoke('lush:choose-project', remote)).rejects.toThrow('cannot choose');
    await expect(f.invoke('lush:connections-list', remote)).rejects.toThrow('untrusted');
    await expect(f.invoke('lush:open-remote', remote, 'https://evil.test')).rejects.toThrow('untrusted');
    expect(f.stats().picks).toBe(1);
    expect(await f.invoke('lush:connections-list', chooser)).toEqual(['https://two.example.com/', 'https://one.example.com/']);
    remote.destroy(); other.destroy(); local.destroy();
    expect(f.stats().stops).toBe(0); // No window stops project daemons or the shared owned Host.
    f.electron.app.emit('before-quit'); expect(f.stats().stops).toBe(1);
  } finally { f.close(); }
});

test('Windows is remote-only: menu, direct calls and trusted IPC never start a local Host', async () => {
  const f = fixture('win32');
  try {
    await f.desktop.start(); const chooser = f.all[0];
    const item = f.stats().template[0].submenu.find(row => row.accelerator === 'CmdOrCtrl+Shift+N');
    expect(item.enabled).toBe(false); expect(item.label).toContain('不可用');
    await expect(f.desktop.openLocal()).rejects.toThrow('Windows 不会启动');
    await expect(f.invoke('lush:open-local', chooser)).rejects.toThrow('Windows 不会启动');
    const remote = await f.desktop.openRemote('https://one.example.com');
    expect(remote.options.webPreferences.additionalArguments).toEqual(['--lush-desktop-mode=remote']);
    await expect(f.invoke('lush:choose-project', remote)).rejects.toThrow('cannot choose');
    expect(f.stats().starts).toBe(0); expect(f.stats().picks).toBe(0);
    expect(f.all).toHaveLength(2);
  } finally { f.close(); }
});

test('connection preload reports Windows local support without exposing platform or generic IPC', () => {
  const source = fs.readFileSync(new URL('../../src/ui/desktop/connection-preload.cjs', import.meta.url), 'utf8');
  for (const platform of ['linux', 'darwin', 'win32']) {
    let bridge; const calls = [];
    vm.runInNewContext(source, { process: { platform }, require: name => {
      if (name !== 'electron') throw new Error('unexpected require');
      return { contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
        ipcRenderer: { invoke: (...args) => calls.push(args) } };
    } });
    expect(bridge.localSupported).toBe(platform !== 'win32');
    expect(bridge.platform).toBeUndefined(); expect(bridge.invoke).toBeUndefined();
    bridge.openRemote('https://one.example.com');
    expect(calls).toEqual([['lush:open-remote', 'https://one.example.com']]);
  }
});

test('IPC rejects foreign windows, subframes, wrong paths and redirects to another origin', async () => {
  const f = fixture();
  try {
    await f.desktop.start(); const remote = await f.desktop.openRemote('https://one.example.com');
    const handler = f.handlers.get('lush:notification-settings');
    expect(() => handler({ sender: { id: 999 }, senderFrame: {} })).toThrow('untrusted');
    expect(() => handler(f.event(remote, { url: 'https://one.example.com/' }))).toThrow('untrusted');
    for (const url of ['https://evil.test/', 'https://one.example.com.evil.test/', 'https://one.example.com/api/worker/1/report']) {
      remote.webContents.mainFrame.url = url;
      expect(() => handler(f.event(remote))).toThrow('untrusted');
    }
    remote.webContents.mainFrame.url = 'https://one.example.com/login';
    expect(handler(f.event(remote))).toMatchObject({ enabled: false });
    let blocked = 0; const event = { preventDefault: () => blocked++ };
    remote.webContents.emit('will-navigate', event, 'file:///tmp/secret');
    remote.webContents.emit('will-redirect', event, 'https://evil.test/', false, true);
    remote.webContents.emit('will-attach-webview', event);
    remote.webContents.session.emit('will-download', event);
    expect(blocked).toBe(4);
    remote.webContents.emit('will-navigate', event, 'https://one.example.com/p/abcdef0123456789/');
    expect(blocked).toBe(4);
  } finally { f.close(); }
});

test('directory picker rejects untrusted senders before opening a dialog and cancellation returns null', async () => {
  const f = fixture();
  try {
    await f.desktop.start();
    const chooser = f.all[0], local = await f.desktop.openLocal();
    const handler = f.handlers.get('lush:choose-project');
    await expect(handler({ sender: { id: 999 }, senderFrame: {} })).rejects.toThrow('untrusted');
    await expect(handler(f.event(local, { url: 'http://127.0.0.1:4318/' }))).rejects.toThrow('untrusted');
    await expect(f.invoke('lush:choose-project', chooser)).rejects.toThrow('untrusted');
    for (const url of ['https://evil.test/', 'http://127.0.0.1:4319/', 'http://127.0.0.1:4318/api/worker/1/report']) {
      local.webContents.mainFrame.url = url;
      await expect(f.invoke('lush:choose-project', local)).rejects.toThrow('untrusted');
    }
    local.webContents.mainFrame.url = 'http://127.0.0.1:4318/p/abcdef0123456789/';
    local.webContents.openHandler({ url: 'http://127.0.0.1:4318/p/abcdef0123456789/api/worker/1/report' });
    const preview = f.all.at(-1);
    expect(preview.options.webPreferences.preload).toBeUndefined();
    await expect(f.invoke('lush:choose-project', preview)).rejects.toThrow('untrusted');
    expect(f.stats().picks).toBe(0);
    expect(await f.invoke('lush:choose-project', local)).toBe('/local/project');
    expect(f.stats().picks).toBe(1);
    f.electron.dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    expect(await f.invoke('lush:choose-project', local)).toBeNull();
  } finally { f.close(); }
});

test('project popups remain owned and scoped; previews have no preload; external schemes are blocked', async () => {
  const f = fixture();
  try {
    await f.desktop.start(); const remote = await f.desktop.openRemote('https://one.example.com');
    expect(remote.webContents.openHandler({ url: 'https://one.example.com/p/abcdef0123456789/' })).toEqual({ action: 'deny' });
    const project = f.all.at(-1);
    expect(path.basename(project.options.webPreferences.preload)).toBe('preload.cjs');
    expect(project.options.webPreferences.partition).toBe(remote.options.webPreferences.partition);
    remote.webContents.openHandler({ url: 'https://one.example.com/p/abcdef0123456789/api/worker/1/report' });
    const preview = f.all.at(-1);
    expect(preview.options.webPreferences.preload).toBeUndefined();
    await expect(f.invoke('lush:notification-settings', preview)).rejects.toThrow('untrusted');
    for (const url of ['javascript:alert(1)', 'file:///tmp/secret', 'ssh://remote', 'https://secret@evil.test/']) remote.webContents.openHandler({ url });
    expect(f.external).toEqual([]);
    remote.webContents.openHandler({ url: 'https://docs.example.com/' });
    expect(f.external).toEqual(['https://docs.example.com/']);
    expect(f.stats().starts).toBe(0);
  } finally { f.close(); }
});

test('local UI IPC derives project identity, persists across ports and broadcasts only trusted local snapshots', async () => {
  const f = fixture(), a = 'aaaaaaaaaaaaaaaa', b = 'bbbbbbbbbbbbbbbb';
  try {
    await f.desktop.start(); const chooser = f.all[0], local = await f.desktop.openLocal();
    const handler = f.handlers.get('lush:ui-preferences');
    const remote = await f.desktop.openRemote('http://127.0.0.1:4318/');
    expect(() => handler(f.event(remote))).toThrow('remote');
    expect(() => handler(f.event(chooser))).toThrow('untrusted');
    expect(() => handler({ sender: { id: 999 }, senderFrame: {} })).toThrow('untrusted');
    expect(() => handler(f.event(local, { url: local.webContents.mainFrame.url }))).toThrow('untrusted');
    for (const url of ['http://127.0.0.1:9999/', 'http://127.0.0.1:4318/login', 'http://127.0.0.1:4318/api/docs/a']) {
      local.webContents.mainFrame.url = url; expect(() => handler(f.event(local))).toThrow('untrusted');
    }
    local.webContents.mainFrame.url = `http://127.0.0.1:4318/p/${a}/`;
    local.webContents.openHandler({ url: `http://127.0.0.1:4318/p/${b}/` });
    const other = f.all.at(-1);
    local.webContents.openHandler({ url: 'http://127.0.0.1:4318/api/docs/a' });
    const preview = f.all.at(-1);
    expect(() => handler(f.event(preview))).toThrow('untrusted');
    expect(() => handler(f.event(local), { name: 'theme', value: 'dark', project: b })).toThrow('invalid');
    await f.invoke('lush:ui-preferences', local, { name: 'theme', value: 'dark' });
    await f.invoke('lush:ui-preferences', local, { name: 'sidebarSort', value: 'id' });
    await f.invoke('lush:ui-preferences', other, { name: 'sidebarSort', value: 'updated' });
    expect(local.webContents.sent).toEqual(['lush:ui-preferences-changed', { project: a, revision: 3, values: { theme: 'dark', sidebarSort: 'id' } }]);
    expect(other.webContents.sent[1]).toMatchObject({ project: b, values: { theme: 'dark', sidebarSort: 'updated' } });
    expect(remote.webContents.sent).toBeUndefined(); expect(preview.webContents.sent).toBeUndefined();
    f.changeLocalUrl('http://127.0.0.1:9876/'); local.destroy();
    const reopened = await f.desktop.openLocal(); reopened.webContents.mainFrame.url = `http://127.0.0.1:9876/p/${a}/`;
    expect((await f.invoke('lush:ui-preferences', reopened)).values).toEqual({ theme: 'dark', sidebarSort: 'id' });
    await f.invoke('lush:ui-preferences', reopened, { reset: true });
    expect((await f.invoke('lush:ui-preferences', other)).values).toEqual({ sidebarSort: 'updated' });
    expect(() => handler(f.event(local))).toThrow('untrusted');
  } finally { f.close(); }
});

test('notice preference IPC shares a stable local identity and isolates canonical remote Hosts', async () => {
  const f = fixture();
  try {
    await f.desktop.start();
    const local = await f.desktop.openLocal();
    const defaults = { idle: { banner: true, system: true }, analysis: { banner: true, system: true }, failed: { banner: true, system: true } };
    expect(await f.invoke('lush:notice-preferences', local)).toEqual(defaults);
    const prefs = { ...defaults, idle: { banner: false, system: false } };
    expect(await f.invoke('lush:notice-preferences', local, prefs)).toEqual(prefs);
    f.changeLocalUrl('http://127.0.0.1:9876/');
    local.destroy();
    const reopened = await f.desktop.openLocal();
    expect(await f.invoke('lush:notice-preferences', reopened)).toEqual(prefs);
    const a = await f.desktop.openRemote('https://ONE.example.com:443');
    const b = await f.desktop.openRemote('https://two.example.com');
    const loopbackRemote = await f.desktop.openRemote('http://127.0.0.1:9876/');
    expect(await f.invoke('lush:notice-preferences', loopbackRemote)).toEqual(defaults);
    expect(await f.invoke('lush:notice-preferences', a, { analysis: { system: false } })).toEqual({ ...defaults, analysis: { banner: true, system: false } });
    const shared = await f.desktop.openRemote('https://one.example.com');
    shared.webContents.mainFrame.url = 'https://one.example.com/p/abcdef0123456789/';
    expect(await f.invoke('lush:notice-preferences', shared)).toEqual({ ...defaults, analysis: { banner: true, system: false } });
    expect(await f.invoke('lush:notice-preferences', b)).toEqual(defaults);
    expect(await f.invoke('lush:notification-settings', a)).toEqual({ enabled: false, supported: true });
    await f.invoke('lush:notification-settings', a, true);
    await f.invoke('lush:notification-settings', a, false);
    expect((await f.invoke('lush:notice-preferences', a)).analysis.system).toBe(false);
    f.electron.Notification.isSupported = () => false;
    expect(await f.invoke('lush:notice-preferences', reopened)).toEqual(prefs);
  } finally { f.close(); }
});

test('notice preference IPC never accepts caller identities, foreign frames, chooser or preview windows', async () => {
  const f = fixture();
  try {
    await f.desktop.start();
    const chooser = f.all[0], remote = await f.desktop.openRemote('https://one.example.com');
    const handler = f.handlers.get('lush:notice-preferences');
    for (const value of [undefined, { failed: { system: false }, host: 'https://two.example.com/', path: '/tmp/file' }]) {
      expect(() => handler({ sender: { id: 999 }, senderFrame: {} }, value)).toThrow('untrusted');
      expect(() => handler(f.event(remote, { url: 'https://one.example.com/' }), value)).toThrow('untrusted');
      expect(() => handler(f.event(chooser), value)).toThrow('untrusted');
      for (const url of ['https://evil.test/', 'https://one.example.com/api/docs/a']) {
        remote.webContents.mainFrame.url = url;
        expect(() => handler(f.event(remote), value)).toThrow('untrusted');
      }
    }
    remote.webContents.mainFrame.url = 'https://one.example.com/';
    remote.webContents.openHandler({ url: 'https://one.example.com/api/docs/a' });
    const preview = f.all.at(-1);
    expect(() => handler(f.event(preview), {})).toThrow('untrusted');
    const normalized = handler(f.event(remote), { failed: { system: false }, host: 'https://two.example.com/', path: '/tmp/file', __proto__: { idle: { system: false } } });
    expect(normalized).toEqual({ idle: { banner: true, system: true }, analysis: { banner: true, system: true }, failed: { banner: true, system: false } });
    const other = await f.desktop.openRemote('https://two.example.com');
    expect(handler(f.event(other)).failed.system).toBe(true);
    remote.destroy();
    expect(() => handler(f.event(remote), {})).toThrow('untrusted');
  } finally { f.close(); }
});

test('native notices are opt-in per Host and click focuses their source window, not another project', async () => {
  const f = fixture();
  try {
    await f.desktop.start(); const a = await f.desktop.openRemote('https://one.example.com');
    const b = await f.desktop.openRemote('https://two.example.com');
    const payload = { title: 'Lush', body: 'new question', tag: 'same-project-notice' };
    expect(await f.invoke('lush:notice', a, payload)).toBe(false);
    await f.invoke('lush:notification-settings', a, true);
    expect(await f.invoke('lush:notification-settings', b)).toMatchObject({ enabled: false });
    await f.invoke('lush:notification-settings', b, true);
    expect(await f.invoke('lush:notice', a, payload)).toBe(true);
    expect(await f.invoke('lush:notice', b, payload)).toBe(true);
    expect(f.notices[0].closed).not.toBe(true);
    f.notices[0].emit('click');
    expect(a.focused).toBe(true); expect(b.focused).toBe(false);
    expect(a.webContents.sent).toEqual(['lush:notice-open']);
    await expect(f.invoke('lush:notice', a, { ...payload, body: 'x'.repeat(4001) })).rejects.toThrow('invalid notification');
    await expect(f.invoke('lush:notification-settings', a, 'true')).rejects.toThrow('invalid notification');
    b.destroy(); expect(f.notices[1].closed).toBe(true);
    expect(await f.invoke('lush:notice', a, payload)).toBe(true);
    await f.invoke('lush:notification-settings', a, false);
    expect(f.notices.at(-1).closed).toBe(true);
  } finally { f.close(); }
});

test('native notification targets are numeric and retain the original project route', async () => {
  const f = fixture();
  try {
    await f.desktop.start(); const win = await f.desktop.openRemote('https://one.example.com');
    win.webContents.mainFrame.url = 'https://one.example.com/p/abcdef0123456789/';
    await f.invoke('lush:notification-settings', win, true);
    const payload = { title: 'Worker', body: 'idle', tag: 'lifecycle', notice_id: 50, task_id: 4 };
    expect(await f.invoke('lush:notice', win, payload)).toBe(true);
    win.webContents.mainFrame.url = 'https://one.example.com/p/1111111111111111/';
    f.notices[0].emit('click');
    expect(win.webContents.sent).toEqual(['lush:notice-open', { notice_id: 50, task_id: 4, pathname: '/p/abcdef0123456789/' }]);
    for (const value of [0, -1, '50', Number.MAX_SAFE_INTEGER + 1, 'https://evil.test/']) {
      await expect(f.invoke('lush:notice', win, { ...payload, notice_id: value })).rejects.toThrow('invalid notification target');
    }
    await expect(f.invoke('lush:notice', win, { ...payload, task_id: null })).rejects.toThrow('invalid notification target');
  } finally { f.close(); }
});

test('notification preload validates target and restores only a safe source project path', () => {
  const source = fs.readFileSync(new URL('../../src/ui/desktop/preload.cjs', import.meta.url), 'utf8');
  let click;
  const location = { pathname: '/p/abcdef0123456789/', hash: '' };
  vm.runInNewContext(source, { require: () => ({ contextBridge: { exposeInMainWorld: () => {} },
    ipcRenderer: { invoke: () => {}, on: (_name, handler) => { click = handler; } } }),
    process: { argv: [], platform: 'linux' }, window: { location } });
  click({}, { notice_id: 50, task_id: 4, pathname: location.pathname });
  expect(location.hash).toBe('#notice-50');
  click({}, { notice_id: 51, task_id: 4, pathname: '/p/1111111111111111/' });
  expect(location.href).toBe('/p/1111111111111111/#notice-51');
  for (const target of [{ notice_id: '50', task_id: 4, pathname: '/' }, { notice_id: 50, task_id: -1, pathname: '/' },
    { notice_id: 50, task_id: 4, pathname: '//evil.test' }, { notice_id: 50, task_id: 4, pathname: '/api/action' }]) {
    location.hash = ''; location.href = '';
    click({}, target); expect(location.hash).toBe(''); expect(location.href).toBe('');
  }
  click({}); expect(location.hash).toBe('#notices');
});

test('network failure closes only the failed window, preserves others and surfaces an explicit retry error', async () => {
  const f = fixture();
  try {
    await f.desktop.start(); const good = await f.desktop.openRemote('https://one.example.com');
    f.fail();
    await expect(f.desktop.openRemote('https://two.example.com')).rejects.toThrow('不会自动重发 Worker 操作');
    expect(f.all.at(-1).destroyed).toBe(true); expect(good.destroyed).toBe(false);
    await expect(f.desktop.openRemote('http://evil.test')).rejects.toThrow('HTTPS');
    expect(f.stats().starts).toBe(0);
    f.desktop.dispose();
    await expect(f.desktop.openRemote('https://three.example.com')).rejects.toThrow('退出');
  } finally { f.close(); }
});

test('early activation cannot create a window before Electron is ready or after quit', async () => {
  const f = fixture();
  try {
    let release;
    f.electron.app.whenReady = () => new Promise(resolve => { release = resolve; });
    const starting = f.desktop.start();
    f.electron.app.emit('second-instance'); f.electron.app.emit('activate');
    expect(f.all).toHaveLength(0);
    release(); await starting; expect(f.all).toHaveLength(1);
    f.electron.app.emit('before-quit'); f.all[0].destroy();
    f.electron.app.emit('activate'); f.electron.app.emit('second-instance');
    expect(f.all).toHaveLength(1);
  } finally { f.close(); }
});

test('sandboxed preloads expose only mode-specific capabilities, never a generic IPC channel', () => {
  const source = fs.readFileSync(new URL('../../src/ui/desktop/preload.cjs', import.meta.url), 'utf8');
  for (const mode of ['local', 'remote', 'unknown']) {
    let bridge, exposed; const calls = [];
    vm.runInNewContext(source, { require: name => {
      if (name !== 'electron') throw new Error('unexpected require');
      return { contextBridge: { exposeInMainWorld: (name, value) => { exposed = name; bridge = value; } },
        ipcRenderer: { invoke: (...args) => calls.push(args), on: () => {} } };
    }, process: { argv: [`--lush-desktop-mode=${mode}`], platform: 'linux' }, window: { location: {} } });
    expect(exposed).toBe('lushDesktop'); expect(bridge.invoke).toBeUndefined();
    expect(Boolean(bridge.chooseProject)).toBe(mode === 'local');
    bridge.notifyNotice({ title: 'x' }); expect(calls[0][0]).toBe('lush:notice');
    bridge.noticePreferences();
    const prefs = { idle: { banner: false, system: true } };
    bridge.noticePreferences(prefs);
    bridge.notificationSettings(); bridge.notificationSettings(true);
    expect(calls.slice(1)).toEqual([['lush:notice-preferences', undefined], ['lush:notice-preferences', prefs],
      ['lush:notification-settings', undefined], ['lush:notification-settings', true]]);
    if (mode === 'local') {
      bridge.readPreferences(); bridge.writePreference('theme', 'dark'); bridge.resetPreferences();
      expect(calls.slice(-3)).toEqual([['lush:ui-preferences'], ['lush:ui-preferences', { name: 'theme', value: 'dark' }], ['lush:ui-preferences', { reset: true }]]);
      expect(() => bridge.onPreferencesChanged('not a callback')).toThrow();
    }
    expect(Object.keys(bridge).sort()).toEqual([...(mode === 'local' ? ['chooseProject', 'readPreferences', 'writePreference', 'resetPreferences', 'onPreferencesChanged'] : []),
      'mode', 'noticePreferences', 'notificationSettings', 'notifyNotice', 'platform'].sort());
  }
});
