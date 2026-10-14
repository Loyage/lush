import { test, expect } from 'bun:test';
import path from 'node:path';
import { setup, fetch } from './harness.js';
import { rawFetch } from './auth-fixture.js';
import { repo } from '../helpers.js';
import { RPCClient } from '../../src/rpc/client.js';
import { Store } from '../../src/persistence/store.js';
import { tokenHash } from '../../src/core/project/internal.js';
import { builtInPrompt, agentPrompt } from '../../src/agent/prompts.js';
import { createProjectHost } from '../../src/host/project-host.js';

function active(f, kind = 'order', parentId = null) {
  const task = f.store.create({ parent_id: parentId, role: kind === 'management' ? 'manager' : 'agent',
    task_kind: kind, goal: '标题机制\n真正需要实现的目标', name: 'fixed-name' });
  const token = `title-token-${task.id}`, controller = new AbortController();
  f.store.update(task.id, { status: 'running' }); f.store.armAgent(task.id, tokenHash(token));
  f.project.running.set(task.id, { token, controller });
  return { task: f.store.task(task.id), token, controller };
}
const request = (rpc, token, title, extra = {}) => rpc.request('worker.auto_title', { title, _token: token, ...extra });
const post = (f, params) => fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ method: 'worker.auto_title', params }) });

function metadata(task) { const { agent_last_seen_at, ...rest } = task; return rest; }

test('self-only RPC title is persistent, once-only, independent of user title and projected through Worker reads', async () => {
  const f = await setup(), rpc = new RPCClient(f.config.socket);
  try {
    const parent = active(f), child = active(f, 'child', parent.task.id);
    f.project.kick = () => { throw Error('title must not schedule'); };
    f.project.workspaces.git = () => { throw Error('title must not touch Git'); };
    const revision = f.project.overviewRevision(), before = metadata(parent.task);
    expect(await request(rpc, parent.token, '  Agent 自动标题机制  ')).toEqual({ id: parent.task.id, auto_title: 'Agent 自动标题机制', changed: true });
    expect(metadata(f.store.task(parent.task.id))).toEqual({ ...before, auto_title: 'Agent 自动标题机制' });
    expect(f.project.overviewRevision()).not.toBe(revision);
    expect(await request(rpc, parent.token, '另一个主题')).toEqual({ id: parent.task.id, auto_title: 'Agent 自动标题机制', changed: false });
    f.project.renameTask(parent.task.id, '用户手动标题');
    expect(await request(rpc, parent.token, '不能覆盖用户命名')).toMatchObject({ auto_title: 'Agent 自动标题机制', changed: false });
    expect((await f.project.taskGraph({ details: false })).nodes.find(row => row.id === parent.task.id).title).toBe('用户手动标题');
    f.project.renameTask(parent.task.id, '');
    expect((await f.project.taskGraph({ details: false })).nodes.find(row => row.id === parent.task.id)).toMatchObject({ title: 'Agent 自动标题机制', auto_title: 'Agent 自动标题机制', goal_preview: parent.task.goal });
    expect(f.project.inspect(parent.task.id)).toMatchObject({ auto_title: 'Agent 自动标题机制', goal: parent.task.goal, name: 'fixed-name' });
    expect(await rpc.request('worker.list')).toEqual(expect.arrayContaining([expect.objectContaining({ id: parent.task.id, auto_title: 'Agent 自动标题机制' })]));
    expect(f.project.activity().tasks.find(row => row.id === parent.task.id).auto_title).toBe('Agent 自动标题机制');
    expect(f.project.developmentSummary().recent_workers.find(row => row.id === parent.task.id).auto_title).toBe('Agent 自动标题机制');
    await request(rpc, child.token, '子 Worker 专项');
    expect(f.project.inspect(parent.task.id).children[0].auto_title).toBe('子 Worker 专项');
    // A new invocation and user follow-up cannot replace the first title.
    f.project.running.delete(parent.task.id); f.store.update(parent.task.id, { status: 'completed' });
    expect(f.project.taskPage().tasks.find(row => row.id === parent.task.id).auto_title).toBe('Agent 自动标题机制');
    f.store.armAgent(parent.task.id, tokenHash('next-invocation'));
    f.store.update(parent.task.id, { status: 'running' });
    f.project.running.set(parent.task.id, { controller: new AbortController() });
    await expect(request(rpc, parent.token, 'old token')).rejects.toThrow('expired');
    expect(await request(rpc, 'next-invocation', '追加输入后的主题')).toMatchObject({ changed: false, auto_title: 'Agent 自动标题机制' });
    expect(f.store.history(parent.task.id).filter(row => row.type === 'task.auto_titled')).toHaveLength(1);
    const reopened = new Store(path.join(f.config.home, 'project.db'), f.root);
    try { expect(reopened.task(parent.task.id).auto_title).toBe('Agent 自动标题机制'); } finally { reopened.close(); }
    expect(f.store.task(parent.task.id).calls).toBe(0);
  } finally { f.project.running.clear(); await f.close(); }
});

test('real order creation retains generated titles through parent selection and Host summary projection', async () => {
  const f = await setup(), rpc = new RPCClient(f.config.socket);
  try {
    await repo(f.root);
    const { task } = await rpc.request('order.submit', { content: '原始指令首行\n详细目标', start: false });
    const token = 'real-created-worker-title';
    f.store.update(task.id, { status: 'running' }); f.store.armAgent(task.id, tokenHash(token));
    f.project.running.set(task.id, { controller: new AbortController() });
    await request(rpc, token, '理解后的工作主题');
    f.project.wake = () => {}; // Persist the real user append without starting another invocation.
    await rpc.request('worker.message', { id: task.id, body: '追加的新主题，不应改变标题' });
    expect(f.project.inspect(task.id).messages[0]).toMatchObject({ append_number: `A${task.input_id}-1`, body: '追加的新主题，不应改变标题' });
    expect(await request(rpc, token, '追加后的新主题')).toMatchObject({ auto_title: '理解后的工作主题', changed: false });
    expect((await rpc.request('input.parents')).items.find(row => row.id === task.id)).toMatchObject({ auto_title: '理解后的工作主题', goal: task.goal });
    const host = createProjectHost(f.config);
    const summary = (await host.projects())[0].summary;
    expect(summary.development.recent_workers.find(row => row.id === task.id)).toMatchObject({ auto_title: '理解后的工作主题', goal: task.goal });
    expect(summary.development.recent_workers.find(row => row.id === task.id)).not.toHaveProperty('agent_token_hash');
    expect((await rpc.request('input.history')).items.find(row => row.kind === 'input' && row.id === task.input_id).content).toBe(task.goal);
  } finally { f.project.running.clear(); await f.close(); }
});

test('automatic title rejects user/HTTP/foreign-target/invalid text and inactive or non-development credentials', async () => {
  const f = await setup(), rpc = new RPCClient(f.config.socket);
  try {
    const own = active(f), foreign = active(f, 'child', own.task.id);
    await expect(rpc.request('worker.auto_title', { title: 'user title' })).rejects.toThrow('agent only');
    for (const extra of [{ id: foreign.task.id }, { task: foreign.task.id }, { parent: foreign.task.id }, { goal: 'rewrite' }])
      await expect(request(rpc, own.token, 'title', extra)).rejects.toThrow('unknown parameter');
    for (const title of [undefined, null, 12, {}, '', '   ', 'x'.repeat(61), 'first\nsecond', 'a\tb', 'a\u0000b', 'a\u2028b'])
      await expect(request(rpc, own.token, title)).rejects.toThrow();
    expect((await rawFetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'worker.auto_title', params: { title: 'anonymous title' } }) })).status).toBe(401);
    expect((await post(f, { title: 'web title' })).status).toBe(400);
    expect((await post(f, { title: 'web agent title', _token: own.token })).status).toBe(400);
    await expect(rpc.request('worker.rename', { id: own.task.id, title: 'manual', _token: own.token })).rejects.toThrow('requires user approval');
    for (const kind of ['main', 'owner', 'analysis', 'management']) {
      const worker = active(f, kind);
      await expect(request(rpc, worker.token, 'forbidden')).rejects.toThrow();
      expect(f.store.task(worker.task.id).auto_title).toBeNull();
    }
    f.project.running.get(own.task.id).parked = true;
    await expect(request(rpc, own.token, 'parked')).rejects.toThrow('no longer active');
    f.project.running.get(own.task.id).parked = false;
    own.controller.abort();
    await expect(request(rpc, own.token, 'aborted')).rejects.toThrow('no longer active');
    f.store.update(foreign.task.id, { status: 'waiting' });
    await expect(request(rpc, foreign.token, 'not running')).rejects.toThrow('no longer active');
    expect(f.store.task(own.task.id).auto_title).toBeNull(); expect(f.store.task(foreign.task.id).auto_title).toBeNull();
  } finally { f.project.running.clear(); await f.close(); }
});

test('first successful title wins concurrent requests; project write gates and frozen metadata boundaries remain', async () => {
  const f = await setup(), rpc = new RPCClient(f.config.socket);
  try {
    const own = active(f);
    for (const gate of ['clearing', 'settingsMigrationApplying', 'workerDeleteIds']) {
      f.project[gate] = gate === 'workerDeleteIds' ? new Set([own.task.id]) : true;
      await expect(request(rpc, own.token, 'blocked')).rejects.toThrow('in progress');
      f.project[gate] = null;
    }
    f.store.update(own.task.id, { reservation: JSON.stringify({ version: 2, kind: 'merge', status: 'resolving' }) });
    const before = metadata(f.store.task(own.task.id));
    const results = await Promise.all([request(rpc, own.token, '主题一'), request(rpc, own.token, '主题二')]);
    expect(results.filter(row => row.changed)).toHaveLength(1);
    expect(results[0].auto_title).toBe(results[1].auto_title);
    expect(metadata(f.store.task(own.task.id))).toEqual({ ...before, auto_title: results[0].auto_title });
    expect(f.store.history(own.task.id).filter(row => row.type === 'task.auto_titled')).toHaveLength(1);
  } finally { f.project.running.clear(); await f.close(); }
});

test('old rows gain nullable auto_title without generating titles or altering history', async () => {
  const f = await setup();
  try {
    const task = f.store.create({ role: 'agent', task_kind: 'order', goal: '原始首行', name: 'old-fixed' });
    f.project.renameTask(task.id, '旧手动标题');
    const before = f.store.task(task.id); delete before.auto_title;
    const history = f.store.history(task.id);
    f.store.run('ALTER TABLE tasks DROP COLUMN auto_title');
    const reopened = new Store(path.join(f.config.home, 'project.db'), f.root);
    try {
      expect(reopened.task(task.id)).toEqual({ ...before, auto_title: null });
      expect(reopened.history(task.id)).toEqual(history);
    } finally { reopened.close(); }
  } finally { await f.close(); }
});

test('built-in Agent prompt requests semantic once-only titles but analysis/management do not', () => {
  for (const progressReporting of [true, false]) {
    const prompt = builtInPrompt('agent', { progressReporting });
    expect(prompt).toContain('lushc skills get auto-title');
    expect(prompt).toContain('auto_title 为空时');
    expect(prompt).not.toContain("lushc worker auto-title '简短标题'");
  }
  expect(builtInPrompt('manager')).not.toContain('lushc worker auto-title');
  const config = { project: '/tmp/lush-title-prompt', home: '/tmp/lush-title-prompt/.lush' };
  expect(agentPrompt(config, 'agent', {}, 'analysis').text).not.toContain('lushc worker auto-title');
  expect(agentPrompt(config, 'agent', { config_mode: 'pi' }, 'order').text).toContain('lushc skills get auto-title');
});
