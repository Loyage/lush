import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createDesktop } from '../../src/ui/desktop/runtime.js';

// Shared simulated Electron shell. It does not render pages or prove native desktop behavior.
export function desktopFixture(platform = 'linux', sshManager = null, sshError = null, sshConfig = () => ({ hosts: [], warnings: [] })) {
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
  const desktop = createDesktop({ electron, userData: dir, platform, sshManager, sshError, sshConfig, localHost: { start: async () => { starts++; return localUrl; }, stop: () => { stops++; } } });
  const event = (win, frame = win.webContents.mainFrame) => ({ sender: win.webContents, senderFrame: frame });
  const invoke = async (name, win, ...args) => handlers.get(name)(event(win), ...args);
  return { desktop, all, notices, errors, external, event, handlers, invoke, electron,
    stats: () => ({ starts, stops, picks, template }), fail: () => { failNext = true; },
    changeLocalUrl: url => { localUrl = url; },
    close: () => { desktop.dispose(); for (const win of all) if (!win.isDestroyed()) win.destroy(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
