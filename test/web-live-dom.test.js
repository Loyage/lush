import { test, expect, afterAll } from 'bun:test';
import { installDom, findByText, deepText } from './dom-stub.js';
import { until } from './helpers.js';

const NOW = Date.now();
const iso = ms => new Date(ms).toISOString();

/**
 * 这套测试把 app.js 真的跑一遍：它用一个最小 DOM stub 代替浏览器，
 * 用可控的 fetch 代替 daemon，然后断言用户看不到手点也能更新的两件事——
 * 「最近一次执行」与展开的执行过程会随轮询推进，以及批量合并的选择 / 顺序 / 结果展示。
 */
function makeWorld() {
  const state = {
    usageLast: { at: iso(NOW - 1000), kind: 'tool', title: 'bash', body: 'ls -la' },
    transcriptSteps: [
      { seq: 1, kind: 'input', title: '任务上下文', at: iso(NOW - 9000), body: '读任务' },
      { seq: 2, kind: 'tool', title: 'bash', at: iso(NOW - 8000), body: '{"command":"ls"}' },
    ],
    freeze: [],
    transcriptAfter: [],
    actions: [],
    drafts: [],
    commits: [],
    // 意图层的两条输入：一条的 planner 申请了批准（specs 分两批），一条已经批准。
    intents: [
      { id: 1, content: 'demo', flow: 'develop', task_id: 9, status: 'awaiting', plan_gate: 'proposed', plan_notice_id: 7,
        specs_pending: 1, specs_planned: 1, specs_dropped: 0, scheduler_id: 4, scheduler_status: 'queued', work_tasks: 2,
        draft_count: 0, created_at: iso(NOW - 9000), planner_updated_at: iso(NOW - 1000) },
      { id: 2, content: '已批准的那条', flow: 'develop', task_id: 11, status: 'completed', plan_gate: 'approved', plan_notice_id: null,
        specs_pending: 0, specs_planned: 2, specs_dropped: 1, scheduler_id: null, scheduler_status: null, work_tasks: 3,
        draft_count: 0, created_at: iso(NOW - 9500), planner_updated_at: iso(NOW - 2000) },
    ],
    // 左侧拆解队列的两条：一条还没被 scheduler 取走，一条已被 scheduler #4 取走并排成了任务 #2。
    specs: [
      { id: 1, input_id: 1, planner_task_id: 9, batch_id: null, seq: 1, goal: '还没编排的拆解', role: 'worker', name: 'queued-one',
        deps: [], status: 'pending', task_id: null, note: null, created_at: iso(NOW - 4000), updated_at: iso(NOW - 4000) },
      { id: 2, input_id: 1, planner_task_id: 9, batch_id: 4, seq: 2, goal: '已被调度取走的拆解', role: 'research', name: 'taken-one',
        deps: [{ spec: 1, kind: 'order' }], status: 'planned', task_id: 2, note: null, created_at: iso(NOW - 3000), updated_at: iso(NOW - 3000) },
    ],
  };
  const task1 = { id: 1, parent_id: null, input_id: 1, role: 'worker', goal: '正在改点什么', status: 'running', integration: 'none',
    updated_at: iso(NOW - 1000), agent_wakes: 2, agent_last_seen_at: iso(NOW - 1000), verifies_task_id: null, resolves_task_id: null };
  const task2 = { id: 2, parent_id: null, input_id: 1, role: 'worker', goal: '合并我', status: 'completed', integration: 'pending',
    updated_at: iso(NOW - 2000), agent_wakes: 1, agent_last_seen_at: iso(NOW - 2000), verifies_task_id: null, resolves_task_id: null };
  const task3 = { id: 3, parent_id: null, input_id: 1, role: 'worker', goal: '另一个待合的', status: 'completed', integration: 'review',
    updated_at: iso(NOW - 3000), agent_wakes: 1, agent_last_seen_at: iso(NOW - 3000), verifies_task_id: null, resolves_task_id: null };
  const task4 = { id: 4, parent_id: null, input_id: null, role: 'scheduler', goal: '调度拆解队列', status: 'queued', integration: 'none',
    updated_at: iso(NOW - 500), agent_wakes: 0, agent_last_seen_at: null, verifies_task_id: null, resolves_task_id: null };
  const snapshot = () => ({
    status: { project: '/tmp/demo', provider: 'mock', concurrency: 2, agents: [], agents_idle: 0, agents_total: 0,
      pending_merges: [{ id: 2, goal: '合并我', branch: 'lush/2-x', integration: 'pending' }], drafts: 0,
      tasks: [{ status: 'running', count: 1 }, { status: 'completed', count: 2 }], merge_freeze: state.freeze, notices: 0,
      // 拆解队列的计数与批次摘要（和 system.status 同形）
      specs: { pending: 1, planned: 1, dropped: 0, batches: [{ id: 4, status: 'queued', role: 'scheduler', count: 1 }] },
      version: '0.2.0', fingerprint: 'abc', home: '/tmp/demo/.lush', started_at: iso(NOW - 60000) },
    timeline: { now: iso(NOW), concurrency: 2, start: iso(NOW - 60000), end: iso(NOW), clamped: false, truncated: false, tasks: [] },
    ladder: { target_branch: 'main', truncated: false, nodes: [
      { id: 2, role: 'worker', goal: '合并我', branch: 'lush/2-x', target_branch: 'main', integration: 'pending', deps: [], covered_by: [], level: 0 },
      { id: 3, role: 'worker', goal: '另一个待合的', branch: 'lush/3-x', target_branch: 'release', integration: 'review', deps: [], covered_by: [], level: 0 },
    ] },
    tasks: [task1, task2, task3], inputs: state.intents, drafts: state.drafts, notices: [], specs: state.specs,
  });
  const detail = id => {
    if (id === 1) return { ...task1, branch: 'lush/1-x', workspace: '/tmp/wt/1', head_commit: 'abc1234', target_branch: 'main',
      calls: 1, agent: { id: 'worker#1', wakes: 2, active: true, pid: 4242, last_seen_at: iso(NOW - 1000) },
      deps: [], dependents: [], verifications: [], resolutions: [], children: [], messages: [], result: null, error: null, integration_error: null };
    if (id === 4) return { ...task4, calls: 0, deps: [], dependents: [], children: [], messages: [], notices: [], result: null, error: null,
      integration_error: null, specs: state.specs };
    return { ...task2, calls: 1 };
  };
  const usage = () => ({ task_id: 1, files: ['s1.jsonl'], model: { provider: 'mock', model_id: 'mock-1' }, thinking_level: null,
    requests: 1, context_tokens: 123, compacted: 0, last_at: state.usageLast.at, last: state.usageLast,
    totals: { input: 10, output: 5, cache_read: 0, cache_write: 0, reasoning: 0, tokens: 15, cost: 0.001 } });
  const fetchImpl = async (url, options = {}) => {
    const path = String(url);
    const json = data => ({ ok: true, status: 200, json: async () => data });
    if (path === '/api/snapshot') return json(snapshot());
    if (path === '/api/action') {
      const body = JSON.parse(options.body);
      state.actions.push(body);
      if (body.method === 'task.merge_many') return json({ merges: body.params.ids.map(id => ({ id, status: 'merged', integration: 'merged' })), merged: body.params.ids.length, stopped: null });
      if (body.method === 'draft.update') { const draft = state.drafts.find(row => row.id === body.params.id); if (draft) draft.content = body.params.content; return json({ id: draft?.id, content: draft?.content }); }
      if (body.method === 'draft.remove') { state.drafts = state.drafts.filter(row => row.id !== body.params.id); return json({ id: body.params.id }); }
      if (body.method === 'draft.add') { const draft = { id: state.drafts.length ? Math.max(...state.drafts.map(row => row.id)) + 1 : 1, content: body.params.content, created_at: iso(NOW) }; state.drafts = [...state.drafts, draft]; return json(draft); }
      if (body.method === 'draft.commit') {
        const ids = body.params.ids ?? state.drafts.map(row => row.id);
        state.commits.push(ids);
        const chosen = state.drafts.filter(row => ids.includes(row.id));
        state.drafts = state.drafts.filter(row => !ids.includes(row.id));
        return json({ id: 1, content: chosen.map(row => row.content).join('\n'), task: { id: 99 }, drafts: ids });
      }
      if (body.method === 'plan.approve' || body.method === 'plan.reject') {
        const intent = state.intents.find(row => row.task_id === body.params.id);
        if (intent) intent.plan_gate = body.method === 'plan.approve' ? 'approved' : 'rejected';
        return json({ planner: body.params.id, plan_gate: intent?.plan_gate ?? null });
      }
      return json({});
    }
    let match = /^\/api\/task\/(\d+)$/.exec(path);
    if (match) return json(detail(Number(match[1])));
    if (/^\/api\/task\/\d+\/history/.test(path)) return json([]);
    if (/^\/api\/task\/\d+\/diff$/.test(path)) return json(null);
    if (/^\/api\/task\/\d+\/usage$/.test(path)) return json(usage());
    match = /^\/api\/task\/\d+\/transcript\?after=(\d+)$/.exec(path);
    if (match) {
      const after = Number(match[1]);
      state.transcriptAfter.push(after);
      const steps = state.transcriptSteps.filter(step => step.seq > after);
      return json({ task_id: 1, files: ['s1.jsonl'], steps, next: state.transcriptSteps.at(-1)?.seq ?? after, has_more: false, truncated: false });
    }
    return { ok: false, status: 404, json: async () => ({ error: `no route ${path}` }) };
  };
  return { state, fetchImpl };
}

const world = makeWorld();
const dom = installDom({ fetch: world.fetchImpl });
await import('../src/ui/web/assets/app.js');

afterAll(() => dom.restore());

test('批量合并：只列出能合的任务，冻结的不给选，按依赖顺序确认，并逐条展示结果', async () => {
  const detail = dom.node('detail');
  // 只有 completed + pending/review 的 #2、#3 有勾选框；running 的 #1 不在候选里。
  const boxes = () => detail.querySelectorAll('input.pick');
  expect(boxes()).toHaveLength(2);
  expect(boxes().every(box => box.disabled === false)).toBe(true);

  // 同一目标分支上出现未解决冲突：另一个任务被冻结，不能再勾。
  world.state.freeze = [{ id: 4, task_id: 4, target_branch: 'main', resolves_task_id: null }];
  await dom.intervalFor(1500)();
  const frozen = boxes().find(box => box.disabled);
  expect(frozen).toBeTruthy();
  // 被冻结的任务在界面上就是不可勾的（浏览器里 disabled 的勾选框不会触发 onchange）。
  expect(deepText(detail)).toContain('合并被冻结：#4');

  // 只选没被冻结的 #3（它在 release 上，不受 main 的冲突冻结影响）。
  const pick = boxes().filter(box => !box.disabled);
  expect(pick).toHaveLength(1);
  pick[0].checked = true;
  pick[0].onchange();
  const mergeSelected = findByText(detail, '合并选中 (1)');
  expect(mergeSelected).toBeTruthy();
  expect(mergeSelected.disabled).toBe(false);

  await mergeSelected.onclick();
  // 确认框把即将合并的东西与「依赖优先」说清楚。
  expect(dom.confirms.at(-1)).toContain('按依赖顺序合并 1 个任务');
  expect(dom.confirms.at(-1)).toContain('#3');
  // 请求只带勾选的 id；顺序由运行时按依赖决定。
  expect(world.state.actions).toEqual([{ method: 'task.merge_many', params: { ids: [3] } }]);
  // 结果逐条展示，刷新后仍在页面上。
  expect(deepText(detail)).toContain('批量合并结果');
  expect(findByText(detail, '已进入目标分支')).toBeTruthy();
  expect(findByText(detail, '全部合并成功：1 个。')).toBeTruthy();
  expect(findByText(detail, '#3')).toBeTruthy();
});

test('详情头部显示对应意图编号，能点开那条意图，input_id 为空时不乱显示', async () => {
  const detail = dom.node('detail');
  const head = () => detail.querySelector('.head');
  dom.location.hash = '#task-1';
  await dom.fire('hashchange');
  await until(() => head() && findByText(head(), '意图 #1'), 2000);

  // 头部写着「意图 #1」而不是「输入 #1」，hover 能看到意图原文，并且是可点的。
  const intent = findByText(head(), '意图 #1');
  expect(intent.title).toContain('demo');
  expect(intent.classList.contains('intent-link')).toBe(true);

  // 点击跳到这条意图的 planner 任务 #9（fixture 里 intents[0].task_id = 9）。
  await intent.onclick();
  expect(dom.location.hash).toBe('#task-9');

  // scheduler #4 的 input_id 是 null：头部不该出现「意图 #null」。
  dom.location.hash = '#task-4';
  await dom.fire('hashchange');
  await until(() => head() && deepText(head()).includes('#4'), 2000);
  expect(deepText(head())).not.toContain('意图 #');
});

test('热任务的详情会自己变新：最近一次执行与展开的执行过程随轮询推进', async () => {
  dom.location.hash = '#task-1';
  await dom.fire('hashchange');
  const detail = dom.node('detail');
  await until(() => detail.querySelector('[data-live="last"]'), 2000);

  const lastRow = detail.querySelector('[data-live="last"]');
  expect(lastRow.querySelector('span').textContent).toContain('bash');
  expect(lastRow.querySelector('span').textContent).toContain('刚刚');

  // 模拟浏览器里每 3 秒跑一次的 liveRefresh：agent 又推进一步，面板不用手点就变新。
  world.state.usageLast = { at: iso(NOW), kind: 'text', title: '回答', body: '改好了，正在跑测试' };
  await dom.intervalFor(3000)();
  const updated = detail.querySelector('[data-live="last"]').querySelector('span').textContent;
  expect(updated).toContain('改好了，正在跑测试');
  expect(updated).toContain('回答');

  // 展开执行过程：首次全量读，之后按 after=next 增量续读。
  const expand = findByText(detail, '查看执行过程');
  await expand.onclick();
  const list = () => detail.querySelector('[data-live="transcript-steps"]');
  await until(() => list() && list().children.length === 2, 2000);
  expect(world.state.transcriptAfter).toEqual([0]);

  world.state.transcriptSteps.push({ seq: 3, kind: 'text', title: '回答', at: iso(NOW), body: '测试通过' });
  await dom.intervalFor(3000)();
  expect(list().children.length).toBe(3);
  expect(deepText(list())).toContain('测试通过');
  // 第二个 tick 用的是游标 2，不是从头再读一遍。
  expect(world.state.transcriptAfter).toEqual([0, 2]);
  // 会话步骤与「最近一次执行」是同一份数据源：最后一步也能在这里看到。
  expect(detail.querySelector('[data-live="last"]').querySelector('span').textContent).toContain('回答');
});

test('缓存可勾选部分提交，也可以就地编辑，轮询不打断编辑', async () => {
  world.state.drafts = [
    { id: 11, content: '第一条', created_at: iso(NOW - 5000) },
    { id: 12, content: '第二条', created_at: iso(NOW - 4000) },
  ];
  await dom.intervalFor(1500)();
  const drafts = dom.node('drafts');
  expect(drafts.querySelectorAll('.draft')).toHaveLength(2);
  const boxes = drafts.querySelectorAll('.pick');
  expect(boxes).toHaveLength(2);
  expect(boxes.every(box => box.checked)).toBe(true);

  // 取消勾选 #12：提交按钮仍可用（#11 还选着），提交只带 #11
  boxes[1].checked = false; boxes[1].onchange();
  expect(dom.node('draft-commit').disabled).toBe(false);
  await dom.node('input-form').onsubmit({ preventDefault() {} });
  expect(world.state.commits.at(-1)).toEqual([11]);
  expect(dom.node('error').textContent).toContain('已提交 1 条输入');

  // 剩下的一条可以点正文就地编辑；轮询刷新不重建正在编辑的那条
  await dom.intervalFor(1500)();
  drafts.querySelector('.goal').onclick();
  const box = drafts.querySelector('textarea.draft-edit');
  expect(box).toBeTruthy();
  expect(box.value).toBe('第二条');
  await dom.intervalFor(1500)();
  expect(drafts.querySelector('textarea.draft-edit')).toBe(box);

  // Enter 保存：draft.update 发出后正文变成新内容
  box.value = '第二条（改过）';
  await box.listeners.keydown[0]({ key: 'Enter', preventDefault() {} });
  await until(() => world.state.drafts[0]?.content === '第二条（改过）');
  await until(() => dom.node('drafts').querySelector('.goal')?.textContent === '第二条（改过）');
});

test('拆解队列只读展示：按批次分组、能跳到派生的任务，scheduler 显示成调度，空队列收敛成空态', async () => {
  const specs = dom.node('specs');
  const groups = () => specs.querySelectorAll('.spec-batch').map(node => node.textContent);
  // 两条分组标题：还没编排的在前，已被 scheduler 取走的次之
  expect(groups()).toHaveLength(2);
  expect(groups()[0]).toContain('等 scheduler 编排');
  expect(groups()[0]).toContain('planner #9');
  expect(groups()[1]).toContain('已被 scheduler #4');
  expect(groups()[1]).toContain('planner #9');
  const text = deepText(specs);
  expect(text).toContain('#1');
  expect(text).toContain('还没编排的拆解');
  expect(text).toContain('排队中');
  expect(text).toContain('#2');
  expect(text).toContain('已被调度取走的拆解');
  expect(text).toContain('已排期');
  expect(text).toContain('任务 #2');
  // 纯只读：队列里唯一的按钮是跳转，没有 spec.add / spec.drop / 编辑入口
  expect(specs.querySelectorAll('button').map(node => node.textContent)).toEqual(['查看任务']);

  // planned 那条的「查看任务」打开它派生成的任务详情
  await findByText(specs, '查看任务').onclick();
  expect(deepText(dom.node('detail'))).toContain('合并我');

  // 意图面板把 scheduler 显示成「调度 #4 · 排队」；点它可展开这一批 spec 与依赖（scheduler 不在任务树里）
  const intents = dom.node('intents');
  expect(deepText(intents)).toContain('调度 #4 · 排队');
  expect(dom.node('tasks').querySelector('[data-id="4"]')).toBeFalsy();
  await findByText(intents, '调度 #4 · 排队').onclick();
  const detail = dom.node('detail');
  expect(deepText(detail)).toContain('拆解队列');
  expect(deepText(detail)).toContain('本任务这一批取走的 spec');
  expect(deepText(detail)).toContain('还没编排的拆解');
  expect(deepText(detail)).toContain('已被调度取走的拆解');
  expect(deepText(detail)).toContain('依赖 spec #1');

  // 队列被清空后，轮询把它收敛成空态，不残留旧节点
  world.state.specs = [];
  await dom.intervalFor(1500)();
  expect(deepText(specs)).toContain('拆解队列空');
  expect(specs.querySelectorAll('.spec')).toHaveLength(0);
  expect(specs.querySelectorAll('.spec-batch')).toHaveLength(0);
});

test('意图面板：planner/scheduler 不进任务树，批准/驳回走 plan.approve|reject', async () => {
  const intents = dom.node('intents');
  const text = deepText(intents);
  // 意图正文 + 意图层状态：规划 #9（planner）与调度 #4（scheduler）都在这里，不在任务树里
  expect(text).toContain('demo');
  expect(text).toContain('规划 #9');
  expect(text).toContain('拆解 待编排 1 · 已编排 1');
  expect(text).toContain('调度 #4 · 排队');
  expect(text).toContain('等你批准');
  expect(text).toContain('已批准');
  expect(dom.node('tasks').querySelector('[data-id="9"]')).toBeFalsy();
  expect(dom.node('tasks').querySelector('[data-id="11"]')).toBeFalsy();

  // 批准：闸门放行交给 scheduler，刷新后按钮消失、徽章变成已批准
  await findByText(intents, '批准并开发').onclick();
  expect(world.state.actions.at(-1)).toEqual({ method: 'plan.approve', params: { id: 9 } });
  expect(deepText(dom.node('intents'))).not.toContain('批准并开发');
  expect(findByText(dom.node('intents'), '已批准')).toBeTruthy();

  // 驳回：先问理由，再把理由一起送给 planner 重拆
  world.state.intents[0].plan_gate = 'proposed';
  await dom.intervalFor(1500)();
  dom.setPrompt('别动架构，先加个开关');
  await findByText(dom.node('intents'), '驳回').onclick();
  expect(dom.prompts.at(-1)).toContain('驳回理由');
  expect(world.state.actions.at(-1)).toEqual({ method: 'plan.reject', params: { id: 9, reason: '别动架构，先加个开关' } });
  expect(findByText(dom.node('intents'), '已驳回')).toBeTruthy();
});
