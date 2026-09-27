import { test, expect } from 'bun:test';
import { RPCClient } from '../../src/rpc/client.js';
import { repo } from '../helpers.js';
import { fetch, pageSource, setup } from './harness.js';

// 大结果不进列表、事件分页、input 快照不再携带已删除的 flow 判定；Web 也不再提供改判入口。

test('Web 全类型窗口与历史分页包含两层 AP，旧 RPC 默认口径不变', async () => {
  const f = await setup();
  try {
    f.project.stopping = true;
    const roles = ['planner', 'scheduler', 'worker', 'coordinator', 'research', 'verifier', 'merger', 'showcase', 'explainer'];
    const history = [];
    for (let round = 0; round < 8; round++) for (const role of roles) {
      const ap = f.store.create({ input_id: null, role, goal: `${role} ${round}` });
      f.store.update(ap.id, { status: 'completed' }); history.push(ap.id);
    }
    const active = roles.map(role => f.store.create({ input_id: null, role, goal: `active ${role}` }));
    const first = await (await fetch(f.url + '/api/overview')).json();
    // Web 概览不再携带并行时间轴字段（后端 read model 与 /api/snapshot 保留）。
    expect(first.timeline).toBeUndefined();
    expect(first.ap_page).toMatchObject({ active: 9, historical: 72, total: 81, shown: 50, has_more: true });
    expect(first.aps).toHaveLength(59);
    for (const ap of active) expect(first.aps.some(row => row.id === ap.id)).toBe(true);
    const older = await (await fetch(f.url + `/api/aps?scope=all&before=${first.ap_page.cursor}&limit=50`)).json();
    expect(older.aps).toHaveLength(22);
    expect(older.has_more).toBe(false);
    const allIds = [...first.aps, ...older.aps].map(ap => ap.id);
    expect(new Set(allIds).size).toBe(81);
    expect([...allIds].sort((a, b) => a - b)).toEqual([...history, ...active.map(ap => ap.id)]);
    const client = new RPCClient(f.config.socket);
    const legacy = await client.request('ap.activity');
    expect(legacy.aps.every(ap => ap.layer === 'work')).toBe(true);
    expect(legacy.page.total).toBe(63);
    expect((await fetch(f.url + '/api/aps?scope=invalid')).status).toBe(400);
    expect((await client.request('ap.page', { scope: 'all', limit: 1 })).aps).toHaveLength(1);
  } finally { await f.close(); }
});

test('large results do not inflate AP listings and event history stays paginated', async () => {
  const f = await setup(); await repo(f.root);
  try {
    f.project.stopping = true;
    const ap = f.store.create({ input_id: null, role: 'research', goal: 'large' });
    f.store.update(ap.id,{result:'x'.repeat(250000),status:'completed'});
    for (let i=0;i<10;i++) f.store.event(ap.id,'output',{result:'x'.repeat(250000)});
    const client = new RPCClient(f.config.socket);
    const aps = await client.request('ap.list'); expect(aps[0].result).toBeUndefined();
    const first = await client.request('ap.history',{id:ap.id});
    expect(first.length).toBeLessThan(11);
    const second = await client.request('ap.history',{id:ap.id,after:first.at(-1).id});
    expect(second[0].id).toBeGreaterThan(first.at(-1).id);
    expect((await client.request('ap.inspect',{id:ap.id})).result.length).toBe(250000);
  } finally { await f.close(); }
});

test('10k history stays bounded, reports UI truncation and cursor-pages while legacy snapshot remains complete', async () => {
  const f = await setup(); await repo(f.root);
  try {
    f.project.stopping = true;
    f.store.run(`WITH RECURSIVE seq(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM seq WHERE id<10000)
      INSERT INTO aps(id,role,goal,status,result) SELECT id,'research','history '||id,'completed','done '||id FROM seq`);
    f.store.setAPIdHigh(10000);
    // system.summary must not touch Agent settings; that full profile belongs to system.status/settings only.
    const agentConfig = f.project.agentConfig;
    f.project.agentConfig = () => { throw new Error('overview opened full Agent config'); };
    const first = await (await fetch(f.url + '/api/overview')).json();
    expect(first.aps).toHaveLength(50);
    expect(first.ap_page).toMatchObject({ active: 0, historical: 10000, shown: 50, has_more: true, truncated: true });
    expect(first.status.agent_config).toBeUndefined();
    expect(first.ladder).toMatchObject({ nodes: [], groups: [], truncated: false });
    const unchanged = await (await fetch(f.url + `/api/overview?revision=${encodeURIComponent(first.revision)}`)).json();
    expect(unchanged).toEqual({ unchanged: true, revision: first.revision });
    const older = await (await fetch(f.url + `/api/aps?before=${first.ap_page.cursor}&limit=50`)).json();
    expect(older.aps).toHaveLength(50); expect(older.has_more).toBe(true);
    const oldest = await (await fetch(f.url + '/api/aps?before=51&limit=50')).json();
    expect(oldest.aps).toHaveLength(50); expect(oldest.cursor).toBe(1); expect(oldest.has_more).toBe(false);
    f.project.agentConfig = agentConfig;
    const legacy = await (await fetch(f.url + '/api/snapshot')).json();
    expect(legacy.aps).toHaveLength(10000); expect(legacy.status.agent_config.default).toBeTruthy();
  } finally { await f.close(); }
});

test('recent event history is cursor-paged and explicitly reports truncation', async () => {
  const f = await setup(); await repo(f.root);
  try {
    f.project.stopping = true;
    const ap = f.store.create({ input_id: null, role: 'research', goal: 'history' });
    for (let index = 0; index < 220; index += 1) f.store.event(ap.id, 'tick', { index });
    const recent = await (await fetch(f.url + `/api/ap/${ap.id}/history-page`)).json();
    expect(recent.events).toHaveLength(100); expect(recent.truncated).toBe(true);
    expect(recent.events[0].id).toBeLessThan(recent.events.at(-1).id);
    const older = await (await fetch(f.url + `/api/ap/${ap.id}/history-page?before=${recent.cursor}`)).json();
    expect(older.events).toHaveLength(100); expect(older.truncated).toBe(true);
    expect(older.events.at(-1).id).toBeLessThan(recent.events[0].id);
    const oldest = await (await fetch(f.url + `/api/ap/${ap.id}/history-page?before=${older.cursor}`)).json();
    expect(oldest.events.length).toBeGreaterThan(0); expect(oldest.truncated).toBe(false);
  } finally { await f.close(); }
});

test('web no longer exposes the removed input flow judgement', async () => {
  const f = await setup(); await repo(f.root);
  const post = (method, params) => fetch(f.url+'/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,params})});
  try {
    expect((await post('input.submit',{content:'了解调度器怎么工作'})).status).toBe(200);
    const snapshot = await (await fetch(f.url+'/api/snapshot')).json();
    expect(snapshot.inputs[0]).not.toHaveProperty('flow');
    const page = await pageSource(f.url);
    // 旧名称在此拼接：既验证页面与接口不再暴露它们，又不给仓库留下已移除的字面量。
    const removedMethod = ['input', 'flow'].join('.');
    const removedLabels = [['标记为', '开发'].join(''), ['标记为', '了解'].join('')];
    for (const label of removedLabels) expect(page).not.toContain(label);
    // handler 与 MUTATIONS 都已删除：未知方法在 Web 层被拒为 400
    expect((await post(removedMethod,{id:1,flow:'explain'})).status).toBe(400);
  } finally { await f.close(); }
});
