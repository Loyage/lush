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
  };
  const task1 = { id: 1, parent_id: null, input_id: 1, role: 'worker', goal: '正在改点什么', status: 'running', integration: 'none',
    updated_at: iso(NOW - 1000), agent_wakes: 2, agent_last_seen_at: iso(NOW - 1000), verifies_task_id: null, resolves_task_id: null };
  const task2 = { id: 2, parent_id: null, input_id: 1, role: 'worker', goal: '合并我', status: 'completed', integration: 'pending',
    updated_at: iso(NOW - 2000), agent_wakes: 1, agent_last_seen_at: iso(NOW - 2000), verifies_task_id: null, resolves_task_id: null };
  const task3 = { id: 3, parent_id: null, input_id: 1, role: 'worker', goal: '另一个待合的', status: 'completed', integration: 'review',
    updated_at: iso(NOW - 3000), agent_wakes: 1, agent_last_seen_at: iso(NOW - 3000), verifies_task_id: null, resolves_task_id: null };
  const snapshot = () => ({
    status: { project: '/tmp/demo', provider: 'mock', concurrency: 2, agents: [], agents_idle: 0, agents_total: 0,
      pending_merges: [{ id: 2, goal: '合并我', branch: 'lush/2-x', integration: 'pending' }], drafts: 0,
      tasks: [{ status: 'running', count: 1 }, { status: 'completed', count: 2 }], merge_freeze: state.freeze, notices: 0,
      version: '0.2.0', fingerprint: 'abc', home: '/tmp/demo/.lush', started_at: iso(NOW - 60000) },
    timeline: { now: iso(NOW), concurrency: 2, start: iso(NOW - 60000), end: iso(NOW), clamped: false, truncated: false, tasks: [] },
    ladder: { target_branch: 'main', truncated: false, nodes: [
      { id: 2, role: 'worker', goal: '合并我', branch: 'lush/2-x', target_branch: 'main', integration: 'pending', deps: [], covered_by: [], level: 0 },
      { id: 3, role: 'worker', goal: '另一个待合的', branch: 'lush/3-x', target_branch: 'release', integration: 'review', deps: [], covered_by: [], level: 0 },
    ] },
    tasks: [task1, task2, task3], inputs: [{ id: 1, content: 'demo', flow: 'develop' }], drafts: [], notices: [],
  });
  const detail = id => id === 1 ? { ...task1, branch: 'lush/1-x', workspace: '/tmp/wt/1', head_commit: 'abc1234', target_branch: 'main',
    calls: 1, agent: { id: 'worker#1', wakes: 2, active: true, pid: 4242, last_seen_at: iso(NOW - 1000) },
    deps: [], dependents: [], verifications: [], resolutions: [], children: [], messages: [], result: null, error: null, integration_error: null } : { ...task2, calls: 1 };
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
