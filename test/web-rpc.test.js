import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fixture, until } from './helpers.js';
import { RPCServer } from '../src/rpc/server.js';
import { RPCClient } from '../src/rpc/client.js';
import { Dispatcher, parseRequest, encode } from '../src/rpc/protocol.js';
import { createSignal } from '../src/signal.js';
import { startWeb } from '../src/ui/web/server.js';
import { UIClient } from '../src/ui/client.js';

// node:http does not inherit machine-wide proxies for these loopback tests.
const fetch = (url, options = {}) => new Promise((resolve, reject) => {
  const request = http.request(url, { method: options.method || 'GET', headers: options.headers }, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
  });
  request.on('error', reject); request.end(options.body);
});
async function setup() {
  const f = fixture(), signal = createSignal();
  const rpc = new RPCServer(f.config.socket,new Dispatcher(f.project,signal,{})); await rpc.start();
  const web = startWeb(f.config,0);
  return { ...f, rpc, web, url:`http://127.0.0.1:${web.port}`, async close() {
    web.stop(true); await rpc.close(); await f.close(); fs.rmSync(f.config.socket,{force:true});
  } };
}

test('web is project scoped, submits immediately and exposes no Service views', async () => {
  const f = await setup();
  try {
    const page = await fetch(f.url); const html = await page.text();
    expect(html).toContain('任务树'); expect(html).not.toContain('Service');
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const submit = await fetch(f.url+'/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'input.submit',params:{content:'web request'}})});
    expect(submit.status).toBe(200);
    const snapshot = await (await fetch(f.url+'/api/snapshot')).json();
    expect(snapshot.status.project).toBe(f.root); expect(snapshot.inputs[0].content).toBe('web request');
    // 并行/串行读模型跟着快照一起下发：没有它们，界面只能说"有这些任务"，说不出谁和谁能同时跑。
    expect(Array.isArray(snapshot.timeline.tasks)).toBe(true);
    expect(snapshot.timeline.concurrency).toBeGreaterThan(0);
    expect(Array.isArray(snapshot.ladder.nodes)).toBe(true);
    const task = await (await fetch(f.url+'/api/task/1')).json(); expect(task.role).toBe('planner');
  } finally { await f.close(); }
});

test('web exposes only read-only task routes and rejects other paths', async () => {
  const f = await setup();
  try {
    await fetch(f.url+'/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'input.submit',params:{content:'read routes'}})});
    expect((await fetch(f.url+'/api/task/1/history')).status).toBe(200);
    const history = await (await fetch(f.url+'/api/task/1/history')).json();
    expect(history[0].type).toBe('created');
    expect((await fetch(f.url+'/api/task/1/history?after=9999')).status).toBe(200);
    expect(await (await fetch(f.url+'/api/task/1/diff')).json()).toBeNull();
    expect((await fetch(f.url+'/api/task/1/diff')).status).toBe(200);
    expect((await fetch(f.url+'/api/task/99/diff')).status).toBe(400);
    expect((await fetch(f.url+'/api/task/1/merge')).status).toBe(404);
    expect((await fetch(f.url+'/api/system/status')).status).toBe(404);
  } finally { await f.close(); }
});

test('web rejects cross-origin requests, forged host, non-JSON and arbitrary RPC', async () => {
  const f = await setup();
  try {
    const body = JSON.stringify({method:'input.submit',params:{content:'bad'}});
    expect((await fetch(f.url+'/api/action',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.invalid'},body})).status).toBe(403);
    expect((await fetch(f.url+'/api/snapshot',{headers:{Host:'evil.invalid'}})).status).toBe(403);
    expect((await fetch(f.url+'/api/action',{method:'POST',body})).status).toBe(400);
    expect((await fetch(f.url+'/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'system.stop',params:{}})})).status).toBe(400);
    expect(f.project.inputs()).toHaveLength(0);
  } finally { await f.close(); }
});

test('web serves the live-refresh and batch-merge modules alongside app.js', async () => {
  const f = await setup();
  try {
    for (const file of ['/live.js', '/merge-select.js']) {
      const response = await fetch(f.url + file);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
    }
    expect(await (await fetch(f.url + '/live.js')).text()).toContain('export async function liveTick');
    expect(await (await fetch(f.url + '/merge-select.js')).text()).toContain('export function mergeCandidates');
    const app = await (await fetch(f.url + '/app.js')).text();
    expect(app).toContain("from './live.js'");
    expect(app).toContain("from './merge-select.js'");
    // 白名单之外仍然 404。
    expect((await fetch(f.url + '/live.mjs')).status).toBe(404);
  } finally { await f.close(); }
});

test('RPC rejects invalid frames, unknown params, invalid ids and cross-project tokens', async () => {
  const f = await setup();
  try {
    expect(() => parseRequest(Buffer.from('invalid'))).toThrow('parse error');
    expect(() => parseRequest(Buffer.from('{"jsonrpc":"2.0","method":"x","id":{}}'))).toThrow('id');
    expect(() => encode({large:'x'.repeat(1048576)})).toThrow('1 MiB');
    const client = new RPCClient(f.config.socket);
    await expect(client.request('task.inspect',{id:-1})).rejects.toThrow('positive');
    await expect(client.request('task.usage',{id:-1})).rejects.toThrow('positive');
    await expect(client.request('task.usage',{id:1,after:0})).rejects.toThrow('unknown parameter');
    await expect(client.request('input.submit',{content:'x',sid:0})).rejects.toThrow('unknown parameter');
    await expect(client.request('input.list',{_token:'foreign'})).rejects.toThrow();
    // 客户端比 daemon 新时不能只说 unknown method，要给出重启这一步
    await expect(new UIClient(f.config).request('service.list',{})).rejects.toThrow('daemon restart');
    // spec.list 无参数：多带一个过滤条件也必须被参数白名单拒掉（过滤/分组在 UI 侧做）
    await expect(new UIClient(f.config).request('spec.list', { status: 'pending' })).rejects.toThrow('unknown parameter');
  } finally { await f.close(); }
});

test('large results do not inflate task listings and event history stays paginated', async () => {
  const f = await setup();
  try {
    f.project.stopping = true;
    const task = f.store.create({ input_id: null, role: 'research', goal: 'large' });
    f.store.update(task.id,{result:'x'.repeat(250000),status:'completed'});
    for (let i=0;i<10;i++) f.store.event(task.id,'output',{result:'x'.repeat(250000)});
    const client = new RPCClient(f.config.socket);
    const tasks = await client.request('task.list'); expect(tasks[0].result).toBeUndefined();
    const first = await client.request('task.history',{id:task.id});
    expect(first.length).toBeLessThan(11);
    const second = await client.request('task.history',{id:task.id,after:first.at(-1).id});
    expect(second[0].id).toBeGreaterThan(first.at(-1).id);
    expect((await client.request('task.inspect',{id:task.id})).result.length).toBe(250000);
  } finally { await f.close(); }
});

test('web surfaces the input flow badge and lets the user reclassify an input', async () => {
  const f = await setup();
  const post = (method, params) => fetch(f.url+'/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,params})});
  try {
    expect((await post('input.submit',{content:'了解调度器怎么工作'})).status).toBe(200);
    expect((await post('input.flow',{id:1,flow:'explain'})).status).toBe(200);
    const snapshot = await (await fetch(f.url+'/api/snapshot')).json();
    expect(snapshot.inputs[0].flow).toBe('explain');
    expect(await (await fetch(f.url+'/app.js')).text()).toContain('标记为了解');
    // 非法取值与非根 task 都在 Web 层报错
    expect((await post('input.flow',{id:1,flow:'maybe'})).status).toBe(400);
    expect((await post('input.flow',{id:99,flow:'develop'})).status).toBe(400);
  } finally { await f.close(); }
});

test('web exposes the read-only agent transcript and keeps sessions out of the read models', async () => {
  const f = await setup();
  try {
    const task = f.project.submit('transcript me').task;
    f.project.stopping = true;   // 只造数据，不让 planner 真的跑
    const dir = path.join(f.config.home, 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `2026-01-01T00-00-00-000Z_lush-task-${task.id}.jsonl`);
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'message', timestamp: 1789749049638, message: { role: 'assistant', content: [
        { type: 'thinking', thinking: '先看看代码' },
        { type: 'toolCall', name: 'bash', arguments: { command: 'ls' } }] } }),
      JSON.stringify({ type: 'message', timestamp: 1789749049639, message: { role: 'toolResult', toolName: 'bash', isError: false, content: [{ type: 'text', text: 'src\nREADME.md' }] } }),
    ].join('\n') + '\n');
    const before = fs.readFileSync(file, 'utf8');
    const page = await (await fetch(`${f.url}/api/task/${task.id}/transcript`)).json();
    expect(page.steps.map(step => [step.kind, step.title])).toEqual([['thinking', '思考'], ['tool', 'bash'], ['result', 'bash']]);
    expect(page.steps[0].body).toBe('先看看代码');
    expect(page.has_more).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    // 越界游标、未知任务、超限 limit 都是 400，不当成服务器错误
    expect((await fetch(`${f.url}/api/task/${task.id}/transcript?after=-1`)).status).toBe(400);
    expect((await fetch(`${f.url}/api/task/99/transcript`)).status).toBe(400);
    // 执行过程默认一步一行：默认展开的只有「回答」，其余（思考/工具调用/工具输出）要点开才看正文
    const app = await (await fetch(`${f.url}/app.js`)).text();
    expect(app).toMatch(/STEP_OPEN = new Set\(\['text'\]\)/);
    expect(app).toContain('展开全部步骤');
    expect(app).toContain('默认折叠成一行');
    // 过程不进快照/列表，只有 transcript 路由才读会话文件；快照只带 work 层任务
    const snapshot = await (await fetch(f.url + '/api/snapshot')).json();
    expect(JSON.stringify(snapshot)).not.toContain('先看看代码');
    expect(snapshot.tasks.map(row => row.id)).not.toContain(task.id);
    expect(snapshot.inputs[0]).toMatchObject({ task_id: task.id });
  } finally { await f.close(); }
});

test('web exposes agent usage (model, context, cost) next to the transcript', async () => {
  const f = await setup();
  try {
    const task = f.project.submit('usage me').task;
    f.project.stopping = true;   // 只造数据，不让 planner 真的跑
    const dir = path.join(f.config.home, 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `2026-01-01T00-00-00-000Z_lush-task-${task.id}.jsonl`), [
      JSON.stringify({ type: 'model_change', timestamp: 1789749049000, provider: 'deepseek', modelId: 'deepseek-flash' }),
      JSON.stringify({ type: 'message', timestamp: 1789749049638, message: { role: 'assistant', provider: 'deepseek', model: 'deepseek-flash',
        content: [{ type: 'text', text: '已处理' }],
        usage: { input: 1426, output: 193, cacheRead: 2176, cacheWrite: 0, reasoning: 68, totalTokens: 3795, cost: { total: 0.000672456 } } } }),
    ].join('\n') + '\n');
    const usage = await (await fetch(`${f.url}/api/task/${task.id}/usage`)).json();
    expect(usage.model).toEqual({ provider: 'deepseek', model_id: 'deepseek-flash' });
    expect(usage.requests).toBe(1);
    expect(usage.context_tokens).toBe(3795);
    expect(usage.totals.cost).toBeCloseTo(0.000672456, 9);
    expect((await fetch(`${f.url}/api/task/99/usage`)).status).toBe(400);
    // 用量只走这条只读路由，不进快照
    expect(JSON.stringify(await (await fetch(f.url + '/api/snapshot')).json())).not.toContain('deepseek-flash');
    // 详情面板把 agent 身份、模型、上下文与花费和执行过程放在同一块里
    const app = await (await fetch(`${f.url}/app.js`)).text();
    expect(app).toContain("block('Agent'");
    for (const label of ['模型', '上下文占用', '累计 token', '预计花费', '模型请求']) expect(app).toContain(label);
  } finally { await f.close(); }
});

test('web serves the verification report as a self-contained document and nothing else', async () => {
  const f = await setup();
  try {
    f.project.stopping = true;   // 只造数据，不让 planner 真的跑
    const worker = f.store.create({ parent_id: null, input_id: null, role: 'worker', goal: 'w', name: 'w' });
    const verifier = f.store.create({ parent_id: null, input_id: null, role: 'verifier', goal: 'v', name: 'verify-1', verifies_task_id: worker.id });
    // 还没写报告时是 404，而不是空文档
    expect((await fetch(`${f.url}/api/task/${verifier.id}/report`)).status).toBe(404);
    const file = path.join(f.config.home, 'verify', String(verifier.id), 'report.html');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '<!doctype html><title>对照</title><p>before/after</p>');
    const response = await fetch(`${f.url}/api/task/${verifier.id}/report`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await response.text()).toContain('before/after');
    // 非 verifier 任务与不存在的任务都不报文件路径，只报错
    expect((await fetch(`${f.url}/api/task/${worker.id}/report`)).status).toBe(400);
    expect((await fetch(`${f.url}/api/task/9999/report`)).status).toBe(400);
    const app = await (await fetch(`${f.url}/app.js`)).text();
    expect(app).toContain('检验中…');
    expect(app).toContain('打开 HTML 报告');
  } finally { await f.close(); }
});

test('web buffers drafts, commits the whole batch and keeps agents out of the composer', async () => {
  const f = await setup();
  const post = (method, params) => fetch(f.url+'/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,params})});
  try {
    const html = await (await fetch(f.url)).text();
    expect(html).toContain('加入缓存');
    expect(html).toContain('提交并规划');
    expect(html).toContain('待提交缓存');
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
    // planner 属于意图层：快照的 inputs 里有它，任务列表里没有
    expect(snapshot.inputs[0].task_id).toBeGreaterThan(0);
    expect(snapshot.tasks).toEqual([]);
    // 已提交的输入不能被删；agent token 与非白名单方法都被拒
    expect((await post('draft.remove',{id:1})).status).toBe(400);
    expect((await post('draft.add',{content:'sneak',_token:'forged'})).status).toBe(400);
    expect((await post('draft.clear',{})).status).toBe(400);
    expect((await post('input.submit',{content:'raw',_token:'forged'})).status).toBe(400);
  } finally { await f.close(); }
});

test('web edits a buffered draft and submits only the picked subset', async () => {
  const f = await setup();
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

    // 只提交选中的一条：input 里只有它，未选中的留在缓存
    expect((await post('draft.commit',{ids:[second.id]})).status).toBe(200);
    snapshot = await snapshotNow();
    expect(snapshot.drafts.map(draft => draft.content)).toEqual(['第一条（改过）']);
    expect(snapshot.inputs[0].content).toBe('第二条');
    expect(snapshot.status.drafts).toBe(1);

    // 已提交的输入既不能改也不在缓存里；未知 id 与空 ids 都拒绝
    expect((await post('draft.update',{id:second.id,content:'x'})).status).toBe(400);
    expect((await post('draft.commit',{ids:[9999]})).status).toBe(400);
    expect((await post('draft.commit',{ids:[]})).status).toBe(400);

    // 页面真的带上了勾选框与就地编辑
    const app = await (await fetch(f.url+'/app.js')).text();
    expect(app).toContain("pick.type = 'checkbox'");
    expect(app).toContain("'draft.update'");
  } finally { await f.close(); }
});

test('web serves the tree sort module and wires the smart-sort dropdown', async () => {
  const f = await setup();
  try {
    const module = await fetch(f.url+'/tree-order.js');
    expect(module.status).toBe(200);
    expect(await module.text()).toContain('export function orderSiblings');
    const app = await (await fetch(f.url+'/app.js')).text();
    expect(app).toContain('智能排序');
    expect(app).toContain('tree-sort');
    const html = await (await fetch(f.url)).text();
    expect(html).toContain('id="tree-sort"');
  } finally { await f.close(); }
});

test('web exposes batch merge through the mutation whitelist', async () => {
  const f = await setup();
  const post = (method, params) => fetch(f.url+'/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,params})});
  try {
    // 白名单通过后才会到运行时校验：空 ids 报的是「至少一个」，不是「method not allowed from Web UI」。
    const response = await post('task.merge_many', { ids: [] });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('at least one');
    // agent token 在 Web 层直接被拒；真正的 USER_ONLY 校验在 daemon，见 merge-batch.test.js
    expect((await post('task.merge_many', { ids: [1], _token: 'forged' })).status).toBe(400);
  } finally { await f.close(); }
});

test('web shows the read-only spec queue and labels scheduler tasks', async () => {
  const f = await setup();
  const post = (method, params) => fetch(f.url+'/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,params})});
  try {
    f.project.stopping = true;   // 只造数据，不让 planner / scheduler 真的跑
    const planner = f.project.submit('重做一个页面').task;
    const workerSpec = f.project.addSpec(planner.id, { goal: '写一个页面', role: 'worker', name: 'build-page' });
    const researchSpec = f.project.addSpec(planner.id, { goal: '调研旧实现', role: 'research', name: 'study-old' });
    const droppedSpec = f.project.addSpec(planner.id, { goal: '重复的拆解', role: 'worker', name: 'duplicate' });
    f.project.dropSpec(droppedSpec.id, '重复');
    // 一个 scheduler 一次性取走这一批；取走后排成任务的算 planned，剩下的仍是 pending。
    const scheduler = f.store.create({ input_id: null, role: 'scheduler', goal: '调度拆解队列' });
    f.store.takeSpecs(scheduler.id, 10);
    const spawned = f.store.create({ parent_id: scheduler.id, input_id: null, role: 'worker', goal: '写一个页面', name: 'build-page' });
    f.store.plannedSpec(workerSpec.id, spawned.id);

    const snapshot = await (await fetch(f.url+'/api/snapshot')).json();
    expect(Array.isArray(snapshot.specs)).toBe(true);
    expect(snapshot.specs.map(spec => spec.id).sort((a, b) => a - b))
      .toEqual([workerSpec.id, researchSpec.id, droppedSpec.id].sort((a, b) => a - b));
    const planned = snapshot.specs.find(spec => spec.id === workerSpec.id);
    expect(planned).toMatchObject({ status: 'planned', batch_id: scheduler.id, planner_task_id: planner.id,
      role: 'worker', name: 'build-page', task_id: spawned.id });
    expect(planned.deps).toEqual([]);
    expect(snapshot.specs.find(spec => spec.id === researchSpec.id)).toMatchObject({ status: 'pending', batch_id: scheduler.id, task_id: null });
    const dropped = snapshot.specs.find(spec => spec.id === droppedSpec.id);
    expect(dropped.status).toBe('dropped');
    expect(dropped.note).toBe('重复');
    // status.specs 的计数与批次摘要
    expect(snapshot.status.specs).toMatchObject({ pending: 1, planned: 1, dropped: 1 });
    expect(snapshot.status.specs.batches.find(batch => batch.id === scheduler.id)).toMatchObject({ status: 'queued', role: 'scheduler', count: 2 });
    // scheduler 不进任务列表，但意图行里带着它的 id 与状态
    expect(snapshot.tasks.some(task => task.role === 'scheduler')).toBe(false);
    expect(snapshot.inputs.find(row => row.task_id === planner.id)).toMatchObject({ scheduler_id: scheduler.id });

    // 队列区块是只读的：Web 不暴露 spec 写操作
    expect((await post('spec.add', { goal: 'nope', role: 'worker' })).status).toBe(400);
    expect((await post('spec.drop', { id: researchSpec.id })).status).toBe(400);

    // 页面真的画了这个区块，并把 scheduler 显示成「调度」
    const html = await (await fetch(f.url)).text();
    expect(html).toContain('拆解队列');
    expect(await (await fetch(f.url+'/app.js')).text()).toContain("scheduler: '调度'");
  } finally { await f.close(); }
});

test('web 意图面板：意图行带 planner 闸门与 scheduler 进度，批准走 plan.approve', async () => {
  const f = await setup();
  const post = (method, params) => fetch(f.url+'/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,params})});
  try {
    f.project.stopping = true;   // 只造意图与闸门，不让 planner 真的跑
    const planner = f.project.submit('做点大事').task;
    const spec = f.project.addSpec(planner.id, { goal: '动架构', role: 'worker', name: 'big-change' });
    f.project.proposePlan(planner.id, '这轮要动架构', '我打算先拆核心再改调用方……');
    // 意图行把 planner 闸门、拆解计数与那条审批 notice 一起下发；任务列表里没有它
    const snapshot = await (await fetch(f.url+'/api/snapshot')).json();
    expect(snapshot.inputs[0]).toMatchObject({ task_id: planner.id, plan_gate: 'proposed', specs_pending: 1, work_tasks: 0, status: 'queued' });
    expect(snapshot.inputs[0].plan_notice_id).toBeGreaterThan(0);
    expect(snapshot.tasks.some(task => task.id === planner.id)).toBe(false);
    // 页面真的画了意图区块，并把 scheduler 当意图层的节点（详情里能看它这一批 spec）
    const html = await (await fetch(f.url)).text();
    expect(html).toContain('意图');
    expect(await (await fetch(f.url+'/app.js')).text()).toContain('plan.approve');
    // 用户批准：白名单放行，闸门变 approved，这一批 spec 留给 scheduler（这里是 stopping，不会真的起）
    expect((await post('plan.approve', { id: planner.id })).status).toBe(200);
    const approved = await (await fetch(f.url+'/api/snapshot')).json();
    expect(approved.inputs[0].plan_gate).toBe('approved');
    expect(approved.status.specs.pending).toBe(1);
    // planner 专属的 plan.propose 不能从 Web 调
    expect((await post('plan.propose', { title: 'nope' })).status).toBe(400);
    // 已经批过了就不能再批，也不能再用普通 notice 回答绕过去
    expect((await post('plan.approve', { id: planner.id })).status).toBe(400);
    expect((await post('notice.answer', { id: approved.inputs[0].plan_notice_id, answer: '又批一次' })).status).toBe(400);
    expect(f.store.task(planner.id).plan_gate).toBe('approved');
    expect(f.store.spec(spec.id).status).toBe('pending');
  } finally { await f.close(); }
});

test('web clears the board through task.clear and refuses it while tasks are live', async () => {
  const f = await setup();
  const post = (method, params) => fetch(f.url+'/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,params})});
  try {
    expect(await (await fetch(f.url+'/app.js')).text()).toContain('清空任务看板');
    expect((await post('input.submit',{content:'one job'})).status).toBe(200);
    // agent token 在 Web 层直接被拒；真正的「有活动任务就不许清」由 daemon 判定，见 task-clear.test.js
    expect((await post('task.clear',{_token:'forged'})).status).toBe(400);
    await until(() => f.project.running.size === 0 && f.store.activeTasks().length === 0);
    const response = await post('task.clear',{});
    expect(response.status).toBe(200);
    expect((await response.json()).cleared.tasks).toBeGreaterThan(0);
    const snapshot = await (await fetch(f.url+'/api/snapshot')).json();
    expect(snapshot.tasks).toEqual([]); expect(snapshot.inputs).toEqual([]);
    expect(snapshot.status.tasks).toEqual([]);
  } finally { await f.close(); }
});
