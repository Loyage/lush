import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const MAX_RECENT = 12;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const PROJECT_ID = '[a-f0-9]{16}';
const ENVIRONMENT_ID = '(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})';
const LOCAL_ROOT = new RegExp(`^/(?:$|login$|p/(${PROJECT_ID})(?:/|/login)?$)`);
const GATEWAY_ROOT = new RegExp(`^/e/(${ENVIRONMENT_ID})(?:/p/(${PROJECT_ID}))?/?$`);
const GATEWAY_NOTICE_KEY = new RegExp(`^gateway:[a-f0-9]{64}:${ENVIRONMENT_ID}$`);

// Only serialized UI preferences, never renderer-selected storage keys or paths.
const SHARED_UI = new Set(['theme', 'markdown', 'reduceMotion', 'polling', 'toastDuration', 'transcriptOrder']);
const PROJECT_UI = new Set(['sidebarSort', 'collapsed', 'filters', 'taskGraphStatuses', 'taskGraphMinimal', 'taskGraphCollapsed']);
const UI_ENUMS = { theme: ['system', 'light', 'dark'], markdown: ['0', '1'], reduceMotion: ['0', '1'],
  polling: ['fast', 'standard', 'power'], toastDuration: ['short', 'standard', 'long'], transcriptOrder: ['asc', 'desc'],
  sidebarSort: ['smart', 'updated', 'id'], taskGraphMinimal: ['0', '1'] };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function uiValue(name, value) {
  if ((!SHARED_UI.has(name) && !PROJECT_UI.has(name)) || typeof value !== 'string' || value.length > 65536) throw new Error('invalid UI preference');
  if (Object.hasOwn(UI_ENUMS, name)) {
    if (!UI_ENUMS[name].includes(value)) throw new Error('invalid UI preference value');
  } else {
    const parsed = JSON.parse(value);
    if (name === 'filters') {
      const fields = { tasks: ['status', 'role', 'integration', 'mine', 'text'], specs: ['status', 'planner', 'role', 'text'], intents: ['gate', 'status', 'text'] };
      if (!object(parsed) || Object.keys(parsed).some(section => !Object.hasOwn(fields, section))) throw new Error('invalid UI filters');
      for (const [section, row] of Object.entries(parsed)) {
        if (!object(row) || Object.keys(row).some(key => !fields[section].includes(key))) throw new Error('invalid UI filters');
        for (const [key, item] of Object.entries(row)) {
          if (key === 'mine' ? typeof item !== 'boolean' : !(typeof item === 'string' || (section === 'tasks' && ['status', 'role'].includes(key) && Array.isArray(item) && item.every(v => typeof v === 'string')))) throw new Error('invalid UI filters');
        }
      }
    } else if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string' || (name === 'taskGraphCollapsed' && Number.isSafeInteger(item) && item > 0))) throw new Error('invalid UI preference collection');
  }
  return value;
}
function uiProject(id) {
  if (id !== null && (typeof id !== 'string' || !/^[a-f0-9]{16}$/.test(id))) throw new Error('invalid UI preference project');
}
function uiProjection(source, names) {
  const out = {};
  for (const name of names) if (object(source) && Object.hasOwn(source, name)) {
    try { out[name] = uiValue(name, source[name]); } catch { /* Corrupt individual preferences default, not arbitrary metadata. */ }
  }
  return out;
}

// Build a fresh whitelist projection: no coercion, inherited keys or arbitrary metadata.
function normalizeNoticePreferences(value) {
  const object = entry => entry !== null && typeof entry === 'object' && !Array.isArray(entry);
  return Object.fromEntries(['idle', 'analysis', 'failed'].map(type => {
    const row = object(value) && Object.hasOwn(value, type) && object(value[type]) ? value[type] : null;
    return [type, Object.fromEntries(['banner', 'system'].map(channel => [channel,
      row && Object.hasOwn(row, channel) && typeof row[channel] === 'boolean' ? row[channel] : true]))];
  }));
}

/** A Host root, never a project path, credential-bearing URL or arbitrary web scheme. */
export function normalizeHostUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('请输入 Host 根地址');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('请输入完整 Host 地址，例如 https://lush.example.com'); }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error('Host 地址只允许 HTTP(S)，不得包含账号或密码');
  }
  if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) {
    throw new Error('远程 Host 必须使用 HTTPS；SSH 隧道请使用 http://127.0.0.1:端口');
  }
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('请输入 Host 根地址，不要包含项目路径、查询参数或片段');
  return `${url.origin}/`;
}

export function sameHost(value, hostUrl) {
  try {
    const url = new URL(value), host = new URL(hostUrl);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.origin === host.origin;
  } catch { return false; }
}

export function sessionPartition(mode, hostUrl) {
  return mode === 'local' ? 'persist:lush-local' : `persist:lush-remote-${createHash('sha256').update(normalizeHostUrl(hostUrl)).digest('hex')}`;
}

export function workspaceIdentity(value) {
  try {
    const pathname = new URL(value).pathname;
    const gateway = GATEWAY_ROOT.exec(pathname);
    if (gateway) return { type: 'gateway', environment: gateway[1], project: gateway[2] || null, route: gateway[2] ? 'project' : 'root' };
    const local = LOCAL_ROOT.exec(pathname);
    if (!local) return null;
    return { type: 'host', environment: null, project: local[1] || null,
      route: pathname.endsWith('/login') || pathname === '/login' ? 'login' : local[1] ? 'project' : 'root' };
  } catch { return null; }
}

export function isProjectPage(value) { return workspaceIdentity(value) !== null; }

/** Native-notice state for gateway pages is isolated by both entry Host and environment identity. */
export function gatewayNoticeKey(hostUrl, environment) {
  if (typeof environment !== 'string' || !new RegExp(`^${ENVIRONMENT_ID}$`).test(environment)) throw new Error('invalid gateway environment identity');
  return `gateway:${createHash('sha256').update(normalizeHostUrl(hostUrl)).digest('hex')}:${environment}`;
}

function normalizeNoticeKey(key) {
  if (key === 'local' || typeof key === 'string' && GATEWAY_NOTICE_KEY.test(key)) return key;
  return normalizeHostUrl(key);
}

/** Client metadata / managed UI only; login cookies belong to Electron's per-Host session partition. */
export class ConnectionStore {
  constructor(dir) { this.dir = dir; this.file = path.join(dir, 'connections.json'); }
  read() {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { raw = {}; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
    const recent = [];
    for (const entry of Array.isArray(raw.recent) ? raw.recent : []) {
      try { const url = normalizeHostUrl(entry); if (!recent.includes(url) && recent.length < MAX_RECENT) recent.push(url); }
      catch { /* Invalid or obsolete endpoints must not become trusted origins. */ }
    }
    const notifications = {};
    if (raw.notifications && typeof raw.notifications === 'object') {
      for (const [key, enabled] of Object.entries(raw.notifications)) {
        if (typeof enabled !== 'boolean') continue;
        try { notifications[normalizeNoticeKey(key)] = enabled; } catch { /* ignore */ }
      }
    }
    // Preserve the old desktop preference for local windows only, never for new remote Hosts.
    if (!Object.hasOwn(notifications, 'local')) {
      try { notifications.local = JSON.parse(fs.readFileSync(path.join(this.dir, 'notifications.json'), 'utf8')).enabled === true; }
      catch { notifications.local = false; }
    }
    const noticeChannels = {};
    if (raw.noticeChannels && typeof raw.noticeChannels === 'object' && !Array.isArray(raw.noticeChannels)) {
      for (const [key, value] of Object.entries(raw.noticeChannels)) {
        try { noticeChannels[normalizeNoticeKey(key)] = normalizeNoticePreferences(value); }
        catch { /* Invalid endpoints must not become preference identities. */ }
      }
    }
    return { version: 1, recent, notifications, noticeChannels };
  }
  write(state) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, this.file); }
    finally { fs.rmSync(tmp, { force: true }); }
  }
  // A separate file keeps failed UI reads/writes from altering connection or notification records.
  readUiPreferences() {
    const file = path.join(this.dir, 'ui-preferences.json');
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { version: 1, revision: 0, shared: {}, projects: {} }; throw error; }
    if (!object(raw) || raw.version !== 1 || !Number.isSafeInteger(raw.revision) || raw.revision < 0 || !object(raw.shared) || !object(raw.projects)) throw new Error('invalid stored UI preferences');
    const projects = {};
    for (const [id, values] of Object.entries(raw.projects)) if (/^[a-f0-9]{16}$/.test(id)) projects[id] = uiProjection(values, PROJECT_UI);
    return { version: 1, revision: raw.revision, shared: uiProjection(raw.shared, SHARED_UI), projects };
  }
  uiPreferences(project, change) {
    uiProject(project);
    if (change !== undefined && (!object(change) || (change.reset === true
      ? !Object.hasOwn(change, 'reset') || Object.keys(change).length !== 1
      : Object.keys(change).length !== 2 || !Object.hasOwn(change, 'name') || !Object.hasOwn(change, 'value')))) throw new Error('invalid UI preference change');
    if (change && change.reset !== true) {
      uiValue(change.name, change.value);
      if (PROJECT_UI.has(change.name) && project === null) throw new Error('project UI preference requires a project page');
    }
    const state = this.readUiPreferences(); // Non-ENOENT failures must never be turned into an empty write.
    if (change) {
      if (change.reset === true) { state.shared = {}; if (project !== null) delete state.projects[project]; }
      else {
        const values = SHARED_UI.has(change.name) ? state.shared : (state.projects[project] ??= {});
        values[change.name] = change.value;
      }
      state.revision++;
      const file = path.join(this.dir, 'ui-preferences.json'), tmp = `${file}.${randomUUID()}.tmp`;
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      try { fs.writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, file); }
      finally { fs.rmSync(tmp, { force: true }); }
    }
    return { project, revision: state.revision, values: { ...state.shared, ...(project === null ? {} : state.projects[project]) } };
  }
  list() { return this.read().recent; }
  remember(value) {
    const url = normalizeHostUrl(value), state = this.read();
    state.recent = [url, ...state.recent.filter(entry => entry !== url)].slice(0, MAX_RECENT);
    this.write(state); return url;
  }
  remove(value) {
    const url = normalizeHostUrl(value), state = this.read();
    state.recent = state.recent.filter(entry => entry !== url);
    this.write(state); // Forgetting a shortcut deliberately does not erase cookies or running windows.
  }
  noticePreferences(key, value) {
    key = normalizeNoticeKey(key);
    const state = this.read();
    if (value !== undefined) {
      state.noticeChannels[key] = normalizeNoticePreferences(value);
      this.write(state);
    }
    return normalizeNoticePreferences(state.noticeChannels[key]);
  }
  enabled(key) { return this.read().notifications[key] === true; }
  setEnabled(key, enabled) {
    if (typeof enabled !== 'boolean') throw new Error('invalid notification preference');
    key = normalizeNoticeKey(key);
    const state = this.read(); state.notifications[key] = enabled; this.write(state);
  }
}
