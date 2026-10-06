// `lush agent sources ...` / `lush agent resources`: managed model-source listing,
// quota visibility, cached model catalog and private file-based credential entry.
// All actions are user-only; secrets never travel through argv or CLI output.
import fs from 'node:fs';
import { check } from '../../core/types.js';
import { exact, option } from '../args.js';

const MAX_INPUT_BYTES = 65536;
const MAX_URL_BYTES = 10000;
const CATALOG_STATUSES = ['fresh', 'cached', 'unknown', 'error', 'unsupported'];

/** Accept both the documented `(args, client)` shape and a `{client, json}` context. */
function context(ref, options = {}) {
  const client = ref && typeof ref.request === 'function' ? ref : ref?.client;
  check(client && typeof client.request === 'function', 'model sources require a connected project client');
  check(!client.token, 'agents cannot read or change managed model sources');
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

function deviceView(value) {
  check(record(value), 'invalid device login response');
  return { id: text(value.id, 80), login_id: text(value.login_id, 80), status: text(value.status, 32),
    ...(Number.isSafeInteger(value.interval_seconds) ? { interval_seconds: value.interval_seconds } : {}),
    ...(text(value.expires_at, 40) ? { expires_at: text(value.expires_at, 40) } : {}),
    ...(record(value.connection) ? { connection: sourceView(value.connection) } : {}) };
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

/**
 * Owner-only regular file with no symlink following and a bounded read. Any failure
 * returns one fixed message so a path, permission or content problem never echoes data.
 */
function readPrivateFile(file, max, message) {
  let fd;
  try {
    check(typeof file === 'string' && file.length > 0 && file.length <= 4096 && typeof process.getuid === 'function', message);
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const stat = fs.fstatSync(fd);
    check(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid() && (stat.mode & 0o077) === 0
      && stat.size <= max, message);
    const source = fs.readFileSync(fd, 'utf8');
    check(Buffer.byteLength(source) <= max, message);
    return source;
  } catch { throw new Error(message); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function readPrivateJson(file) {
  const source = readPrivateFile(file, MAX_INPUT_BYTES, 'cannot safely read the input file: owner-only regular file required');
  let value;
  try { value = JSON.parse(source); } catch { check(false, 'input file must be valid JSON'); }
  check(value && typeof value === 'object' && !Array.isArray(value), 'input must be a JSON object');
  return value;
}

function readPrivateText(file) {
  const value = readPrivateFile(file, MAX_URL_BYTES, 'cannot safely read the callback file: owner-only regular file required').trim();
  check(value.length > 0 && !/[\x00-\x1f\x7f]/.test(value), 'callback file must contain one plain callback URL');
  return value;
}

async function listSources(client) {
  const value = await client.request('agent.connections.list', {});
  check(value && typeof value === 'object', 'invalid connection list response');
  return { version: 1, checked_at: text(value.checked_at, 40), sampling: samplingView(value.sampling),
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

async function modelsFor(client, args) {
  const id = args.shift();
  check(typeof id === 'string' && id.length > 0 && id.length <= 80, 'a connection id is required');
  const refresh = args.includes('--refresh'); if (refresh) args.splice(args.indexOf('--refresh'), 1);
  exact(args, 0);
  return catalogView(await client.request(refresh ? 'agent.connections.models.refresh' : 'agent.connections.models', { id }));
}

async function login(client, args) {
  const id = args.shift();
  check(typeof id === 'string' && id.length > 0 && id.length <= 80, 'a connection id is required for login');
  const cancel = option(args, '--cancel'), poll = option(args, '--poll'), finish = option(args, '--finish');
  const urlFile = option(args, '--url-file'), callback = args.includes('--callback');
  if (callback) args.splice(args.indexOf('--callback'), 1);
  exact(args, 0);
  const selected = [cancel, poll, finish].filter(value => value !== null).length + (callback ? 1 : 0);
  check(selected <= 1, 'choose one of --callback, --poll, --cancel or --finish');
  if (cancel !== null) return deviceView(await client.request('agent.connections.device.cancel', { id, login_id: cancel }));
  if (poll !== null) return deviceView(await client.request('agent.connections.device.poll', { id, login_id: poll }));
  if (finish !== null) {
    check(urlFile, '--finish requires --url-file PATH');
    return sourceView(await client.request('agent.connections.login.finish',
      { id, login_id: finish, redirect_url: readPrivateText(urlFile) }));
  }
  if (callback) {
    const started = await client.request('agent.connections.login.start', { id });
    return { id, login_id: text(started.login_id, 80), url: text(started.url, 4096), expires_at: text(started.expires_at, 40),
      redirect_uri: text(started.redirect_uri, 2048), instructions: text(started.instructions, 600) };
  }
  const started = await client.request('agent.connections.device.start', { id });
  return { id, login_id: text(started.login_id, 80), verification_uri: text(started.verification_uri, 512),
    user_code: text(started.user_code, 64), expires_at: text(started.expires_at, 40),
    interval_seconds: Number.isSafeInteger(started.interval_seconds) ? started.interval_seconds : null };
}

export async function runSources(args, clientRef, options = {}) {
  const { client } = context(clientRef, options);
  const verb = args.shift() || 'list';
  if (verb === 'list') { exact(args, 0); return await listSources(client); }
  if (verb === 'show') { exact(args, 1); return await showSource(client, args[0]); }
  if (verb === 'refresh') {
    const id = args.shift() ?? null;
    check(id === null || id.length <= 80, 'invalid connection id');
    exact(args, 0);
    await client.request('agent.connections.query', id === null ? {} : { id });
    return { ...await listSources(client), queried: id ?? 'all' };
  }
  if (verb === 'models') return await modelsFor(client, args);
  if (verb === 'save') {
    const file = option(args, '--file'); exact(args, 0);
    check(file, 'agent sources save requires --file PATH');
    const input = readPrivateJson(file);
    check(Object.keys(input).every(key => ['connection', 'credential'].includes(key)), 'save input accepts only connection and credential');
    check(input.connection && typeof input.connection === 'object' && !Array.isArray(input.connection), 'connection is required');
    return sourceView(await client.request('agent.connections.save',
      { connection: input.connection, ...(input.credential ? { credential: input.credential } : {}) }));
  }
  if (verb === 'remove') { exact(args, 1); return { removed: text((await client.request('agent.connections.remove', { id: args[0] }))?.removed, 80) }; }
  if (verb === 'login') return await login(client, args);
  check(false, 'agent sources expects list, show, models, refresh, save, remove or login');
}

export async function runResources(args, clientRef, options = {}) {
  const { client } = context(clientRef, options);
  exact(args, 0);
  const value = await client.request('agent.selection.resources', {});
  check(value && typeof value === 'object', 'invalid resource read response');
  return { version: 1, checked_at: text(value.checked_at, 40),
    connections: (Array.isArray(value.connections) ? value.connections : []).map(connection => ({
      ...sourceView(connection), supported_agents: list(connection.supported_agents, 8),
      model_catalog: catalogView(connection.model_catalog ?? {}) })),
    ...(value.warning ? { warning: text(value.warning, 600) } : {}) };
}

