import { expect, test } from 'bun:test';
import fs from 'node:fs';
import { setup, fetch } from './harness.js';
import { startTestWeb } from './auth-fixture.js';
import { env, temp } from '../helpers.js';
import { UIClient } from '../../src/ui/client.js';
import { projectRouteId } from '../../src/host/registry.js';

const create = (f, parent = null, goal = 'selected') => f.store.create({ parent_id: parent, role: 'agent', task_kind: parent ? 'child' : 'order', goal });

test('real HTTP/RPC relation pages preserve root, statuses and empty cursors; invalid queries and writes are refused', async () => {
  const f = await setup();
  try {
    const parent = create(f), selected = create(f, parent.id), child = create(f, selected.id, 'direct child');
    const archived = create(f, selected.id, 'archived direct child'); create(f, child.id, 'grandchild');
    f.store.update(child.id, { status: 'failed' }); f.store.update(archived.id, { status: 'completed', integration: 'merged' });
    f.store.event(archived.id, 'task.accepted', { actor: 'user' });
    const base = `${f.url}/api/worker/${selected.id}/relations`;
    const response = await fetch(base + '?limit=1'); expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const first = await response.json();
    expect(first.parent.id).toBe(parent.id); expect(first.children).toMatchObject({ total: 2, cursor: child.id, has_more: true, limit: 1 });
    expect(first.children.items[0]).toMatchObject({ id: child.id, status: 'failed', goal: 'direct child' });
    const next = await (await fetch(base + `?after=${first.children.cursor}&limit=1`)).json();
    expect(next.children.items).toHaveLength(1);
    expect(next.children.items[0]).toMatchObject({ id: archived.id, status: 'completed', integration: 'merged', accepted: true });
    expect(next.children.has_more).toBe(false);
    expect((await (await fetch(`${f.url}/api/worker/${parent.id}/relations`)).json()).parent).toBeNull();
    for (const query of ['unknown=1','force=true','limit=1&limit=2','after=0&after=1','after=-1','after=1.5','after=9007199254740992',
      'after=bad','after=','after=false','limit=','limit=0','limit=201','limit=1.5','limit=bad']) {
      expect((await fetch(base + '?' + query)).status).toBe(400);
    }
    for (const id of ['0','999999999','9007199254740992']) expect((await fetch(`${f.url}/api/worker/${id}/relations`)).status).toBe(400);
    expect((await fetch(`${f.url}/api/task/${selected.id}/relations`)).status).toBe(404);
    expect((await fetch(base, { method: 'POST' })).status).not.toBe(200);
    expect((await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'worker.relations', params: { id: selected.id } }) })).status).toBe(400);
  } finally { await f.close(); }
});

test('global Host uses the explicit source project for real relation reads, never last-selected project', async () => {
  const a = await setup(), b = await setup(), global = temp(); let host;
  try {
    const aa = create(a, null, 'project A'), ab = create(a, aa.id, 'child A');
    const ba = create(b, null, 'project B'), bb = create(b, ba.id, 'child B');
    expect(aa.id).toBe(ba.id); expect(ab.id).toBe(bb.id);
    const facts = new Map([[a.root, a], [b.root, b]]);
    host = startTestWeb(null, 0, { env: env({ LUSH_GLOBAL_CONFIG: global }), openProject: async project => {
      const f = facts.get(project); if (!f) throw new Error('unknown test project');
      return { config: f.config, client: new UIClient(f.config) };
    } });
    const url = `http://127.0.0.1:${host.port}`;
    for (const f of [a, b]) expect((await fetch(url + '/api/host/select', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: f.root }) })).status).toBe(200);
    for (const [f, title] of [[a, 'child A'], [b, 'child B'], [a, 'child A']]) {
      const response = await fetch(`${url}/p/${projectRouteId(f.root)}/api/worker/${aa.id}/relations`);
      expect(response.status).toBe(200); expect((await response.json()).children.items.map(row => row.goal)).toEqual([title]);
    }
    expect((await fetch(`${url}/api/worker/${aa.id}/relations`)).status).toBe(400);
    expect((await fetch(`${url}/p/0000000000000000/api/worker/${aa.id}/relations`)).status).toBe(400);
  } finally { host?.stop(true); await a.close(); await b.close(); fs.rmSync(global, { recursive: true, force: true }); }
});
