import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { Store } from '../../src/persistence/store.js';
import iteration from '../../src/core/project/iteration.js';
import { TERMINAL, isSettled } from '../../src/core/types.js';
import { tokenHash } from '../../src/core/project/internal.js';
import { fixture, repo, git, until } from '../helpers.js';

function setup(provider) {
  const f = fixture(provider);
  Object.assign(f.project, iteration); // Production registration is owned by the parent Task.
  f.project.stopping = true;
  return f;
}
async function commit(dir, file, body) {
  fs.writeFileSync(path.join(dir, file), body);
  await git(dir, 'add', file); await git(dir, 'commit', '-m', file);
  return git(dir, 'rev-parse', 'HEAD');
}
async function deliver(f, source) {
  await f.project.reserveTask(source.id, 'merge');
  f.project.stopping = false;
  const kick = f.project.kick; f.project.kick = () => {};
  try { await f.project.driveTaskMerge(source.parent_id); }
  finally { f.project.kick = kick; f.project.stopping = true; }
  return f.store.task(source.id);
}
async function sourceTask(f, name = 'source') {
  const { task } = await f.project.say(name);
  await commit(task.workspace, `${name}.txt`, 'first\n');
  f.store.update(task.id, { status: 'waiting', result: 'first delivery' });
  return task;
}

test('multi-round Squash retains parent advances, Task identity, conversation and immutable receipts', async () => {
  const f = setup({ resolve() { return { agent: 'mock' }; }, async run({ cwd, messages }) {
    const repair = messages.find(message => message.body.includes('合并分歧'));
    if (repair) await git(cwd, 'merge', '--no-edit', repair.body.match(/[0-9a-f]{40}/)[0]);
    else await commit(cwd, 'second.txt', 'second iteration\n');
    return repair ? 'repaired and tested' : 'second delivery';
  } });
  await repo(f.root);
  try {
    const source = await sourceTask(f);
    const first = await deliver(f, source);
    expect(first).toMatchObject({ id: source.id, status: 'awaiting_acceptance', integration: 'merged', base_commit: source.base_commit });
    expect(TERMINAL.has(first.status)).toBe(false); expect(isSettled(first)).toBe(true);
    const receipt = JSON.parse(first.reservation);
    const repeated = await f.project.reserveTask(source.id, 'merge');
    expect(repeated.changed).toBe(false);
    expect(JSON.parse(f.store.task(source.id).reservation)).toEqual(receipt);
    await commit(f.root, 'parent.txt', 'new parent work must survive\n');
    f.project.stopping = false;
    f.project.message(source.id, 'please add the second iteration');
    expect(f.store.task(source.id).reservation).toBeNull();
    await until(() => f.store.task(source.id).status === 'waiting' && !f.project.running.has(source.id));
    expect(f.store.task(source.id).integration).toBe('pending');
    await f.project.reserveTask(source.id, 'merge');
    await until(() => f.store.task(source.id).status === 'awaiting_acceptance' && f.store.history(source.id).filter(event => event.type === 'task.merge_integrated').length === 2, 8000);
    const final = f.store.task(source.id);
    expect(final).toMatchObject({ id: source.id, parent_id: source.parent_id, branch: source.branch,
      workspace: source.workspace, base_commit: source.base_commit, calls: 2 });
    for (const file of ['source.txt', 'second.txt', 'parent.txt']) expect(await git(f.root, 'show', `main:${file}`)).toBeTruthy();
    expect(await git(f.root, 'rev-list', '--count', `${source.base_commit}..main`)).toBe('3');
    const receipts = f.store.history(source.id).filter(event => event.type === 'task.merge_integrated');
    expect(receipts[0].data).toMatchObject({ source_commit: receipt.commit, commit: receipt.landed_commit, parent_id: source.parent_id });
    expect(receipts[1].data.source_commit).toBe(final.head_commit);
    expect(final.iteration_base_commit).toBe(final.head_commit);
    await until(() => !f.project.running.has(source.id));
    const accepted = await f.project.acceptTask(source.id);
    expect(accepted.status).toBe('completed'); expect(fs.existsSync(source.workspace)).toBe(true);
    expect(() => f.project.message(source.id, 'not without reopening')).toThrow('ended');
    await f.project.workspaces.cleanup(source.id);
    await expect(f.project.reopenTask(source.id)).rejects.toThrow('archived');
  } finally { await f.close(); }
});

test('a no-op follow-up consumes the old booking without losing Squash cleanup evidence', async () => {
  const f = setup({ resolve() { return { agent: 'mock' }; }, async run() { return 'nothing else needed'; } });
  await repo(f.root);
  try {
    const source = await sourceTask(f);
    await deliver(f, source);
    f.project.stopping = false; f.project.message(source.id, 'just explain the result');
    await until(() => f.store.task(source.id).status === 'awaiting_acceptance' && !f.project.running.has(source.id));
    expect(f.store.task(source.id).reservation).toBeNull();
    expect(f.store.task(source.id).integration).toBe('merged');
    expect(f.store.history(source.id).filter(event => event.type === 'task.merge_integrated')).toHaveLength(1);
    await f.project.acceptTask(source.id);
    await f.project.workspaces.cleanup(source.id);
    expect(f.store.task(source.id).branch).toBeNull();
  } finally { await f.close(); }
});

test('no-change delegated delivery keeps legacy completion and is not a historical merged Task', async () => {
  const f = setup({ resolve() { return { agent: 'mock' }; }, async run() { return 'collected'; } });
  await repo(f.root);
  try {
    const { task: parent } = await f.project.say('parent'); f.store.update(parent.id, { status: 'waiting' });
    const child = await f.project.spawn(parent.id, 'answer first, code later');
    f.project.stopping = false; f.project.kick();
    await until(() => f.store.task(child.id).status === 'completed' && f.store.task(parent.id).calls === 1 && f.store.task(parent.id).status === 'waiting');
    expect(f.store.task(child.id).reservation).toBeNull();
    await expect(f.project.reopenTask(child.id)).rejects.toThrow('completed/merged');
    expect(f.store.task(child.id)).toMatchObject({ integration: 'none', status: 'completed', calls: 1 });
    expect(f.project.reservationWaitReason(f.store.task(parent.id))).toBeNull();
  } finally { await f.close(); }
});

test('delivered unaccepted descendants do not block parent delivery, but must be accepted before parent completion', async () => {
  const f = setup(); await repo(f.root);
  try {
    const { task: parent } = await f.project.say('parent'); f.store.update(parent.id, { status: 'waiting' });
    const child = await f.project.spawn(parent.id, 'child');
    await commit(child.workspace, 'nested.txt', 'nested\n'); f.store.update(child.id, { status: 'waiting' });
    await deliver(f, child);
    // Consume the parent receipt as if its collecting invocation has returned.
    f.store.run('UPDATE messages SET consumed=1 WHERE task_id=?', parent.id);
    f.store.update(parent.id, { status: 'waiting' });
    expect(f.project.reservationWaitReason(f.store.task(parent.id))).toBeNull();
    await deliver(f, parent);
    expect(f.store.task(parent.id).status).toBe('awaiting_acceptance');
    await expect(f.project.acceptTask(parent.id)).rejects.toThrow('descendants');
    await f.project.acceptTask(child.id);
    await f.project.acceptTask(parent.id);
    await expect(f.project.reopenTask(child.id)).rejects.toThrow('parent has ended');
    await expect(f.project.reopenTask(parent.id)).rejects.toThrow('accepted Tasks cannot be reopened');
    expect(f.store.task(child.id).status).toBe('completed');
    expect(f.store.task(child.id).calls).toBe(0);
  } finally { await f.close(); }
});

test('accepted and archived child resources do not block later parent acceptance', async () => {
  const f = setup(); await repo(f.root);
  try {
    const { task: parent } = await f.project.say('parent'); f.store.update(parent.id, { status: 'waiting' });
    const child = await f.project.spawn(parent.id, 'child');
    await commit(child.workspace, 'archived-child.txt', 'child\n');
    f.store.update(child.id, { status: 'waiting' });
    await deliver(f, child);
    f.store.run('UPDATE messages SET consumed=1 WHERE task_id=?', parent.id);
    f.store.update(parent.id, { status: 'waiting' });
    await deliver(f, parent);
    await f.project.acceptTask(child.id);
    await f.project.archiveBranch(child.branch);
    expect((await f.project.acceptTask(parent.id)).status).toBe('completed');
  } finally { await f.close(); }
});

test('acceptance refuses dirt, committed new work, unread input, reservations and active descendants', async () => {
  const f = setup(); await repo(f.root);
  try {
    const source = await sourceTask(f); await deliver(f, source);
    fs.writeFileSync(path.join(source.workspace, 'dirty.txt'), 'valuable\n');
    await expect(f.project.acceptTask(source.id)).rejects.toThrow();
    expect(f.store.task(source.id).status).toBe('awaiting_acceptance');
    fs.unlinkSync(path.join(source.workspace, 'dirty.txt'));
    await commit(source.workspace, 'extra.txt', 'undelivered\n');
    await expect(f.project.acceptTask(source.id)).rejects.toThrow('undelivered');
    expect(await git(f.root, 'ls-tree', '--name-only', 'main', 'extra.txt')).toBe('');
    const quiet = await sourceTask(f, 'quiet'); await deliver(f, quiet);
    f.project.message(quiet.id, 'unprocessed');
    await expect(f.project.acceptTask(quiet.id)).rejects.toThrow('idle');
    f.store.update(quiet.id, { status: 'waiting' });
    await expect(f.project.acceptTask(quiet.id)).rejects.toThrow('unread');
    f.store.run('UPDATE messages SET consumed=1 WHERE task_id=?', quiet.id);
    f.store.update(quiet.id, { reservation: JSON.stringify({ version: 2, kind: 'merge', status: 'pending' }) });
    await expect(f.project.acceptTask(quiet.id)).rejects.toThrow('reserved');
    f.store.update(quiet.id, { reservation: null });
    const child = await f.project.spawn(quiet.id, 'active descendant');
    await expect(f.project.acceptTask(quiet.id)).rejects.toThrow('descendants');
    expect(f.store.task(child.id).status).toBe('queued');
  } finally { await f.close(); }
});

test('a lost parent delivery cannot be mistaken for an unchanged accepted iteration', async () => {
  const f = setup(); await repo(f.root);
  try {
    const source = await sourceTask(f); const delivered = await deliver(f, source);
    const landed = JSON.parse(delivered.reservation).landed_commit;
    // Isolated test-only parent ref rewrite simulates external history drift (no reset/clean).
    await git(f.root, 'update-ref', 'refs/heads/main', source.base_commit, landed);
    await expect(f.project.acceptTask(source.id)).rejects.toThrow('undelivered');
    expect(f.store.task(source.id).status).toBe('awaiting_acceptance');
    expect(fs.existsSync(source.workspace)).toBe(true);
  } finally { await f.close(); }
});

test('acceptance rechecks input after asynchronous Git validation and cannot overwrite a new wake', async () => {
  const f = setup(); await repo(f.root);
  try {
    const source = await sourceTask(f); await deliver(f, source);
    const finish = f.project.workspaces.finish.bind(f.project.workspaces);
    f.project.workspaces.finish = async task => {
      await finish(task);
      f.project.message(task.id, 'arrived while checking');
    };
    await expect(f.project.acceptTask(source.id)).rejects.toThrow('changed');
    expect(f.store.task(source.id).status).toBe('queued');
    expect(f.store.unread(source.id)).toHaveLength(1);
  } finally { await f.close(); }
});

test('historical reopen is explicit, does not call Agent, preserves rows and rejects archived branches', async () => {
  const f = setup(); await repo(f.root);
  try {
    const source = await sourceTask(f); const delivered = await deliver(f, source);
    f.store.update(source.id, { status: 'completed', iteration_base_commit: null, calls: 9 });
    const old = f.store.create({ role: 'agent', task_kind: 'say', goal: 'unrelated historical row' });
    f.store.update(old.id, { status: 'completed', integration: 'merged' });
    f.project.recover();
    expect(f.store.task(source.id).status).toBe('completed');
    const reopened = await f.project.reopenTask(source.id);
    expect(reopened).toMatchObject({ id: source.id, status: 'awaiting_acceptance', integration: 'merged', calls: 9,
      branch: source.branch, workspace: source.workspace, base_commit: source.base_commit, head_commit: delivered.head_commit });
    expect(f.store.runsForTask(source.id)).toHaveLength(0);
    expect(f.store.task(old.id).status).toBe('completed');
    await f.project.acceptTask(source.id); await f.project.archiveBranch(source.branch);
    await expect(f.project.reopenTask(source.id)).rejects.toThrow('archived');
    expect(await git(f.root, 'show-ref', '--verify', `refs/heads/${source.branch}`).catch(() => null)).toBeNull();
  } finally { await f.close(); }
});

test('synced source uses iteration baseline without changing its immutable fork or old reservation', async () => {
  const f = setup(); await repo(f.root);
  try {
    const source = await sourceTask(f); const delivered = await deliver(f, source);
    const previous = delivered.reservation;
    const parent = await git(f.root, 'rev-parse', 'main');
    await git(source.workspace, 'merge', '--no-edit', parent);
    const head = await git(source.workspace, 'rev-parse', 'HEAD');
    // Exercise the sync child public contract without depending on its implementation.
    f.store.update(source.id, { head_commit: head, iteration_base_commit: parent, integration: 'merged' });
    expect((await f.project.acceptTask(source.id)).base_commit).toBe(source.base_commit);
    expect(f.store.task(source.id).reservation).toBe(previous);
    await f.project.workspaces.cleanup(source.id);
    expect(f.store.task(source.id).workspace).toBeNull();
  } finally { await f.close(); }
});

test('accept/reopen cannot revive an invocation token; cancellation releases a repeated reservation', async () => {
  const f = setup(); await repo(f.root);
  try {
    const source = await sourceTask(f); await deliver(f, source);
    const token = 'old-token';
    f.store.armAgent(source.id, tokenHash(token));
    const run = { controller: new AbortController(), parked: false };
    f.project.running.set(source.id, run);
    expect(() => f.project.actor(token)).toThrow('no longer active');
    await expect(f.project.acceptTask(source.id)).rejects.toThrow('in flight');
    f.project.running.delete(source.id);
    await f.project.acceptTask(source.id);
    await expect(f.project.reopenTask(source.id)).rejects.toThrow('accepted Tasks cannot be reopened');
    expect(() => f.project.actor(token)).toThrow('expired');
    const historic = await sourceTask(f, 'historical-token'); await deliver(f, historic);
    f.store.update(historic.id, { status: 'completed' });
    await f.project.reopenTask(historic.id);
    expect(() => f.project.actor(token)).toThrow('expired');
    await commit(historic.workspace, 'cancel.txt', 'cancel second iteration\n');
    await f.project.reserveTask(historic.id, 'merge');
    expect(f.project.branchFreeze('main')).toBeTruthy();
    f.project.cancel(historic.id);
    expect(f.project.branchFreeze('main')).toBeNull();
    expect(f.store.task(historic.id).status).toBe('cancelled');
    expect(f.store.history(historic.id).filter(event => event.type === 'task.merge_integrated')).toHaveLength(1);
  } finally { await f.close(); }
});

test('opening an old database adds a nullable iteration baseline without migrating existing Tasks', async () => {
  const f = setup();
  try {
    const dbPath = path.join(f.config.home, 'iteration-old.sqlite');
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE tasks (id INTEGER PRIMARY KEY,parent_id INTEGER,input_id INTEGER,role TEXT,goal TEXT,name TEXT,status TEXT,
      result TEXT,error TEXT,calls INTEGER,agent_wakes INTEGER,agent_token_hash TEXT,agent_last_seen_at TEXT,workspace TEXT,branch TEXT,
      base_commit TEXT,head_commit TEXT,integration TEXT,target_branch TEXT,integration_error TEXT,layer TEXT,plan_gate TEXT,
      verifies_task_id INTEGER,baseline_workspace TEXT,baseline_commit TEXT,resolves_task_id INTEGER,created_at TEXT,updated_at TEXT);
      INSERT INTO tasks(id,role,goal,status,integration,layer,base_commit) VALUES (42,'agent','old','completed','merged','work','original');`);
    db.close();
    const store = new Store(dbPath, f.root);
    try { expect(store.task(42)).toMatchObject({ status: 'completed', integration: 'merged', base_commit: 'original', iteration_base_commit: null }); }
    finally { store.close(); }
  } finally { await f.close(); }
});
