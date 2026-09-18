/**
 * `lush agent ...`: the client side of agent profiles.
 *
 * These commands never touch the daemon. A profile is a plain file under
 * `$LUSH_HOME/agents/`, so the CLI reads and writes it directly and keeps
 * working while `lushd` is stopped — that is the whole point of the command
 * group, and the difference from `lush service ...` (whose every verb is an RPC).
 *
 * Every function returns a plain JSON-able result; text rendering lives in
 * `format/agent.js`. The daemon resolves the same profile files at call time
 * (see `agent/catalog.js`), so a change made here applies to the next call
 * without restarting the daemon.
 */
import fs from 'node:fs';
import { LushError } from '../core/types.js';
import {
  DEFAULT_AGENT_NAME, ProfileStore, checkAgentName, resolveAgentSpec,
} from '../agent/profiles.js';
import { AgentCatalog } from '../agent/catalog.js';

function storeFor(config) {
  return new ProfileStore(config.home);
}

/**
 * The profile fields explicitly passed on the command line (others stay
 * untouched). `command` is the parser's own leaf id, so `--command` arrives as
 * `pi_command` and is mapped here.
 */
function fieldsFromArgs(args) {
  const patch = {};
  if (Object.hasOwn(args, 'provider')) patch.provider = args.provider;
  if (Object.hasOwn(args, 'pi_command')) patch.command = args.pi_command;
  if (Object.hasOwn(args, 'model')) patch.model = args.model;
  if (Object.hasOwn(args, 'pi_provider')) patch.pi_provider = args.pi_provider;
  if (Object.hasOwn(args, 'plugins')) patch.plugins = args.plugins;
  if (Object.hasOwn(args, 'flags')) patch.flags = args.flags;
  if (Object.hasOwn(args, 'description')) patch.description = args.description;
  return patch;
}

/**
 * The argv a profile would run, shown without requiring its binary to exist:
 * `agent inspect` must explain a profile on a machine that cannot run it yet.
 */
function previewProfile(config, spec) {
  if (spec.provider !== 'pi') {
    return {
      preview: null,
      preview_error: `agent ${spec.name} runs in-service (${spec.provider}); there is no external command line`,
    };
  }
  try {
    const catalog = new AgentCatalog({ home: config.home, env: process.env });
    return { preview: catalog.preview(spec), preview_error: null };
  } catch (err) {
    return { preview: null, preview_error: err?.message ?? String(err) };
  }
}

/** One profile, fully resolved: what it is, where it came from, and what it would run. */
function inspectProfile(config, name) {
  const store = storeFor(config);
  const file = store.file(name);
  const present = fs.existsSync(file);
  const base = {
    name,
    default: name === DEFAULT_AGENT_NAME,
    source: present ? 'file' : 'builtin',
    path: file,
    present,
  };
  let layer;
  try {
    layer = store.read(name);
  } catch (err) {
    return { ...base, valid: false, errors: [err?.message ?? String(err)] };
  }
  const spec = resolveAgentSpec(layer, { name, env: process.env });
  const { preview, preview_error: previewError } = previewProfile(config, spec);
  return {
    ...base,
    valid: true,
    errors: [],
    provider: spec.provider,
    command: spec.command,
    model: spec.model,
    pi_provider: spec.pi_provider,
    plugins: spec.plugins,
    pure: spec.pure,
    plugin_flags: spec.plugin_args,
    flags: spec.flags,
    argv_flags: spec.argv_args,
    description: spec.description,
    /** What the file itself declares; everything else comes from env / fallbacks. */
    declared: spec.declared,
    preview,
    preview_error: previewError,
  };
}

/** One `agent list` row. A broken file stays listed, with its validation error. */
function listRow(entry) {
  const base = {
    name: entry.name,
    default: entry.name === DEFAULT_AGENT_NAME,
    source: entry.source,
    path: entry.path,
    present: entry.present === true,
  };
  if (entry.declared === null) return { ...base, valid: false, error: entry.error };
  const spec = resolveAgentSpec(entry, { name: entry.name, env: process.env });
  return {
    ...base,
    valid: true,
    error: null,
    provider: spec.provider,
    command: spec.command,
    model: spec.model,
    pi_provider: spec.pi_provider,
    plugins: spec.plugins,
    pure: spec.pure,
    flags: spec.flags,
    description: spec.description,
  };
}

export function agentList(config) {
  const store = storeFor(config);
  const entries = store.list();
  // The built-in default is always present, even when it has no override file.
  if (!entries.some((entry) => entry.name === DEFAULT_AGENT_NAME)) entries.unshift(store.read(DEFAULT_AGENT_NAME));
  entries.sort((left, right) => {
    if (left.name === DEFAULT_AGENT_NAME) return right.name === DEFAULT_AGENT_NAME ? 0 : -1;
    if (right.name === DEFAULT_AGENT_NAME) return 1;
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
  return {
    action: 'list',
    home: config.home,
    dir: store.dir,
    default_agent: DEFAULT_AGENT_NAME,
    agents: entries.map(listRow),
  };
}

export function agentInspect(config, args) {
  const name = checkAgentName(args.name);
  const store = storeFor(config);
  // A missing profile is a plain "not found" (exit 1); a *broken* file is still
  // inspectable, because reporting the validation error is the point.
  if (!store.exists(name) && name !== DEFAULT_AGENT_NAME) store.read(name);
  return { action: 'inspect', ...inspectProfile(config, name) };
}

export function agentAdd(config, args) {
  const store = storeFor(config);
  const name = checkAgentName(args.name);
  // `provider` is the one field with a default: a new profile should say which
  // backend it is about, everything else legitimately inherits.
  const declared = { provider: 'pi', ...fieldsFromArgs(args) };
  const existed = store.exists(name);
  const written = store.write(name, declared, { force: args.force === true });
  return { action: 'add', name, path: written.path, overwrote: existed, profile: written.declared };
}

export function agentEdit(config, args) {
  const store = storeFor(config);
  const name = checkAgentName(args.name);
  const patch = fieldsFromArgs(args);
  if (Object.keys(patch).length === 0) {
    throw new LushError('nothing to change: pass at least one option (see --help)', -32602);
  }
  const existed = store.exists(name);
  const base = existed ? store.read(name).declared : {};
  const written = store.write(name, { ...base, ...patch }, { force: true });
  return { action: 'edit', name, path: written.path, created: !existed, profile: written.declared };
}

export function agentDelete(config, args) {
  const store = storeFor(config);
  const name = checkAgentName(args.name);
  const removed = store.remove(name);
  return { action: 'delete', name, path: removed.path };
}

/**
 * `lush agent default` shows the effective default agent; `lush agent default
 * <name>` copies that profile's own fields onto `default`, i.e. it writes
 * `$LUSH_HOME/agents/default.json`. The built-in default itself never changes
 * and is never deleted: this only adds (or replaces) the override file.
 */
export function agentDefault(config, args = {}) {
  const store = storeFor(config);
  if (args.name === undefined) {
    return { ...inspectProfile(config, DEFAULT_AGENT_NAME), action: 'default', copied_from: null };
  }
  const source = checkAgentName(args.name);
  const layer = store.read(source); // a missing source profile fails here
  store.write(DEFAULT_AGENT_NAME, layer.declared, { force: true });
  return { ...inspectProfile(config, DEFAULT_AGENT_NAME), action: 'default', copied_from: source };
}

export function agentPath(config) {
  const store = storeFor(config);
  return { action: 'path', home: config.home, dir: store.dir };
}
