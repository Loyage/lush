import { test, expect } from 'bun:test';
import { run as worker } from '../src/cli/commands/task.js';
import { run as notice } from '../src/cli/commands/notice.js';
import { run as order } from '../src/cli/commands/intent.js';
import { resolveWorkerId, workerLabel } from '../src/cli/worker-number.js';
import { print } from '../src/cli/args.js';
import { printTree, printBranchShow } from '../src/cli/print.js';

function clientFor(response = params => params) {
  const calls = [];
  return { token: null, calls, async request(method, params) {
    calls.push({ method, params });
    if (method === 'worker.lookup') return { id: 205, worker_number: params.number };
    return typeof response === 'function' ? response(params, method) : response;
  } };
}
function capture(fn) {
  const lines = [], original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { fn(); } finally { console.log = original; }
  return lines.join('\n');
}

const cases = [
  [['inspect', 'W5-1'], 'worker.inspect', { id: 205 }],
  [['tree', 'W5-1'], 'worker.tree', { id: 205 }],
  [['spawn', 'goal', '--parent', 'W5-1', '--name', 'child'], 'worker.spawn', { parent: 205, goal: 'goal', name: 'child' }],
  [['message', 'W5-1', 'follow-up'], 'worker.message', { id: 205, body: 'follow-up' }],
  [['history', 'W5-1', '--after', '9'], 'worker.history', { id: 205, after: 9 }],
  [['transcript', 'W5-1', '--after', '9'], 'worker.transcript', { id: 205, after: 9 }],
  [['integrate', 'W5-1', 'sha'], 'worker.integrate', { id: 205, commit: 'sha' }],
  [['reserve', 'W5-1', 'merge'], 'worker.reserve', { id: 205, kind: 'merge' }],
  [['auto-merge', 'W5-1', 'on'], 'worker.auto_merge', { id: 205, enabled: true }],
  [['approve-merge', 'W5-1', 'sha', 'base'], 'worker.approve_merge', { id: 205, commit: 'sha', baseline: 'base' }],
  [['cleanup', 'W5-1', '--keep-branch'], 'worker.cleanup', { id: 205, keep_branch: true }],
  [['delete', 'W5-1'], 'worker.delete_preview', { id: 205 }],
  [['delete', 'W5-1', '--confirm', '--revision', 'rev'], 'worker.delete', { id: 205, revision: 'rev', confirm: true }],
  ...['accept', 'reopen', 'cancel', 'retry', 'interrupt', 'resume', 'resolve', 'sync-parent', 'resolve-sync',
    'clear-override', 'resolve-divergence', 'resolve-child-divergence', 'unreserve'].map(verb =>
    [[verb, 'W5-1'], `worker.${verb.replaceAll('-', '_')}`, { id: 205 }]),
];
for (const [args, method, params] of cases) {
  test(`numbered CLI ${args[0]} resolves the exact Worker before forwarding integer identity`, async () => {
    const client = clientFor();
    expect(await worker('worker', [...args], { client, json: true })).toEqual(params);
    expect(client.calls).toEqual([
      { method: 'worker.lookup', params: { number: 'W5-1' } }, { method, params },
    ]);
  });
}

test('integer identities issue no lookup and deeply nested numbers resolve literally', async () => {
  const client = clientFor();
  expect(await resolveWorkerId(client, '205')).toBe(205);
  expect(await resolveWorkerId(client, 205)).toBe(205);
  expect(client.calls).toEqual([]);
  expect(await resolveWorkerId(client, 'W5-1-1')).toBe(205);
  expect(client.calls).toEqual([{ method: 'worker.lookup', params: { number: 'W5-1-1' } }]);
});

test('malformed or unsafe Worker numbers are rejected before any RPC', async () => {
  const client = clientFor();
  for (const value of ['W', 'W0', 'W05', 'W5-0', 'W5-01', 'W5--1', 'W5-', 'W5/1', 'W5-1x', 'w5', 'O5',
    '#5', ' W5', 'W5 ', 'W9007199254740992', 'W5-9007199254740992']) {
    await expect(resolveWorkerId(client, value)).rejects.toThrow();
  }
  expect(client.calls).toEqual([]);
});

test('failed or mismatched lookups never forward a Worker action', async () => {
  for (const response of [{ id: 205, worker_number: 'W5-2' }, { id: 'bad', worker_number: 'W5-1' }, null]) {
    const calls = [];
    const client = { async request(method, params) { calls.push({ method, params }); return response; } };
    await expect(worker('worker', ['cancel', 'W5-1'], { client, json: true })).rejects.toThrow();
    expect(calls).toEqual([{ method: 'worker.lookup', params: { number: 'W5-1' } }]);
  }
  const client = { async request() { throw new Error('Worker number not found'); } };
  await expect(worker('worker', ['inspect', 'W5-1'], { client, json: true })).rejects.toThrow('not found');
});

test('numbered wait resolves once and forbidden agent wait/follow do not resolve', async () => {
  const client = clientFor({ id: 205, status: 'completed' });
  expect(await worker('worker', ['wait', 'W5-1'], { client, json: true })).toEqual({ id: 205, status: 'completed' });
  expect(client.calls).toEqual([
    { method: 'worker.lookup', params: { number: 'W5-1' } }, { method: 'worker.inspect', params: { id: 205 } },
  ]);
  const forbidden = clientFor(); forbidden.token = 'live';
  await expect(worker('worker', ['wait', 'W5-1'], { client: forbidden, json: true })).rejects.toThrow('must end');
  await expect(worker('worker', ['transcript', 'W5-1', '--follow'], { client: forbidden, json: false })).rejects.toThrow('must end');
  expect(forbidden.calls).toEqual([]);
});

test('numbered transcript follow uses the resolved integer rather than number components', async () => {
  const client = clientFor({ files: [], steps: [], next: 9, has_more: false, truncated: false });
  const original = process.stderr.write;
  process.stderr.write = () => true;
  try { await worker('worker', ['transcript', 'W5-1', '--after', '9', '--follow'], { client, json: false }); }
  finally { process.stderr.write = original; }
  expect(client.calls).toEqual([
    { method: 'worker.lookup', params: { number: 'W5-1' } },
    { method: 'worker.transcript', params: { id: 205, after: 9, limit: 200 } },
  ]);
});

test('notice --worker resolves Worker identity but notice IDs remain integers', async () => {
  const client = clientFor();
  await notice('notice', ['post', 'title', '--worker', 'W5-1', '--body', 'body'], { client });
  expect(client.calls).toEqual([
    { method: 'worker.lookup', params: { number: 'W5-1' } },
    { method: 'notice.post', params: { task: 205, title: 'title', body: 'body' } },
  ]);
  for (const args of [['read', 'W5'], ['dismiss', 'W5'], ['answer', 'W5', 'yes']]) {
    await expect(notice('notice', args, { client })).rejects.toThrow('positive integer');
  }
  expect(client.calls).toHaveLength(2);
});

test('brief lists preserve nullable number and integer cursors; reserve-all is a branch operation', async () => {
  const client = clientFor([
    { id: 205, worker_number: 'W5-1', parent_id: 190, role: 'agent', status: 'waiting', integration: 'none', goal: 'numbered' },
    { id: 206, parent_id: 190, role: 'agent', status: 'waiting', integration: 'none', goal: 'legacy' },
  ]);
  const value = await worker('worker', ['list', '--brief', '--after', '100', '--limit', '1'], { client, json: true });
  expect(value.tasks[0]).toMatchObject({ id: 205, worker_number: 'W5-1' });
  expect(value.next_after).toBe(205); expect(value.has_more).toBe(true);
  expect(client.calls).toEqual([{ method: 'worker.list', params: { after: 100, limit: 2 } }]);
  const page = await worker('worker', ['list', '--brief'], { client, json: true });
  expect(page.tasks[1].worker_number).toBeNull();
  const branch = clientFor();
  await worker('worker', ['reserve-all', 'W5'], { client: branch, json: true });
  expect(branch.calls).toEqual([{ method: 'worker.reserve_all', params: { branch: 'W5' } }]);
});

test('human lists/tree/branch show persisted numbers without renaming legacy or changing JSON', () => {
  const parent = { id: 205, worker_number: 'W5', role: 'agent', status: 'waiting', goal: 'parent' };
  const child = { id: 210, worker_number: 'W5-1', parent_id: 205, task_kind: 'child', role: 'agent',
    status: 'awaiting_acceptance', goal: 'child', children: [] };
  const legacy = { id: 7, role: 'worker', status: 'completed', goal: 'legacy', children: [] };
  const tree = [{ ...parent, children: [child, legacy] }];
  const text = capture(() => {
    print([parent, legacy], false); printTree(tree, { concurrency: 1, agents: [] });
    printBranchShow({ branch: 'main', parent: null, task_id: 205, task_worker_number: 'W5', task_role: 'agent',
      chain: [], children: [], descendants: [] });
  });
  expect(text).toContain('W5\twaiting'); expect(text).toContain('7\tcompleted');
  expect(text).toContain('待父 Worker W5 确认'); expect(text).toContain('{#7 ‖ W5-1}');
  expect(text).toContain('W5-1 agent awaiting_acceptance'); expect(text).toContain('#7 worker completed');
  expect(text).toContain('Worker: W5');
  expect(JSON.parse(capture(() => print([parent], true)))[0]).toMatchObject({ id: 205, worker_number: 'W5' });
  expect(workerLabel({ id: 205 })).toBe('#205');
});

test('order human output identifies On while its return and JSON keep integer identity', async () => {
  const result = { id: 5, task: { id: 205, worker_number: 'W5' } };
  const client = clientFor(result), lines = [], original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    expect(await order('order', ['goal'], { client, json: false })).toBe(result);
    expect(await order('order', ['goal'], { client, json: true })).toBe(result);
  } finally { console.log = original; }
  expect(lines).toEqual(['输入 O5 → Worker W5']);
});
