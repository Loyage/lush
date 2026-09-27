import fs from 'node:fs';
import path from 'node:path';

/** Pi's --fork copies the whole source file, not an arbitrary point in its tree. Make a
 * frozen, single-branch JSONL source ending at the entry recorded with the Git commit. */
export function forkCheckpoint(home, pointer) {
  const sessions = path.resolve(home, 'sessions');
  const source = path.resolve(pointer.session);
  if (!/^[0-9a-f]{40,64}$/.test(pointer.commit)) throw new Error('invalid checkpoint commit');
  if (!source.startsWith(sessions + path.sep) || !source.endsWith('.jsonl')) throw new Error('Pi checkpoint is outside project sessions');
  const dir = path.join(home, 'session-checkpoints');
  const filename = path.join(dir, `${pointer.commit}.jsonl`);
  if (fs.existsSync(filename)) return filename; // The first fork freezes the source, even if Pi later appends to it.
  if (!fs.realpathSync(source).startsWith(fs.realpathSync(sessions) + path.sep)) throw new Error('Pi checkpoint is outside project sessions');
  if (fs.statSync(source).size > 64 * 1024 * 1024) throw new Error('Pi checkpoint source exceeds 64 MiB');
  const lines = fs.readFileSync(source, 'utf8').trimEnd().split('\n');
  const entries = lines.map(line => JSON.parse(line));
  if (entries[0]?.type !== 'session' || !entries[0].id || !pointer.entry) throw new Error('invalid Pi checkpoint');
  const byId = new Map(entries.slice(1).map(entry => [entry.id, entry]));
  const branch = [], visited = new Set();
  let id = pointer.entry;
  while (id !== null) {
    if (visited.has(id)) throw new Error('cyclic Pi checkpoint');
    visited.add(id);
    const entry = byId.get(id);
    if (!entry) throw new Error(`missing Pi entry ${id}`);
    branch.push(entry);
    id = entry.parentId;
  }
  branch.reverse();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Checkpoint is immutable per commit. A failed earlier attempt must not leave a partial source.
  const temporary = `${filename}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, [entries[0], ...branch].map(entry => JSON.stringify(entry)).join('\n') + '\n', { mode: 0o600 });
    fs.renameSync(temporary, filename);
  } finally { fs.rmSync(temporary, { force: true }); }
  return filename;
}

/** The marker is written by the Pi extension at tool boundaries, never by the model. */
export function readCommitPointer(home, taskId, runId) {
  const file = path.join(home, 'sessions', `task-${taskId}-context.json`);
  try {
    const marker = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (marker.task_id !== taskId || marker.run_id !== runId || !marker.entry ||
      !marker.session || !path.resolve(marker.session).startsWith(path.resolve(home, 'sessions') + path.sep)) return null;
    return marker;
  } catch { return null; }
}
