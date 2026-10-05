// Managed account model catalog: bounded, identity-scoped cache of the models a
// connection can actually reach. Never a model probe: only audited listing
// endpoints, Pi auth-free local metadata, or the user's explicit model range.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, fail, object } from './connections-utils.js';

export const CATALOG_VERSION = 1;
export const CATALOG_MAX_MODELS = 500;
const MAX_BYTES = 512 * 1024;
const MAX_ENTRIES = 60;
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/**
 * Audited listing adapters. `path` is resolved against the connection's own
 * endpoint origin, so a credential is never sent to a destination the user did
 * not configure for that connection. No adapter runs a model request.
 */
export const LISTINGS = Object.freeze({
  deepseek: { path: '/models', auth: true, parse: parseOpenAiList },
  openrouter: { path: '/api/v1/models', auth: false, parse: parseOpenRouterList },
});

const text = (value, max = 256) => typeof value === 'string' && value.trim().length > 0
  && Buffer.byteLength(value) <= max && !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value) ? value.trim() : null;
const positive = value => Number.isSafeInteger(value) && value > 0 && value <= 1e12 ? value : null;
const levels = value => Array.isArray(value)
  ? [...new Set(value.filter(level => THINKING_LEVELS.has(level)))].slice(0, 8) : null;
const flag = value => typeof value === 'boolean' ? value : null;

function model(provider, rawId, values = {}) {
  const id = text(rawId);
  if (!id) return null;
  return { id: `${provider}/${id}`, name: text(values.name) || id,
    thinking_levels: levels(values.thinking_levels),
    context: positive(values.context), max_output: positive(values.max_output),
    images: flag(values.images), reasoning: flag(values.reasoning) };
}

function dedupe(rows) {
  const seen = new Set(), models = [];
  for (const row of rows) {
    if (!object(row) || models.length >= CATALOG_MAX_MODELS) continue;
    const id = text(row.id);
    if (!id || seen.has(id)) continue;
    seen.add(id); models.push(row);
  }
  return models;
}

function parseOpenAiList(data, provider) {
  if (!object(data) || !Array.isArray(data.data)) fail('invalid_response');
  const models = data.data.slice(0, CATALOG_MAX_MODELS)
    .map(row => object(row) ? model(provider, row.id) : null).filter(Boolean);
  if (!models.length) fail('invalid_response');
  return models;
}

function parseOpenRouterList(data) {
  if (!object(data) || !Array.isArray(data.data)) fail('invalid_response');
  const models = data.data.slice(0, CATALOG_MAX_MODELS).map(row => {
    if (!object(row)) return null;
    const parameters = Array.isArray(row.supported_parameters) ? row.supported_parameters : [];
    const modalities = Array.isArray(row.architecture?.input_modalities) ? row.architecture.input_modalities : null;
    return model('openrouter', row.id, { name: row.name, context: row.context_length,
      images: modalities ? modalities.includes('image') : null,
      reasoning: parameters.includes('reasoning') ? true : null });
  }).filter(Boolean);
  if (!models.length) fail('invalid_response');
  return models;
}

/** User-declared range only; never claims the account can actually call these. */
export function manualModels(connection) {
  return dedupe((connection.models || []).map(id => model(connection.provider, id)));
}

/** Auth-free Pi SDK metadata, filtered to the connection's provider. */
export function localModels(connection, metadata) {
  const rows = Array.isArray(metadata?.models) ? metadata.models : [];
  return dedupe(rows.filter(row => object(row) && row.provider === connection.provider).map(row => {
    const raw = typeof row.id === 'string' && row.id.startsWith(`${connection.provider}/`)
      ? row.id.slice(connection.provider.length + 1) : row.id;
    const number = value => typeof value === 'string' && /^\d+$/.test(value) ? Number(value)
      : Number.isSafeInteger(value) ? value : null;
    return model(connection.provider, raw, { name: row.label, context: number(row.context),
      max_output: number(row.max_output), thinking_levels: row.thinking === false ? [] : null,
      images: typeof row.images === 'boolean' ? row.images : null, reasoning: typeof row.thinking === 'boolean' ? row.thinking : null });
  }));
}

export function catalogKey(connection, identity) {
  return digest(['agent-catalog-v1', connection.provider, connection.endpoint, connection.models,
    identity.account_key, identity.source_key]);
}

export function listingUrl(connection, listing) {
  return new URL(listing.path, new URL(connection.endpoint).origin).href;
}

/** Strict, bounded projection safe for RPC, persistence and the selection read face. */
export function normalizeCatalog(value, id, now = Date.now) {
  if (!object(value)) fail('auth_changed');
  const status = ['fresh', 'cached', 'unknown', 'error', 'unsupported'].includes(value.status) ? value.status : 'unknown';
  const source = ['listing', 'pi-local', 'manual', 'none'].includes(value.source) ? value.source : 'none';
  const parsed = typeof value.checked_at === 'string' ? Date.parse(value.checked_at) : NaN;
  const models = dedupe((Array.isArray(value.models) ? value.models.slice(0, CATALOG_MAX_MODELS) : []).map(row => {
    if (!object(row)) return null;
    const mid = text(row.id);
    if (!mid) return null;
    return { id: mid, name: text(row.name) || mid, thinking_levels: levels(row.thinking_levels),
      context: positive(row.context), max_output: positive(row.max_output),
      images: flag(row.images), reasoning: flag(row.reasoning) };
  }));
  return { version: CATALOG_VERSION, id, checked_at: Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(now()).toISOString(),
    status, source, models,
    warning: typeof value.warning === 'string' && value.warning.length <= 600 ? value.warning : null,
    error_code: typeof value.error_code === 'string' && value.error_code.length <= 64 ? value.error_code : null };
}

const owner = stat => process.getuid === undefined || stat.uid === process.getuid();
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;

function validateEntries(value) {
  if (!object(value) || value.version !== 1 || !object(value.entries)
    || Object.keys(value.entries).length > MAX_ENTRIES) fail('auth_changed');
  const entries = {};
  for (const [key, entry] of Object.entries(value.entries)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !object(entry)) fail('auth_changed');
    entries[key] = normalizeCatalog(entry, text(entry.id) || 'unknown', () => Date.now());
  }
  return { version: 1, entries };
}

/** Owner-only, atomic catalog store beside the connection file. No secrets are written. */
export class ConnectionCatalogFile {
  constructor(connectionsFile) {
    this.connections = connectionsFile;
    this.file = path.join(connectionsFile.dir, 'agent-connection-catalog.json');
  }
  empty() { return { version: 1, entries: {} }; }
  read() {
    const parent = this.connections.directory();
    if (!parent) return this.empty();
    let fd;
    try {
      try { fd = fs.openSync(this.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); }
      catch (error) { if (error.code === 'ENOENT') return this.empty(); throw error; }
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || !owner(stat) || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.size > MAX_BYTES) fail('auth_changed');
      const raw = fs.readFileSync(fd, 'utf8'), after = fs.fstatSync(fd);
      if (Buffer.byteLength(raw) > MAX_BYTES || !same(stat, after) || stat.size !== after.size
        || !same(stat, fs.lstatSync(this.file)) || !same(parent, this.connections.directory())) fail('auth_changed');
      return validateEntries(JSON.parse(raw));
    } catch { fail('auth_changed'); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  get(key) { return this.read().entries[key] ?? null; }
  /** Bounded retry keeps concurrent per-connection refreshes from losing independent catalogs. */
  async put(key, catalog) {
    const deadline = Date.now() + 2000;
    for (;;) {
      try { return this._putOnce(key, catalog); }
      catch (error) {
        if (error?.connectionCode !== 'auth_locked' || Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
  }
  _putOnce(key, catalog) {
    if (!/^[a-f0-9]{64}$/.test(key)) fail('auth_changed');
    this.connections.directory(true);
    const dir = this.connections.dir;
    const lock = this.connections.lock('agent-connection-catalog.lock');
    let temporary, fd;
    try {
      lock.assert();
      const entries = { ...this.read().entries, [key]: normalizeCatalog(catalog, catalog.id, () => Date.now()) };
      const keys = Object.keys(entries);
      if (keys.length > MAX_ENTRIES) {
        for (const stale of keys.sort((a, b) => String(entries[a].checked_at).localeCompare(String(entries[b].checked_at))).slice(0, keys.length - MAX_ENTRIES)) delete entries[stale];
      }
      const body = JSON.stringify({ version: 1, entries }, null, 2) + '\n';
      if (Buffer.byteLength(body) > MAX_BYTES) fail('invalid_response');
      temporary = path.join(dir, `.catalog-${randomUUID()}.tmp`);
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
      fs.writeFileSync(fd, body); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      lock.assert();
      this.read();
      fs.renameSync(temporary, this.file); temporary = null;
    } catch (error) {
      if (error?.connectionCode || error?.name === 'LushError') throw error;
      fail('auth_changed');
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (temporary) { try { fs.unlinkSync(temporary); } catch { /* never remove a replaced temp */ } }
      lock.release();
    }
  }
}
