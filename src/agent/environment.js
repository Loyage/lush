import fs from 'node:fs';
import path from 'node:path';
import { check } from '../core/types.js';
import { AGENT_ROLES } from './prompts.js';

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
  check(Buffer.byteLength(source) <= 65536, `${file} exceeds 65536 bytes`);
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

export function agentEnvironment(config, role) {
  const resolvedRole = role === 'scheduler' ? 'planner' : role;
  check(AGENT_ROLES.includes(resolvedRole), `role must be one of ${AGENT_ROLES.join(', ')}`);
  const dir = path.join(config.home, 'agent');
  const files = [path.join(dir, 'agent.env'), path.join(dir, `${resolvedRole}.env`)];
  const values = {};
  const sources = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    Object.assign(values, parseAgentEnv(fs.readFileSync(file, 'utf8'), file));
    sources.push(file);
  }
  const bytes = Object.entries(values).reduce((sum, [name, value]) => sum + Buffer.byteLength(name) + Buffer.byteLength(value) + 2, 0);
  check(bytes <= 65536, `assembled ${resolvedRole} agent environment exceeds 65536 bytes`);
  return { role, resolved_role: resolvedRole, values, sources, files };
}
