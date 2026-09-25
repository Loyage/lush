import { test, expect } from 'bun:test';
import { repo } from '../helpers.js';
import { fetch, pageSource, setup } from './harness.js';

// 缓存逐条提交：不带 ids = 全部，带 ids = 指定子集。

test('web buffers drafts, commits the whole batch and keeps agents out of the composer', async () => {
  const f = await setup(); await repo(f.root);
  const post = (method, params) => fetch(f.url+'/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,params})});
  try {
    const html = await (await fetch(f.url)).text();
    expect(html).toContain('存草稿');
    expect(html).toContain('>发送</button>');
    expect(html).toContain('>草稿<span');
    expect((await post('draft.add',{content:'第一条'})).status).toBe(200);
    expect((await post('draft.add',{content:'第二条'})).status).toBe(200);
    let snapshot = await (await fetch(f.url+'/api/snapshot')).json();
    expect(snapshot.drafts.map(draft => draft.content)).toEqual(['第一条','第二条']);
    expect(snapshot.status.drafts).toBe(2);
    expect((await post('draft.remove',{id:snapshot.drafts[0].id})).status).toBe(200);
    expect((await post('draft.commit',{})).status).toBe(200);
    snapshot = await (await fetch(f.url+'/api/snapshot')).json();
    expect(snapshot.drafts).toEqual([]);
    expect(snapshot.status.drafts).toBe(0);
    expect(snapshot.inputs[0].content).toBe('第二条');
    // planner 属于 control plane，不在任务列表；mock Plan 已由 runtime 直接编译出 research work。
    expect(snapshot.inputs[0].task_id).toBeGreaterThan(0);
    expect(snapshot.tasks.some(task => task.role === 'planner')).toBe(false);
    expect(snapshot.tasks.some(task => task.role === 'research')).toBe(true);
    // 已提交的输入不能被删；agent token 与非白名单方法都被拒
    expect((await post('draft.remove',{id:1})).status).toBe(400);
    expect((await post('draft.add',{content:'sneak',_token:'forged'})).status).toBe(400);
    expect((await post('draft.clear',{})).status).toBe(400);
    const divergence = await (await post('task.resolve_divergence',{id:9999})).json();
    expect(divergence.error).toContain('task 9999'); // routed to daemon, not rejected by Web mutation whitelist
    expect((await post('input.submit',{content:'raw',_token:'forged'})).status).toBe(400);
  } finally { await f.close(); }
});

test('input.submit accepts one draft id or direct text, never mixes both or consumes unrelated drafts', async () => {
  const f = await setup(); await repo(f.root);
  const post = (method, params) => fetch(f.url+'/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,params})});
  try {
    const first = await (await post('draft.add', { content: 'first' })).json();
    const second = await (await post('draft.add', { content: 'second' })).json();
    expect((await post('input.submit', { draft_id: first.id, content: 'override' })).status).toBe(400);
    expect((await post('input.submit', { draft_id: second.id, references: [] })).status).toBe(400);
    expect((await post('input.submit', { draft_id: 9999 })).status).toBe(400);
    let snapshot = await (await fetch(f.url+'/api/snapshot')).json();
    expect(snapshot.drafts.map(draft => draft.id)).toEqual([first.id, second.id]);
    const sent = await (await post('input.submit', { draft_id: second.id })).json();
    expect(sent.content).toBe('second'); expect(sent.draft).toBe(second.id);
    expect((await post('input.submit', { draft_id: second.id })).status).toBe(400);
    snapshot = await (await fetch(f.url+'/api/snapshot')).json();
    expect(snapshot.drafts.map(draft => draft.id)).toEqual([first.id]);
    const direct = await (await post('input.submit', { content: 'direct' })).json();
    expect(direct.content).toBe('direct');
    snapshot = await (await fetch(f.url+'/api/snapshot')).json();
    expect(snapshot.drafts.map(draft => draft.id)).toEqual([first.id]);
  } finally { await f.close(); }
});

test('web persists structured context references without mixing them into input text', async () => {
  const f = await setup(); await repo(f.root);
  const post = (method, params) => fetch(f.url+'/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,params})});
  const reference = { version: 1, kind: 'text', target: {}, label: '所选文字', quote: '页面原文',
    location: { view: 'overview', section: 'selection' }, captured_at: '2026-01-01T00:00:00.000Z' };
  try {
    const added = await post('draft.add', { content: '解释它', references: [reference] });
    expect(added.status).toBe(200);
    let snapshot = await (await fetch(f.url+'/api/snapshot')).json();
    expect(snapshot.drafts[0].content).toBe('解释它');
    expect(snapshot.drafts[0].references[0].quote).toBe('页面原文');
    expect((await post('draft.commit', { ids: [snapshot.drafts[0].id] })).status).toBe(200);
    snapshot = await (await fetch(f.url+'/api/snapshot')).json();
    expect(snapshot.inputs[0].content).toBe('解释它');
    expect(snapshot.inputs[0].references[0]).toMatchObject({ segment: 1, kind: 'text', quote: '页面原文' });
  } finally { await f.close(); }
});

test('web edits a buffered draft and submits only the picked subset', async () => {
  const f = await setup(); await repo(f.root);
  const post = (method, params) => fetch(f.url+'/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,params})});
  const snapshotNow = async () => (await fetch(f.url+'/api/snapshot')).json();
  try {
    await post('draft.add',{content:'第一条'});
    await post('draft.add',{content:'第二条'});
    let snapshot = await snapshotNow();
    const [first, second] = snapshot.drafts;

    // 就地编辑：draft.update 经 HTTP 可用，内容立刻生效
    expect((await post('draft.update',{id:first.id,content:'第一条（改过）'})).status).toBe(200);
    snapshot = await snapshotNow();
    expect(snapshot.drafts.map(draft => draft.content)).toEqual(['第一条（改过）','第二条']);

    // 只提交指定的一条：返回逐条 input，input 里只有它，未提交的留在缓存
    const committed = await post('draft.commit',{ids:[second.id]});
    expect(committed.status).toBe(200);
    const batch = await committed.json();
    expect(Array.isArray(batch.inputs)).toBe(true);
    expect(batch.inputs.map(input => input.content)).toEqual(['第二条']);
    expect(batch.drafts).toEqual([second.id]);
    snapshot = await snapshotNow();
    expect(snapshot.drafts.map(draft => draft.content)).toEqual(['第一条（改过）']);
    expect(snapshot.inputs[0].content).toBe('第二条');
    expect(snapshot.status.drafts).toBe(1);

    // 已提交的输入既不能改也不在缓存里；未知 id 与空 ids 都拒绝
    expect((await post('draft.update',{id:second.id,content:'x'})).status).toBe(400);
    expect((await post('draft.commit',{ids:[9999]})).status).toBe(400);
    expect((await post('draft.commit',{ids:[]})).status).toBe(400);

    // 页面真的带上了单条发送与就地编辑，且不再有勾选框
    const app = await pageSource(f.url);
    expect(app).toContain("'say.submit', { draft_id: draft.id");
    expect(app).toContain("agentHelp");
    expect(app).not.toContain("pick.type = 'checkbox'");
    expect(app).toContain("'draft.update'");
  } finally { await f.close(); }
});
