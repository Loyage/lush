import { test, expect } from 'bun:test';
import { repo } from '../helpers.js';
import { fetch, pageSource, setup } from './harness.js';

// 只读 spec 队列、意图面板、plan.approve。

test('web shows the read-only Plan and deterministic compilation state', async () => {
  const f = await setup(); await repo(f.root);
  const post = (method, params) => fetch(f.url+'/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,params})});
  try {
    f.project.stopping = true;   // 只造数据，不让 planner 真的跑
    const planner = (await f.project.submit('重做一个页面')).task;
    const workerSpec = f.project.addSpec(planner.id, { goal: '写一个页面', role: 'worker', name: 'build-page' });
    const researchSpec = f.project.addSpec(planner.id, { goal: '调研旧实现', role: 'research', name: 'study-old' });
    const droppedSpec = f.project.addSpec(planner.id, { goal: '重复的拆解', role: 'worker', name: 'duplicate' });
    f.project.dropSpec(droppedSpec.id, '重复');
    // runtime 直接把 spec 编译成 root work item；另一条仍 pending。
    const spawned = f.store.transaction(() => f.project.materializeSpec(planner.id, workerSpec.id));

    const snapshot = await (await fetch(f.url+'/api/snapshot')).json();
    expect(Array.isArray(snapshot.specs)).toBe(true);
    expect(snapshot.specs.map(spec => spec.id).sort((a, b) => a - b))
      .toEqual([workerSpec.id, researchSpec.id, droppedSpec.id].sort((a, b) => a - b));
    const planned = snapshot.specs.find(spec => spec.id === workerSpec.id);
    expect(planned).toMatchObject({ status: 'planned', batch_id: null, planner_task_id: planner.id,
      role: 'worker', name: 'build-page', task_id: spawned.id });
    expect(planned.deps).toEqual([]);
    expect(snapshot.specs.find(spec => spec.id === researchSpec.id)).toMatchObject({ status: 'pending', batch_id: null, task_id: null });
    const dropped = snapshot.specs.find(spec => spec.id === droppedSpec.id);
    expect(dropped.status).toBe('dropped');
    expect(dropped.note).toBe('重复');
    // status.specs 显式说明由 deterministic compiler 负责，不再产生 batch task。
    expect(snapshot.status.specs).toMatchObject({ pending: 1, planned: 1, dropped: 1, compiler: 'deterministic', batches: [] });
    expect(snapshot.tasks.some(task => task.role === 'scheduler')).toBe(false);
    expect(snapshot.inputs.find(row => row.task_id === planner.id)).toMatchObject({ scheduler_id: null });

    // 队列区块是只读的：Web 不暴露 spec 写操作
    expect((await post('spec.add', { goal: 'nope', role: 'worker' })).status).toBe(400);
    expect((await post('spec.drop', { id: researchSpec.id })).status).toBe(400);

    // 执行计划是业务页面，不是任务类型，写清由 runtime 编译。
    const html = await (await fetch(f.url)).text();
    expect(html).toContain('执行计划');
    expect(await pageSource(f.url)).toContain('runtime');
  } finally { await f.close(); }
});

test('web Intent 面板：planner 闸门批准后交给 deterministic compiler', async () => {
  const f = await setup(); await repo(f.root);
  const post = (method, params) => fetch(f.url+'/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,params})});
  try {
    f.project.stopping = true;   // 只造意图与闸门，不让 planner 真的跑
    const planner = (await f.project.submit('做点大事')).task;
    const spec = f.project.addSpec(planner.id, { goal: '动架构', role: 'worker', name: 'big-change' });
    f.project.proposePlan(planner.id, '这轮要动架构', '我打算先拆核心再改调用方……');
    // 意图行把 planner 闸门、拆解计数与那条审批 notice 一起下发；任务列表里没有它
    const snapshot = await (await fetch(f.url+'/api/snapshot')).json();
    expect(snapshot.inputs[0]).toMatchObject({ task_id: planner.id, plan_gate: 'proposed', specs_pending: 1, work_tasks: 0, status: 'queued' });
    expect(snapshot.inputs[0].plan_notice_id).toBeGreaterThan(0);
    expect(snapshot.tasks.some(task => task.id === planner.id)).toBe(false);
    // 页面画出 Intent 及审批动作。
    const html = await (await fetch(f.url)).text();
    expect(html).toContain('意图');
    expect(await pageSource(f.url)).toContain('plan.approve');
    // 用户批准：白名单放行；这里 stopping，所以 compiler 暂不运行。
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
