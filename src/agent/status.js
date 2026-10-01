import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentEnvironment } from './environment.js';
import { MODEL_PRESETS } from './settings.js';
import { discoverAgentResources } from './resources.js';
import { resolvePiInstallation, statusCommand } from './status-command.js';
import { readStatusJson, readPiAccounts, usageDigest } from './status-accounts.js';
import { runUsageQueries } from './usage-query-run.js';

const flights = new WeakMap(), usageFlights = new WeakMap();
const helper = fileURLToPath(new URL('./status-pi.js', import.meta.url));
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 500) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, max) : null;

// Model metadata, not provider request/auth configuration. Nothing executable or secret enters the SDK probe.
function metadataConfig(config) {
  const providers = {};
  for (const [id, value] of Object.entries(object(config?.providers) ? config.providers : {}).slice(0, 100)) {
    if (!/^[a-z][a-z0-9_-]{0,79}$/i.test(id) || !object(value)) continue;
    const model = entry => {
      if (!object(entry) || !text(entry.id, 256)) return null;
      return { id: text(entry.id, 256), name: text(entry.name, 256) || text(entry.id, 256),
        ...(typeof entry.reasoning === 'boolean' ? { reasoning: entry.reasoning } : {}),
        ...(Array.isArray(entry.input) ? { input: entry.input.filter(item => ['text', 'image'].includes(item)) } : {}),
        ...(Number.isFinite(entry.contextWindow) && entry.contextWindow > 0 ? { contextWindow: entry.contextWindow } : {}),
        ...(Number.isFinite(entry.maxTokens) && entry.maxTokens > 0 ? { maxTokens: entry.maxTokens } : {}),
      };
    };
    const models = Array.isArray(value.models) ? value.models.slice(0, 500).map(model).filter(Boolean) : [];
    const modelOverrides = {};
    for (const [name, entry] of Object.entries(object(value.modelOverrides) ? value.modelOverrides : {}).slice(0, 500)) {
      const safe = model({ ...entry, id: name });
      if (safe) { delete safe.id; modelOverrides[text(name, 256)] = safe; }
    }
    providers[id] = { api: 'openai-completions', baseUrl: 'https://metadata.invalid/v1', models, modelOverrides };
  }
  return { providers };
}
function packageSettings(value) {
  return { packages: Array.isArray(value?.packages) ? value.packages.slice(0, 200).flatMap(item => {
    const source = typeof item === 'string' ? item : item?.source;
    return typeof source === 'string' && source.length < 4096 ? [source] : [];
  }) : [] };
}
function packageSource(value) {
  const source = text(value, 4096); if (!source) return null;
  // Sources may be authenticated git URLs. Their userinfo/query must not reach the browser.
  const prefix = source.startsWith('git:') ? 'git:' : '';
  try {
    const url = new URL(prefix ? source.slice(4) : source);
    if (['http:', 'https:', 'ssh:'].includes(url.protocol)) {
      url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return `${prefix}${url.href}`;
    }
  } catch {}
  return source.replace(/([?&](?:token|key|password|auth)=)[^&]*/gi, '$1***');
}
async function localPiMetadata(installation, config, configDir, modelsConfig, globalSettings, projectSettings) {
  if (!installation.package_dir) throw new Error();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-pi-status-'));
  try {
    fs.chmodSync(dir, 0o700);
    const modelsFile = path.join(dir, 'models.json'), inputFile = path.join(dir, 'query.json');
    fs.writeFileSync(modelsFile, JSON.stringify(metadataConfig(modelsConfig)), { mode: 0o600 });
    fs.writeFileSync(inputFile, JSON.stringify({ models_file: modelsFile, project: config.project, config_dir: configDir,
      global_settings: packageSettings(globalSettings), project_settings: packageSettings(projectSettings) }), { mode: 0o600 });
    const result = JSON.parse(await statusCommand(process.execPath, [helper, installation.package_dir, inputFile], {
      PATH: config.env.PATH || '', HOME: dir, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1',
    }, dir));
    return result;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function boundedRows(rows, budget, keys) {
  const result = []; let bytes = 0, truncated = false;
  for (const item of rows || []) {
    if (!object(item)) continue;
    const safe = {};
    for (const [key, max] of Object.entries(keys)) if (item[key] !== undefined) safe[key] = text(item[key], max);
    const size = Buffer.byteLength(JSON.stringify(safe));
    if (bytes + size > budget) { truncated = true; break; }
    bytes += size; result.push(safe);
  }
  return { rows: result, truncated };
}
function projectPath(value, project, home = os.homedir()) {
  if (typeof value !== 'string' || !value) return value;
  if (value === '~' || value.startsWith('~/')) return path.join(home, value.slice(2));
  return path.resolve(project, value);
}
function statusContext(config, profile) {
  const warnings = [], checked_at = new Date().toISOString();
  let env = { ...config.env };
  try { env = { ...env, ...agentEnvironment(config, 'agent').values, ...(profile.env || {}) }; }
  catch { warnings.push('项目 Agent 环境文件无法安全读取；当前查询使用 daemon 环境，角色覆盖状态未知。'); }
  // Never pass a running agent's invocation credentials or session into a metadata subprocess.
  for (const key of Object.keys(env)) if (key === 'LUSH_AGENT_TOKEN' || key === 'LUSH_TASK_ID' || key.startsWith('PI_SESSION')
    || ['PI_PROVIDER', 'PI_MODEL', 'PI_REASONING_LEVEL', 'LUSH_RUNTIME_CONTEXT'].includes(key)) delete env[key];
  env.PI_OFFLINE = '1'; env.PI_SKIP_VERSION_CHECK = '1';
  const queryConfig = { ...config, env };
  const homeDir = env.HOME || os.homedir();
  const config_dir = projectPath(env.PI_CODING_AGENT_DIR || path.join(homeDir, '.pi', 'agent'), config.project, homeDir);
  env.PI_CODING_AGENT_DIR = config_dir;
  const modelsConfig = readStatusJson(path.join(config_dir, 'models.json'), warnings, 'Pi 模型配置');
  const globalSettings = readStatusJson(path.join(config_dir, 'settings.json'), warnings, 'Pi 用户设置');
  const projectSettings = readStatusJson(path.join(config.project, '.pi', 'settings.json'), warnings, 'Pi 项目设置');
  const model = text(profile.model || (profile.agent === 'pi' ? env.LUSH_PI_MODEL : '')
    || projectSettings?.defaultModel || globalSettings?.defaultModel, 256);
  const currentProvider = env.LUSH_PI_PROVIDER || (model?.includes('/') ? model.split('/')[0] : null)
    || projectSettings?.defaultProvider || globalSettings?.defaultProvider;
  const { accounts, keys } = readPiAccounts(config_dir, env, modelsConfig, warnings, currentProvider, checked_at);
  return { warnings, checked_at, env, queryConfig, config_dir, modelsConfig, globalSettings, projectSettings, model, currentProvider, accounts, keys, homeDir };
}
async function status(config, profile, options, context) {
  const { warnings, checked_at, env, queryConfig, config_dir, modelsConfig, globalSettings, projectSettings, model, currentProvider, homeDir } = context;
  const installation = resolvePiInstallation(queryConfig);
  const usagePromise = usageFlight(config, profile, options, context);
  const metadataPromise = localPiMetadata(installation, queryConfig, config_dir, modelsConfig, globalSettings, projectSettings).catch(() => null);
  let version = null, runtimeWarning = null;
  const versionPromise = (async () => {
    try {
      if (!installation.executable) throw new Error();
      const output = (await statusCommand(installation.executable, ['--version'], env, config.project, { maxBytes: 1024 })).trim();
      if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(output)) throw new Error();
      version = output;
    } catch { runtimeWarning = '无法查询当前配置的 Pi 命令版本；程序未安装、命令不可用或输出无效。'; }
  })();
  const [metadata, usage] = await Promise.all([metadataPromise, usagePromise]);
  const accounts = usage.accounts;
  const eligible = new Set(accounts.filter(account => account.status === 'configured').map(account => account.provider));
  let models;
  if (Array.isArray(metadata?.models)) {
    models = { agent: 'pi', source: 'local', warning: '本地 Pi 模型目录，按已配置且未过期的凭证筛选；未联网验证可用性，不加载扩展提供的动态模型。',
      models: metadata.models.filter(item => object(item) && eligible.has(item.provider) && text(item.id, 256)).slice(0, 500).map(item => ({
        id: `${text(item.provider, 80)}/${text(item.id, 256)}`, provider: text(item.provider, 80), label: text(item.label, 256) || text(item.id, 256),
        context: Number.isFinite(item.context) ? String(item.context) : '', max_output: Number.isFinite(item.max_output) ? String(item.max_output) : '',
        thinking: Boolean(item.thinking), images: Boolean(item.images),
      })) };
  } else {
    models = { agent: 'pi', source: 'presets', models: MODEL_PRESETS.pi.map(id => ({ id, label: id })),
      warning: '无法安全读取此 Pi 安装的 SDK 模型目录，显示内置预设；预设不代表实际可用模型。' };
  }
  const packages = Array.isArray(metadata?.packages) ? metadata.packages.slice(0, 200).flatMap(item => {
    const source = packageSource(item?.source); if (!source) return [];
    return [{ source, root: text(item.root, 4096) }];
  }) : [];
  const resourceWarning = metadata?.packages ? null : '无法安全读取此 Pi 安装的 SDK 包目录，仅显示本地目录与 Lush 配置资源。';
  let resources;
  try {
    resources = await discoverAgentResources(queryConfig, { packages, warning: resourceWarning,
      extensions: (profile.extensions || []).map(value => projectPath(value, config.project, homeDir)),
      skills: (profile.skills || []).map(value => projectPath(value, config.project, homeDir)) });
  } catch {
    resources = { agent: 'pi', extensions: [], skills: [], packages, warning: '资源目录读取失败，未取得完整安装列表。' };
  }
  // Fit the existing 1 MiB RPC frame in UTF-8 bytes, even with long paths and CJK metadata.
  for (const key of ['extensions', 'skills', 'packages']) {
    const bounded = boundedRows(resources[key], key === 'packages' ? 64000 : 96000,
      key === 'packages' ? { source: 512, root: 8192 } : { id: 8192, label: 256, source: 256, description: 500 });
    resources[key] = bounded.rows;
    if (bounded.truncated) { resources.truncated = true; resources.warning = `${resources.warning || ''} 资源列表较大，已截断。`.trim(); }
  }
  let modelBytes = 0;
  const safeModels = [];
  for (const item of models.models) {
    const size = Buffer.byteLength(JSON.stringify(item));
    if (modelBytes + size > 160000) { models.truncated = true; models.warning = `${models.warning || ''} 模型列表较大，已截断。`.trim(); break; }
    modelBytes += size; safeModels.push(item);
  }
  models.models = safeModels;
  await versionPromise;
  return { version: 1, agent: 'pi', query_id: usage.query_id, checked_at: usage.checked_at, current_provider: currentProvider,
    scope: { project: config.project, role: 'agent', note: '当前项目 daemon 的 Pi 安装与公共/agent 角色配置；不是浏览器本机，也不是某次 invocation 的实况。账号状态是本地凭证信息，未联网验证登录。' },
    runtime: { command: installation.command, executable: installation.executable, real_path: installation.real_path, version, config_dir,
      backend: profile.agent || config.provider || null, model, warning: runtimeWarning },
    models, resources, accounts, warnings };
}

function flight(map, config, profile, options, context, run) {
  // Hot-read config/env/credentials participate in identity, but only their digest is retained.
  const identities = context.accounts.map(({ balance, ...account }) => account);
  const key = usageDigest([profile, context.env, context.modelsConfig, context.globalSettings, context.projectSettings,
    identities, [...context.keys], options.usageConfig || null, options.timeout || null]);
  let entries = map.get(config); if (!entries) { entries = new Map(); map.set(config, entries); }
  if (entries.has(key)) return entries.get(key);
  const pending = run().finally(() => { if (entries.get(key) === pending) entries.delete(key); });
  entries.set(key, pending); return pending;
}
function usageFlight(config, profile, options, context) {
  return flight(usageFlights, config, profile, options, context, () => runUsageQueries(context, options));
}
/** Lightweight account-only query: no Pi executable, SDK, plugins, model calls or OAuth refresh. */
export function discoverAgentUsage(config, profile, options = {}) {
  return usageFlight(config, profile, options, statusContext(config, profile));
}
/** Concurrent identical queries share work; new file/config state never reuses a stale request. */
export function discoverAgentStatus(config, profile, options = {}) {
  const context = statusContext(config, profile);
  return flight(flights, config, profile, options, context, () => status(config, profile, options, context));
}
