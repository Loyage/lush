import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../src/cli/main.js';
import { HELP } from '../src/cli/help.js';
import { run as worker } from '../src/cli/commands/task.js';
import { run as notice } from '../src/cli/commands/notice.js';
import { printTree, printTranscript, printBranchShow } from '../src/cli/print.js';
import { fixture, env } from './helpers.js';

const root = path.resolve(import.meta.dir, '..');
function recordingClient() {
  const calls = [];
  return { calls, async request(method, params) { calls.push({ method, params }); return params; } };
}

test('task is rejected instead of registered as a worker alias', async () => {
  for (const args of [['task'], ['task', 'list'], ['task', 'spawn', 'goal'], ['tasks']]) {
    await expect(main(args)).rejects.toThrow(`unknown command: ${args[0]}`);
  }
  expect(HELP).toContain('Lush — Worker 中心开发');
  expect(HELP).toContain('worker spawn');
  expect(HELP).not.toMatch(/\btask\b|\bTask\b|任务/);
});

test('worker main command dispatches and retains LUSH_TASK_ID as the default parent', async () => {
  const f = fixture();
  try {
    const script = `import { main } from ${JSON.stringify(path.join(root, 'src/cli/main.js'))};
import { UIClient } from ${JSON.stringify(path.join(root, 'src/ui/client.js'))};
UIClient.prototype.request = async function(method, params) { return { method, params }; };
await main(['worker', 'spawn', 'goal', '--name', 'child-worker', '--json']);`;
    const proc = Bun.spawn(['bun', '-e', script], { cwd: f.root,
      env: env({ LUSH_PROJECT: f.root, LUSH_TASK_ID: '7' }), stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ code, err }).toEqual({ code: 0, err: '' });
    expect(JSON.parse(out)).toEqual({ method: 'worker.spawn', params: { parent: 7, goal: 'goal', name: 'child-worker' } });
  } finally { await f.close(); }
});

test('worker read and lifecycle commands use only worker RPC methods', async () => {
  const client = recordingClient();
  const cases = [
    [['inspect', '7'], 'worker.inspect', { id: 7 }],
    [['tree', '7'], 'worker.tree', { id: 7 }],
    [['spawn', 'goal', '--parent', '7', '--name', 'child'], 'worker.spawn', { parent: 7, goal: 'goal', name: 'child' }],
    [['message', '7', 'follow-up'], 'worker.message', { id: 7, body: 'follow-up' }],
    [['history', '7', '--after', '9'], 'worker.history', { id: 7, after: 9 }],
    [['transcript', '7', '--after', '9'], 'worker.transcript', { id: 7, after: 9 }],
    [['integrate', '7', 'sha'], 'worker.integrate', { id: 7, commit: 'sha' }],
    [['cleanup', '7', '--keep-branch'], 'worker.cleanup', { id: 7, keep_branch: true }],
    ...['accept', 'reopen', 'cancel', 'retry', 'interrupt', 'resume', 'resolve', 'sync-parent', 'resolve-sync'].map(verb =>
      [[verb, '7'], `worker.${verb.replaceAll('-', '_')}`, { id: 7 }]),
  ];
  for (const [args, method, params] of cases) {
    expect(await worker('worker', [...args], { client, json: true })).toEqual(params);
    expect(client.calls.at(-1)).toEqual({ method, params });
  }
  await expect(worker('worker', ['unknown'], { client, json: true })).rejects.toThrow('unknown worker command');
  expect(client.calls).toHaveLength(cases.length);
});

test('worker auto-merge is a strict user hook CLI, not a reservation', async () => {
  const calls = [], client = { async request(method, params) { calls.push({ method, params }); return params; } };
  expect(await worker('worker', ['auto-merge','7','on'], { client, json: true })).toEqual({ id: 7, enabled: true });
  expect(await worker('worker', ['auto-merge','7','off'], { client, json: true })).toEqual({ id: 7, enabled: false });
  expect(calls).toEqual([
    { method: 'worker.auto_merge', params: { id: 7, enabled: true } },
    { method: 'worker.auto_merge', params: { id: 7, enabled: false } },
  ]);
  for (const args of [['7'],['7','true'],['7','on','force'],['invalid','on']])
    await expect(worker('worker', ['auto-merge', ...args], { client, json: true })).rejects.toThrow();
  expect(calls).toHaveLength(2);
  expect(HELP).toContain('worker auto-merge ID on|off');
});

test('worker iteration CLI rejects extra arguments and documents each action', async () => {
  for (const verb of ['accept','reopen','sync-parent','resolve-sync']) {
    const client = { async request() { throw new Error('CLI must reject before RPC'); } };
    expect(HELP).toContain(`worker ${verb} ID`);
    await expect(worker('worker', [verb, '7', 'force'], { client, json: true })).rejects.toThrow();
  }
});

test('worker wait is read-only and forbidden to agents', async () => {
  const calls = [], result = { id: 7, status: 'completed' };
  const client = { token: null, async request(method, params) { calls.push({ method, params }); return result; } };
  expect(await worker('worker', ['wait', '7'], { client, json: true })).toBe(result);
  expect(calls).toEqual([{ method: 'worker.inspect', params: { id: 7 } }]);
  await expect(worker('worker', ['wait', '7'], { client: { ...client, token: 'live' }, json: true })).rejects.toThrow('must end their invocation');
  expect(calls).toHaveLength(1);
});

test('notice uses --worker while preserving the notice RPC identity field', async () => {
  const client = recordingClient();
  await notice('notice', ['post', 'title', '--worker', '7', '--body', 'body'], { client });
  expect(client.calls).toEqual([{ method: 'notice.post', params: { task: 7, title: 'title', body: 'body' } }]);
  await expect(notice('notice', ['post', 'title', '--task', '7'], { client })).rejects.toThrow('invalid arguments');
  expect(client.calls).toHaveLength(1);
});

test('package and ops expose workers without a tasks shortcut', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  expect(pkg.scripts.workers).toBe('bun ./scripts/ops.js workers');
  expect(pkg.scripts.tasks).toBeUndefined();
  for (const command of ['workers', 'tree', 'inspect', 'transcript', 'message']) {
    const proc = Bun.spawn(['bun', path.join(root, 'scripts/ops.js'), command, '--help'], {
      env: env(), stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ code, err }).toEqual({ code: 0, err: '' });
    expect(out).toContain(HELP);
  }
  const proc = Bun.spawn(['bun', path.join(root, 'scripts/ops.js'), 'tasks'], { env: env(), stdout: 'pipe', stderr: 'pipe' });
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  expect(code).toBe(1);
  expect(err).toContain('unknown command: tasks');
});

test('human-readable CLI renders Worker identity and child wait labels', () => {
  const logs = [], original = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    printTranscript({ files: [], steps: [] });
    printTree([{ id: 7, role: 'agent', task_kind: 'child', parent_id: 2, status: 'awaiting_acceptance', goal: 'goal', children: [] }], { concurrency: 1, agents: [] });
    printBranchShow({ branch: 'main', parent: null, task_id: 7, task_role: 'worker', chain: [], children: [], descendants: [] });
  } finally { console.log = original; }
  const text = logs.join('\n');
  expect(text).toContain('这个 Worker 还没有 pi 会话记录');
  expect(text).toContain('待父 Worker #2 确认');
  expect(text).toContain('Worker: worker#7');
  expect(text).not.toMatch(/任务|\bTask\b|task:/);
});
