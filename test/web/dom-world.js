export const NOW = Date.now();
export const iso = ms => new Date(ms).toISOString();

/**
 * DOM 测试共用的 world 工厂：用一个最小 DOM stub 代替浏览器（test/dom-stub.js），用可控的 fetch
 * 代替 daemon，让 src/ui/web/assets/app.js 真的跑一遍。返回的 `{ state, fetchImpl }` 与原文件同形。
 */
export function makeWorld() {
  const state = {
    usageLast: { at: iso(NOW - 1000), kind: 'tool', title: 'bash', body: 'ls -la' },
    transcriptSteps: [
      { seq: 1, kind: 'input', title: '任务上下文', at: iso(NOW - 9000), body: '读任务' },
      { seq: 2, kind: 'tool', title: 'bash', at: iso(NOW - 8000), body: '{"command":"ls"}' },
    ],
    freeze: [],
    // 分支图：给 /api/graph 造数据。覆盖「有任务的分支」「无任务的锚点分支」「未登记的新 ref」
    // 「只有 parent 指针提到的占位分支」，以及一条记录还在、ref 已消失的分支。
    // 测试可以整体替换 state.graph 来模拟截断 / 空图 / 新分支。
    graph: {
      generated_at: iso(NOW), current_branch: 'main', truncated: false, git: true, error: null,
      nodes: [
        { kind: 'task', id: 1, role: 'worker', name: 'one', goal: '正在改点什么', status: 'running', integration: 'none',
          branch: 'lush/demo/1-one', workspace: '/tmp/wt/1', workspace_state: 'missing', branch_state: 'present',
          base_commit: 'aaa', head_commit: 'bbb', target_branch: 'main', ahead: 1, behind: 0, merged: false, current: false },
        { kind: 'task', id: 2, role: 'worker', name: 'two', goal: '合并我', status: 'completed', integration: 'pending',
          branch: 'lush/demo/2-two', workspace: '/tmp/wt/2', workspace_state: 'present', branch_state: 'present',
          base_commit: 'ccc', head_commit: 'ddd', target_branch: 'main', ahead: 1, behind: 0, merged: false, current: false },
        { kind: 'task', id: 3, role: 'worker', name: 'three', goal: '另一个待合的', status: 'completed', integration: 'review',
          branch: 'lush/demo/3-three', workspace: null, workspace_state: 'none', branch_state: 'missing',
          base_commit: 'eee', head_commit: 'fff', target_branch: 'release', ahead: 2, behind: 1, merged: false, current: false },
        { kind: 'branch', id: 'branch:main', name: 'main', head_commit: 'eee', current: true, tracked: false, placeholder: false },
        { kind: 'branch', id: 'branch:release', name: 'release', head_commit: 'fff', current: false, tracked: false, placeholder: false },
        { kind: 'branch', id: 'branch:lush/demo/1-one', name: 'lush/demo/1-one', head_commit: 'bbb', current: false, tracked: true, placeholder: false },
        { kind: 'branch', id: 'branch:lush/demo/2-two', name: 'lush/demo/2-two', head_commit: 'ddd', current: false, tracked: true, placeholder: false },
        { kind: 'branch', id: 'branch:lush/demo/3-three', name: 'lush/demo/3-three', head_commit: null, current: false, tracked: true, placeholder: false },
        { kind: 'branch', id: 'branch:lush/demo/input-1-anchor', name: 'lush/demo/input-1-anchor', head_commit: 'abc', current: false, tracked: true, placeholder: false },
        { kind: 'branch', id: 'branch:feature/scratch', name: 'feature/scratch', head_commit: 'aaa', current: false, tracked: false, placeholder: false },
        { kind: 'branch', id: 'branch:feature/gone', name: 'feature/gone', head_commit: null, current: false, tracked: false, placeholder: true },
      ],
      edges: [
        { kind: 'code', from: 1, to: 2 },
        { kind: 'target', from: 1, to: 'branch:main' },
        { kind: 'target', from: 2, to: 'branch:main' },
        { kind: 'target', from: 3, to: 'branch:release' },
        // fork：新分支从旧分支分出来，父分支下嵌套。
        { kind: 'fork', from: 'branch:main', to: 'branch:lush/demo/input-1-anchor' },
        { kind: 'fork', from: 'branch:main', to: 'branch:lush/demo/1-one' },
        { kind: 'fork', from: 'branch:lush/demo/1-one', to: 'branch:lush/demo/2-two' },
        { kind: 'fork', from: 'branch:release', to: 'branch:lush/demo/3-three' },
        { kind: 'fork', from: 'branch:feature/gone', to: 'branch:feature/scratch' },
      ],
    },
    currentBranch: 'main',
    notices: [],
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
    ladder: { target_branch: 'main', current_branch: state.currentBranch, truncated: false, nodes: [
      { id: 2, role: 'worker', goal: '合并我', branch: 'lush/2-x', target_branch: 'main', integration: 'pending', deps: [], covered_by: [], level: 0 },
      { id: 3, role: 'worker', goal: '另一个待合的', branch: 'lush/3-x', target_branch: 'release', integration: 'review', deps: [], covered_by: [], level: 0 },
    ], groups: [
      { target_branch: 'main', current: state.currentBranch === 'main', ready: !state.freeze.length && state.currentBranch === 'main' ? 1 : 0, items: [
        { id: 2, source_task_id: 2, role: 'worker', goal: '合并我', branch: 'lush/2-x', target_branch: 'main', integration: 'pending',
          phase: 'awaiting_review', ready: !state.freeze.length && state.currentBranch === 'main', deps: [], covered_by: [], level: 0,
          blockers: [
            ...(state.freeze.length ? [{ code: 'frozen', task_id: state.freeze[0].task_id, message: `#${state.freeze[0].task_id} 的冲突冻结了 main` }] : []),
            ...(state.currentBranch !== 'main' ? [{ code: 'wrong_branch', message: `当前检出 ${state.currentBranch}，需要切换到 main` }] : []),
          ] },
      ] },
      { target_branch: 'release', current: state.currentBranch === 'release', ready: state.currentBranch === 'release' ? 1 : 0, items: [
        { id: 3, source_task_id: 3, role: 'worker', goal: '另一个待合的', branch: 'lush/3-x', target_branch: 'release', integration: 'review',
          phase: 'review_required', ready: state.currentBranch === 'release',
          blockers: state.currentBranch === 'release' ? [] : [{ code: 'wrong_branch', message: `当前检出 ${state.currentBranch}，需要切换到 release` }],
          deps: [], covered_by: [], level: 0 },
      ] },
    ] },
    tasks: [task1, task2, task3], inputs: state.intents, drafts: state.drafts, notices: state.notices, specs: state.specs,
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
    if (path === '/api/graph') return json(state.graph);
    if (path === '/api/action') {
      const body = JSON.parse(options.body);
      state.actions.push(body);
      if (body.method === 'task.merge_many') return json({ target_branch: body.params.ids.includes(3) ? 'release' : 'main',
        merges: body.params.ids.map(id => ({ id, status: 'merged', integration: 'merged' })), merged: body.params.ids.length, stopped: null });
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

