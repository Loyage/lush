import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const MAX_RECENT = 12;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

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

export function isProjectPage(value) {
  try { return /^(?:\/|\/login|\/p\/[a-f0-9]{16}\/?|\/p\/[a-f0-9]{16}\/login)$/.test(new URL(value).pathname); }
  catch { return false; }
}

/** Metadata only; login cookies belong to Electron's per-Host session partition. */
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
        try { notifications[key === 'local' ? key : normalizeHostUrl(key)] = enabled; } catch { /* ignore */ }
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
        try { noticeChannels[key === 'local' ? key : normalizeHostUrl(key)] = normalizeNoticePreferences(value); }
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
    key = key === 'local' ? key : normalizeHostUrl(key);
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
    key = key === 'local' ? key : normalizeHostUrl(key);
    const state = this.read(); state.notifications[key] = enabled; this.write(state);
  }
}
