import fs from 'node:fs';
import path from 'node:path';
import { check, isPlainObject } from '../core/types.js';
import { AGENT_ROLES } from './prompts.js';
import { randomUUID } from 'node:crypto';
import { configurationHome, configurationScope, normalizeConfigurationScope, ensureConfigurationDirectory, withConfigurationWriteLock } from '../core/device-config.js';

const MAX_ENV_BYTES = 65536;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const AGENT_ENV_TARGETS = ['common', ...AGENT_ROLES];

function targetFile(config, target, scope = 'project') {
  check(AGENT_ENV_TARGETS.includes(target), `target must be one of ${AGENT_ENV_TARGETS.join(', ')}`);
  return path.join(configurationHome(config, scope), 'agent', target === 'common' ? 'agent.env' : `${target}.env`);
}

function safeAgentDir(config, create = false, scope = 'project') {
  const home = configurationHome(config, scope), dir = path.join(home, 'agent');
  if (create) { ensureConfigurationDirectory(config, scope); fs.mkdirSync(dir, { mode: 0o700, recursive: true }); }
  let root;
  try { root = fs.lstatSync(home); } catch (error) { if (error.code === 'ENOENT') return dir; throw error; }
  check(root.isDirectory() && !root.isSymbolicLink() && root.uid === process.getuid() && !(root.mode & 0o022)
    && (scope !== 'device' || !(root.mode & 0o077)) && fs.realpathSync(home) === home, 'unsafe agent environment directory');
  let stat;
  try { stat = fs.lstatSync(dir); } catch (error) { if (error.code === 'ENOENT') return dir; throw error; }
  check(!stat.isSymbolicLink() && stat.isDirectory() && stat.uid === process.getuid() && !(stat.mode & 0o022)
    && (!(scope === 'device' || create) || !(stat.mode & 0o077)), `unsafe agent environment directory: ${dir}`);
  return dir;
}

function readFile(file, scope = 'project') {
  let published;
  try { published = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  check(!published.isSymbolicLink(), `unsafe agent environment file: ${file}`);
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    check(stat.isFile() && stat.uid === process.getuid() && stat.nlink === 1
      && (scope !== 'device' || !(stat.mode & 0o077)), `unsafe agent environment file: ${file}`);
    check(stat.size <= MAX_ENV_BYTES, `${file} exceeds ${MAX_ENV_BYTES} bytes`);
    const source = fs.readFileSync(fd, 'utf8'), after = fs.fstatSync(fd), current = fs.lstatSync(file);
    check(Buffer.byteLength(source) <= MAX_ENV_BYTES && stat.dev === after.dev && stat.ino === after.ino
      && stat.size === after.size && stat.mtimeMs === after.mtimeMs && stat.dev === current.dev && stat.ino === current.ino,
    'agent environment file changed while reading');
    return source;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function normalizeValues(values) {
  check(isPlainObject(values), 'agent environment values must be an object');
  check(Object.keys(values).length <= 512, 'agent environment has too many variables');
  const normalized = {};
  for (const [name, value] of Object.entries(values)) {
    check(ENV_NAME.test(name), `invalid environment variable name: ${name || '(empty)'}`);
    check(!name.startsWith('LUSH_'), `${name} is reserved by Lush`);
    check(typeof value === 'string', `${name} must be a string`);
    check(!value.includes('\0'), `${name} contains NUL`);
    normalized[name] = value;
  }
  return normalized;
}

/** Per-task env overrides stored in a task-local Agent profile use the same name/value rules as role env files. */
export function normalizeAgentEnv(values) { return normalizeValues(values); }

function quoted(value) {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t')}"`;
}

function serializeValues(values) {
  const source = Object.keys(values).sort().map(name => `${name}=${quoted(values[name])}`).join('\n');
  return source ? `${source}\n` : '';
}

function quotedValue(raw, quote, file, lineNumber) {
  let value = '';
  for (let i = 1; i < raw.length; i += 1) {
    const char = raw[i];
    if (char === quote) {
      const tail = raw.slice(i + 1).trim();
      check(!tail || tail.startsWith('#'), `${file}:${lineNumber}: unexpected text after quoted value`);
      return value;
    }
    if (quote === '"' && char === '\\') {
      i += 1;
      check(i < raw.length, `${file}:${lineNumber}: unfinished escape`);
      const escaped = raw[i];
      value += ({ n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' })[escaped] ?? `\\${escaped}`;
    } else value += char;
  }
  check(false, `${file}:${lineNumber}: unterminated quoted value`);
}

export function parseAgentEnv(source, file = 'agent.env') {
  check(Buffer.byteLength(source) <= MAX_ENV_BYTES, `${file} exceeds ${MAX_ENV_BYTES} bytes`);
  const values = {};
  for (const [index, original] of source.replaceAll('\r\n', '\n').split('\n').entries()) {
    let line = original.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trimStart();
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    check(match, `${file}:${index + 1}: expected NAME=value`);
    const [, name, raw] = match;
    check(!name.startsWith('LUSH_'), `${file}:${index + 1}: ${name} is reserved by Lush`);
    let value;
    if (raw.startsWith('"') || raw.startsWith("'")) value = quotedValue(raw, raw[0], file, index + 1);
    else value = raw.replace(/\s+#.*$/, '').trim();
    check(!value.includes('\0'), `${file}:${index + 1}: value contains NUL`);
    values[name] = value;
  }
  return values;
}

export function readLocalAgentEnvironment(config, target, scope = 'project') {
  const file = targetFile(config, target, scope);
  safeAgentDir(config, false, scope);
  const source = readFile(file, scope);
  return { target, file, exists: source !== null, values: source === null ? {} : parseAgentEnv(source, file) };
}

function overlayEnvironment(values, layer) {
  for (const name of Object.keys(layer)) if (/^(https?_proxy|all_proxy|no_proxy)$/i.test(name)) {
    for (const previous of Object.keys(values)) if (previous.toLowerCase() === name.toLowerCase()) delete values[previous];
  }
  Object.assign(values, layer);
}

export function readAgentEnvironment(config, target, scope = 'project') {
  normalizeConfigurationScope(scope);
  const own = readLocalAgentEnvironment(config, target, scope);
  const inherited = scope === 'project' && config.deviceHome ? readLocalAgentEnvironment(config, target, 'device') : null;
  const values = {}; overlayEnvironment(values, inherited?.values || {}); overlayEnvironment(values, own.values);
  if (!config.deviceHome) return own;
  const source = own.exists && inherited?.exists ? 'mixed' : own.exists ? scope : inherited?.exists ? 'device' : 'default';
  return { ...own, values, sources: [inherited, own].filter(layer => layer?.exists).map(layer => layer.file),
    configuration_scope: configurationScope(config, scope, source, scope === 'project' && own.exists) };
}

/** Web/RPC editor storage: canonical NAME="value" output, atomically replaced with owner-only permissions. */
export function saveAgentEnvironment(config, target, values, scope = 'project') {
  const file = targetFile(config, target, scope);
  const normalized = normalizeValues(values);
  const serialized = serializeValues(normalized);
  check(Buffer.byteLength(serialized) <= MAX_ENV_BYTES, `agent environment exceeds ${MAX_ENV_BYTES} bytes`);
  // Round-trip through the runtime parser before touching disk, so the editor cannot write a file invocations cannot load.
  const parsed = parseAgentEnv(serialized, file);
  check(Object.keys(parsed).length === Object.keys(normalized).length
    && Object.entries(normalized).every(([name, value]) => parsed[name] === value), 'agent environment could not be serialized');
  return withConfigurationWriteLock(config, scope, lock => {
    safeAgentDir(config, true, scope);
    readFile(file, scope); // Reject unsafe aliases before rename/unlink.
    if (!serialized) {
      lock.assert(); fs.rmSync(file, { force: true });
      return readAgentEnvironment(config, target, scope);
    }
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, serialized, { mode: 0o600, flag: 'wx' });
      lock.assert(); safeAgentDir(config, false, scope); readFile(file, scope);
      fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
    return readAgentEnvironment(config, target, scope);
  });
}

export function clearAgentEnvironmentOverride(config, target) { return saveAgentEnvironment(config, target, {}); }

/** Pi-default mode uses the machine's own Pi environment; no Lush Agent env file is injected. */
export function emptyAgentEnvironment(role) {
  const resolvedRole = role === 'scheduler' ? 'planner' : role;
  check(AGENT_ROLES.includes(resolvedRole), `role must be one of ${AGENT_ROLES.join(', ')}`);
  return { role, resolved_role: resolvedRole, values: {}, sources: [], files: [] };
}

export function agentEnvironment(config, role) {
  const resolvedRole = role === 'scheduler' ? 'planner' : role;
  check(AGENT_ROLES.includes(resolvedRole), `role must be one of ${AGENT_ROLES.join(', ')}`);
  const layers = [
    ...(config.deviceHome ? [readLocalAgentEnvironment(config, 'common', 'device'), readLocalAgentEnvironment(config, resolvedRole, 'device')] : []),
    readLocalAgentEnvironment(config, 'common'), readLocalAgentEnvironment(config, resolvedRole),
  ];
  const values = {};
  const sources = [];
  for (const layer of layers) {
    if (!layer.exists) continue;
    // Preserve names while removing stale case aliases from lower layers.
    overlayEnvironment(values, layer.values);
    sources.push(layer.file);
  }
  const bytes = Object.entries(values).reduce((sum, [name, value]) => sum + Buffer.byteLength(name) + Buffer.byteLength(value) + 2, 0);
  check(bytes <= MAX_ENV_BYTES, `assembled ${resolvedRole} agent environment exceeds ${MAX_ENV_BYTES} bytes`);
  return { role, resolved_role: resolvedRole, values, sources, files: layers.map(layer => layer.file) };
}
