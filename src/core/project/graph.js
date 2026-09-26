import fs from 'node:fs';
import { branchFreeze } from '../branch-freeze.js';

/** 分支图的规模上限：只读视图不该为了画全图把 daemon 拖垮，超限截断并在结果里说明。 */
export const GRAPH_NODE_LIMIT = 200;
export const GRAPH_EDGE_LIMIT = 2000;

/** 会产出 worktree / 分支的角色：候选任务来自这三类。
 *  planner / scheduler 是意图层，没有自己的分支，但也要按「这条输入的锚点分支」挂进图里，
 *  由下面的 intentRows 单独取（见 graph() —— 派生锚点分支只在那里做一次）。 */
const GRAPH_ROLES = ['worker', 'merger', 'verifier', 'showcase', 'agent'];
const TASK_ROLE_SQL = GRAPH_ROLES.map(role => `'${role}'`).join(',');

/** verifier 自己不拥有代码分支，但必须画在它正在验收的分支上：单 worker 检验跟随被检验任务，
 * Candidate 检验跟随 Candidate 固定的 Intent 集成分支。表达式只接收源码内固定 alias，不含外部输入。 */
const taskBranchSql = alias => `COALESCE(${alias}.branch,
  CASE
    WHEN ${alias}.role='showcase' THEN json_extract(${alias}.showcase,'$.branch')
    WHEN ${alias}.role='verifier' AND ${alias}.review_candidate_id IS NOT NULL
      THEN (SELECT branch FROM review_candidates candidate WHERE candidate.id=${alias}.review_candidate_id)
    WHEN ${alias}.role='verifier' AND ${alias}.verifies_task_id IS NOT NULL
      THEN (SELECT branch FROM tasks verified WHERE verified.id=${alias}.verifies_task_id)
    ELSE NULL
  END)`;

const branchId = name => `branch:${name}`;

/** 汇总 status 里算「活动」的口径：任务还占着槽、等槽或等用户。 */
const ACTIVE_STATUSES = new Set(['running', 'queued', 'waiting', 'awaiting']);
/** 一句话标题的上限：超出截断加省略号，别让整段 goal 撑爆界面。 */
const TITLE_LIMIT = 60;

/** 一句话摘要：第一行、压缩空白、按字数截断。没有内容时给 null，不把空串当标题。 */
function summarize(text) {
  const line = String(text ?? '').split('\n')[0].replace(/\s+/g, ' ').trim();
  if (!line) return null;
  return line.length > TITLE_LIMIT ? `${line.slice(0, TITLE_LIMIT)}…` : line;
}

/**
 * 分支图读模型：分支谱系（分支节点 + fork 边）+ 任务 -> 分支 / worktree / 目标分支的关系网，
 * 以及任务的堆叠（code）/顺序（order）/解冲突（resolve）/检验（verify）/目标分支（target）边。
 *
 * 分支节点覆盖三处事实之和，与 `Project#branchTree` 同口径：
 * - `branches` 表里的每条记录（含 `task_id IS NULL` 的输入锚点、`branch import` 登记的分支）；
 * - `refs/heads` 里现在真实存在的每个本地 ref（没有记录时 `tracked:false`）；
 * - 只被某条记录的 `parent` 指针提到、既无记录也无 ref 的占位名（`placeholder:true`），
 *   这样刚创建的分支的父分支不会缺失，子分支不会从图上掉下去。
 * `head_commit` 与 `current` 都按当前 ref 现算，不缓存旧值。
 *
 * 每个分支节点另外回答三个问题（只增不改，老字段照旧）：`origin`（这条分支因何存在：输入锚点 /
 * 任务分支 / import 登记 / 只有本地 ref / 占位名）与配套的 `title`、`summary`、`source_id`、`created_at`；
 * `title` 优先取 `branches.summary`（人写的简述），没有摘要时才回落输入 / goal 首行截断。
 * `status` + `tasks`（这条分支自己的任务连同全部后代分支任务的汇总口径：active / failed /
 * merged / ready / empty）。归档过的分支另带 `archived` / `archived_at` / `deleted`，状态固定为
 * `archived`（不被汇总口径改写），它名下的任务节点也标 `archived:true`，仍然留在图上。
 * 这些都只是读 store 已有事实，不写库、不改 git。每个 `kind:"task"` 节点（含意图层的 planner / scheduler）
 * 带解析后的 task `progress`，并另带「待你决断」的 notice：`notice`（open 且 kind 为 question / plan 的最新一条，没有则 null）与
 * `notice_count`（这类 open notice 的总数）。info 提醒（status='sent'）与 answered / dismissed 都不算，
 * 一次 SELECT 取回后在内存里按 task_id 归并。
 * fork 边在 `status`（fast_forward / diverged / integrated / missing / unknown）与 ahead/behind 之外
 * 再给三个可执行动作：`can_merge`（子→父 fast-forward）/ `can_sync`（分歧时建子侧 merger）/ `can_catchup`
 * （父→子 fast-forward，子分支没有独有提交时才能跟上）。
 *
 * branch.diagnostics 另提供起点→tip 的改动规模、有界文件列表、最近提交与独立的未提交统计。
 * 全部只用只读 git（含 diff / log / status）与文件系统探测：
 * 不 checkout、不 merge、不改 index、不删 worktree、不写 store（无 update / event），
 * 所以 `project.stopping === true` 时也能安全跑。非 git 项目或 git 命令失败返回空图并带
 * `git:false` / `error`，不抛错——图是给人看的辅助视图，不该把 daemon 的轮询打断。
 */
export default {
  /**
   * Task 图读模型：Task 是身份与父子关系，分支 / worktree 只是属性，不画成节点。全程只读 store 既有事实，
   * 不写库、不改 git，所以轮询与 `project.stopping` 期间也能安全跑。
   *
   * 每个节点的 `branch_info` 除了实时 ref 与 Git 诊断，还投影这条 Task 自己的分支上「合并编排」所需的
   * 两个只读字段：`subtree_say`（分支谱系里还有多少条 say 子分支，决定是否值得给编排入口）与
   * `merge_run`（该分支仍在跑的合并运行摘要 `{mode,status,done,total,task_id}`，没有则 null）。
   * 两者只读 `branches` / `branches.merge_run`，不触发任何执行。
   */
  async taskGraph() {
    const limit = GRAPH_NODE_LIMIT;
    const rows = this.store.all(`SELECT id, parent_id, input_id, task_kind, role, name, goal, status,
      integration, integration_error, branch, workspace, target_branch, base_commit, head_commit, resolves_task_id,
      reservation, progress_plan, created_at, updated_at, calls, agent_wakes,
      (SELECT p.task_kind FROM tasks p WHERE p.id=tasks.parent_id) AS parent_task_kind,
      CASE WHEN result IS NULL THEN 0 ELSE 1 END AS has_result,
      substr(result, 1, 320) AS result_preview
      FROM tasks ORDER BY CASE WHEN task_kind IN ('main','owner') THEN 0
        WHEN status IN ('running','queued','waiting','awaiting') THEN 1 ELSE 2 END, id DESC LIMIT ?`, limit + 1);
    const selected = rows.slice(0, limit);
    const ids = selected.map(row => row.id);
    const pending = new Map();
    if (ids.length) for (const notice of this.store.all(`SELECT id, task_id, kind, title, substr(body,1,1000) AS body
      FROM notices WHERE status='open' AND task_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`, ...ids)) {
      const item = pending.get(notice.task_id) ?? { count: 0, notice: null };
      item.count++; item.notice = notice; pending.set(notice.task_id, item);
    }
    const children = new Map();
    if (ids.length) for (const child of this.store.all(`SELECT parent_id, count(*) AS total,
      sum(CASE WHEN status IN ('running','queued','waiting','awaiting') THEN 1 ELSE 0 END) AS active
      FROM tasks WHERE parent_id IN (${ids.map(() => '?').join(',')}) GROUP BY parent_id`, ...ids)) children.set(child.parent_id, child);
    const dependencies = this.store.depMap(ids);
    const resolutions = new Map();
    if (ids.length) for (const entry of this.store.all(`SELECT task_id, data FROM events
      WHERE type='task.divergence_resolution_requested' AND task_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`, ...ids)) {
      try { resolutions.set(entry.task_id, JSON.parse(entry.data).source_task_id); } catch { /* legacy event */ }
    }
    const freezes = new Map(this.branchFreeze().map(item => [item.branch, item]));
    // Task 卡片的合并编排入口只读投影：目标就是这条 Task 自己的分支。只读 store / branches，不碰 git、不写库。
    const activeBranches = this.store.branches().filter(row => row.status === 'active');
    const activeRuns = new Map(this.store.activeBranchMergeRuns().map(({ target, run }) => [target, run]));
    const sayBranches = new Set(this.store.all("SELECT branch FROM tasks WHERE task_kind='say' AND branch IS NOT NULL")
      .map(row => row.branch));
    // 一次把分支树拼好并记忆化「分支下的 say 子分支数」，避免每个 Task 节点各扫一遍全部分支。
    const branchChildren = new Map();
    for (const row of activeBranches) {
      const parent = row.parent && row.parent !== row.branch ? row.parent : null;
      if (!parent) continue;
      if (!branchChildren.has(parent)) branchChildren.set(parent, []);
      branchChildren.get(parent).push(row.branch);
    }
    const sayDescendants = new Map();
    const countSayDescendants = (name, seen = new Set()) => {
      if (sayDescendants.has(name)) return sayDescendants.get(name);
      if (seen.has(name)) return 0; // 坏数据成环时见好就收，不让计数卡死。
      seen.add(name);
      let total = 0;
      for (const child of branchChildren.get(name) || []) {
        if (sayBranches.has(child)) total += 1;
        total += countSayDescendants(child, seen);
      }
      sayDescendants.set(name, total);
      return total;
    };
    const branchNames = [...new Set(selected.map(row => row.branch).filter(Boolean))];
    const records = new Map(branchNames.length ? this.store.all(`SELECT branch, parent, status, created_from_commit
      FROM branches WHERE branch IN (${branchNames.map(() => '?').join(',')})`, ...branchNames)
      .map(row => [row.branch, row]) : []);
    const refs = new Map();
    try {
      const output = await this.workspaces.git(this.config.project, 'for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads');
      for (const line of output.split('\n')) {
        const at = line.indexOf(' '); if (at > 0) refs.set(line.slice(0, at), line.slice(at + 1).trim());
      }
    } catch { /* no Git: mark head and diagnostics unknown, not clean */ }
    const candidates = branchNames.filter(name => records.get(name)?.status !== 'archived');
    const diagnostics = candidates.length ? await this.workspaces.branchDiagnostics(candidates
      .map(name => ({ name, head_commit: refs.get(name) ?? null,
        created_from_commit: records.get(name)?.created_from_commit ?? null }))) : new Map();
    const nodes = selected.map(({ goal, progress_plan, reservation, ...row }) => {
      const view = this.progressView({ progress_plan, reservation });
      const delivery = view.reservation;
      const progress = view.progress;
      const current = progress?.items?.find(item => item.status !== 'completed');
      const plan = progress?.items?.length ? { total: progress.items.length,
        completed: progress.items.filter(item => item.status === 'completed').length,
        current: current ? { label: current.label, started_at: current.started_at } : null } : null;
      const notice = pending.get(row.id) ?? { count: 0, notice: null };
      const child = children.get(row.id) ?? { total: 0, active: 0 };
      const blockers = (dependencies.get(row.id) ?? []).filter(edge => !['completed','failed','cancelled'].includes(edge.status));
      const freeze = freezes.get(row.branch ?? row.target_branch) ?? null;
      const waiting_reason = freeze && row.status !== 'running' && row.id !== freeze.task_id
        ? `冻结 · ${freeze.reason}`
        : row.status === 'awaiting' && notice.count ? `${notice.count} 条待你处理`
        : row.status === 'waiting' && child.active ? `等待 ${child.active} 个子 Task`
        : row.status === 'queued' && blockers.length ? `等待依赖 Task #${blockers.map(edge => edge.id).join('、#')}`
        : row.status === 'queued' ? '等待 Agent 调用槽'
        : row.status === 'waiting' ? '静息 · 等待新输入或子 Task 信号' : null;
      const branch = row.branch ? records.get(row.branch) : null;
      // 这条分支下还有多少个 say 子分支：决定卡片上「编排合并全部子 Task」入口是否有意义。
      const subtree_say = row.branch ? countSayDescendants(row.branch) : 0;
      const mergeRun = row.branch ? activeRuns.get(row.branch) ?? null : null;
      return { ...row, kind: 'task', title: summarize(goal) || row.name || `Task #${row.id}`,
        goal_preview: String(goal ?? '').slice(0, 600),
        progress: plan, notice: notice.notice, notice_count: notice.count,
        children_total: child.total, children_active: child.active, waiting_reason,
        freeze: freeze ? { kind: freeze.kind, task_id: freeze.task_id ?? null, reason: freeze.reason } : null,
        resolves_task_id: row.resolves_task_id ?? resolutions.get(row.id) ?? null,
        reservation: delivery, delivery: delivery ? { kind: delivery.kind, status: delivery.status,
          blocked_reason: delivery.blocked_reason ?? null } : null,
        branch_info: row.branch ? { parent: branch?.parent ?? null, archived: branch?.status === 'archived',
          current_head: refs.get(row.branch) ?? null, diagnostics: diagnostics.get(row.branch) ?? null,
          subtree_say, merge_run: mergeRun ? { mode: mergeRun.mode ?? 'merge_all', status: mergeRun.status,
            done: mergeRun.done?.length ?? 0, total: mergeRun.order?.length ?? 0, task_id: mergeRun.task_id ?? null } : null } : null,
        workspace_state: row.workspace ? (fs.existsSync(row.workspace) ? 'present' : 'missing') : 'none',
        has_result: Boolean(row.has_result),
        has_rule: fs.existsSync(`${this.config.home}/task-rules/task-${row.id}.mjs`) };
    });
    const visible = new Set(ids);
    const edges = nodes.filter(node => visible.has(node.parent_id)).map(node => ({ from: node.parent_id, to: node.id }));
    return { nodes, edges, truncated: rows.length > limit, total: this.store.get('SELECT count(*) AS n FROM tasks').n };
  },

  async graph() {
    const generated_at = new Date().toISOString();
    const empty = { generated_at, current_branch: null, truncated: false, git: false, error: null, nodes: [], edges: [] };
    const project = this.config.project;
    try {
      await this.workspaces.git(project, 'rev-parse', '--git-dir');
    } catch (error) {
      return { ...empty, error: `not a git repository: ${error.message}` };
    }
    let currentBranch = null;
    try { currentBranch = await this.workspaces.git(project, 'symbolic-ref', '--short', 'HEAD'); } catch { /* detached HEAD：没有当前分支 */ }

    try {
      // 一次 for-each-ref 拿到所有本地分支的顶端，避免每个节点各跑一次 rev-parse。
      const refs = new Map();
      const refList = await this.workspaces.git(project, 'for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads');
      for (const line of refList.split('\n')) {
        const at = line.indexOf(' ');
        if (at > 0) refs.set(line.slice(0, at), line.slice(at + 1).trim());
      }

      const rows = this.store.all(`SELECT id, role, name, goal, status, integration, input_id,
        ${taskBranchSql('tasks')} AS branch, workspace, parent_id, task_kind, reservation,
        (SELECT p.task_kind FROM tasks p WHERE p.id=tasks.parent_id) AS parent_task_kind,
        base_commit, head_commit, target_branch, baseline_workspace, resolves_task_id, verifies_task_id, progress_plan
        FROM tasks WHERE role IN (${TASK_ROLE_SQL}) ORDER BY id DESC`);
      // 没有可归属分支也没有 worktree（含已完整回收）的任务不进图。verifier 的 branch 是上面只读派生的
      // 服务对象分支，所以 Candidate 验收即使清掉 baseline worktree 后也仍留在正确的输入分支下。
      // role='agent' 里只有 say 与新派生的 child 是「自己拥有分支与 worktree」的工作 Task，必须画成任务行；
      // main/owner 是分支所有者（同样的信息已经落在 branch 节点的 title / source_id 上，不重复画），
      // analysis 是只读分离检出（无分支），都不进任务节点。
      const candidates = rows.filter(row => (row.role !== 'agent' || row.task_kind === 'say' || row.task_kind === 'child')
        && (row.branch || row.workspace || row.baseline_workspace));

      // 分支节点名：记录 ∪ 现在的 ref ∪ 当前检出 ∪ 占位父名。记录是历史事实，ref 是现状，
      // 两者都不丢；只被 parent 提到的名字补占位节点，否则它的子分支会从树上消失。
      const records = new Map(this.store.branches().map(row => [row.branch, row]));
      /** 归档分支：branches.status === 'archived'。它的 ref / worktree 已经没了，但任务行还留着。 */
      const isArchivedBranch = name => Boolean(name) && records.get(name)?.status === 'archived';
      const branchNames = new Set(records.keys());
      if (currentBranch) branchNames.add(currentBranch);
      for (const name of refs.keys()) branchNames.add(name);
      const placeholders = new Set();
      for (const row of records.values()) {
        if (!row.parent) continue;
        branchNames.add(row.parent);
        if (!records.has(row.parent) && !refs.has(row.parent)) placeholders.add(row.parent);
      }
      // 当前检出最前，其余按名字：超过上限时至少保证当前分支在图上。
      const orderedBranchNames = [...branchNames].sort((a, b) =>
        Number(b === currentBranch) - Number(a === currentBranch) || a.localeCompare(b));
      const branchCapacity = Math.min(orderedBranchNames.length, GRAPH_NODE_LIMIT);
      // 分支节点先占额度，剩下的才留给任务：分支基础事实比某个任务节点更值得画。
      const taskCapacity = Math.max(0, GRAPH_NODE_LIMIT - branchCapacity);
      let truncated = orderedBranchNames.length > branchCapacity || candidates.length > taskCapacity;
      const taskRows = candidates.slice(0, taskCapacity);

      // 每个任务「待你决断」的 notice：open 且 kind 是 question / plan。info 提醒（status='sent'）
      // 与 answered / dismissed 的都不算；任务结算时 lifecycle 会把 open 置为 dismissed，所以终态任务不会带。
      // 一次查询按 id 升序取全部，再在内存里按 task_id 归并：最新一条（id 最大）与总数。
      // 快速路由（前缀短路）：按 input_id 命中 input.route 事件，任务节点与意图层一样标注。
      const routedInputs = this.store.routedInputIds();
      const isRouted = inputId => inputId !== null && inputId !== undefined && routedInputs.has(inputId);
      const pendingNotices = new Map();
      for (const row of this.store.all(`SELECT id, task_id, kind, title, body, created_at FROM notices
        WHERE status='open' AND kind IN ('question','plan') ORDER BY id`)) {
        const entry = pendingNotices.get(row.task_id);
        const notice = { id: row.id, kind: row.kind, title: row.title, body: row.body, created_at: row.created_at };
        if (entry) { entry.notice = notice; entry.count += 1; } else pendingNotices.set(row.task_id, { notice, count: 1 });
      }
      const pendingFor = taskId => pendingNotices.get(taskId) ?? { notice: null, count: 0 };
      // 分支诊断只需要横条所需的有界摘要，不把每个 task 最多 32 条的完整计划塞进 1 MiB graph 帧。
      const progressFor = row => {
        const progress = this.progressView(row).progress;
        if (!progress) return null;
        const completed = progress.items.filter(item => item.status === 'completed').length;
        const current = progress.items.find(item => item.status !== 'completed') || null;
        return { version: 1, completed, total: progress.items.length,
          current: current ? { key: current.key, label: current.label, started_at: current.started_at } : null, updated_at: progress.updated_at };
      };

      // 分支节点的「为什么 / 是什么 / 现在怎样」全部来自 store 已有事实，不额外写库：
      // inputs.anchor_branch 回答「因为哪条输入」，tasks.branch 回答「哪个任务」，
      // branches.task_id 是创建那一刻的绑定，branches.parent 链回答「这条子树现在在干什么」。
      const inputByAnchor = new Map();
      const anchorByInput = new Map();
      for (const input of this.store.all('SELECT id, content, anchor_branch FROM inputs WHERE anchor_branch IS NOT NULL ORDER BY id')) {
        inputByAnchor.set(input.anchor_branch, input);
        anchorByInput.set(input.id, input.anchor_branch);
      }
      // planner / scheduler 没有 branch / workspace，但也要像 worker 那样挂到「这条输入」的锚点分支下。
      // 派生规则只此一处：planner 取自己的 input_id；scheduler 取本批 spec 的 input_id，
      // 批为空 / 那个输入没有锚点时回落该批 planner 的输入锚点；都找不到才 branch = null（走兜底分组，不瞎猜）。
      const plannerInput = new Map();
      for (const planner of this.store.all("SELECT id, input_id FROM tasks WHERE role='planner'")) plannerInput.set(planner.id, planner.input_id);
      const schedulerAnchor = (schedulerId) => {
        const spec = this.store.get('SELECT input_id, planner_task_id FROM task_specs WHERE batch_id=? ORDER BY id LIMIT 1', schedulerId);
        if (!spec) return null;
        return anchorByInput.get(spec.input_id) ?? anchorByInput.get(plannerInput.get(spec.planner_task_id)) ?? null;
      };
      const intentRows = this.store.all(`SELECT id, role, name, goal, status, integration, input_id, progress_plan
        FROM tasks WHERE role IN ('planner','scheduler') ORDER BY id DESC`)
        .map(row => ({ ...row, branch: (row.role === 'planner' ? anchorByInput.get(row.input_id) : schedulerAnchor(row.id)) ?? null }));
      const taskById = new Map();
      const tasksByBranch = new Map();
      for (const task of this.store.all(`SELECT id, name, goal, status, ${taskBranchSql('tasks')} AS branch
        FROM tasks ORDER BY id`)) {
        taskById.set(task.id, task);
        if (!task.branch) continue;
        if (!tasksByBranch.has(task.branch)) tasksByBranch.set(task.branch, []);
        tasksByBranch.get(task.branch).push(task);
      }
      // 意图层任务按派生出来的锚点分支并入同一个 map：分支汇总（tasks / status）复用同一套派生分支，
      // 不再另算一份口径，所以 running 的 planner 会让锚点分支从 empty 变成 active。
      for (const task of intentRows) {
        if (!task.branch) continue;
        if (!tasksByBranch.has(task.branch)) tasksByBranch.set(task.branch, []);
        tasksByBranch.get(task.branch).push(task);
      }
      // 后代链：占位父也在链上，所以子树能穿过占位名继续往下；环用 seen 兜住，宁可少算也不死循环。
      const childBranches = new Map();
      for (const row of records.values()) {
        if (!row.parent) continue;
        if (!childBranches.has(row.parent)) childBranches.set(row.parent, []);
        childBranches.get(row.parent).push(row.branch);
      }
      const subtreeOf = (name) => {
        const seen = new Set([name]);
        const queue = [name];
        while (queue.length) {
          for (const child of childBranches.get(queue.pop()) ?? []) if (!seen.has(child)) { seen.add(child); queue.push(child); }
        }
        return seen;
      };

      // 谱系事实先算：branch 节点的汇总 status 要回答「这条分支进父分支了没有」，与 fork 边同源。
      // 一条 fork 边只跑一次 rev-list；ahead/behind 已足够判断祖先关系：
      // child ahead=0 => 已进入 parent，behind=0 => parent 可快进到 child，两边都 >0 => 分歧。
      const branchNodes = orderedBranchNames.slice(0, branchCapacity);
      const branchNodeIds = new Set(branchNodes.map(branchId));
      const relations = new Map();
      for (const row of records.values()) {
        if (!row.parent || !branchNodeIds.has(branchId(row.parent)) || !branchNodeIds.has(branchId(row.branch))) continue;
        const childHead = refs.get(row.branch) ?? null, parentHead = refs.get(row.parent) ?? null;
        let status = 'missing', ahead = null, behind = null;
        if (childHead && parentHead) {
          try {
            const output = await this.workspaces.git(project, 'rev-list', '--left-right', '--count', `${parentHead}...${childHead}`);
            [behind, ahead] = output.split(/\s+/).map(Number);
            status = ahead === 0 ? 'integrated' : behind === 0 ? 'fast_forward' : 'diverged';
          } catch { status = 'unknown'; ahead = null; behind = null; }
        }
        relations.set(row.branch, { status, ahead, behind, parent_head: parentHead, child_head: childHead });
      }

      const diagnostics = await this.workspaces.branchDiagnostics(branchNodes
        .filter(name => records.get(name)?.status !== 'archived')
        .map(name => ({ name, head_commit: refs.get(name) ?? null,
          created_from_commit: records.get(name)?.created_from_commit ?? null })));
      // 写冻结与一键合并运行都是现算的只读投影：图只负责展示“为什么这条分支现在不能动”。
      const freezeMap = branchFreeze(this.store);
      const mergeRunOf = name => {
        const raw = records.get(name)?.merge_run;
        if (!raw) return null;
        try { const run = JSON.parse(raw); return run && ['running', 'paused'].includes(run.status) ? run : null; } catch { return null; }
      };
      const nodes = [];
      for (const name of branchNodes) {
        const record = records.get(name) ?? null;
        const placeholder = placeholders.has(name);
        const input = inputByAnchor.get(name) ?? null;
        const own = tasksByBranch.get(name) ?? [];
        // origin 优先级从高到低：占位 > 有 ref 但没记录 > 输入锚点 > 任务分支 > 只登记过。
        const origin = placeholder ? 'placeholder'
          : !record ? 'local'
          : input ? 'input'
          : record.task_id !== null || own.length ? 'task'
          : 'registered';
        // 任务分支的标题取创建它的那个任务：记录里的 task_id 优先，其次这条分支上最新的任务。
        const owner = origin !== 'task' ? null
          : (record.task_id === null ? null : taskById.get(record.task_id)) ?? own[own.length - 1] ?? null;
        // 汇总口径：这条分支自己的任务 + 全部后代分支的任务，占位父也参与统计。
        const counts = { total: 0, active: 0, failed: 0, completed: 0 };
        for (const descendant of subtreeOf(name)) {
          for (const task of tasksByBranch.get(descendant) ?? []) {
            counts.total += 1;
            if (ACTIVE_STATUSES.has(task.status)) counts.active += 1;
            else if (task.status === 'failed') counts.failed += 1;
            else if (task.status === 'completed') counts.completed += 1;
          }
        }
        // 归档是记录状态，不是 git 现状：ref 已经删掉，但分支记录与工作信息都还在。
        const archived = record?.status === 'archived';
        // 一句话摘要：人写的简述（store 原文）；空 / 缺失时 null，标题才回落派生。
        const summary = record?.summary && String(record.summary).trim() ? record.summary : null;
        // 分支的 worktree 只在创建那一刻记进 branches 行；目录被归档/清理后就报 missing，不假装还在。
        const worktree = record?.worktree ?? null;
        const worktree_state = worktree ? (fs.existsSync(worktree) ? 'present' : 'missing') : 'none';
        const { allowed, reason, latest_task_id } = await this.showcaseEligibility(name);
        // 预约只是分支附属元数据：reserved 取当前 pending 记录，reserve_allowed 回答「现在能不能预约」
        // （静态条件，不跑 Git）；阻塞原因由 reserve_reason 现算，不落库。
        let reservation = null;
        if (record?.showcase_reservation) {
          try { const parsed = JSON.parse(record.showcase_reservation); if (parsed && typeof parsed === 'object') reservation = parsed; } catch { /* 损坏值当没有预约 */ }
        }
        const pendingReservation = reservation?.status === 'pending' ? reservation : null;
        const reservable = this.showcaseReservable(name);
        nodes.push({
          kind: 'branch', id: branchId(name), name,
          showcase: { allowed, reason, latest_task_id, reserved: pendingReservation !== null,
            reserved_at: pendingReservation?.created_at ?? null, reserve_allowed: reservable.allowed, reserve_reason: reservable.reason },
          head_commit: refs.get(name) ?? null,
          current: name === currentBranch,
          tracked: record !== null,
          created_from_commit: record?.created_from_commit ?? null,
          diagnostics: diagnostics.get(name) ?? null,
          placeholder,
          origin,
          // 标题优先用摘要；没有摘要时完全保持既有派生（输入 / goal 首行压缩并截断）。
          title: summary ?? (origin === 'input' ? summarize(input.content)
            : origin === 'task' ? (owner ? summarize(owner.goal) ?? owner.name ?? null : null)
            : null),
          summary,
          source_id: origin === 'input' ? input.id : origin === 'task' ? record?.task_id ?? owner?.id ?? null : null,
          created_at: record?.created_at ?? null,
          worktree,
          worktree_state,
          // 归档分支：状态固定为 archived（不被 active/merged 这类汇总口径改写），并带上归档时间。
          // 时间戳复用 branches.deleted_at——markBranchArchived 与 markBranchDeleted 同口径，不另造一列。
          archived,
          archived_at: archived ? record?.deleted_at ?? null : null,
          deleted: record?.status === 'deleted',
          // 冻结与进行中的一键合并：界面用它禁用写按钮并解释原因。
          status: archived ? 'archived'
            : counts.active ? 'active' : counts.failed ? 'failed' : !counts.total ? 'empty'
            : relations.get(name)?.status === 'integrated' ? 'merged' : 'ready',
          tasks: counts,
          freeze: freezeMap.get(name) ?? null,
          merge_run: mergeRunOf(name),
        });
      }

      for (const row of taskRows) {
        const workspacePath = row.workspace || row.baseline_workspace || null;
        const workspace_state = workspacePath ? (fs.existsSync(workspacePath) ? 'present' : 'missing') : 'none';
        const knownRef = row.branch ? refs.get(row.branch) ?? null : null;
        const branch_state = row.branch && knownRef ? 'present' : 'missing';
        // Branch-first 图比较的是分支当前 tip；task.head_commit 只是 agent 最初交付时的 reviewed commit。
        const headCommit = row.role === 'showcase' ? row.head_commit : knownRef || row.head_commit;
        const targetHead = row.target_branch ? refs.get(row.target_branch) ?? null : null;
        let ahead = null, behind = null, merged = null;
        if (headCommit && row.target_branch && targetHead) {
          try {
            // 左边 = 只有目标分支有的（behind），右边 = 只有本分支有的（ahead）。
            const output = await this.workspaces.git(project, 'rev-list', '--left-right', '--count',
              `refs/heads/${row.target_branch}...${headCommit}`);
            const [left, right] = output.split(/\s+/).map(Number);
            if (Number.isFinite(left) && Number.isFinite(right)) { behind = left; ahead = right; }
          } catch { /* 任一侧取不到就保持 null */ }
          merged = headCommit === targetHead ? true : await this.containsCommit(headCommit, targetHead);
        }
        const pending = pendingFor(row.id);
        const node = {
          kind: 'task', id: row.id, role: row.role, name: row.name ?? null,
          task_kind: row.task_kind ?? null, parent_id: row.parent_id ?? null,
          parent_task_kind: row.parent_task_kind ?? null,
          reservation: row.task_kind === 'say' ? this.progressView(row).reservation : null,
          has_result: row.task_kind === 'say' && row.result !== null,
          goal: String(row.goal ?? '').slice(0, 120),
          status: row.status, integration: row.integration, route: isRouted(row.input_id),
          branch: row.branch ?? null, workspace: workspacePath, workspace_state, branch_state: row.role === 'showcase' ? null : branch_state,
          // 任务的分支已经归档：ref/worktree 都没了，但这是预期状态，节点照旧画在图上。
          archived: isArchivedBranch(row.branch),
          base_commit: row.base_commit ?? null, head_commit: headCommit ?? null, reviewed_commit: row.head_commit ?? null,
          target_branch: row.target_branch ?? null, ahead, behind, merged,
          current: Boolean(row.branch) && row.branch === currentBranch,
          // 「待你决断」的最新一条 notice 与总数（口径见上面 pendingNotices）。
          notice: pending.notice, notice_count: pending.count,
          progress: progressFor(row),
        };
        nodes.push(node);
      }
      // 意图层任务（planner / scheduler）和 worker 任务一样是 kind:task 节点，只是没有自己的
      // worktree / 目标分支：合并信息一律保持 null，绝不臆造 ahead/behind/merged，也不画「缺失分支」。
      for (const row of intentRows) {
        const pending = pendingFor(row.id);
        nodes.push({
          kind: 'task', id: row.id, role: row.role, name: row.name ?? null,
          goal: String(row.goal ?? '').slice(0, 120),
          status: row.status, integration: row.integration, route: isRouted(row.input_id),
          branch: row.branch,
          workspace: null, workspace_state: 'none', branch_state: null,
          archived: isArchivedBranch(row.branch),
          base_commit: null, head_commit: null, reviewed_commit: null,
          target_branch: null, ahead: null, behind: null, merged: null,
          current: false,
          notice: pending.notice, notice_count: pending.count,
          progress: progressFor(row),
        });
      }
      if (nodes.length > GRAPH_NODE_LIMIT) { truncated = true; nodes.length = GRAPH_NODE_LIMIT; }
      const nodeIds = new Set(nodes.map(node => node.id));

      const edges = [];
      for (const dep of this.store.all('SELECT task_id, depends_on, kind FROM task_deps ORDER BY task_id, depends_on')) {
        if (!nodeIds.has(dep.task_id) || !nodeIds.has(dep.depends_on)) continue;
        edges.push({ kind: dep.kind, from: dep.depends_on, to: dep.task_id });
      }
      for (const row of taskRows) {
        if (row.resolves_task_id && nodeIds.has(row.resolves_task_id)) edges.push({ kind: 'resolve', from: row.id, to: row.resolves_task_id });
        if (row.verifies_task_id && nodeIds.has(row.verifies_task_id)) edges.push({ kind: 'verify', from: row.id, to: row.verifies_task_id });
        if (row.target_branch && nodeIds.has(branchId(row.target_branch))) edges.push({ kind: 'target', from: row.id, to: branchId(row.target_branch) });
      }
      // 谱系边：每条记录了 parent 的分支给出「从哪条分支分出来」。两端都在节点集合里才加，
      // 所以被截断掉的分支不会留下悬空边。relation 与 branch 节点的汇总 status 同一次计算。
      const childrenByParent = new Map();
      for (const child of records.values()) {
        if (!child.parent) continue;
        if (!childrenByParent.has(child.parent)) childrenByParent.set(child.parent, []);
        childrenByParent.get(child.parent).push(child);
      }
      for (const row of records.values()) {
        if (!row.parent || !nodeIds.has(branchId(row.parent)) || !nodeIds.has(branchId(row.branch))) continue;
        const relation = relations.get(row.branch) ?? { status: 'unknown', ahead: null, behind: null };
        const blockers = [...this.workspaces.branchTaskBlockers(row.branch),
          ...(childrenByParent.get(row.branch) || []).filter(child => child.status !== 'deleted'
            && refs.has(child.branch) && relations.get(child.branch)?.status !== 'integrated').map(child => child.branch)];
        edges.push({ kind: 'fork', from: branchId(row.parent), to: branchId(row.branch),
          ...relation, blockers,
          can_merge: relation.status === 'fast_forward' && blockers.length === 0,
          can_sync: relation.status === 'diverged' && blockers.length === 0,
          // 子分支没有独有提交、父分支已前进：可以直接快进跟上（见 workspaces.catchupBranch）。
          can_catchup: relation.status === 'integrated' && relation.behind > 0 && blockers.length === 0 });
      }
      let trimmedEdges = edges;
      if (trimmedEdges.length > GRAPH_EDGE_LIMIT) { truncated = true; trimmedEdges = trimmedEdges.slice(0, GRAPH_EDGE_LIMIT); }

      return { generated_at, current_branch: currentBranch, truncated, git: true, error: null, nodes, edges: trimmedEdges };
    } catch (error) {
      return { ...empty, git: true, error: error.message };
    }
  },
};
