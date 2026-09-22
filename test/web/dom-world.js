export const NOW = Date.now();
export const iso = ms => new Date(ms).toISOString();

/**
 * DOM 测试共用的 world 工厂：用一个最小 DOM stub 代替浏览器（test/dom-stub.js），用可控的 fetch
 * 代替 daemon，让 src/ui/web/assets/app.js 真的跑一遍。返回的 `{ state, fetchImpl }` 与原文件同形。
 */
export function makeWorld() {
  const state = {
    // 折叠态「最近一次执行」：usage.last 带精确 tokens，chip 与执行过程同口径显示。
    usageLast: { at: iso(NOW - 1000), kind: 'tool', title: 'bash', body: 'ls -la',
      tokens: { input: 300, output: 40, cache_read: 9600, cache_write: 0, reasoning: 9, total: 9940, cost: 0.001, exact: true, turn: true } },
    // 执行过程 fixture：无 tokens 的 input 步；同一条 assistant 回复拆出的两个 step（只有首步带 first）；
    // 两次请求之间的一批工具输出（估算，只有批首带 first，续读到的同批步骤没有 first）。
    transcriptSteps: [
      { seq: 1, kind: 'input', title: '任务上下文', at: iso(NOW - 9000), body: '读任务' },
      { seq: 2, kind: 'thinking', title: '思考', at: iso(NOW - 8000), body: '先看看',
        tokens: { input: 300, output: 40, cache_read: 9600, cache_write: 0, reasoning: 9, total: 9940, cost: 0.001, exact: true, turn: true, first: true } },
      { seq: 3, kind: 'tool', title: 'bash', at: iso(NOW - 7500), body: '{"command":"ls"}',
        tokens: { input: 300, output: 40, cache_read: 9600, cache_write: 0, reasoning: 9, total: 9940, cost: 0.001, exact: true, turn: true } },
      { seq: 4, kind: 'result', title: 'bash', at: iso(NOW - 7000), body: 'src\nREADME.md',
        tokens: { context_added: 1200, estimated: true, batch: true, first: true } },
      { seq: 5, kind: 'result', title: 'edit', at: iso(NOW - 6500), body: 'ok',
        tokens: { context_added: 1200, estimated: true, batch: true } },
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
          base_commit: 'aaa', head_commit: 'bbb', target_branch: 'main', ahead: 1, behind: 0, merged: false, current: false,
          progress: { version: 1, updated_at: iso(NOW - 500), completed: 1, total: 3,
            current: { key: 'implement', label: '实现功能', started_at: iso(NOW - 65000) } } },
        { kind: 'task', id: 2, role: 'worker', name: 'two', goal: '合并我', status: 'completed', integration: 'pending',
          branch: 'lush/demo/2-two', workspace: '/tmp/wt/2', workspace_state: 'present', branch_state: 'present',
          base_commit: 'ccc', head_commit: 'ddd', target_branch: 'main', ahead: 1, behind: 0, merged: false, current: false },
        { kind: 'task', id: 3, role: 'worker', name: 'three', goal: '另一个待合的', status: 'completed', integration: 'review',
          branch: 'lush/demo/3-three', workspace: null, workspace_state: 'none', branch_state: 'missing',
          base_commit: 'eee', head_commit: 'fff', target_branch: 'release', ahead: 2, behind: 1, merged: false, current: false },
        // created_at 决定兄弟顺序：新的在前（见 test/web/graph-layout.test.js 的纯逻辑断言）；
        // feature/scratch 与 feature/gone 是本地未登记 / 占位分支，没有创建时间——排在已知时间之后。
        { kind: 'branch', id: 'branch:main', name: 'main', head_commit: 'eee', current: true, tracked: false, placeholder: false, created_at: iso(NOW - 60000) },
        { kind: 'branch', id: 'branch:release', name: 'release', head_commit: 'fff', current: false, tracked: false, placeholder: false, created_at: iso(NOW - 50000) },
        { kind: 'branch', id: 'branch:lush/demo/1-one', name: 'lush/demo/1-one', head_commit: 'bbb', current: false, tracked: true, placeholder: false, created_at: iso(NOW - 30000) },
        { kind: 'branch', id: 'branch:lush/demo/2-two', name: 'lush/demo/2-two', head_commit: 'ddd', current: false, tracked: true, placeholder: false, created_at: iso(NOW - 20000) },
        { kind: 'branch', id: 'branch:lush/demo/3-three', name: 'lush/demo/3-three', head_commit: null, current: false, tracked: true, placeholder: false, created_at: iso(NOW - 25000) },
        { kind: 'branch', id: 'branch:lush/demo/input-1-anchor', name: 'lush/demo/input-1-anchor', head_commit: 'abc', current: false, tracked: true, placeholder: false, created_at: iso(NOW - 40000) },
        { kind: 'branch', id: 'branch:feature/scratch', name: 'feature/scratch', head_commit: 'aaa', current: false, tracked: false, placeholder: false },
        { kind: 'branch', id: 'branch:feature/gone', name: 'feature/gone', head_commit: null, current: false, tracked: false, placeholder: true },
        // 落后型：子分支没有独有提交、父分支已前进——可以直接快进跟上（can_catchup）。
        { kind: 'branch', id: 'branch:lush/demo/behind-only', name: 'lush/demo/behind-only', head_commit: 'aaa', current: false, tracked: true, placeholder: false, created_at: iso(NOW - 10000) },
      ],
      edges: [
        { kind: 'code', from: 1, to: 2 },
        { kind: 'target', from: 1, to: 'branch:main' },
        { kind: 'target', from: 2, to: 'branch:main' },
        { kind: 'target', from: 3, to: 'branch:release' },
        // fork：新分支从旧分支分出来，父分支下嵌套。
        { kind: 'fork', from: 'branch:main', to: 'branch:lush/demo/input-1-anchor', status: 'integrated', ahead: 0, behind: 0, blockers: [], can_merge: false, can_sync: false },
        { kind: 'fork', from: 'branch:main', to: 'branch:lush/demo/1-one', status: 'fast_forward', ahead: 1, behind: 0, blockers: [], can_merge: true, can_sync: false },
        { kind: 'fork', from: 'branch:lush/demo/1-one', to: 'branch:lush/demo/2-two', status: 'diverged', ahead: 1, behind: 2, blockers: [], can_merge: false, can_sync: true },
        { kind: 'fork', from: 'branch:release', to: 'branch:lush/demo/3-three', status: 'missing', ahead: null, behind: null, blockers: [], can_merge: false, can_sync: false },
        { kind: 'fork', from: 'branch:feature/gone', to: 'branch:feature/scratch', status: 'unknown', ahead: null, behind: null, blockers: [], can_merge: false, can_sync: false },
        { kind: 'fork', from: 'branch:main', to: 'branch:lush/demo/behind-only', status: 'integrated', ahead: 0, behind: 3, blockers: [], can_merge: false, can_sync: false, can_catchup: true },
      ],
    },
    currentBranch: 'main',
    // 运行设置（并发上限）：system.status.settings 的镜像；/api/action 的 system.configure 改写它。
    runtimeSettings: {
      file: '/tmp/demo/.lush/settings.json',
      concurrency: { value: 2, default: 2, overridden: false },
      control_concurrency: { value: 1, default: 1, overridden: false },
    },
    notices: [],
    transcriptAfter: [],
    actions: [],
    agentEnvironments: {
      common: { HTTP_PROXY: 'http://127.0.0.1:7897', API_KEY: 'secret-value' },
      planner: {}, coordinator: {}, worker: {}, research: {}, verifier: {}, merger: {},
    },
    agentConfig: {
      version: 1, file: '/tmp/demo/.lush/agent.json', runtime_agent: 'pi',
      default: { agent: 'pi', model: '', thinking: '', default_prompt: '', append_prompt: '', extensions: [], skills: [] }, roles: {},
      resolved: Object.fromEntries(['planner','coordinator','worker','research','verifier','merger'].map(role => [role, { agent: 'pi', model: '', thinking: '', default_prompt: '', append_prompt: '', extensions: [], skills: [] }])),
      options: {
        agents: ['pi','codex'],
        roles: [['planner','规划任务'],['coordinator','协调任务'],['worker','开发任务'],['research','调研任务'],['verifier','验收任务'],['merger','分支分歧解决']].map(([id,label]) => ({ id,label })),
        thinking: { pi: ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], codex: ['', 'minimal', 'low', 'medium', 'high', 'xhigh'] },
        models: { pi: ['openai-codex/gpt-5.4'], codex: ['gpt-5.4','gpt-5.4-mini'] },
        default_prompt: '你是 Lush 的默认 task agent。\n遵守任务协议与权限边界。',
        default_prompts: Object.fromEntries(['planner','coordinator','worker','research','verifier','merger'].map(role => [role, `内置 ${role} Prompt`])),
      },
    },
    // 概览打开时不该每 1.5s 打一遍 git：/api/graph 的取数次数记在这里，供测试断言。
    graphFetches: 0,
    drafts: [],
    commits: [],
    // 一条已冻结、等待验收的 Review Candidate（挂到 Intent #2 上）。
    candidates: [
      { id: 1, input_id: 2, version: 1, branch: 'lush/demo/input-2', commit_hash: 'c0ffee123456', baseline_branch: 'main',
        baseline_commit: 'beef00112233', status: 'ready', summary: '已批准的那条', feedback: null, report_task_id: 12,
        has_report: true, created_at: iso(NOW - 2000), updated_at: iso(NOW - 1000) },
    ],
    // 意图层的两条输入：一条的 planner 申请了批准（specs 分两批），一条已经批准。
    intents: [
      { id: 1, content: 'demo', flow: 'develop', task_id: 9, status: 'awaiting', plan_gate: 'proposed', plan_notice_id: 7,
        specs_pending: 1, specs_planned: 1, specs_dropped: 0, scheduler_id: 4, scheduler_status: 'queued', work_tasks: 2,
        draft_count: 0, references: [], created_at: iso(NOW - 9000), planner_updated_at: iso(NOW - 1000) },
      { id: 2, content: '已批准的那条', flow: 'develop', task_id: 11, status: 'completed', plan_gate: 'approved', plan_notice_id: null,
        specs_pending: 0, specs_planned: 2, specs_dropped: 1, scheduler_id: null, scheduler_status: null, work_tasks: 3,
        work_active: 0, work_failed: 0, candidate_id: 1, candidate_version: 1, candidate_status: 'ready', candidate_report_task_id: 12,
        draft_count: 0, references: [], created_at: iso(NOW - 9500), planner_updated_at: iso(NOW - 2000) },
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
    updated_at: iso(NOW - 1000), agent_wakes: 2, agent_last_seen_at: iso(NOW - 1000), verifies_task_id: null, resolves_task_id: null,
    progress: { version: 1, updated_at: iso(NOW - 500), items: [
      { key: 'inspect', label: '确认现状', status: 'completed', started_at: iso(NOW - 9000), completed_at: iso(NOW - 2000), duration_ms: 7000 },
      { key: 'implement', label: '实现功能', status: 'pending', started_at: iso(NOW - 65000), completed_at: null, duration_ms: null },
      { key: 'test', label: '运行测试', status: 'pending', started_at: null, completed_at: null, duration_ms: null },
    ] } };
  const task2 = { id: 2, parent_id: null, input_id: 1, role: 'worker', goal: '合并我', status: 'completed', integration: 'pending',
    updated_at: iso(NOW - 2000), agent_wakes: 1, agent_last_seen_at: iso(NOW - 2000), verifies_task_id: null, resolves_task_id: null };
  const task3 = { id: 3, parent_id: null, input_id: 1, role: 'worker', goal: '另一个待合的', status: 'completed', integration: 'review',
    updated_at: iso(NOW - 3000), agent_wakes: 1, agent_last_seen_at: iso(NOW - 3000), verifies_task_id: null, resolves_task_id: null };
  const task4 = { id: 4, parent_id: null, input_id: null, role: 'scheduler', goal: '调度拆解队列', status: 'queued', integration: 'none',
    updated_at: iso(NOW - 500), agent_wakes: 0, agent_last_seen_at: null, verifies_task_id: null, resolves_task_id: null };
  const snapshot = () => ({
    status: { project: '/tmp/demo', home: '/tmp/demo/.lush', provider: 'mock',
      concurrency: state.runtimeSettings.concurrency.value, control_concurrency: state.runtimeSettings.control_concurrency.value,
      settings: state.runtimeSettings,
      call_timeout: 900, task_call_limit: 24, max_depth: 8, agent_config: state.agentConfig, agents: [], agents_idle: 0, agents_total: 0,
      pending_merges: [{ id: 2, goal: '合并我', branch: 'lush/2-x', integration: 'pending' }], drafts: 0,
      tasks: [{ status: 'running', count: 1 }, { status: 'completed', count: 2 }], merge_freeze: state.freeze, notices: 0,
      // 拆解队列的计数与批次摘要（和 system.status 同形）
      specs: { pending: 1, planned: 1, dropped: 0, batches: [{ id: 4, status: 'queued', role: 'scheduler', count: 1 }] },
      version: '0.2.0', fingerprint: 'abc', started_at: iso(NOW - 60000) },
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
    candidates: state.candidates,
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
    if (path.startsWith('/api/agent/models?agent=')) {
      const agent = decodeURIComponent(path.split('=').at(-1));
      return json({ agent, source: 'cli', warning: null, models: agent === 'pi'
        ? [{ id: 'openai-codex/gpt-5.4', label: 'gpt-5.4', provider: 'openai-codex' }, { id: 'deepseek/deepseek-flash', label: 'deepseek-flash', provider: 'deepseek' }]
        : [{ id: 'gpt-5.4', label: 'GPT-5.4' }, { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini' }] });
    }
    if (path === '/api/agent/resources') return json({ agent: 'pi', warning: null,
      extensions: [{ id: '/tmp/pi/extensions/review.ts', label: 'review.ts', source: '用户扩展' }],
      skills: [{ id: '/tmp/pi/skills/browser/SKILL.md', label: 'browser', description: '浏览器自动化', source: '用户 Skills' }],
    });
    if (path.startsWith('/api/agent/environment?target=')) {
      const target = decodeURIComponent(path.split('=').at(-1));
      const values = { ...(state.agentEnvironments[target] || {}) };
      return json({ target, file: `/tmp/demo/.lush/agent/${target === 'common' ? 'agent' : target}.env`, exists: Object.keys(values).length > 0, values });
    }
    if (path === '/api/graph') { state.graphFetches += 1; return json(state.graph); }
    if (path === '/api/action') {
      const body = JSON.parse(options.body);
      state.actions.push(body);
      if (body.method === 'agent.configure') {
        const config = body.params.config;
        state.agentConfig = { ...state.agentConfig, version: 1, default: config.default, roles: config.roles,
          resolved: Object.fromEntries(state.agentConfig.options.roles.map(({ id }) => [id, { ...(config.roles[id] || config.default) }])) };
        return json(state.agentConfig);
      }
      if (body.method === 'agent.environment.configure') {
        const { target, values } = body.params;
        state.agentEnvironments[target] = { ...values };
        return json({ target, file: `/tmp/demo/.lush/agent/${target === 'common' ? 'agent' : target}.env`, exists: Object.keys(values).length > 0, values: { ...values } });
      }
      if (body.method === 'system.configure') {
        // 并发上限的热更新：null 清除覆盖（回退环境默认），数字写为覆盖值；与核心同语义。
        const patch = body.params.settings || {};
        const next = { ...state.runtimeSettings };
        for (const key of ['concurrency', 'control_concurrency']) {
          if (!Object.hasOwn(patch, key)) continue;
          next[key] = patch[key] === null
            ? { ...next[key], value: next[key].default, overridden: false }
            : { ...next[key], value: patch[key], overridden: true };
        }
        state.runtimeSettings = next;
        return json({ file: next.file, concurrency: next.concurrency, control_concurrency: next.control_concurrency });
      }
      if (body.method === 'branch.merge') return json({ child: body.params.branch, parent: 'main', status: 'integrated', merged: true });
      if (body.method === 'branch.sync') return json({ branch: body.params.branch, parent: 'main', status: 'queued', task: { id: 88 } });
      if (body.method === 'branch.catchup') return json({ child: body.params.branch, parent: 'main', caught_up: true, from: 'aaa', to: 'bbb' });
      if (body.method === 'branch.archive') {
        // 归档在真实 daemon 里会删掉子树每一条的 ref 与 worktree，库里只留记录；这里同步这一点，
        // 让重拉后的图看得出变化（归档的分支不再占分支树，后代也一起归档）。
        const subtree = [body.params.branch];
        for (let index = 0; index < subtree.length; index += 1) {
          for (const edge of state.graph.edges) {
            if (edge.kind !== 'fork' || edge.from !== `branch:${subtree[index]}`) continue;
            const child = edge.to.slice('branch:'.length);
            if (!subtree.includes(child)) subtree.push(child);
          }
        }
        for (const name of subtree) {
          const node = state.graph.nodes.find(row => row.kind === 'branch' && row.name === name);
          if (node) { node.archived = true; node.archived_at = iso(NOW); node.status = 'archived'; node.head_commit = null; node.worktree_state = 'missing'; }
          const task = state.graph.nodes.find(row => row.kind === 'task' && row.branch === name);
          if (task) { task.archived = true; task.workspace = null; task.workspace_state = 'none'; }
        }
        return json({ branch: body.params.branch, archived: true, count: subtree.length,
          branches: subtree.map(name => ({ branch: name, worktree: 'removed', ref: 'deleted', tip: 'ddd', discarded: true })),
          worktree: 'removed', ref: 'deleted', tip: 'ddd', discarded: true, tasks: [], sessions: [] });
      }
      if (body.method === 'task.delete') {
        // 删除：被删任务从图上消失，重拉后兜底分组跟着收起来（真实 daemon 侧还有子树与安全门）。
        state.graph.nodes = state.graph.nodes.filter(node => !(node.kind === 'task' && node.id === body.params.id));
        return json({ deleted: { root: body.params.id, ids: [body.params.id], tasks: 1 },
          reclaimed: { worktrees: 0, branches: 0 }, next_task_id: 99 });
      }
      if (body.method === 'task.merge_many') return json({ target_branch: body.params.ids.includes(3) ? 'release' : 'main',
        merges: body.params.ids.map(id => ({ id, status: 'merged', integration: 'merged' })), merged: body.params.ids.length, stopped: null });
      if (body.method === 'draft.update') { const draft = state.drafts.find(row => row.id === body.params.id); if (draft) { draft.content = body.params.content; if (body.params.references !== undefined) draft.references = body.params.references; } return json({ id: draft?.id, content: draft?.content, references: draft?.references || [] }); }
      if (body.method === 'draft.remove') { state.drafts = state.drafts.filter(row => row.id !== body.params.id); return json({ id: body.params.id }); }
      if (body.method === 'draft.add') { const draft = { id: state.drafts.length ? Math.max(...state.drafts.map(row => row.id)) + 1 : 1, content: body.params.content, references: body.params.references || [], created_at: iso(NOW) }; state.drafts = [...state.drafts, draft]; return json(draft); }
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
        // 批 / 驳之后这条计划 notice 就被结算了：分支图上的决策区要跟着消失（重拉后的图看得出来）。
        for (const node of state.graph.nodes) {
          if (node.kind === 'task' && node.id === body.params.id && node.notice?.kind === 'plan') { node.notice = null; node.notice_count = 0; }
        }
        return json({ planner: body.params.id, plan_gate: intent?.plan_gate ?? null });
      }
      if (body.method === 'notice.answer' || body.method === 'notice.dismiss') {
        // 答复 / 忽略一条待决 notice：把它从图上拿掉，让重拉后的分支图看得出「这件事已经处理了」。
        for (const node of state.graph.nodes) {
          if (node.kind === 'task' && node.notice?.id === body.params.id) { node.notice = null; node.notice_count = 0; }
        }
        return json({ id: body.params.id, status: body.method === 'notice.dismiss' ? 'dismissed' : 'answered' });
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

