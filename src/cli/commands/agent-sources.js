// `lush agent source ...` / `lush agent model choices`: managed model-source listing,
// quota visibility and cached model catalog. No local credential or login workflow.
import { check } from '../../core/types.js';
import { exact } from '../args.js';
import { safeConfigurationScope } from '../settings-scope.js';

const CATALOG_STATUSES = ['fresh', 'cached', 'unknown', 'error', 'unsupported'];

/** Accept both the documented `(args, client)` shape and a `{client, json}` context. */
function context(ref, options = {}) {
  const client = ref && typeof ref.request === 'function' ? ref : ref?.client;
  check(client && typeof client.request === 'function', 'model sources require a connected project client');
  check(!client.token || client.management, 'agents cannot read or change managed model sources');
  return { client, json: options.json === true || ref?.json === true };
}

const text = (value, max = 2048) => typeof value === 'string' && value.length <= max ? value : null;
const list = (value, max = 100) => Array.isArray(value)
  ? value.filter(item => typeof item === 'string' && item.length > 0 && item.length <= 256).slice(0, max) : [];
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const integer = value => Number.isSafeInteger(value) ? value : null;
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;

/** Every nested level is rebuilt from an allow-list; unknown or secret-bearing fields never reach stdout. */
function resourceView(row) {
  const value = record(row); if (!value) return null;
  return { id: text(value.id, 80), kind: ['balance', 'quota'].includes(value.kind) ? value.kind : null,
    scope: ['account', 'key', 'model'].includes(value.scope) ? value.scope : null,
    label: text(value.label, 200), unit: text(value.unit, 40),
    remaining: finite(value.remaining), total: finite(value.total), used: finite(value.used),
    used_percent: finite(value.used_percent), reset_at: text(value.reset_at, 40),
    window_seconds: integer(value.window_seconds), models: list(value.models) };
}

function observationView(row) {
  const value = record(row); if (!value) return null;
  return { status: text(value.status, 32) ?? 'unknown', checked_at: text(value.checked_at, 40),
    source: text(value.source, 32) ?? 'none', error_code: text(value.error_code, 64),
    reason: text(value.reason, 600),
    resources: (Array.isArray(value.resources) ? value.resources : []).slice(0, 64).map(resourceView).filter(Boolean) };
}

function consumerView(row) {
  const value = record(row); if (!value) return null;
  return { task_id: integer(value.task_id), model: text(value.model, 300) };
}

function samplingView(value) {
  const row = record(value); if (!row) return null;
  return { enabled: row.enabled === true, interval_minutes: integer(row.interval_minutes),
    retention_days: integer(row.retention_days) };
}

function sourceView(row) {
  check(row && typeof row === 'object' && !Array.isArray(row), 'invalid connection response');
  const credential = record(row.credential) ?? {};
  return { id: text(row.id, 80), label: text(row.label), provider: text(row.provider, 80),
    endpoint: text(row.endpoint), auth_type: row.auth_type === 'oauth' ? 'oauth' : 'api_key',
    enabled: row.enabled === true, notify_reset: row.notify_reset === true, models: list(row.models),
    default_model: text(row.default_model, 256), default_thinking: text(row.default_thinking, 32),
    ...(['device', 'project'].includes(row.storage_scope) ? { storage_scope: row.storage_scope } : {}),
    credential: { status: text(credential.status, 32) ?? 'unknown', identity: text(credential.identity, 120),
      expires_at: text(credential.expires_at, 40) },
    observation: observationView(row.observation) ?? observationView({}),
    ...(record(row.last_success) ? { last_success: { checked_at: text(row.last_success.checked_at, 40),
      observation: observationView(row.last_success.observation) ?? observationView({}) } } : {}),
    ...(Array.isArray(row.consumers) ? { consumers: row.consumers.slice(0, 100).map(consumerView).filter(Boolean) } : {}) };
}

function catalogView(value) {
  check(value && typeof value === 'object' && !Array.isArray(value), 'invalid model catalog response');
  return { version: 1, id: text(value.id, 80), checked_at: text(value.checked_at, 40),
    status: CATALOG_STATUSES.includes(value.status) ? value.status : 'unknown',
    source: ['listing', 'pi-local', 'manual', 'none'].includes(value.source) ? value.source : 'none',
    models: (Array.isArray(value.models) ? value.models : []).slice(0, 500).filter(model => model && typeof model === 'object')
      .map(model => ({ id: text(model.id, 300), name: text(model.name, 300),
        thinking_levels: Array.isArray(model.thinking_levels) ? list(model.thinking_levels, 8) : null,
        context: Number.isSafeInteger(model.context) ? model.context : null,
        max_output: Number.isSafeInteger(model.max_output) ? model.max_output : null,
        images: typeof model.images === 'boolean' ? model.images : null,
        reasoning: typeof model.reasoning === 'boolean' ? model.reasoning : null })),
    warning: text(value.warning, 600), error_code: text(value.error_code, 64) };
}

async function listSources(client) {
  const value = await client.request('agent.connections.list', {});
  check(value && typeof value === 'object', 'invalid connection list response');
  return { version: 1, checked_at: text(value.checked_at, 40), sampling: samplingView(value.sampling),
    ...(value.configuration_scope ? { configuration_scope: safeConfigurationScope(value.configuration_scope) } : {}),
    connections: (Array.isArray(value.connections) ? value.connections : []).map(sourceView),
    ...(value.warning ? { warning: text(value.warning, 600) } : {}) };
}

async function showSource(client, id) {
  check(typeof id === 'string' && id.length > 0 && id.length <= 80, 'a connection id is required');
  const list = await listSources(client);
  const row = list.connections.find(connection => connection.id === id);
  check(row, `connection ${id} was not found`);
  return row;
}

async function modelsFor(client, args, refresh) {
  exact(args, 1);
  const id = args[0];
  check(typeof id === 'string' && id.length > 0 && id.length <= 80 && !id.startsWith('-'), 'a connection id is required');
  const value = await client.request(refresh ? 'agent.connections.models.refresh' : 'agent.connections.models', { id });
  return value?.receipt_id ? value : catalogView(value);
}

export async function runSources(args, clientRef, options = {}) {
  const { client } = context(clientRef, options);
  const verb = args.shift();
  if (verb === 'list') { exact(args, 0); return await listSources(client); }
  if (verb === 'show') { exact(args, 1); return await showSource(client, args[0]); }
  if (verb === 'refresh') {
    const id = args.shift() ?? null;
    check(id === null || id.length <= 80, 'invalid connection id');
    exact(args, 0);
    const receipt = await client.request('agent.connections.query', id === null ? {} : { id });
    if (receipt?.receipt_id) return receipt;
    return { ...await listSources(client), queried: id ?? 'all' };
  }
  if (verb === 'models') {
    const action = args.shift();
    check(['list', 'refresh'].includes(action), 'agent source models requires list or refresh');
    return await modelsFor(client, args, action === 'refresh');
  }
  if (verb === 'remove') {
    exact(args, 1); const value = await client.request('agent.connections.remove', { id: args[0] });
    return value?.receipt_id ? value : { removed: text(value?.removed, 80) };
  }
  check(false, 'agent source expects list, show, models, refresh or remove');
}

export async function runResources(args, clientRef, options = {}) {
  const { client } = context(clientRef, options);
  exact(args, 0);
  const value = await client.request('agent.selection.resources', {});
  check(value && typeof value === 'object', 'invalid resource read response');
  return { version: 1, checked_at: text(value.checked_at, 40),
    ...(value.configuration_scope ? { configuration_scope: safeConfigurationScope(value.configuration_scope) } : {}),
    connections: (Array.isArray(value.connections) ? value.connections : []).map(connection => ({
      ...sourceView(connection), supported_agents: list(connection.supported_agents, 8),
      model_catalog: catalogView(connection.model_catalog ?? {}) })),
    ...(value.warning ? { warning: text(value.warning, 600) } : {}) };
}

