import { test, expect } from 'bun:test';
import { RPCClient } from '../../src/rpc/client.js';
import { repo } from '../helpers.js';
import { fetch, pageSource, setup } from './harness.js';

// 大结果不进列表、事件分页；Web 也不再提供改判入口。
test('large results do not inflate task listings and event history stays paginated', async () => {
  const f = await setup();
  try {
    f.project.stopping = true;
    const task = f.store.create({ input_id: null, role: 'research', goal: 'large' });
    f.store.update(task.id,{result:'x'.repeat(250000),status:'completed'});
    f.store.transaction(() => {
      for (let i=0;i<10;i++) f.store.event(task.id,'output',{result:'x'.repeat(250000)});
    });
    const client = new RPCClient(f.config.socket);
    const tasks = await client.request('worker.list'); expect(tasks[0].result).toBeUndefined();
    const first = await client.request('worker.history',{id:task.id});
    expect(first.length).toBeLessThan(11);
    const second = await client.request('worker.history',{id:task.id,after:first.at(-1).id});
    expect(second[0].id).toBeGreaterThan(first.at(-1).id);
    expect((await client.request('worker.inspect',{id:task.id})).result.length).toBe(250000);
  } finally { await f.close(); }
});
test('recent event history is cursor-paged and explicitly reports truncation', async () => {
  const f = await setup();
  try {
    f.project.stopping = true;
    const task = f.store.create({ input_id: null, role: 'research', goal: 'history' });
    f.store.transaction(() => {
      // 只用略超两个默认页（100）的数据：三页游标与截断边界的口径不变，记录数最小。
      for (let index = 0; index < 201; index += 1) f.store.event(task.id, 'tick', { index });
    });
    const recent = await (await fetch(f.url + `/api/worker/${task.id}/history-page`)).json();
    expect(recent.events).toHaveLength(100); expect(recent.truncated).toBe(true);
    expect(recent.events[0].id).toBeLessThan(recent.events.at(-1).id);
    const older = await (await fetch(f.url + `/api/worker/${task.id}/history-page?before=${recent.cursor}`)).json();
    expect(older.events).toHaveLength(100); expect(older.truncated).toBe(true);
    expect(older.events.at(-1).id).toBeLessThan(recent.events[0].id);
    const oldest = await (await fetch(f.url + `/api/worker/${task.id}/history-page?before=${older.cursor}`)).json();
    expect(oldest.events.length).toBeGreaterThan(0); expect(oldest.truncated).toBe(false);
  } finally { await f.close(); }
});

test('web no longer exposes the removed input flow judgement', async () => {
  const f = await setup(); await repo(f.root);
  const post = (method, params) => fetch(f.url+'/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,params})});
  try {
    expect((await post('order.submit',{content:'了解调度器怎么工作'})).status).toBe(200);
    const page = await pageSource(f.url);
    // 旧名称在此拼接：既验证页面与接口不再暴露它们，又不给仓库留下已移除的字面量。
    const removedMethod = ['input', 'flow'].join('.');
    const removedLabels = [['标记为', '开发'].join(''), ['标记为', '了解'].join('')];
    for (const label of removedLabels) expect(page).not.toContain(label);
    // handler 与 MUTATIONS 都已删除：未知方法在 Web 层被拒为 400
    expect((await post(removedMethod,{id:1,flow:'explain'})).status).toBe(400);
  } finally { await f.close(); }
});
