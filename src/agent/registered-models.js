import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { check, LushError } from '../core/types.js';
import { withConfigurationWriteLock } from '../core/device-config.js';
import { ConnectionFile } from './connections-file.js';
import { fields, safeText, validId, DEFAULT_ENDPOINTS } from './connections-utils.js';

export const REGISTERED_MODEL_LIMIT = 50;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const storageError = () => new LushError('registered model storage unavailable; check private file integrity and permissions');

function normalize(value, id) {
  fields(value, ['id', 'name', 'connection_id', 'model'], 'registered model');
  check(uuid(id), 'registered model id is invalid');
  check(validId(value.connection_id), 'registered model connection id is invalid');
  const name = safeText(value.name, 'registered model name', 128);
  const model = safeText(value.model, 'registered physical model', 256);
  check(model === value.model && /^[a-z][a-z0-9-]*\/\S+$/.test(model), 'registered model requires a qualified provider/model');
  return { id, name, connection_id: value.connection_id, model };
}

class RegisteredModelFile extends ConnectionFile {
  constructor(home) {
    super(home, { privateRoot: true });
    this.file = path.join(this.dir, 'agent-registered-models.json');
  }
  emptyData() { return { version: 1, models: [] }; }
  get lockName() { return 'agent-registered-models.lock'; }
  validateData(data) {
    fields(data, ['version', 'models'], 'stored registered models');
    check(data.version === 1 && Array.isArray(data.models) && data.models.length <= REGISTERED_MODEL_LIMIT,
      'invalid registered model storage');
    const ids = new Set(), names = new Set();
    const models = data.models.map(value => {
      const row = normalize(value, value.id);
      check(row.name === value.name && !ids.has(row.id) && !names.has(row.name), 'invalid registered model storage');
      ids.add(row.id); names.add(row.name); return row;
    });
    check(models.every(row => row.name === row.id || !ids.has(row.name)), 'invalid registered model storage');
    return { version: 1, models };
  }
  read() {
    try { return super.read(); } catch { throw storageError(); }
  }
  transaction(fn) {
    // The same device-wide gate serializes source changes, migration and registry writes.
    // Preserve our bounded validation errors; never propagate raw filesystem diagnostics.
    try { return withConfigurationWriteLock({ home: this.home }, 'project', () => this._transaction(fn)); }
    catch (error) {
      if (error instanceof LushError && !error.connectionCode) throw error;
      if (error?.connectionCode === 'auth_locked' || String(error?.message).includes('busy'))
        throw new LushError('registered model configuration is busy; retry after the current operation');
      throw storageError();
    }
  }
}

/** Local eligibility only, not a remote model/credential probe. Keeps physical IDs containing slashes intact. */
function eligibility(row, source) {
  if (!source) return 'source_missing';
  if (!source.enabled) return 'source_disabled';
  if (source.credential.status !== 'configured'
    && !(source.auth_type === 'oauth' && source.credential.status === 'expired')) return 'credential_unconfigured';
  if (source.auth_type === 'oauth' && new URL(source.endpoint).origin !== new URL(DEFAULT_ENDPOINTS[source.provider]).origin)
    return 'source_unsupported';
  const prefix = `${source.provider}/`;
  if (!row.model.startsWith(prefix) || row.model.length === prefix.length) return 'provider_mismatch';
  if (source.models.length && !source.models.includes(row.model.slice(prefix.length))) return 'model_out_of_scope';
  return null;
}

/** Device-owned aliases only. No profile, Worker, history, credential mutation or networking. */
export class RegisteredModelManager {
  constructor(connections) {
    check(connections.scope === 'device', 'registered models require device settings');
    this.connections = connections;
    this.file = new RegisteredModelFile(connections.file.home);
  }
  sources() {
    this.connections._alive();
    try { return this.connections.config().connections; } catch { throw storageError(); }
  }
  view(row, sources) {
    const source = sources.find(item => item.id === row.connection_id), reason = eligibility(row, source);
    return { ...row, selectable: reason === null, reason, storage_scope: 'device',
      source: source ? { id: source.id, label: source.label, provider: source.provider, endpoint: source.endpoint,
        enabled: source.enabled, auth_type: source.auth_type, credential_status: source.credential.status } : null };
  }
  list() {
    const data = this.file.read(), sources = this.sources();
    return { version: 1, models: data.models.map(row => this.view(row, sources)), storage_scope: 'device' };
  }
  save(value) {
    this.connections._alive();
    const row = normalize(value, value?.id ?? randomUUID());
    return this.file.transaction(data => {
      const index = data.models.findIndex(item => item.id === row.id);
      check(value.id === undefined || index >= 0, 'registered model not found');
      check(value.id !== undefined || index < 0, 'registered model id collision; retry with a new registration');
      check(index >= 0 || data.models.length < REGISTERED_MODEL_LIMIT, `registered model limit reached (${REGISTERED_MODEL_LIMIT})`);
      check(!data.models.some(item => item.id !== row.id && item.name === row.name), 'registered model name already exists');
      // Avoid ambiguous ID/name selectors, including names equal to a future generated ID.
      check(!data.models.some(item => item.id !== row.id && (item.name === row.id || item.id === row.name)),
        'registered model name conflicts with an id');
      const view = this.view(row, this.sources());
      check(view.selectable, `registered model source unavailable (${view.reason})`);
      if (index < 0) data.models.push(row); else data.models[index] = row;
      return view;
    });
  }
  remove(id) {
    this.connections._alive(); check(uuid(id), 'registered model id is invalid');
    return this.file.transaction(data => {
      const index = data.models.findIndex(row => row.id === id);
      check(index >= 0, 'registered model not found');
      data.models.splice(index, 1); return { removed: id };
    });
  }
  resolve(selector) {
    check(typeof selector === 'string' && selector === safeText(selector, 'registered model selector', 128),
      'registered model selector must be exact');
    const rows = this.list().models.filter(row => row.id === selector || row.name === selector);
    check(rows.length === 1, rows.length ? 'registered model selector is ambiguous' : 'registered model not found');
    const row = rows[0]; check(row.selectable, `registered model source unavailable (${row.reason})`);
    const { id, name, connection_id, model } = row;
    return { id, name, connection_id, model };
  }
}
