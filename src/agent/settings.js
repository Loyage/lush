import fs from 'node:fs';
import path from 'node:path';
import { check, isPlainObject } from '../core/types.js';
import { GUIDE } from './guide.js';
import { AGENT_ROLES as PROMPT_ROLES, builtInPrompt } from './prompts.js';

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
  planner: '规划任务', coordinator: '协调任务', worker: '开发任务', research: '调研任务',
  verifier: '检验任务', merger: '分支分歧解决', showcase: '效果展示',
};
const MAX_FILE_BYTES = 256 * 1024;
const MAX_PROMPT_BYTES = 32 * 1024;
const PROFILE_KEYS = new Set(['agent', 'model', 'thinking', 'prompt', 'default_prompt', 'append_prompt', 'extensions', 'skills']);

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

function normalizeProfile(value, name) {
  check(isPlainObject(value), `${name} must be an object`);
  check(Object.keys(value).every(key => PROFILE_KEYS.has(key)), `${name} has an unknown field`);
  const agent = text(value.agent ?? '', `${name}.agent`, 32);
  check(AGENT_BACKENDS.includes(agent), `${name}.agent must be pi or codex`);
  const model = text(value.model ?? '', `${name}.model`, 256).trim();
  const thinking = text(value.thinking ?? '', `${name}.thinking`, 32).trim();
  check(THINKING_LEVELS[agent].includes(thinking), `${name}.thinking is not supported by ${agent}`);
  const default_prompt = text(value.default_prompt ?? '', `${name}.default_prompt`, MAX_PROMPT_BYTES).trim();
  // `prompt` was the original append-only field; keep reading it so existing project files upgrade without intervention.
  const append_prompt = text(value.append_prompt ?? value.prompt ?? '', `${name}.append_prompt`, MAX_PROMPT_BYTES).trim();
  const extensions = resourceList(value.extensions ?? [], `${name}.extensions`);
  const skills = resourceList(value.skills ?? [], `${name}.skills`);
  return { agent, model, thinking, default_prompt, append_prompt, extensions, skills };
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
  const base = normalizeProfile(value.default ?? fallback, 'default');
  const roles = value.roles ?? {};
  check(isPlainObject(roles), 'roles must be an object');
  check(Object.keys(roles).every(role => AGENT_ROLES.includes(role)), 'agent config has an unknown role');
  const normalizedRoles = {};
  for (const role of AGENT_ROLES) if (roles[role] !== undefined && roles[role] !== null) {
    normalizedRoles[role] = normalizeProfile(roles[role], `roles.${role}`);
  }
  return { version: 1, default: base, roles: normalizedRoles };
}

/** Project-level agent settings. Reads on every invocation so queued work sees the latest saved profile. */
export class AgentSettings {
  constructor(config) {
    this.config = config;
    this.file = path.join(config.home, 'agent.json');
  }

  readStored() {
    const fallback = envDefault(this.config);
    if (!fs.existsSync(this.file)) return normalizeAgentConfig({ version: 1, default: fallback, roles: {} }, fallback);
    const stat = fs.lstatSync(this.file);
    check(!stat.isSymbolicLink() && stat.isFile() && stat.uid === process.getuid(), `unsafe Agent config file: ${this.file}`);
    check((stat.mode & 0o077) === 0, `${this.file} must only be readable by its owner (chmod 600)`);
    check(stat.size <= MAX_FILE_BYTES, `${this.file} is too large`);
    let value;
    try { value = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch { throw new Error(`invalid JSON in ${this.file}`); }
    return normalizeAgentConfig(value, fallback);
  }

  get() {
    const stored = this.readStored();
    const resolved = {};
    for (const role of AGENT_ROLES) resolved[role] = { ...(stored.roles[role] || stored.default) };
    return {
      ...stored, resolved, file: this.file, runtime_agent: this.config.provider === 'mock' ? 'mock' : stored.default.agent,
      options: {
        agents: [...AGENT_BACKENDS],
        roles: AGENT_ROLES.map(id => ({ id, label: ROLE_LABELS[id] })),
        thinking: Object.fromEntries(Object.entries(THINKING_LEVELS).map(([key, values]) => [key, [...values]])),
        models: Object.fromEntries(Object.entries(MODEL_PRESETS).map(([key, values]) => [key, [...values]])),
        // Compatibility field for older clients; role-aware clients use default_prompts.
        default_prompt: GUIDE,
        default_prompts: Object.fromEntries(AGENT_ROLES.map(role => [role, builtInPrompt(role)])),
      },
    };
  }

  resolve(role) {
    const config = this.get();
    return { ...(config.resolved[role === 'scheduler' ? 'planner' : role] || config.default) };
  }

  save(value) {
    const normalized = normalizeAgentConfig(value, envDefault(this.config));
    const body = JSON.stringify(normalized, null, 2) + '\n';
    check(Buffer.byteLength(body) <= MAX_FILE_BYTES, 'agent config is too large');
    fs.mkdirSync(this.config.home, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, body, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.file);
      fs.chmodSync(this.file, 0o600);
    } finally { fs.rmSync(temporary, { force: true }); }
    return this.get();
  }
}
