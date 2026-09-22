import fs from 'node:fs';
import path from 'node:path';
import { check, isPlainObject } from '../core/types.js';
import { AGENT_ROLES } from './prompts.js';

const MAX_ENV_BYTES = 65536;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const AGENT_ENV_TARGETS = ['common', ...AGENT_ROLES];

function targetFile(config, target) {
  check(AGENT_ENV_TARGETS.includes(target), `target must be one of ${AGENT_ENV_TARGETS.join(', ')}`);
  return path.join(config.home, 'agent', target === 'common' ? 'agent.env' : `${target}.env`);
}

function safeAgentDir(config, create = false) {
  const dir = path.join(config.home, 'agent');
  if (create) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(dir)) return dir;
  const stat = fs.lstatSync(dir);
  check(!stat.isSymbolicLink() && stat.isDirectory() && stat.uid === process.getuid(), `unsafe agent environment directory: ${dir}`);
  if (create) fs.chmodSync(dir, 0o700);
  return dir;
}

function readFile(file) {
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  check(!stat.isSymbolicLink() && stat.isFile() && stat.uid === process.getuid(), `unsafe agent environment file: ${file}`);
  check(stat.size <= MAX_ENV_BYTES, `${file} exceeds ${MAX_ENV_BYTES} bytes`);
  return fs.readFileSync(file, 'utf8');
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

export function readAgentEnvironment(config, target) {
  safeAgentDir(config);
  const file = targetFile(config, target);
  const source = readFile(file);
  return { target, file, exists: source !== null, values: source === null ? {} : parseAgentEnv(source, file) };
}

/** Web/RPC editor storage: canonical NAME="value" output, atomically replaced with owner-only permissions. */
export function saveAgentEnvironment(config, target, values) {
  const file = targetFile(config, target);
  const normalized = normalizeValues(values);
  const serialized = serializeValues(normalized);
  check(Buffer.byteLength(serialized) <= MAX_ENV_BYTES, `agent environment exceeds ${MAX_ENV_BYTES} bytes`);
  // Round-trip through the runtime parser before touching disk, so the editor cannot write a file invocations cannot load.
  const parsed = parseAgentEnv(serialized, file);
  check(Object.keys(parsed).length === Object.keys(normalized).length
    && Object.entries(normalized).every(([name, value]) => parsed[name] === value), 'agent environment could not be serialized');
  safeAgentDir(config, true);
  readFile(file); // Reject a pre-existing symlink or foreign-owned path before rename/unlink.
  if (!serialized) {
    fs.rmSync(file, { force: true });
    return { target, file, exists: false, values: {} };
  }
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, serialized, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally { fs.rmSync(temporary, { force: true }); }
  return readAgentEnvironment(config, target);
}

export function agentEnvironment(config, role) {
  const resolvedRole = role === 'scheduler' ? 'planner' : role;
  check(AGENT_ROLES.includes(resolvedRole), `role must be one of ${AGENT_ROLES.join(', ')}`);
  const layers = [readAgentEnvironment(config, 'common'), readAgentEnvironment(config, resolvedRole)];
  const values = {};
  const sources = [];
  for (const layer of layers) {
    if (!layer.exists) continue;
    Object.assign(values, layer.values);
    sources.push(layer.file);
  }
  const bytes = Object.entries(values).reduce((sum, [name, value]) => sum + Buffer.byteLength(name) + Buffer.byteLength(value) + 2, 0);
  check(bytes <= MAX_ENV_BYTES, `assembled ${resolvedRole} agent environment exceeds ${MAX_ENV_BYTES} bytes`);
  return { role, resolved_role: resolvedRole, values, sources, files: layers.map(layer => layer.file) };
}
