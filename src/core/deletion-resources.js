import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { check } from './types.js';

export const deletionHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function present(file) { try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }

/** Only project-private roots. Never follow a root or an ancestor symlink, even when absent. */
export function deletionPath(config, file) {
  const home = path.resolve(config.home), resolved = path.resolve(file);
  check(resolved.startsWith(home + path.sep), `resource is outside project home: ${file}`);
  const relative = path.relative(config.project, resolved);
  check(!relative.startsWith('..'), `resource is outside project: ${file}`);
  let current = config.project;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const stat = present(current);
    check(!stat?.isSymbolicLink(), `resource path is a symlink: ${current}`);
  }
  return resolved;
}

/** Revision includes ignored/untracked contents' metadata too. Descendant links are not followed. */
export function deletionFingerprint(config, file) {
  const root = deletionPath(config, file), entries = [];
  const visit = (name, depth = 0) => {
    check(depth < 100 && entries.length < 20000, `resource too large to safely preview: ${root}`);
    const stat = present(name);
    if (!stat) { entries.push([path.relative(root, name), null]); return; }
    entries.push([path.relative(root, name), stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs,
      stat.isSymbolicLink() ? fs.readlinkSync(name) : null]);
    if (stat.isDirectory()) for (const child of fs.readdirSync(name).sort()) visit(path.join(name, child), depth + 1);
  };
  visit(root);
  return deletionHash(entries);
}

/** No recursive directory scanning outside known private roots; file naming is exact-ID anchored. */
export function workerFiles(config, tasks, contexts) {
  const home = config.home, files = new Set();
  const add = (file, directory = false) => {
    deletionPath(config, file);
    const stat = present(file);
    if (!stat) return;
    check(directory ? stat.isDirectory() : stat.isFile(), `resource has unexpected type or ownership: ${file}`);
    files.add(file);
  };
  const sessions = path.join(home, 'sessions');
  deletionPath(config, sessions);
  const names = present(sessions) ? fs.readdirSync(sessions) : [];
  for (const task of tasks) {
    const id = task.id;
    for (const name of names) if (name.endsWith(`_lush-task-${id}.jsonl`) ||
      new RegExp(`^(?:task-${id}-(?:input|system)\\.md|task-${id}-context\\.json(?:\\.\\d+\\.tmp)?|decision-${id}\\.json|codex-task-${id}(?:-result\\.md|\\.json(?:\\.\\d+\\.tmp)?))$`).test(name)) add(path.join(sessions, name));
    add(path.join(home, 'task-rules', `task-${id}.mjs`));
    for (const suffix of ['request.json', 'stop.json']) add(path.join(home, 'preempt', `task-${id}.${suffix}`));
    add(path.join(home, 'verify', String(id)), true);
  }
  for (const context of contexts) {
    check(/^[0-9a-f]{40,64}$/.test(context.commit_hash), 'invalid commit context identity');
    add(path.join(home, 'session-checkpoints', `${context.commit_hash}.jsonl`));
    const checkpoints = path.join(home, 'session-checkpoints');
    deletionPath(config, checkpoints);
    for (const name of present(checkpoints) ? fs.readdirSync(checkpoints) : [])
      if (new RegExp(`^${context.commit_hash}\\.jsonl\\.\\d+\\.tmp$`).test(name)) add(path.join(checkpoints, name));
    if (context.session_path) {
      check(path.resolve(context.session_path).startsWith(path.resolve(sessions) + path.sep), 'commit context session is outside project sessions');
      check(path.basename(context.session_path).endsWith(`_lush-task-${context.task_id}.jsonl`), 'commit context session has unknown Worker ownership');
      add(path.resolve(context.session_path));
    }
  }
  return [...files].sort();
}
