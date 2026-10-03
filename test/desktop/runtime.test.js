import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { desktopFixture as fixture } from './runtime-fixture.js';

test('SSH initialization errors preserve local and URL workflows and are reported only on SSH use', async () => {
  const f = fixture('linux', null, 'SSH 连接记录损坏；未重置记录');
  try {
    await f.desktop.start(); const chooser = f.all[0];
    await expect(f.invoke('lush:ssh-inspect', chooser, { alias: 'server' })).rejects.toThrow('未重置记录');
    await f.desktop.openLocal(); await f.desktop.openRemote('https://existing.example.com');
    expect(f.stats().starts).toBe(1); expect(f.all).toHaveLength(3);
  } finally { f.close(); }
});

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
    bridge.sshList(); bridge.sshInspect({ alias: 'server' });
    bridge.sshConnect({ confirmation: 'opaque', install: true }); bridge.sshCancel(); bridge.sshDisconnect('record-id');
    expect(calls.slice(1)).toEqual([['lush:ssh-list'], ['lush:ssh-inspect', { alias: 'server' }],
      ['lush:ssh-connect', { confirmation: 'opaque', install: true }], ['lush:ssh-cancel'], ['lush:ssh-disconnect', 'record-id']]);
    expect(Object.keys(bridge).sort()).toEqual(['localSupported', 'list', 'openLocal', 'openRemote', 'remove',
      'sshList', 'sshInspect', 'sshConnect', 'sshCancel', 'sshDisconnect'].sort());
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


function mockSSH() {
  const inspected = [], connected = [], disconnected = [];
  const state = { records: [], needsInstall: true, inspectGate: null, connectGate: null, disposals: 0, failure: null };
  const manager = {
    list: async () => state.records,
    inspect: async profile => {
      inspected.push(profile);
      if (state.inspectGate) await state.inspectGate;
      if (state.failure) throw new Error(state.failure);
      return { profile, ready: !state.needsInstall, requiresInstall: state.needsInstall,
        plan: { target: 'linux-x64', install_dir: '/home/remote/.local/share/lush', bun: 'private', version: '0.2.0' }, warnings: ['Agent authentication is not verified'] };
    },
    connect: async (profile, options) => {
      connected.push({ profile, options });
      if (state.connectGate) await state.connectGate;
      state.records = [{ ...profile, connected: true }];
      return { profile, url: 'http://127.0.0.1:14318/' };
    },
    disconnect: async id => { disconnected.push(id); state.records = state.records.map(row => row.id === id ? { ...row, connected: false } : row); },
    dispose: () => { state.disposals++; },
  };
  return { manager, state, inspected, connected, disconnected };
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('SSH first install needs a saved preflight and single-use confirmation; managed URLs never become ordinary shortcuts', async () => {
  const ssh = mockSSH(), f = fixture('win32', ssh.manager);
  try {
    await f.desktop.start(); const chooser = f.all[0];
    await expect(f.invoke('lush:ssh-connect', chooser, { confirmation: 'made-up', install: true })).rejects.toThrow('先预检');
    expect(ssh.connected).toEqual([]);
    const inspection = await f.invoke('lush:ssh-inspect', chooser, { alias: 'my-server' });
    expect(inspection.profile.id).toMatch(/^[a-f0-9]{32}$/);
    expect(inspection.requiresInstall).toBe(true); expect(inspection.plan.bun).toBe('private');
    await expect(f.invoke('lush:ssh-connect', chooser, { confirmation: inspection.confirmation, install: false })).rejects.toThrow('明确确认');
    await expect(f.invoke('lush:ssh-connect', chooser, { confirmation: inspection.confirmation, install: true, profile: { alias: 'evil' } })).rejects.toThrow('先预检');
    const connected = await f.invoke('lush:ssh-connect', chooser, { confirmation: inspection.confirmation, install: true });
    expect(ssh.connected).toEqual([{ profile: inspection.profile, options: { install: true } }]);
    expect(connected.profile).toEqual(inspection.profile);
    expect(await f.invoke('lush:connections-list', chooser)).toEqual([]);
    expect(await f.invoke('lush:ssh-list', chooser)).toEqual([{ ...inspection.profile, connected: true }]);
    const remote = f.all[1];
    expect(remote.options.title).toContain('SSH my-server');
    expect(remote.options.webPreferences.partition).toStartWith('persist:lush-ssh-');
    expect(remote.options.webPreferences.additionalArguments).toEqual(['--lush-desktop-mode=remote']);
    expect(f.stats().starts).toBe(0);
    await expect(f.invoke('lush:ssh-connect', chooser, { confirmation: inspection.confirmation, install: true })).rejects.toThrow('先预检');
    const repeated = await f.invoke('lush:ssh-inspect', chooser, { alias: 'my-server' });
    expect(repeated.profile).toEqual(inspection.profile); // Typed aliases reuse the persisted identity too.
    await f.invoke('lush:ssh-cancel', chooser);
  } finally { f.close(); }
});

test('SSH identities come from saved records or the main process and cannot be rebound to another alias', async () => {
  const ssh = mockSSH(), f = fixture('linux', ssh.manager);
  try {
    await f.desktop.start(); const chooser = f.all[0];
    const id = '0123456789abcdef0123456789abcdef';
    ssh.state.records = [{ id, alias: 'saved-server', connected: false }];
    const existing = await f.invoke('lush:ssh-inspect', chooser, { alias: 'saved-server' });
    expect(existing.profile.id).toBe(id);
    const before = ssh.inspected.length;
    await expect(f.invoke('lush:ssh-inspect', chooser, { id, alias: 'different-server' })).rejects.toThrow('不能替换服务器');
    await expect(f.invoke('lush:ssh-inspect', chooser, { id: 'renderer-invented-id', alias: 'new-server' })).rejects.toThrow('未知 SSH 连接身份');
    expect(ssh.inspected).toHaveLength(before);
    const generated = await f.invoke('lush:ssh-inspect', chooser, { alias: 'new-server' });
    expect(generated.profile.id).toMatch(/^[a-f0-9]{32}$/);
    await f.invoke('lush:ssh-cancel', chooser);
    const repeated = await f.invoke('lush:ssh-inspect', chooser, generated.profile);
    expect(repeated.profile).toEqual(generated.profile); // Unsaved, main-generated preflight IDs can be inspected again safely.
    await expect(f.invoke('lush:ssh-inspect', chooser, { ...generated.profile, alias: 'replacement-server' })).rejects.toThrow('不能替换服务器');
  } finally { f.close(); }
});

test('every SSH IPC rejects workspaces, previews, foreign senders and chooser subframes', async () => {
  const ssh = mockSSH(), f = fixture('linux', ssh.manager);
  try {
    await f.desktop.start(); const chooser = f.all[0], remote = await f.desktop.openRemote('https://server.example.com');
    remote.webContents.openHandler({ url: 'https://server.example.com/api/docs/example' });
    const preview = f.all.at(-1);
    for (const name of ['lush:ssh-list', 'lush:ssh-inspect', 'lush:ssh-connect', 'lush:ssh-cancel', 'lush:ssh-disconnect']) {
      const handler = f.handlers.get(name);
      for (const event of [f.event(remote), f.event(preview), f.event(chooser, { url: chooser.webContents.mainFrame.url }), { sender: { id: 999 }, senderFrame: {} }]) {
        await expect(Promise.resolve().then(() => handler(event, { alias: 'server', install: true }))).rejects.toThrow('untrusted');
      }
    }
    expect(ssh.inspected).toEqual([]); expect(ssh.connected).toEqual([]); expect(ssh.disconnected).toEqual([]);
  } finally { f.close(); }
});

test('SSH cancellation revokes plans and prevents late checks or connections from opening windows', async () => {
  const ssh = mockSSH(), f = fixture('linux', ssh.manager);
  try {
    await f.desktop.start(); const chooser = f.all[0];
    const checked = await f.invoke('lush:ssh-inspect', chooser, { alias: 'server' });
    await f.invoke('lush:ssh-cancel', chooser);
    await expect(f.invoke('lush:ssh-connect', chooser, { confirmation: checked.confirmation, install: true })).rejects.toThrow('先预检');
    const gate = deferred(); ssh.state.inspectGate = gate.promise;
    const pendingCheck = f.invoke('lush:ssh-inspect', chooser, { alias: 'server' });
    const failedCheck = pendingCheck.catch(error => error);
    await expect(f.invoke('lush:ssh-inspect', chooser, { alias: 'other' })).rejects.toThrow('正在进行');
    await f.invoke('lush:ssh-cancel', chooser); gate.resolve();
    expect((await failedCheck).message).toContain('已取消');
    expect(ssh.disconnected).toContain(ssh.inspected.at(-1).id);
    ssh.state.inspectGate = null;
    const next = await f.invoke('lush:ssh-inspect', chooser, { alias: 'server' });
    const connectGate = deferred(); ssh.state.connectGate = connectGate.promise;
    const connecting = f.invoke('lush:ssh-connect', chooser, { confirmation: next.confirmation, install: true });
    const failedConnect = connecting.catch(error => error);
    await f.invoke('lush:ssh-cancel', chooser); connectGate.resolve();
    expect((await failedConnect).message).toContain('已取消');
    expect(f.all).toHaveLength(1);
    expect(ssh.disconnected).toContain(next.profile.id);
  } finally { f.close(); }
});

test('SSH chooser reload and close invalidate pending authorizations while workspace close keeps its tunnel', async () => {
  const ssh = mockSSH(), f = fixture('linux', ssh.manager);
  try {
    await f.desktop.start(); const chooser = f.all[0];
    const inspection = await f.invoke('lush:ssh-inspect', chooser, { alias: 'server' });
    chooser.webContents.emit('did-start-navigation', {}, chooser.webContents.mainFrame.url, false, true);
    await expect(f.invoke('lush:ssh-connect', chooser, { confirmation: inspection.confirmation, install: true })).rejects.toThrow('先预检');
    ssh.state.needsInstall = false;
    const next = await f.invoke('lush:ssh-inspect', chooser, { alias: 'server' });
    await f.invoke('lush:ssh-connect', chooser, { confirmation: next.confirmation, install: true });
    expect(ssh.connected.at(-1).options.install).toBe(false); // Cannot use the flag to install without an install plan.
    const workspace = f.all[1], partition = workspace.options.webPreferences.partition;
    workspace.webContents.openHandler({ url: 'http://127.0.0.1:14318/p/abcdef0123456789/' });
    expect(f.all.at(-1).options.webPreferences.partition).toBe(partition);
    workspace.destroy(); expect(ssh.disconnected).toEqual([]);
    const ordinary = await f.desktop.openRemote('http://127.0.0.1:14318/');
    expect(ordinary.options.webPreferences.partition).not.toBe(partition);
    await f.invoke('lush:ssh-disconnect', chooser, next.profile.id);
    expect(ssh.disconnected).toContain(next.profile.id);
    await expect(f.invoke('lush:ssh-disconnect', chooser, 'not-owned')).rejects.toThrow('未知');
    const beforeClose = await f.invoke('lush:ssh-inspect', chooser, { alias: 'server' });
    chooser.destroy();
    const freshChooser = f.desktop.showConnections();
    await expect(f.invoke('lush:ssh-connect', freshChooser, { confirmation: beforeClose.confirmation, install: false })).rejects.toThrow('先预检');
    f.desktop.dispose(); f.desktop.dispose();
    expect(ssh.state.disposals).toBe(1); expect(f.stats().stops).toBe(1);
  } finally { f.close(); }
});

test('SSH closed chooser rejects late inspection and strict profile validation does not pass commands to the manager', async () => {
  const ssh = mockSSH(), f = fixture('linux', ssh.manager);
  try {
    await f.desktop.start(); const chooser = f.all[0];
    for (const value of [null, { alias: '-oProxyCommand=evil' }, { alias: 'server;echo secret' }, { alias: 'user@server' }, { alias: 'server', password: 'secret' }]) {
      await expect(f.invoke('lush:ssh-inspect', chooser, value)).rejects.toThrow('Host 别名');
    }
    expect(ssh.inspected).toEqual([]);
    const gate = deferred(); ssh.state.inspectGate = gate.promise;
    const pending = f.invoke('lush:ssh-inspect', chooser, { alias: 'server' });
    const failed = pending.catch(error => error);
    chooser.destroy(); gate.resolve();
    expect((await failed).message).toContain('已取消');
    expect(ssh.disconnected).toHaveLength(1); expect(f.all).toHaveLength(1);
  } finally { f.close(); }
});
