import fs from 'node:fs';
import path from 'node:path';
import { check, isPlainObject } from '../core/types.js';
import { safeAdministratorValue } from './delegation.js';

const privateName = name => name.startsWith('.') || /(?:^|[._-])(?:auth|credentials?|secrets?|tokens?|passwords?|private|id_rsa|id_ed25519)(?:[._-]|$)/i.test(name)
  || /\.(?:pem|key|p12|pfx|sqlite|db|jsonl|log)$/i.test(name);
/** Only code-owned current-project source access. No project, cwd, environment or absolute-path override. */
export function readProjectAdministratorSource(project, params, listing = false) {
  check(isPlainObject(params) && Object.keys(params).every(key => ['path','offset','limit'].includes(key)), 'invalid project source fields');
  check(typeof params.path === 'string' && params.path.length <= 4096 && !path.isAbsolute(params.path) && !/[\\\0]/.test(params.path), 'relative project source path required');
  const parts = params.path.split('/').filter(Boolean);
  check(parts.every(part => !['.','..'].includes(part) && !privateName(part)), 'private source path unavailable');
  let file = project.config.project;
  for (const part of parts) { file = path.join(file, part); check(!fs.lstatSync(file).isSymbolicLink(), 'source symlinks unavailable'); }
  const stat = fs.lstatSync(file);
  check(fs.realpathSync(file) === file && stat.uid === process.getuid() && (listing ? stat.isDirectory() : stat.isFile() && stat.nlink === 1), 'source path or ownership changed');
  const offset = params.offset ?? (listing ? 0 : 1), limit = params.limit ?? (listing ? 100 : 100);
  check(Number.isSafeInteger(offset) && offset >= (listing ? 0 : 1) && Number.isSafeInteger(limit) && limit >= 1 && limit <= (listing ? 100 : 2000), 'invalid project source page');
  if (listing) {
    const entries = fs.readdirSync(file, { withFileTypes: true }).filter(item => !privateName(item.name) && !item.isSymbolicLink() && (item.isDirectory() || item.isFile())).sort((a,b) => a.name.localeCompare(b.name));
    const items = entries.slice(offset,offset + limit).map(item => ({ name: item.name, kind: item.isDirectory() ? 'directory' : 'file' }));
    return { items, next: offset + items.length, has_more: entries.length > offset + items.length, coverage: 'eligible_current_project_sources_only' };
  }
  check(stat.size <= 1024 * 1024, 'source read exceeds budget');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let content;
  try {
    const before = fs.fstatSync(fd); check(before.ino === stat.ino && before.dev === stat.dev, 'source changed');
    content = fs.readFileSync(fd,'utf8');
    const after = fs.fstatSync(fd), current = fs.lstatSync(file);
    check(before.ino === current.ino && before.dev === current.dev && before.size === after.size && before.mtimeMs === after.mtimeMs, 'source changed while reading');
  } finally { fs.closeSync(fd); }
  check(!content.includes('\0'), 'binary source unavailable');
  const lines = content.split('\n'), selected = lines.slice(offset - 1, offset - 1 + limit).join('\n');
  check(Buffer.byteLength(selected) <= 16000, 'source page exceeds native receipt budget; request fewer lines');
  return { content: safeAdministratorValue(selected), offset, next: offset + Math.min(limit, Math.max(0,lines.length - offset + 1)), has_more: lines.length >= offset + limit, coverage: 'current_project_source_secret_patterns_redacted' };
}
