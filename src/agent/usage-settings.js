import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { check, isPlainObject, LushError } from '../core/types.js';

const MAX_BYTES = 128 * 1024;
const ID = /^[a-z][a-z0-9_-]{0,79}$/i;
const SECRET = /^(?:authorization|proxy-authorization|cookie|key|.*(?:api[-_]?key|token|password|secret))$/i;
const BLOCKED_HEADERS = /^(?:host|content-length|connection|transfer-encoding|upgrade|proxy-.*|sec-.*)$/i;
const defaults = () => ({ version: 1, enabled: false, interval_minutes: 5, retention_days: 90, providers: [], custom: [] });
function fields(value, allowed, label) {
  check(isPlainObject(value), `${label} must be an object`);
  check(Object.keys(value).every(key => allowed.includes(key)), `${label} has an unknown field`);
}
function label(value, name, max = 120) {
  check(typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value), `${name} must be safe text`);
  return value.trim();
}
function integer(value, min, max, name) {
  check(Number.isInteger(value) && value >= min && value <= max, `${name} must be an integer from ${min} to ${max}`); return value;
}
function template(value, name, max = 8192) {
  check(typeof value === 'string' && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value), `${name} must be bounded text`);
  const rest = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key) => {
    check(!/^(?:LUSH_|PI_SESSION)/i.test(key), `${name} cannot reference invocation variables`); return '';
  });
  check(!rest.includes('${'), `${name} has an invalid environment reference`);
  return value;
}
function fieldPath(value) {
  if (value === undefined || value === null || value === '') return null;
  check(typeof value === 'string' && value.length <= 240 && /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(value)
    && value.split('.').length <= 20 && !value.split('.').some(part => ['__proto__', 'prototype', 'constructor'].includes(part)), 'usage item field path is invalid');
  return value;
}
function sensitiveBody(value) {
  if (Array.isArray(value)) { value.forEach(sensitiveBody); return; }
  if (!isPlainObject(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET.test(key)) check(typeof entry === 'string' && /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(entry), 'body credentials must use environment references');
    sensitiveBody(entry);
  }
}
function customQuery(value) {
  fields(value, ['provider','label','url','method','headers','body','kind','items'], 'custom usage query');
  check(typeof value.provider === 'string' && ID.test(value.provider), 'custom provider is invalid');
  const name = label(value.label, 'custom label');
  check(typeof value.url === 'string' && value.url.length <= 2048 && !value.url.includes('${') && !/[\s\x00-\x1f\x7f]/.test(value.url), 'custom URL must be HTTPS');
  let url;
  try { url = new URL(value.url); } catch { throw new LushError('custom URL must be HTTPS'); }
  check(url.protocol === 'https:' && url.hostname && !url.username && !url.password && !url.hash, 'custom URL must be HTTPS without credentials or fragment');
  check(![...url.searchParams.keys()].some(key => SECRET.test(key)), 'URL credentials are not supported; use an environment-referenced header');
  check(['GET','POST'].includes(value.method), 'custom method must be GET or POST');
  check(['balance','quota'].includes(value.kind), 'custom kind must be balance or quota');
  const headers = value.headers ?? {};
  check(isPlainObject(headers) && Object.keys(headers).length <= 20, 'custom headers must be a bounded object');
  const seenHeaders = new Set(), cleanHeaders = {};
  for (const [key, entry] of Object.entries(headers)) {
    check(/^[A-Za-z][A-Za-z0-9-]{0,79}$/.test(key) && !BLOCKED_HEADERS.test(key) && !seenHeaders.has(key.toLowerCase()), 'custom header name is invalid or repeated');
    seenHeaders.add(key.toLowerCase());
    template(entry, 'custom header');
    check(!/[\r\n]/.test(entry), 'custom headers cannot contain newlines');
    if (SECRET.test(key)) check(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(entry), 'header credentials must use environment references');
    cleanHeaders[key] = entry;
  }
  let body = value.body ?? null;
  if (body === '') body = null;
  check(value.method !== 'GET' || body === null, 'GET queries cannot have a body');
  if (body !== null) {
    template(body, 'custom body', 16384);
    let parsed; try { parsed = JSON.parse(body); } catch { throw new LushError('custom body must be JSON text'); }
    sensitiveBody(parsed);
  }
  check(Array.isArray(value.items) && value.items.length > 0 && value.items.length <= 10, 'custom query must have 1..10 items');
  const ids = new Set();
  const items = value.items.map(item => {
    fields(item, ['id','label','unit','remaining','total','used','reset_at','window_seconds'], 'usage item');
    check(typeof item.id === 'string' && ID.test(item.id) && !ids.has(item.id), 'usage item id is invalid or repeated'); ids.add(item.id);
    const remaining = fieldPath(item.remaining), total = fieldPath(item.total), used = fieldPath(item.used);
    check(remaining || total || used, 'usage item requires a numeric field path');
    return { id: item.id, label: label(item.label, 'item label'), unit: label(item.unit, 'item unit', 24), remaining, total, used,
      reset_at: fieldPath(item.reset_at), window_seconds: item.window_seconds == null ? null : integer(item.window_seconds, 1, 315360000, 'window_seconds') };
  });
  return { provider: value.provider, label: name, url: url.href, method: value.method, headers: cleanHeaders, body, kind: value.kind, items };
}

/** Declarative only: no scripts, shell substitutions or resolved secret values. */
export function normalizeUsageConfig(value) {
  fields(value, ['version','enabled','interval_minutes','retention_days','providers','custom'], 'usage config');
  const out = { ...defaults(), ...value };
  check(out.version === 1, 'usage config must use version 1');
  check(typeof out.enabled === 'boolean', 'usage enabled must be boolean');
  integer(out.interval_minutes, 1, 1440, 'interval_minutes'); integer(out.retention_days, 1, 3650, 'retention_days');
  check(Array.isArray(out.providers) && out.providers.length <= 20 && out.providers.every(id => typeof id === 'string' && ID.test(id))
    && new Set(out.providers).size === out.providers.length, 'providers must contain at most 20 unique provider IDs');
  check(Array.isArray(out.custom) && out.custom.length <= 20, 'custom must contain at most 20 queries');
  out.providers = [...out.providers]; out.custom = out.custom.map(customQuery);
  check(new Set(out.custom.map(item => item.provider)).size === out.custom.length, 'custom provider is repeated');
  check(Buffer.byteLength(JSON.stringify(out)) <= MAX_BYTES, 'usage config is too large');
  return out;
}

export class UsageSettings {
  constructor(config) { this.config = config; this.file = path.join(config.home, 'agent-usage.json'); }
  get() {
    let stat;
    try { stat = fs.lstatSync(this.file); } catch (error) { if (error.code === 'ENOENT') return defaults(); throw new LushError('usage settings cannot be read'); }
    check(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && !(stat.mode & 0o077), 'unsafe usage settings file; owner-only regular file required');
    check(stat.size <= MAX_BYTES, 'usage settings file is too large');
    let value; try { value = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { throw new LushError('invalid JSON in usage settings file'); }
    return normalizeUsageConfig(value);
  }
  save(value) {
    const normalized = normalizeUsageConfig(value);
    this.get(); // Refuse to overwrite unsafe/corrupt on-disk configuration.
    fs.mkdirSync(this.config.home, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(normalized, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } finally { fs.rmSync(temporary, { force: true }); }
    return normalized;
  }
}
