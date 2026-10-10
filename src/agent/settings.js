import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { configurationHome, configurationScope, settingsConfigurationScope, withConfigurationWriteLock } from '../core/device-config.js';
import { check, isPlainObject } from '../core/types.js';
import { AGENT_ROLES as PROMPT_ROLES, builtInPrompt } from './prompts.js';
import { normalizeAgentEnv } from './environment.js';

export const AGENT_ROLES = [...PROMPT_ROLES];
export const AGENT_BACKENDS = ['pi', 'codex'];
export const THINKING_LEVELS = {
  pi: ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['', 'minimal', 'low', 'medium', 'high', 'xhigh'],
};
export const MODEL_PRESETS = {
  pi: ['openai-codex/gpt-5.4', 'openai-codex/gpt-5.4-mini', 'openai-codex/gpt-5.3-codex-spark'],
  codex: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark'],
};

const ROLE_LABELS = {
  agent: '直接 Worker', planner: '规划 Worker', coordinator: '协调 Worker', worker: '开发 Worker', research: '调研 Worker',
  verifier: '检验 Worker', merger: '分支分歧解决', explainer: '执行过程介绍（Pi 无工具）', butler: '托管模式管家（Pi 无工具）',
  manager: '项目管理 Agent（受限管理工具）',
};
/** One wording for every boundary that refuses to start an unbounded Pi invocation. */
export const MISSING_PI_SOURCE_MESSAGE = 'Pi requires a Lush model source; select a source in Agent configuration before the next invocation';

const MAX_FILE_BYTES = 256 * 1024;
const MAX_PROMPT_BYTES = 32 * 1024;
const PROFILE_KEYS = new Set(['agent', 'config_mode', 'model', 'thinking', 'prompt', 'default_prompt', 'append_prompt', 'extensions', 'skills', 'soft_budget', 'env', 'connection_id']);

export function normalizeSoftBudget(value) {
  if (value === undefined || value === null) return {};
  check(isPlainObject(value), 'soft_budget must be an object');
  check(Object.keys(value).every(key => ['responses', 'tokens'].includes(key)), 'unknown soft_budget field');
  const result = {};
  for (const key of ['responses', 'tokens']) {
    if (value[key] === undefined || value[key] === null) continue;
    const max = key === 'responses' ? 10000 : 1000000000;
    check(Number.isSafeInteger(value[key]) && value[key] > 0 && value[key] <= max, `soft_budget.${key} must be 1..${max}`);
    result[key] = value[key];
  }
  return result;
}

function text(value, name, maxBytes) {
  check(typeof value === 'string', `${name} must be text`);
  check(Buffer.byteLength(value) <= maxBytes, `${name} is too long`);
  return value;
}

function resourceList(value, name) {
  check(Array.isArray(value), `${name} must be a list`);
  check(value.length <= 64, `${name} has too many entries`);
  const seen = new Set();
  return value.map((entry, index) => text(entry, `${name}[${index}]`, 4096).trim())
    .filter(entry => entry && !seen.has(entry) && seen.add(entry));
}

export function normalizeAgentProfile(value, name = 'profile') {
  check(isPlainObject(value), `${name} must be an object`);
  check(Object.keys(value).every(key => PROFILE_KEYS.has(key)), `${name} has an unknown field`);
  const agent = text(value.agent ?? '', `${name}.agent`, 32);
  check(AGENT_BACKENDS.includes(agent), `${name}.agent must be pi or codex`);
  check(name !== 'roles.manager' || agent === 'pi', 'manager requires Pi restricted management tools; the legacy Codex CLI backend is not supported');
  const config_mode = text(value.config_mode ?? '', `${name}.config_mode`, 16).trim();
  check(['', 'lush', 'pi'].includes(config_mode), `${name}.config_mode must be lush or pi`);
  check(config_mode !== 'pi' || agent === 'pi', `${name}: Pi default configuration is available only for the Pi backend`);
  check(config_mode !== 'pi' || !['roles.explainer', 'roles.butler'].includes(name),
    `${name}: isolated agents require Lush configuration`);
  // Pi-default mode keeps the backend and mode only: nothing managed by Lush may leak into the
  // effective profile. A later switch back to Lush has to opt in again to each of these.
  if (config_mode === 'pi') {
    return { agent, model: '', thinking: '', default_prompt: '', append_prompt: '', extensions: [], skills: [], config_mode: 'pi' };
  }
  const model = text(value.model ?? '', `${name}.model`, 256).trim();
  const connection_id = text(value.connection_id ?? '', `${name}.connection_id`, 128).trim();
  if (connection_id) {
    check(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(connection_id), 'connection_id must be a connection UUID');
    check(agent === 'pi', 'managed connections support only Pi');
    check(/^[a-z][a-z0-9_-]*\/.+$/i.test(model), 'managed connection requires a qualified physical model');
  }
  const thinking = text(value.thinking ?? '', `${name}.thinking`, 32).trim();
  check(THINKING_LEVELS[agent].includes(thinking), `${name}.thinking is not supported by ${agent}`);
  const default_prompt = text(value.default_prompt ?? '', `${name}.default_prompt`, MAX_PROMPT_BYTES).trim();
  // `prompt` was the original append-only field; keep reading it so existing project files upgrade without intervention.
  const append_prompt = text(value.append_prompt ?? value.prompt ?? '', `${name}.append_prompt`, MAX_PROMPT_BYTES).trim();
  const extensions = resourceList(value.extensions ?? [], `${name}.extensions`);
  const skills = resourceList(value.skills ?? [], `${name}.skills`);
  const soft_budget = normalizeSoftBudget(value.soft_budget);
  const enabled = Object.keys(soft_budget).length > 0;
  check(!enabled || agent === 'pi', 'soft_budget is supported only by Pi');
  check(!enabled || !['roles.explainer','roles.butler'].includes(name), 'explainer/butler does not support soft_budget');
  // Per-task env overrides are the innermost layer; stored only when non-empty so profiles stay byte-stable.
  const env = normalizeAgentEnv(value.env ?? {});
  return { agent, model, thinking, default_prompt: name === 'roles.manager' ? '' : default_prompt,
    append_prompt: name === 'roles.manager' ? '' : append_prompt,
    extensions: name === 'roles.manager' ? [] : extensions, skills: name === 'roles.manager' ? [] : skills,
    ...(enabled ? { soft_budget } : {}), ...(Object.keys(env).length ? { env } : {}), ...(connection_id ? { connection_id } : {}) };
}

function envDefault(config) {
  const agent = AGENT_BACKENDS.includes(config.provider) ? config.provider : 'pi';
  if (agent === 'codex') return {
    agent, model: config.env.LUSH_CODEX_MODEL || '', thinking: config.env.LUSH_CODEX_THINKING || '', default_prompt: '', append_prompt: '', extensions: [], skills: [],
  };
  return {
    agent, model: config.env.LUSH_PI_MODEL || '', thinking: config.env.LUSH_PI_THINKING || '', default_prompt: '', append_prompt: '', extensions: [], skills: [],
  };
}

export function normalizeAgentConfig(value, fallback) {
  check(isPlainObject(value), 'agent config must be an object');
  check(value.version === undefined || value.version === 1, 'agent config version must be 1');
  check(Object.keys(value).every(key => ['version', 'default', 'roles'].includes(key)), 'agent config has an unknown field');
  const base = normalizeAgentProfile(value.default ?? fallback, 'default');
  const roles = value.roles ?? {};
  check(isPlainObject(roles), 'roles must be an object');
  check(Object.keys(roles).every(role => AGENT_ROLES.includes(role)), 'agent config has an unknown role');
  const normalizedRoles = {};
  for (const role of AGENT_ROLES) if (roles[role] !== undefined && roles[role] !== null) {
    normalizedRoles[role] = normalizeAgentProfile(roles[role], `roles.${role}`);
  }
  return { version: 1, default: base, roles: normalizedRoles };
}

/** Device-owned profiles, re-read for each later invocation; explicit Worker profiles remain complete. */
export class AgentSettings {
  constructor(config) {
    this.config = config;
    this.file = path.join(configurationHome(config, settingsConfigurationScope(config)), 'agent.json');
  }

  readLocal(scope = 'project') {
    const home = configurationHome(this.config, scope), file = path.join(home, 'agent.json');
    let root;
    try { root = fs.lstatSync(home); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    check(root.isDirectory() && !root.isSymbolicLink() && root.uid === process.getuid() && !(root.mode & 0o022)
      && (scope !== 'device' || !(root.mode & 0o077)) && fs.realpathSync(home) === home, 'unsafe Agent config directory');
    let fd;
    try {
      let published;
      try { published = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      check(!published.isSymbolicLink(), `unsafe Agent config file: ${file}`);
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(fd);
      check(stat.isFile() && stat.uid === process.getuid() && stat.nlink === 1, `unsafe Agent config file: ${file}`);
      check((stat.mode & 0o077) === 0, `${file} must only be readable by its owner (chmod 600)`);
      check(stat.size <= MAX_FILE_BYTES, `${file} is too large`);
      const source = fs.readFileSync(fd, 'utf8'), after = fs.fstatSync(fd), current = fs.lstatSync(file), currentRoot = fs.lstatSync(home);
      check(Buffer.byteLength(source) <= MAX_FILE_BYTES && stat.dev === after.dev && stat.ino === after.ino
        && stat.size === after.size && stat.mtimeMs === after.mtimeMs && stat.dev === current.dev && stat.ino === current.ino
        && root.dev === currentRoot.dev && root.ino === currentRoot.ino && fs.realpathSync(home) === home,
      'Agent config file changed while reading');
      let value;
      try { value = JSON.parse(source); } catch { throw new Error(`invalid JSON in ${file}`); }
      // Retired overrides stay on disk; compatibility is read-only.
      if (isPlainObject(value?.roles) && Object.hasOwn(value.roles, 'showcase')) {
        const { showcase: retired, ...roles } = value.roles;
        value = { ...value, roles };
      }
      return normalizeAgentConfig(value, envDefault(this.config));
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }

  selection(scope) {
    scope = settingsConfigurationScope(this.config, scope);
    const own = this.readLocal(scope);
    return { stored: own || normalizeAgentConfig({ default: envDefault(this.config), roles: {} }, envDefault(this.config)),
      source: own ? scope : 'default', file: path.join(configurationHome(this.config, scope), 'agent.json'), overridden: false };
  }

  readStored(scope) { return this.selection(scope).stored; }

  get(scope) {
    scope = settingsConfigurationScope(this.config, scope);
    const selection = this.selection(scope), stored = selection.stored;
    const progressReporting = this.config.runtimeSettings?.get(scope)?.progress_reporting?.value ?? this.config.progressReporting;
    const resolved = {};
    for (const role of AGENT_ROLES) {
      resolved[role] = { ...(stored.roles[role] || stored.default) };
      // The isolated, no-extension explainer never inherits a development budget or Pi-default mode.
      if (['explainer','butler'].includes(role)) { delete resolved[role].soft_budget; delete resolved[role].config_mode; }
      // A manager may inherit model/auth selection, never a development Prompt or executable resources.
      if (role === 'manager') Object.assign(resolved[role], { default_prompt: '', append_prompt: '', extensions: [], skills: [] });
    }
    return {
      ...stored, resolved, file: selection.file,
      configuration_scope: configurationScope(this.config, scope, selection.source, selection.overridden), runtime_agent: this.config.provider === 'mock' ? 'mock' : stored.default.agent,
      options: {
        agents: [...AGENT_BACKENDS],
        // Which configuration source a Pi invocation uses: Lush-managed or the machine's own Pi.
        config_modes: ['lush', 'pi'],
        roles: AGENT_ROLES.map(id => ({ id, label: ROLE_LABELS[id] })),
        thinking: Object.fromEntries(Object.entries(THINKING_LEVELS).map(([key, values]) => [key, [...values]])),
        models: Object.fromEntries(Object.entries(MODEL_PRESETS).map(([key, values]) => [key, [...values]])),
        // Compatibility field for older clients; role-aware clients use default_prompts.
        default_prompt: builtInPrompt('planner', { progressReporting: progressReporting !== false }),
        default_prompts: Object.fromEntries(AGENT_ROLES.map(role => [role, builtInPrompt(role, { progressReporting: progressReporting !== false })])),
      },
    };
  }

  resolve(role) {
    check(role !== 'showcase', 'showcase role is no longer supported');
    const config = this.get();
    return { ...(config.resolved[role === 'scheduler' ? 'planner' : role] || config.default) };
  }

  /** Validate and freeze a task-local profile for one explicit retry attempt. */
  retryProfile(role, value) {
    const resolvedRole = role === 'scheduler' ? 'planner' : role;
    check(AGENT_ROLES.includes(resolvedRole), `unknown agent role: ${role}`);
    return normalizeAgentProfile(value, `roles.${resolvedRole}`);
  }

  save(value, scope) {
    scope = settingsConfigurationScope(this.config, scope);
    const normalized = normalizeAgentConfig(value, envDefault(this.config));
    // A shared resource cannot resolve relative to whichever project happens to launch next.
    if (scope === 'device') for (const profile of [normalized.default, ...Object.values(normalized.roles)]) {
      for (const key of ['extensions', 'skills']) profile[key] = profile[key].map(resource => {
        if (path.isAbsolute(resource)) return resource;
        if (resource.startsWith('~/') && this.config.env?.HOME) return path.resolve(this.config.env.HOME, resource.slice(2));
        check(typeof this.config.project === 'string' && path.isAbsolute(this.config.project), 'shared resource paths must be absolute');
        return path.resolve(this.config.project, resource);
      });
    }
    const body = JSON.stringify(normalized, null, 2) + '\n';
    check(Buffer.byteLength(body) <= MAX_FILE_BYTES, 'agent config is too large');
    return withConfigurationWriteLock(this.config, scope, lock => {
      this.readLocal(scope);
      const file = path.join(configurationHome(this.config, scope), 'agent.json'), temporary = `${file}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, body, { mode: 0o600, flag: 'wx' });
        lock.assert(); this.readLocal(scope);
        fs.renameSync(temporary, file);
      } finally { fs.rmSync(temporary, { force: true }); }
      return this.get(scope);
    });
  }

  clearOverride() {
    settingsConfigurationScope(this.config, 'project');
    return withConfigurationWriteLock(this.config, 'project', lock => {
      this.readLocal(); lock.assert(); fs.rmSync(this.file, { force: true });
      return this.get();
    });
  }
}
