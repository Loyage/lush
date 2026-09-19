import { test, expect } from 'bun:test';
import { fetch, pageSource, setup } from './harness.js';

// 只读 spec 队列、意图面板、plan.approve。

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
    expect(await pageSource(f.url)).toContain("scheduler: '调度'");
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
    expect(await pageSource(f.url)).toContain('plan.approve');
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
