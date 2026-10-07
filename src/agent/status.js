import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentEnvironment } from './environment.js';
import { agentNetworkEnvironment, networkSnapshot } from './network.js';
import { resolvePiInstallation, statusCommand } from './status-command.js';
import { readStatusJson, readPiAccounts, usageDigest } from './status-accounts.js';
import { runUsageQueries } from './usage-query-run.js';
import { piConfigDirectory, isolatedPiEnvironment } from './pi-config.js';
import { discoverSoftwareStatus } from './status-software.js';

const usageFlights = new WeakMap();
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

// Legacy adapter only, for isolated compatibility tests. No project service invokes this path.
function usageContext(config, profile) {
  const warnings = [], checked_at = new Date().toISOString();
  const network = networkSnapshot(config);
  let env = agentNetworkEnvironment(config);
  try { env = agentNetworkEnvironment(config, agentEnvironment(config, 'agent').values, profile.env || {}); }
  catch { warnings.push('项目 Agent 环境文件无法安全读取；当前查询使用项目网络默认环境，角色覆盖状态未知。'); }
  for (const key of Object.keys(env)) if (key === 'LUSH_AGENT_TOKEN' || key === 'LUSH_TASK_ID' || key.startsWith('PI_SESSION')
    || ['PI_PROVIDER', 'PI_MODEL', 'PI_REASONING_LEVEL', 'LUSH_RUNTIME_CONTEXT'].includes(key)) delete env[key];
  env.PI_OFFLINE = '1'; env.PI_SKIP_VERSION_CHECK = '1';
  const config_dir = piConfigDirectory(config);
  env.PI_CODING_AGENT_DIR = config_dir;
  const queryConfig = { ...config, env: isolatedPiEnvironment(config, env, config_dir) };
  const modelsConfig = readStatusJson(path.join(config_dir, 'models.json'), warnings, 'Lush Pi 模型配置', { privateFile: true });
  const globalSettings = readStatusJson(path.join(config_dir, 'settings.json'), warnings, 'Lush Pi 设置', { privateFile: true });
  const projectSettings = {};
  const model = text(profile.model || '', 256);
  const currentProvider = model?.includes('/') ? model.split('/')[0] : null;
  const { accounts, keys, codexAuth } = readPiAccounts(config_dir, queryConfig.env, modelsConfig, warnings, currentProvider, checked_at);
  return { warnings, checked_at, env, network, queryConfig, config_dir, modelsConfig, globalSettings, projectSettings, model, currentProvider, accounts, keys, codexAuth };
}

/** Optional SDK catalog from sanitized Lush metadata, without auth, dynamic extensions or requests. */
export async function discoverPiModelMetadata(config) {
  const directory = piConfigDirectory(config), warnings = [];
  const models = readStatusJson(path.join(directory, 'models.json'), warnings, 'Lush Pi 模型配置', { privateFile: true });
  if (models === null) throw new Error('Lush Pi model metadata unavailable');
  const providers = new Set(Object.keys(metadataConfig(models).providers));
  if (!providers.size) throw new Error('Lush Pi 独立模型元数据尚未配置；预设不代表实际可用模型');
  const queryConfig = { ...config, env: isolatedPiEnvironment(config) };
  const metadata = await localPiMetadata(resolvePiInstallation(queryConfig), queryConfig, directory, models, {}, {});
  if (!Array.isArray(metadata.models)) throw new Error('Pi SDK model metadata unavailable');
  return { agent: 'pi', source: 'local', warning: 'Lush 独立配置的本地模型目录，不读取用户 Pi 认证或运行扩展；目录未联网验证，实际调用必须选择匹配的 Lush 模型来源。',
    models: metadata.models.filter(item => object(item) && providers.has(item.provider) && text(item.id, 256)).slice(0, 500).map(item => ({
      id: `${text(item.provider, 80)}/${text(item.id, 256)}`, provider: text(item.provider, 80), label: text(item.label, 256) || text(item.id, 256),
      context: Number.isFinite(item.context) ? String(item.context) : '', max_output: Number.isFinite(item.max_output) ? String(item.max_output) : '',
      thinking: Boolean(item.thinking), images: Boolean(item.images),
    })) };
}

/** Retained internal legacy adapter, not an active project query/sampling entry point. */
export function discoverAgentUsage(config, profile, options = {}) {
  const context = usageContext(config, profile);
  const identities = context.accounts.map(({ balance, ...account }) => account);
  const key = usageDigest([profile, context.env, context.modelsConfig, context.globalSettings, context.projectSettings,
    identities, [...context.keys], context.codexAuth, options.usageConfig || null, options.timeout || null,
    options.refreshCodex !== false, context.network.key]);
  let entries = usageFlights.get(config); if (!entries) { entries = new Map(); usageFlights.set(config, entries); }
  if (entries.has(key)) return entries.get(key);
  const pending = runUsageQueries(context, { ...options,
    fetch: (url, init) => context.network.fetch(url, init, options.fetch),
    authFetch: (url, init) => context.network.fetch(url, init, options.authFetch || options.fetch),
  }).finally(() => { if (entries.get(key) === pending) entries.delete(key); });
  entries.set(key, pending); return pending;
}

/** Software-only diagnostics: profile/account/model/resource settings are deliberately ignored. */
export function discoverAgentStatus(config, _profile, options = {}) {
  return discoverSoftwareStatus(config, options);
}
