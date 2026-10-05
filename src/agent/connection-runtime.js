import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check } from '../core/types.js';

const MAX_FILE = 256 * 1024;
const MODEL_FIELDS = ['id', 'name', 'api', 'reasoning', 'input', 'cost', 'contextWindow', 'maxTokens', 'compat', 'inputLimits', 'promptCache'];
const SETTINGS = ['defaultProjectTrust', 'thinkingBudgets', 'modelThinkingLevels', 'defaultTools', 'compaction', 'branchSummary',
  'transport', 'httpProxy', 'httpIdleTimeoutMs', 'websocketConnectTimeoutMs', 'retry', 'shellPath', 'shellCommandPrefix',
  'images', 'warnings', 'cacheWarming'];
const CONTEXT_FILES = ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD', 'SYSTEM.md', 'APPEND_SYSTEM.md'];
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const select = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
function readLocal(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE) return null;
    return fs.readFileSync(file, 'utf8');
  } catch { return null; }
}
function readJson(file) { try { return JSON.parse(readLocal(file)); } catch { return null; } }
function privateDir(dir) {
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw new Error('managed Pi directory unavailable'); }
  const stat = fs.lstatSync(dir);
  check(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && !(stat.mode & 0o077), 'unsafe managed Pi directory');
}

/** Private input only. Nothing in this object may enter run events or model-facing task JSON. */
export function validateRuntimeConnection(agent, runtime) {
  check(agent.agent === 'pi', 'managed connections support only Pi');
  const connection = runtime?.connection;
  check(connection?.id === agent.connection_id && connection.enabled === true, 'managed connection is unavailable');
  const prefix = `${connection.provider}/`;
  check(typeof agent.model === 'string' && agent.model.startsWith(prefix) && agent.model.length > prefix.length,
    'managed connection requires its qualified physical model');
  const modelId = agent.model.slice(prefix.length);
  if (connection.provider === 'openai-compatible') {
    check(Array.isArray(connection.models) && connection.models.length > 0, 'compatible API requires explicit model IDs');
    check(connection.auth_type === 'api_key', 'compatible API requires API key authentication');
  }
  check(!connection.models?.length || connection.models.includes(modelId), 'model is outside managed connection scope');
  let endpoint;
  try { endpoint = new URL(connection.endpoint); } catch { throw new Error('invalid managed model endpoint'); }
  check(endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash,
    'invalid managed model endpoint');
  const credential = runtime.credential;
  check(credential && (credential.type === 'api_key' || credential.type === 'oauth'), 'managed credential unavailable');
  if (connection.auth_type === 'oauth') {
    check(connection.provider === 'openai-codex' && credential.type === 'oauth'
      && typeof credential.access === 'string' && credential.access.length > 0
      && Number.isFinite(credential.expires) && credential.expires > Date.now(), 'managed OAuth credential expired');
  } else {
    // Pi auth.json supports executable/interpolated values. Stored managed keys are literal secrets, never commands.
    check(credential.type === 'api_key' && typeof credential.key === 'string' && credential.key.length > 0
      && !/[!$\s\0]/.test(credential.key), 'managed runtime requires a literal API key');
  }
  return { connection, modelId };
}

/** Disposable per-invocation auth, no refresh token, no argv secrets and no modification of the caller's Pi directory. */
export function createRuntimeConnection(config, agent, runtime, environment = {}) {
  const { connection, modelId } = validateRuntimeConnection(agent, runtime);
  const parent = path.join(config.home, 'agent-runtime');
  privateDir(parent);
  const dir = fs.mkdtempSync(path.join(parent, 'connection-'));
  fs.chmodSync(dir, 0o700);
  const write = (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
  try {
    const original = environment.PI_CODING_AGENT_DIR || config.env.PI_CODING_AGENT_DIR || path.join(config.env.HOME || os.homedir(), '.pi', 'agent');
    const originalDir = path.resolve(config.project, original);
    const settings = readJson(path.join(originalDir, 'settings.json'));
    if (object(settings)) write('settings.json', { ...select(settings, SETTINGS), enableInstallTelemetry: false, enableAnalytics: false });
    for (const name of CONTEXT_FILES) {
      const text = readLocal(path.join(originalDir, name));
      if (text !== null) fs.writeFileSync(path.join(dir, name), text, { mode: 0o600, flag: 'wx' });
    }
    const compatible = connection.provider === 'openai-compatible';
    // A generic endpoint must not inherit another endpoint's protocol, capabilities or compatibility flags.
    const source = compatible ? null : readJson(path.join(originalDir, 'models.json'))?.providers?.[connection.provider];
    const provider = compatible ? {
      baseUrl: connection.endpoint, api: 'openai-completions',
      // These are conservative local operating budgets, NOT discovered upstream limits or prices.
      // Text/tool calls only; no advertised image, reasoning or cache capabilities.
      models: [{ id: modelId, name: modelId, reasoning: false, input: ['text'],
        contextWindow: 32768, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } : { baseUrl: connection.endpoint };
    if (object(source)) {
      if (typeof source.api === 'string') provider.api = source.api;
      if (Array.isArray(source.models)) {
        const model = source.models.find(entry => object(entry) && entry.id === modelId);
        if (model) provider.models = [select(model, MODEL_FIELDS)];
      }
      const override = source.modelOverrides?.[modelId];
      if (object(override)) provider.modelOverrides = { [modelId]: select(override, MODEL_FIELDS.filter(key => key !== 'id')) };
    }
    write('models.json', { providers: { [connection.provider]: provider } });
    const credential = runtime.credential.type === 'oauth'
      ? { type: 'oauth', access: runtime.credential.access, expires: runtime.credential.expires, refresh: '',
          ...(runtime.credential.accountId ? { accountId: runtime.credential.accountId } : {}) }
      : { type: 'api_key', key: runtime.credential.key };
    write('auth.json', { [connection.provider]: credential });
    return { dir, observations: path.join(dir, 'observations.json'),
      binding: { id: connection.id, provider: connection.provider, endpoint: connection.endpoint, model: agent.model,
        account_key: runtime.account_key, source_key: runtime.source_key } };
  } catch {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error('managed Pi configuration could not be prepared');
  }
}

/** Read only our bounded, owner-only passive output. Invalid data is ignored, not projected into history. */
export function readRuntimeObservations(runtime) {
  if (!runtime) return [];
  const file = runtime.observations;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > 65536) return [];
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(data) || data.length > 64) return [];
    return data.filter(row => row?.source === 'response_headers' && row.checked_at && Array.isArray(row.resources));
  } catch { return []; }
}

/** Only documented provider-specific percentage fields, never generic RPM/TPM rate limits or raw headers. */
export function parseConnectionHeaders(provider, headers, status, checkedAt = new Date().toISOString()) {
  if (provider !== 'openai-codex' || !object(headers)) return null;
  const safeNumber = (name, max) => {
    const text = Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
    if (typeof text !== 'string' || text.length > 32 || !/^\d+(?:\.\d+)?$/.test(text)) return null;
    const value = Number(text); return Number.isFinite(value) && value >= 0 && value <= max ? value : null;
  };
  const resources = [];
  for (const [key, label] of [['primary', '主要额度窗口'], ['secondary', '次要额度窗口']]) {
    const used = safeNumber(`x-codex-${key}-used-percent`, 100);
    if (used === null) continue;
    const minutes = safeNumber(`x-codex-${key}-window-minutes`, 5256000);
    const seconds = safeNumber(`x-codex-${key}-reset-after-seconds`, 315360000);
    const reset = safeNumber(`x-codex-${key}-reset-at`, 8640000000000);
    const at = reset !== null ? reset * 1000 : seconds !== null ? Date.parse(checkedAt) + seconds * 1000 : null;
    resources.push({ id: key, kind: 'quota', scope: 'account', label, unit: '%', remaining: 100 - used, total: 100, used,
      used_percent: used, reset_at: at !== null && Number.isFinite(at) && at <= 8640000000000000 ? new Date(at).toISOString() : null,
      window_seconds: minutes > 0 && Number.isInteger(minutes * 60) ? minutes * 60 : null, models: [] });
  }
  if (!resources.length && status !== 429) return null;
  return { status: resources.length ? (status === 429 ? 'partial' : 'available') : 'error', checked_at: checkedAt,
    source: 'response_headers', resources, error_code: status === 429 ? 'rate_limited' : null,
    reason: status === 429 ? '正常模型请求被限流；此信号不等于套餐已耗尽。' : '正常模型响应中的套餐百分比；不是金额或绝对 token 配额。' };
}
