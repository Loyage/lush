import { test, expect } from 'bun:test';
import path from 'node:path';
import { setup, fetch } from './harness.js';
import { RPCClient } from '../../src/rpc/client.js';
import { Store } from '../../src/persistence/store.js';
import { tokenHash } from '../../src/core/project/internal.js';

const post = (f, params, headers = {}) => fetch(f.url + '/api/action', { method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ method: 'worker.rename', params }) });
const create = f => f.store.create({ role: 'agent', task_kind: 'order', goal: '原始目标\n任务正文永不重写', name: 'order-original' });

test('real RPC/HTTP rename persists independent display metadata across all lifecycle states without execution side effects', async () => {
  const f = await setup(), task = create(f);
  try {
    f.project.kick = () => { throw new Error('rename must not schedule'); };
    f.project.workspaces.git = () => { throw new Error('rename must not touch Git'); };
    const revision = f.store.get("SELECT value FROM meta WHERE key='overview_revision'").value;
    for (const status of ['running', 'queued', 'waiting', 'awaiting', 'paused', 'awaiting_acceptance', 'completed', 'failed', 'cancelled']) {
      f.store.update(task.id, { status, reservation: JSON.stringify({ version: 2, kind: 'merge', status: 'requested' }),
        retry_profile: JSON.stringify({ agent: 'pi', model: 'openai/gpt-5', thinking: 'high', append_prompt: 'PRIVATE_PROMPT', env: { SECRET: 'PRIVATE_ENV' } }) });
      const before = f.store.task(task.id);
      const response = await post(f, { id: task.id, title: `  我的标题 ${status}  ` });
      expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ id: task.id, display_title: `我的标题 ${status}` });
      expect(f.store.task(task.id)).toEqual({ ...before, display_title: `我的标题 ${status}` });
    }
    expect(f.store.get("SELECT value FROM meta WHERE key='overview_revision'").value).not.toBe(revision);
    const rpc = new RPCClient(f.config.socket);
    expect(await rpc.request('worker.rename', { id: task.id, title: '自定义标题' })).toEqual({ id: task.id, display_title: '自定义标题' });
    const reopened = new Store(path.join(f.config.home, 'project.db'), f.root);
    try { expect(reopened.task(task.id).display_title).toBe('自定义标题'); } finally { reopened.close(); }
    const graph = await f.project.taskGraph({ details: false });
    expect(graph.nodes.find(row => row.id === task.id)).toMatchObject({ title: '自定义标题', display_title: '自定义标题', goal_preview: task.goal });
    expect(f.project.inspect(task.id)).toMatchObject({ display_title: '自定义标题', goal: task.goal, name: task.name });
    expect(await rpc.request('worker.list')).toEqual(expect.arrayContaining([expect.objectContaining({ id: task.id, display_title: '自定义标题' })]));
    expect(f.project.taskPage().tasks.find(row => row.id === task.id).display_title).toBe('自定义标题');
    const child = f.store.create({ parent_id: task.id, role: 'agent', task_kind: 'child', goal: 'child' });
    f.project.renameTask(child.id, '子标题');
    expect(f.project.inspect(task.id).children[0].display_title).toBe('子标题');
    for (const title of ['', '   ', null]) {
      expect(await rpc.request('worker.rename', { id: task.id, title })).toEqual({ id: task.id, display_title: null });
      expect((await f.project.taskGraph({ details: false })).nodes.find(row => row.id === task.id).title).toContain('原始目标');
    }
    const events = f.store.history(task.id).filter(row => row.type === 'task.renamed');
    await rpc.request('worker.rename', { id: task.id, title: null });
    expect(f.store.history(task.id).filter(row => row.type === 'task.renamed')).toHaveLength(events.length);
    expect(f.project.running.size).toBe(0); expect(f.store.task(task.id).calls).toBe(0);
  } finally { await f.close(); }
});

test('rename rejects invalid parameters and Agent credentials; follows existing login and Origin protection', async () => {
  const f = await setup(), task = create(f), token = 'active-rename-test-token';
  try {
    const before = f.store.task(task.id);
    for (const params of [{ id: task.id }, { id: task.id, title: 12 }, { id: task.id, title: {} },
      { id: task.id, title: 'x'.repeat(201) }, { id: task.id, title: 'first\nsecond' },
      { id: task.id, title: 'a\u0000b' }, { id: task.id, title: 'a\tb' }, { id: task.id, title: 'a\u2028b' },
      { id: task.id, title: 'title', goal: 'rewrite' }, { id: 0, title: 'title' }, { id: 99999, title: 'title' }]) {
      expect((await post(f, params)).status).toBe(400); expect(f.store.task(task.id)).toEqual(before);
    }
    expect((await post(f, { id: task.id, title: 'title' }, { Origin: 'https://attacker.invalid' })).status).toBe(403);
    expect((await post(f, { id: task.id, title: 'title', _token: token })).status).toBe(400);
    f.store.update(task.id, { status: 'running' }); f.store.armAgent(task.id, tokenHash(token));
    f.project.running.set(task.id, { token, controller: new AbortController() });
    await expect(new RPCClient(f.config.socket).request('worker.rename', { id: task.id, title: 'Agent title', _token: token })).rejects.toThrow('requires user approval');
    const activeBefore = f.store.task(task.id);
    expect((await post(f, { id: task.id, title: '用户标题' })).status).toBe(200);
    expect(f.store.task(task.id)).toEqual({ ...activeBefore, display_title: '用户标题' });
    expect(f.project.running.get(task.id).controller.signal.aborted).toBe(false);
    f.project.workerDeleteIds = new Set([task.id]);
    expect((await post(f, { id: task.id, title: 'during deletion' })).status).toBe(400);
    f.project.workerDeleteIds = null;
  } finally { f.project.running.clear(); await f.close(); }
  const secured = await setup({ auth: { username: 'owner', password: 'test-password' } }), protectedTask = create(secured);
  try { expect((await post(secured, { id: protectedTask.id, title: 'title' })).status).toBe(401); }
  finally { await secured.close(); }
});

test('old database gains nullable title metadata without rewriting historical task rows', async () => {
  const f = await setup(), task = create(f);
  try {
    const before = f.store.task(task.id); delete before.display_title;
    f.store.run('ALTER TABLE tasks DROP COLUMN display_title');
    const reopened = new Store(path.join(f.config.home, 'project.db'), f.root);
    try { expect(reopened.task(task.id)).toEqual({ ...before, display_title: null }); }
    finally { reopened.close(); }
  } finally { await f.close(); }
});
