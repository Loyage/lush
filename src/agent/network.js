import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { isPlainObject, LushError } from '../core/types.js';
import { outboundFetch } from './network-transport.js';
import { configurationScope, settingsConfigurationScope, scopedConfiguration, withConfigurationWriteLock } from '../core/device-config.js';

const MAX_BYTES = 65536;
const PROXY_NAMES = ['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
const defaults = () => ({ version: 1, mode: 'inherit', proxy_url: null, no_proxy: [], proxy_auth: null });
const invalid = () => new LushError('Invalid outbound network settings or private file');
const verify = condition => { if (!condition) throw invalid(); };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const owner = stat => typeof process.getuid === 'function' && stat.uid === process.getuid();
const privateFile = stat => stat.isFile() && owner(stat) && (stat.mode & 0o777) === 0o600 && stat.nlink === 1 && stat.size <= MAX_BYTES;
function fields(value, names) { verify(isPlainObject(value) && Object.keys(value).every(key => names.includes(key))); }
function proxyURL(value, credentials = false) {
  verify(typeof value === 'string' && value.length > 0 && value.length <= 8192 && /^https?:\/\//.test(value) && !/[\s\\\x00-\x1f\x7f]/.test(value));
  let url; try { url = new URL(value); } catch { throw invalid(); }
  verify(['http:', 'https:'].includes(url.protocol) && !url.search && !url.hash && url.pathname === '/' && (credentials || !url.username && !url.password));
  return url;
}
function rule(value) {
  verify(typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s\x00-\x1f\x7f/@?#]/.test(value));
  if (value === '*') return { any: true };
  let host = value.toLowerCase(), port = null;
  if (host.startsWith('[')) {
    const match = /^\[([^\]]+)\](?::(\d+))?$/.exec(host); verify(match && isIP(match[1]) === 6);
    host = match[1]; port = match[2] || null;
  } else if (!isIP(host)) {
    const match = /^(.*?)(?::(\d+))?$/.exec(host); host = match[1]; port = match[2] || null;
    if (host.startsWith('*.')) host = host.slice(2);
    else if (host.startsWith('.')) host = host.slice(1);
    host = host.replace(/\.$/, '');
    verify(host.length && host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)));
  }
  verify(!port || Number(port) >= 1 && Number(port) <= 65535);
  if (isIP(host) === 6) host = new URL(`http://[${host}]`).hostname.slice(1, -1);
  return { host, port: port ? String(Number(port)) : null };
}
function normalize(value, previous = null) {
  fields(value, ['version', 'mode', 'proxy_url', 'no_proxy', 'proxy_auth']);
  verify(value.version === 1 && ['inherit', 'direct', 'proxy'].includes(value.mode));
  verify(Array.isArray(value.no_proxy) && value.no_proxy.length <= 128);
  const no_proxy = [...new Set(value.no_proxy.map(item => { rule(item); return item.toLowerCase(); }))];
  let proxy_url = null, proxy_auth = null;
  if (value.mode === 'proxy') {
    proxy_url = proxyURL(value.proxy_url).origin;
    if (value.proxy_auth === undefined && previous?.proxy_url === proxy_url) proxy_auth = previous.proxy_auth;
    else if (value.proxy_auth !== undefined && value.proxy_auth !== null) {
      fields(value.proxy_auth, ['username', 'password']);
      const { username, password } = value.proxy_auth;
      verify(typeof username === 'string' && username.length > 0 && username.length <= 1024 && !/[\x00-\x1f\x7f:]/.test(username));
      verify(typeof password === 'string' && password.length <= 4096 && !/[\x00-\x1f\x7f]/.test(password));
      proxy_auth = { username, password };
    }
  } else verify(value.proxy_url === null || value.proxy_url === undefined || value.proxy_url === '');
  return { version: 1, mode: value.mode, proxy_url, no_proxy, proxy_auth };
}
function location(config, create = false) {
  verify(process.platform !== 'win32' && typeof config?.home === 'string' && path.isAbsolute(config.home));
  const home = path.resolve(config.home);
  if (!fs.existsSync(home)) { if (!create) return null; fs.mkdirSync(home, { mode: 0o700 }); }
  const stat = fs.lstatSync(home);
  verify(stat.isDirectory() && !stat.isSymbolicLink() && owner(stat) && (stat.mode & 0o777) === 0o700 && fs.realpathSync(home) === home);
  return { home, stat, file: path.join(home, 'network.json') };
}
function storedLocal(config) {
  // Minimal legacy metadata/test configs have no persistence home; there is no file to load.
  if (!config?.home) return defaults();
  let fd;
  try {
    const loc = location(config); if (!loc) return defaults();
    try { fd = fs.openSync(loc.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
    catch (error) { if (error.code === 'ENOENT') return defaults(); throw error; }
    const stat = fs.fstatSync(fd); verify(privateFile(stat));
    const source = fs.readFileSync(fd, 'utf8'), after = fs.fstatSync(fd);
    verify(Buffer.byteLength(source) <= MAX_BYTES && same(stat, after) && stat.size === after.size && stat.mtimeMs === after.mtimeMs
      && same(stat, fs.lstatSync(loc.file)) && same(loc.stat, location(config).stat));
    const data = JSON.parse(source); return normalize(data);
  } catch { throw invalid(); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function networkSelection(config, scope) {
  scope = settingsConfigurationScope(config, scope);
  if (scope === 'device') {
    const selected = scopedConfiguration(config, scope), loc = location(selected);
    let exists = false;
    if (loc) try { fs.lstatSync(loc.file); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { data: storedLocal(selected), source: exists ? 'device' : 'default', overridden: false };
  }
  const loc = config?.home ? location(config) : null;
  if (loc) try { fs.lstatSync(loc.file); return { data: storedLocal(config), source: 'project', overridden: true }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (config?.deviceHome) return networkSelection(config, 'device');
  return { data: storedLocal(config), source: 'default', overridden: false };
}
function stored(config, scope) { return networkSelection(config, scope).data; }
export function networkConfigurationScope(config, scope) {
  scope = settingsConfigurationScope(config, scope);
  const selected = networkSelection(config, scope);
  return configurationScope(config, scope, selected.source, selected.overridden);
}
const publicView = data => ({ version: 1, mode: data.mode, proxy_url: data.proxy_url, no_proxy: [...data.no_proxy], has_proxy_auth: !!data.proxy_auth });
export function readNetworkConfiguration(config, scope) {
  scope = settingsConfigurationScope(config, scope);
  const selected = networkSelection(config, scope), view = publicView(selected.data);
  return config?.deviceHome ? { ...view, configuration_scope: configurationScope(config, scope, selected.source, selected.overridden) } : view;
}
export function saveNetworkConfiguration(config, value, scope) {
  scope = settingsConfigurationScope(config, scope);
  try {
    return withConfigurationWriteLock(config, scope, lock => {
      const previous = stored(config, scope);
      const saved = saveLocalNetworkConfiguration(scopedConfiguration(config, scope), value, previous, lock);
      return config?.deviceHome ? { ...saved, configuration_scope: networkConfigurationScope(config, scope) } : saved;
    });
  } catch { throw invalid(); }
}
export function clearNetworkOverride(config) {
  settingsConfigurationScope(config, 'project');
  try {
    return withConfigurationWriteLock(config, 'project', lock => {
      storedLocal(config); const loc = location(config); lock.assert(); fs.rmSync(loc.file, { force: true });
      return readNetworkConfiguration(config);
    });
  } catch { throw invalid(); }
}
function saveLocalNetworkConfiguration(config, value, inherited, writeLock) {
  let temporary, fd, lock, loc, lockStat;
  try {
    loc = location(config, true); lock = path.join(loc.home, 'network.lock');
    fs.mkdirSync(lock, { mode: 0o700 });
    lockStat = fs.lstatSync(lock);
    storedLocal(config); const data = normalize(value, inherited);
    const source = JSON.stringify(data, null, 2) + '\n'; verify(Buffer.byteLength(source) <= MAX_BYTES);
    temporary = path.join(loc.home, `.network-${randomUUID()}.tmp`);
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, source); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    storedLocal(config); writeLock.assert(); verify(same(loc.stat, location(config).stat) && same(lockStat, fs.lstatSync(lock)));
    fs.renameSync(temporary, loc.file); temporary = null;
    fs.rmdirSync(lock); lock = null;
    return publicView(data);
  } catch { throw invalid(); }
  finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (temporary) { try { fs.unlinkSync(temporary); } catch {} }
    // Only a lock this invocation created can be released; never steal a busy/replaced lock.
    if (lockStat && lock) { try { if (same(lockStat, fs.lstatSync(lock)) && same(loc.stat, location(config).stat)) fs.rmdirSync(lock); } catch {} }
  }
}

/** Case aliases are a single variable across layers, not independent overrides. */
export function mergeNetworkEnvironment(...layers) {
  const result = {};
  for (const layer of layers) {
    Object.assign(result, layer || {});
    for (const name of PROXY_NAMES) {
      const aliases = Object.keys(layer || {}).filter(key => key.toLowerCase() === name);
      if (!aliases.length) continue;
      const value = layer[name] ?? layer[name.toUpperCase()] ?? layer[aliases[0]];
      for (const key of Object.keys(result)) if (key.toLowerCase() === name) delete result[key];
      result[name] = value; result[name.toUpperCase()] = value;
    }
  }
  return result;
}
function authenticatedProxy(data) {
  const url = proxyURL(data.proxy_url);
  if (data.proxy_auth) { url.username = data.proxy_auth.username; url.password = data.proxy_auth.password; }
  return url.href;
}
function projectEnvironment(config, data) {
  const env = mergeNetworkEnvironment(config?.env || {});
  if (data.mode !== 'inherit') {
    const address = data.mode === 'proxy' ? authenticatedProxy(data) : '';
    Object.assign(env, mergeNetworkEnvironment({ HTTP_PROXY: address, HTTPS_PROXY: address, ALL_PROXY: '', NO_PROXY: data.no_proxy.join(',') }));
  }
  return env;
}
function local(host) {
  host = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host.startsWith('127.') && isIP(host) === 4
    || /^::ffff:7f[0-9a-f]{2}:/i.test(host);
}
function bypass(url, rules) {
  let host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (local(host)) return true;
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return rules.some(item => item.any || (!item.port || item.port === port)
    && (host === item.host || !isIP(item.host) && host.endsWith(`.${item.host}`)));
}
export function agentNetworkEnvironment(config, ...overrides) {
  const env = mergeNetworkEnvironment(projectEnvironment(config, stored(config)), ...overrides);
  // External CLI network stacks differ. Supply aliases and explicit local exclusions.
  const extra = ['localhost', '.localhost', '127.0.0.1', '[::1]'];
  const rules = (env.no_proxy || '').split(',').map(item => item.trim()).filter(Boolean);
  const exclusions = [...new Set([...rules, ...extra])].join(',');
  return mergeNetworkEnvironment(env, { NO_PROXY: exclusions });
}
/** Scrub accidental CLI diagnostics/results; never exposes proxy userinfo or password prefixes. */
export function redactNetworkText(env, text) {
  const secrets = new Set();
  for (const name of ['http_proxy', 'https_proxy', 'all_proxy']) {
    const raw = env[name] || env[name.toUpperCase()]; if (!raw) continue;
    try {
      const url = new URL(raw);
      if (!url.username && !url.password) continue;
      secrets.add(raw);
      for (const part of [url.username, url.password]) if (part) { secrets.add(part); try { secrets.add(decodeURIComponent(part)); } catch {} }
      secrets.add(Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64'));
    } catch { /* invalid network variables are not interpolated into diagnostics */ }
  }
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) text = text.replaceAll(secret, '[redacted]');
  return text;
}

/** Immutable internal snapshot: credentials and routing never appear in public views. */
export function networkSnapshot(config, options = {}) {
  const data = stored(config), env = options.env ? mergeNetworkEnvironment(options.env) : projectEnvironment(config, data);
  const exclusions = (env.no_proxy || '').split(',').map(item => item.trim()).filter(Boolean).map(item => rule(item));
  const proxies = { http: env.http_proxy || env.all_proxy || '', https: env.https_proxy || env.http_proxy || env.all_proxy || '' };
  const key = createHash('sha256').update(JSON.stringify([data, proxies, exclusions])).digest('hex');
  const route = target => {
    const url = new URL(target); verify(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password);
    if (bypass(url, exclusions)) return '';
    const proxy = proxies[url.protocol === 'https:' ? 'https' : 'http'];
    if (proxy) proxyURL(proxy, true); // Unsupported inherited proxies fail only on a route that would use them.
    return proxy;
  };
  return { key, route, fetch: (target, init = {}, fetcher = null) => {
    const proxy = route(target);
    // The seam remains deterministic. Production uses built-ins to avoid Bun's process-global proxy/NO_PROXY overrides.
    return fetcher ? fetcher(target, { ...init, proxy }) : outboundFetch(target, init, proxy);
  } };
}
