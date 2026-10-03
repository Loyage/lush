import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { env, fixture, git, repo } from '../helpers.js';
import { forkCheckpoint } from '../../src/agent/fork.js';
import { PiProvider } from '../../src/agent/provider.js';

const gitAdapter = path.resolve(import.meta.dir, '../../bin/git');

test('commit adapter records a Pi entry and a child forks from that exact committed context', async () => {
  const f = fixture(); f.project.stopping = true;
  await repo(f.root);
  try {
    const parent = await f.project.order('parent work');
    const task = parent.task;
    const sessions = path.join(f.config.home, 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    const session = path.join(sessions, `timestamp_lush-task-${task.id}.jsonl`);
    const header = { type: 'session', version: 3, id: `lush-task-${task.id}`, cwd: task.workspace };
    const user = { type: 'message', id: 'a1', parentId: null, message: { role: 'user', content: 'parent context' } };
    const old = { type: 'message', id: 'a2', parentId: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'saved at commit' }] } };
    const future = { type: 'message', id: 'a3', parentId: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: 'after commit' }] } };
    fs.writeFileSync(session, [header, user, old, future].map(entry => JSON.stringify(entry)).join('\n') + '\n');
    const runId = 42;
    fs.writeFileSync(path.join(sessions, `task-${task.id}-context.json`), JSON.stringify({ task_id: task.id, run_id: runId, session, entry: old.id }));
    fs.writeFileSync(path.join(task.workspace, 'file.txt'), 'committed by parent\n');
    await git(task.workspace, 'add', 'file.txt');
    const commit = spawnSync(gitAdapter, ['commit', '-m', 'parent change'], { cwd: task.workspace, encoding: 'utf8',
      env: env({ LUSH_PROJECT: f.root, LUSH_TASK_ID: String(task.id),
        LUSH_RUNTIME_CONTEXT: JSON.stringify({ run_id: runId }) }) });
    expect(commit.status).toBe(0);
    const sha = await git(task.workspace, 'rev-parse', 'HEAD');
    const pointer = f.store.get('SELECT session_path AS session, entry_id AS entry FROM commit_contexts WHERE commit_hash=?', sha);
    expect(pointer).toEqual({ session, entry: 'a2' });
    const checkpoint = forkCheckpoint(f.config.home, { ...pointer, commit: sha });
    const entries = fs.readFileSync(checkpoint, 'utf8').trim().split('\n').map(JSON.parse);
    expect(entries.map(entry => entry.id)).toEqual([header.id, 'a1', 'a2']);
    const input = await f.project.order('user intent forks the parent', task.branch);
    expect(input.task).toMatchObject({ parent_id: task.id, base_commit: sha, target_branch: task.branch });
    expect(input.anchor.commit).toBe(sha);
    const child = await f.project.spawn(task.id, 'child task', 'agent', [], 'child-task');
    expect(child).toMatchObject({ parent_id: task.id, base_commit: sha, target_branch: task.branch });
    expect(await git(child.workspace, 'rev-parse', 'HEAD')).toBe(sha);
    expect(f.store.branch(child.branch).created_from_commit).toBe(sha);
    const command = path.join(f.root, 'fake-pi');
    const argvFile = path.join(f.root, 'pi-args.json');
    fs.writeFileSync(command, '#!/usr/bin/env bun\nimport fs from "node:fs"; fs.writeFileSync(process.env.PI_ARGS_FILE, JSON.stringify(process.argv.slice(2))); console.log("ok");\n', { mode: 0o700 });
    const provider = new PiProvider({ ...f.config, env: { ...f.config.env, LUSH_PI_COMMAND: command, PI_ARGS_FILE: argvFile } });
    const invoke = () => provider.run({ task: child, context: { invocation: { run_id: 12 } },
      messages: [], cwd: child.workspace, token: 'test', signal: new AbortController().signal,
      onSpawn() {}, agent: { agent: 'pi', extensions: [], skills: [], soft_budget: {} }, forkPointer: pointer });
    expect(await invoke()).toBe('ok');
    const args = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
    expect(args.slice(args.indexOf('--fork'), args.indexOf('--fork') + 2)).toEqual(['--fork', checkpoint]);
    expect(args).toContain('--system-prompt');
  } finally { await f.close(); }
});

test('a parent commit without Pi context still makes a worktree; forged checkpoints are rejected', async () => {
  const f = fixture(); f.project.stopping = true;
  await repo(f.root);
  try {
    const order = await f.project.order('initial input');
    expect(f.store.get('SELECT * FROM commit_contexts WHERE commit_hash=?', order.anchor.commit)).toBeNull();
    const child = await f.project.spawn(order.task.id, 'child task', 'agent', [], 'child-task');
    expect(child.base_commit).toBe(order.anchor.commit);
    expect(await git(child.workspace, 'rev-parse', 'HEAD')).toBe(order.anchor.commit);
    expect(() => forkCheckpoint(f.config.home, { session: '/tmp/foreign.jsonl', entry: 'a', commit: 'a'.repeat(40) })).toThrow('outside');
  } finally { await f.close(); }
});
