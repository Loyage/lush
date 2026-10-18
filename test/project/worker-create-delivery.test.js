import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until } from '../helpers.js';

async function setup() {
  const f = fixture({ async run({ cwd, task }) {
    fs.writeFileSync(path.join(cwd, 'fork-change.txt'), `fork ${task.id}\n`);
    await git(cwd, 'add', '.'); await git(cwd, 'commit', '-m', 'fork first change');
    return 'fork completed';
  } });
  f.project.kick = () => {}; await repo(f.root);
  const source = (await f.project.order('source', 'main', [], null, false)).task;
  fs.writeFileSync(path.join(source.workspace, 'source-change.txt'), 'committed source\n');
  await git(source.workspace, 'add', '.'); await git(source.workspace, 'commit', '-m', 'source change');
  const commit = await git(source.workspace, 'rev-parse', 'HEAD');
  const session = path.join(f.config.home, 'sessions', 'source.jsonl'); fs.mkdirSync(path.dirname(session), { recursive: true });
  fs.writeFileSync(session, [{ type: 'session', id: 'source-session' }, { type: 'message', id: 'entry', parentId: null,
    message: { role: 'user', content: 'source checkpoint' } }].map(JSON.stringify).join('\n') + '\n');
  f.store.run('INSERT INTO commit_contexts(commit_hash,task_id,session_path,entry_id) VALUES (?,?,?,?)', commit, source.id, session, 'entry');
  f.project.configureTask(source.id, { agent: 'pi', model: 'deepseek/deepseek-chat' });
  return { ...f, source };
}

test('fork from sibling baseline uses its actual parent for explicit Squash, never source ownership or inherited Hook policy', async () => {
  const f = await setup();
  try {
    const { project: p, source } = f;
    const defaults = p.automationSettings(); p.setCompletionDefaults(true, 'merge', defaults.revision);
    f.store.update(source.id, { auto_merge: JSON.stringify({ version: 1, enabled: true, locked: true }) });
    const fork = (await p.createWorker({ mode: 'fork', source: source.id })).task;
    expect(p.autoMergeView(f.store.task(fork.id)).enabled).toBe(false);
    const main = await git(f.root, 'rev-parse', 'main'), sourceHead = await git(source.workspace, 'rev-parse', 'HEAD');
    p.message(fork.id, 'first user work'); p.pump();
    await until(() => !p.running.size && f.store.task(fork.id).result, 10000);
    expect(f.store.task(fork.id).integration).toBe('pending');
    expect(await git(f.root, 'rev-parse', 'main')).toBe(main); // default stays off even when global completion default is merge
    await p.requestTaskMerge(fork.id); await p.settleQueuedMerge(fork.id);
    await until(() => f.store.task(fork.id).integration === 'merged', 10000);
    expect(await git(f.root, 'show', 'main:source-change.txt')).toBe('committed source');
    expect(await git(f.root, 'show', 'main:fork-change.txt')).toBe(`fork ${fork.id}`);
    expect(await git(source.workspace, 'rev-parse', 'HEAD')).toBe(sourceHead);
    expect(f.store.task(fork.id)).toMatchObject({ parent_id: source.parent_id, target_branch: 'main' });
    expect(f.store.branch(fork.branch).parent).toBe('main');
  } finally { await f.close(); }
});

test('parent divergence cannot silently swallow source/target ancestry gates: fixed repair is pinned to real parent, not fork source', async () => {
  const f = await setup();
  try {
    const { project: p, source } = f;
    const fork = (await p.createWorker({ mode: 'fork', source: source.id })).task;
    fs.writeFileSync(path.join(f.root, 'parent-change.txt'), 'parent work\n');
    await git(f.root, 'add', '.'); await git(f.root, 'commit', '-m', 'new parent work');
    const parentHead = await git(f.root, 'rev-parse', 'main'), sourceHead = await git(source.workspace, 'rev-parse', 'HEAD');
    p.message(fork.id, 'first fork work'); p.pump(); await until(() => !p.running.size && f.store.task(fork.id).result, 10000);
    const forkHead = await git(fork.workspace, 'rev-parse', 'HEAD');
    await p.requestTaskMerge(fork.id); await p.settleQueuedMerge(fork.id);
    await until(() => JSON.parse(f.store.task(fork.id).reservation).status === 'resolving', 10000);
    const booking = JSON.parse(f.store.task(fork.id).reservation);
    expect(booking).toMatchObject({ parent_id: source.parent_id, baseline: parentHead, commit: forkHead, status: 'resolving' });
    expect(await git(f.root, 'rev-parse', 'main')).toBe(parentHead);
    expect(await git(source.workspace, 'rev-parse', 'HEAD')).toBe(sourceHead);
    expect(f.store.task(fork.id).parent_id).toBe(source.parent_id);
    expect(p.activeTaskMerge(source.parent_id).id).toBe(fork.id);
    expect(f.store.get("SELECT id FROM events WHERE task_id=? AND type='task.reparented_for_merge'", fork.id)).toBeNull();
  } finally { await f.close(); }
});
