/**
 * Agent profiles: "one agent = one configuration file".
 *
 * A profile is one JSON file per agent at `$LUSH_HOME/agents/<name>.json`; the
 * file name *is* the agent name, so the file needs no `name` field. Every field
 * is optional and acts as an overlay: a field the file declares wins, otherwise
 * the matching environment variable applies, otherwise the built-in fallback
 * (`AGENT_FALLBACKS`) does. That keeps `LUSH_PROVIDER` / `LUSH_PI_COMMAND` /
 * `LUSH_PI_PROVIDER` / `LUSH_PI_MODEL` meaningful while still letting a profile
 * override any single one of them.
 *
 * The built-in `default` profile is always available and cannot be deleted: it
 * is the fallback tier (`pi` with the pure flag set, i.e. no user extensions /
 * skills / prompt templates / themes / AGENTS.md). Writing
 * `$LUSH_HOME/agents/default.json` overrides it field by field.
 *
 * This module is pure file I/O + validation + field resolution: no daemon, no
 * provider, no third-party dependency. The CLI reads and writes profiles with
 * it directly (a running daemon is not required), and the daemon resolves one
 * profile per call through `AgentCatalog` (`catalog.js`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { LushError, isPlainObject } from '../core/types.js';

/** An agent name is also its file name, so it stays filesystem-safe. */
export const AGENT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** Providers a profile may name; `pi` is the only external one. */
export const AGENT_PROVIDERS = ['pi', 'openai', 'mock'];

/** The profile used when a process does not select one explicitly. */
export const DEFAULT_AGENT_NAME = 'default';

/**
 * What "pure pi" means: pi runs with its own read/bash/edit/write tools only,
 * and none of the user's extensions, skills, prompt templates, themes or
 * `AGENTS.md` context files are loaded. These are the flags a profile with
 * `plugins: false` expands to; the daemon's own argv is what makes the change
 * visible (`lush agent inspect` / `lush call --dry-run`).
 */
export const PURE_PI_FLAGS = Object.freeze([
  '--no-extensions',
  '--no-skills',
  '--no-prompt-templates',
  '--no-themes',
  '--no-context-files',
]);

/** Keys a profile file may contain, in the order `add` / `inspect` write them. */
export const PROFILE_FIELDS = Object.freeze([
  'provider', 'command', 'model', 'pi_provider', 'plugins', 'flags', 'description',
]);

/**
 * Last-resort value of every field, applied after the profile file and the
 * environment. `plugins: false` is what makes the default agent pure.
 */
export const AGENT_FALLBACKS = Object.freeze({
  provider: 'pi',
  command: 'pi',
  pi_provider: '',
  model: '',
  plugins: false,
  flags: Object.freeze([]),
});

export const BUILTIN_DEFAULT_DESCRIPTION = '内置默认 agent：纯净 pi（不加载 extensions / skills / prompt templates / themes / AGENTS.md）';

/** Environment variables of the fallback tier, one per profile field. */
const ENV_FIELDS = {
  provider: 'LUSH_PROVIDER',
  command: 'LUSH_PI_COMMAND',
  pi_provider: 'LUSH_PI_PROVIDER',
  model: 'LUSH_PI_MODEL',
};

/** Reject anything that could not be used as `$LUSH_HOME/agents/<name>.json`. */
export function checkAgentName(name) {
  if (typeof name !== 'string' || !AGENT_NAME_PATTERN.test(name)) {
    throw new LushError(
      `invalid agent name: ${JSON.stringify(name)} (must start with a letter and use only letters, digits, '_' or '-')`,
      -32602,
    );
  }
  return name;
}

/**
 * Validate one profile object (the *file* content, not the resolved agent) and
 * return only the declared fields, in canonical order. Unknown fields are an
 * error: a typo must not silently do nothing.
 */
const STRING_FIELDS = ['command', 'model', 'pi_provider', 'description'];

function readProfileField(field, value, where) {
  if (field === 'provider') {
    if (!AGENT_PROVIDERS.includes(value)) {
      throw new LushError(`agent provider must be one of ${AGENT_PROVIDERS.join(', ')}${where}`, -32602);
    }
    return value;
  }
  if (STRING_FIELDS.includes(field)) {
    if (typeof value !== 'string' || value.length > 500) {
      throw new LushError(`agent ${field} must be a string of at most 500 characters${where}`, -32602);
    }
    return value;
  }
  if (field === 'plugins') {
    if (typeof value !== 'boolean') {
      throw new LushError(`agent plugins must be a boolean${where}`, -32602);
    }
    return value;
  }
  if (!Array.isArray(value) || value.some((flag) => typeof flag !== 'string' || flag.trim() === '' || flag.length > 500)) {
    throw new LushError(`agent flags must be a list of non-empty strings${where}`, -32602);
  }
  return [...value];
}

/**
 * Validate one profile object (the *file* content, not the resolved agent) and
 * return only the declared fields, in `PROFILE_FIELDS` order (so a written file
 * has a stable layout). Unknown fields are an error: a typo must not silently do
 * nothing.
 */
export function parseProfile(value, { path: file = null } = {}) {
  const where = file === null ? '' : ` (${file})`;
  if (!isPlainObject(value)) {
    throw new LushError(`agent profile must be a JSON object${where}`, -32602);
  }
  const unknown = Object.keys(value).filter((key) => !PROFILE_FIELDS.includes(key));
  if (unknown.length) {
    throw new LushError(`agent profile has unknown field ${unknown.join(', ')}${where}`
      + ` (expected ${PROFILE_FIELDS.join(', ')})`, -32602);
  }
  const declared = {};
  for (const field of PROFILE_FIELDS) {
    if (Object.hasOwn(value, field)) declared[field] = readProfileField(field, value[field], where);
  }
  return declared;
}

/** The plugin switches of one resolved agent: pure flags first, then extra flags. */
export function pluginArgs(withPlugins, flags = []) {
  return [...(withPlugins === true ? [] : PURE_PI_FLAGS), ...flags];
}

function envField(field, env) {
  const key = ENV_FIELDS[field];
  if (key === undefined) return undefined;
  const raw = env?.[key];
  return typeof raw === 'string' && raw !== '' ? raw : undefined;
}

/**
 * Turn one profile layer (see `ProfileStore.read`) into the effective agent
 * spec. Field by field: declared in the file → environment → built-in
 * fallback. `declared` keeps what the file itself said, so `inspect` can show
 * why a value came out the way it did.
 */
export function resolveAgentSpec(layer, { name = DEFAULT_AGENT_NAME, env = process.env } = {}) {
  const declared = layer?.declared ?? {};
  const pick = (field) => declared[field] ?? envField(field, env) ?? AGENT_FALLBACKS[field];
  const plugins = pick('plugins');
  const flags = [...pick('flags')];
  const source = layer?.source ?? 'builtin';
  const description = declared.description
    ?? (name === DEFAULT_AGENT_NAME && source === 'builtin' ? BUILTIN_DEFAULT_DESCRIPTION : '');
  const spec = {
    name,
    source,
    path: layer?.path ?? null,
    present: layer?.present === true,
    declared,
    provider: pick('provider'),
    command: pick('command'),
    pi_provider: pick('pi_provider'),
    model: pick('model'),
    plugins,
    flags,
    description,
    /** `true` when the pure flag set is in effect (the default). */
    pure: plugins !== true,
  };
  // One expansion function for both the real argv (`agent/pi_args.js`) and the
  // previews (`agent inspect`), so what is printed cannot drift from what runs.
  spec.plugin_args = pluginArgs(plugins === true);
  spec.argv_args = [...spec.plugin_args, ...flags];
  return spec;
}

/**
 * The profile files of one `$LUSH_HOME`. Reading and writing is all this does:
 * `read('default')` falls back to the built-in layer when no file exists, every
 * other missing name is an error.
 */
export class ProfileStore {
  constructor(home) {
    if (typeof home !== 'string' || home === '') {
      throw new LushError('agent profiles require the Lush home directory', -32602);
    }
    this.home = home;
    this.dir = path.join(home, 'agents');
  }

  file(name) {
    return path.join(this.dir, `${name}.json`);
  }

  exists(name) {
    return fs.existsSync(this.file(name));
  }

  /** One profile layer: what the file declares, plus where it came from. */
  read(name = DEFAULT_AGENT_NAME) {
    checkAgentName(name);
    const file = this.file(name);
    let raw = null;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      raw = null;
    }
    if (raw === null) {
      if (name !== DEFAULT_AGENT_NAME) {
        throw new LushError(`agent profile not found: ${name} (${file})`, -32004);
      }
      return { name, source: 'builtin', path: file, present: false, declared: {} };
    }
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new LushError(`invalid agent profile ${file}: not valid JSON`, -32602);
    }
    return { name, source: 'file', path: file, present: true, declared: parseProfile(value, { path: file }) };
  }

  /**
   * Every profile file, sorted by name. A broken file stays in the listing with
   * its error instead of failing the whole read: `lush agent list` is how you
   * find out that a hand-written profile is wrong.
   */
  list() {
    let files = [];
    try {
      files = fs.readdirSync(this.dir);
    } catch {
      files = [];
    }
    const names = files.filter((file) => file.endsWith('.json')).map((file) => file.slice(0, -'.json'.length)).sort();
    return names.map((name) => {
      try {
        return this.read(name);
      } catch (err) {
        return { name, source: 'file', path: this.file(name), present: true, error: err.message, declared: null };
      }
    });
  }

  /** Write one profile file; existing files are refused unless `force`. */
  write(name, declared, { force = false } = {}) {
    checkAgentName(name);
    const file = this.file(name);
    if (!force && fs.existsSync(file)) {
      throw new LushError(`agent profile already exists: ${name} (${file}); pass --force to overwrite`, -32010);
    }
    const parsed = parseProfile(declared, { path: file });
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    return { name, path: file, declared: parsed };
  }

  /** Delete one profile file; the built-in `default` refuses to go away. */
  remove(name) {
    checkAgentName(name);
    const file = this.file(name);
    if (name === DEFAULT_AGENT_NAME) {
      throw new LushError('the built-in default agent cannot be deleted (edit its override file instead)', -32010);
    }
    if (!fs.existsSync(file)) {
      throw new LushError(`agent profile not found: ${name} (${file})`, -32004);
    }
    fs.rmSync(file);
    return { name, path: file };
  }
}
