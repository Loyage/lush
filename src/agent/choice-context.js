import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const MAX = 64 * 1024 * 1024;
export const choiceDigest = bytes => createHash('sha256').update(bytes).digest('hex');
const validId = id => { if (!Number.isSafeInteger(id) || id < 1) throw new Error('invalid choice resource identity'); return id; };
export const choiceContextPath = (home, noticeId) => path.join(home, 'choice-snapshots', `notice-${validId(noticeId)}.jsonl`);
export const choiceForkPath = (home, taskId) => path.join(home, 'choice-contexts', `task-${validId(taskId)}.jsonl`);

/** No ancestor symlinks, no external paths, and bounded private regular files. */
export function readChoiceFile(home, filename, digest = null) {
  const root = path.resolve(home), target = path.resolve(filename);
  if (!target.startsWith(root + path.sep)) throw new Error('choice context outside project home');
  let current = root;
  for (const part of ['', ...path.relative(root, target).split(path.sep)]) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('choice context path is a symlink');
  }
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > MAX) throw new Error('choice context is not a bounded regular file');
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length > MAX)
      throw new Error('choice context changed during read');
    if (digest && choiceDigest(bytes) !== digest) throw new Error('choice context no longer matches its checkpoint');
    return bytes;
  } finally { fs.closeSync(fd); }
}

export function writeChoiceFile(home, filename, bytes) {
  const root = path.resolve(home), dir = path.dirname(filename);
  if (path.dirname(dir) !== root || !['choice-snapshots','choice-contexts'].includes(path.basename(dir))) throw new Error('invalid choice context directory');
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('choice home is a symlink');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('choice directory is a symlink');
  fs.writeFileSync(filename, bytes, { mode: 0o600, flag: 'wx' });
}

/** Copy only the attested pre-answer branch, not appended answers or unrelated branches.
 * This uses Pi's documented v2/v3 session tree format, without loading SDK/extensions. */
export function freezeChoiceContext(home, taskId, pointer) {
  if (!pointer?.entry || typeof pointer.session !== 'string') throw new Error('missing choice context marker');
  const source = path.resolve(pointer.session), sessions = path.resolve(home, 'sessions');
  if (path.dirname(source) !== sessions || !path.basename(source).endsWith(`_lush-task-${validId(taskId)}.jsonl`))
    throw new Error('choice marker does not belong to the source Worker');
  const entries = readChoiceFile(home, source).toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  const header = entries.shift();
  if (header?.type !== 'session' || !header.id || ![2,3].includes(header.version)) throw new Error('unsupported Pi session format');
  const byId = new Map();
  for (const entry of entries) {
    if (typeof entry.id !== 'string' || byId.has(entry.id)) throw new Error('invalid Pi session entry identity');
    byId.set(entry.id, entry);
  }
  const branch = [], visited = new Set();
  let leaf = pointer.entry;
  while (leaf !== null) {
    if (visited.has(leaf)) throw new Error('cyclic Pi session');
    const entry = byId.get(leaf);
    if (!entry || !(entry.parentId === null || typeof entry.parentId === 'string')) throw new Error('incomplete Pi session branch');
    visited.add(leaf); branch.push(entry); leaf = entry.parentId;
  }
  branch.reverse();
  const pending = new Set();
  for (const entry of branch) {
    if (entry.type === 'message' && entry.message?.role === 'assistant') {
      if (pending.size) throw new Error('incomplete Pi tool boundary');
      for (const content of entry.message.content ?? []) if (content.type === 'toolCall') pending.add(content.id);
    } else if (entry.type === 'message' && entry.message?.role === 'toolResult') pending.delete(entry.message.toolCallId);
    if (entry.type === 'compaction' && !visited.has(entry.firstKeptEntryId)) throw new Error('incomplete Pi compaction boundary');
  }
  if (pending.size) throw new Error('incomplete Pi tool boundary');
  // A self-contained copy must not advertise the old mutable file as its parent.
  const { parentSession: _parent, ...standalone } = header;
  return Buffer.from([standalone, ...branch].map(entry => JSON.stringify(entry)).join('\n') + '\n');
}
