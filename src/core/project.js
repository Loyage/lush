import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { check, id, text, TERMINAL, bounded, isPlainObject, LushError } from './types.js';
import { Workspaces } from './workspaces.js';
import { taskSlug } from './naming.js';
import { readTranscript, readUsage } from './transcript.js';
import { mergeOrder } from './merge-batch.js';
import { PiProvider, MockProvider } from '../agent/provider.js';

const DEP_KINDS = new Set(['code', 'order']);
/** 两类用户输入：develop 会派生 worker 产码，explain 只出结论、不产生待合并改动。 */
export const FLOWS = new Set(['develop', 'explain']);
/** Buffered drafts are a cache, not a queue: bounded so a forgotten tab cannot grow the db forever. */
const MAX_DRAFTS = 500;
/** 一个 planner 一轮能攒下的 pending spec 上限；一批也按它取，所以一轮拆解不会被截成两批。 */
const MAX_BATCH_SPECS = 200;
/** A batch keeps every utterance identifiable; a single draft stays verbatim. */
function batchContent(drafts) {
  if (drafts.length === 1) return drafts[0].content;
  return [`用户在一次提交中给了 ${drafts.length} 条，按输入顺序：`,
    ...drafts.map((draft, index) => `${index + 1}) ${draft.content}`)].join('\n');
}
function normalizeDeps(deps) {
  check(Array.isArray(deps), 'deps must be an array');
  check(deps.length <= 32, 'at most 32 dependencies per task');
  const edges = [];
  for (const raw of deps) {
    const value = isPlainObject(raw) ? raw : { id: raw };
    const kind = value.kind ?? 'code';
    check(DEP_KINDS.has(kind), 'dependency kind must be code or order');
    const depId = id(value.id);
    check(!edges.some(edge => edge.id === depId), `duplicate dependency on task ${depId}`);
    edges.push({ id: depId, kind });
  }
  return edges;
}

/** One task owns exactly one agent for its whole life; only the credential rotates per wake. */
function agentView(task, run = null) {
  return { id: `${task.role}#${task.id}`, task_id: task.id, role: task.role, wakes: task.agent_wakes,
    created_at: task.created_at, last_seen_at: task.agent_last_seen_at, active: Boolean(run), pid: run?.pid ?? null };
}
const tokenHash = token => createHash('sha256').update(token).digest('hex');
/** 时间轴窗口：再老的调用线段画成一堆像素没有意义，所以只展示最近一段。 */
const TIMELINE_WINDOW_MS = 6 * 3600 * 1000;
/**
 * 一段空隙的原因。库里只留下两边的状态，所以历史上只能按"起点时上游是否已结算"近似：
 * 起点还有上游没结束 ⇒ 等依赖；否则就是排队等并发槽（等子任务/等你决定只对当前状态精确）。
 */
function waitSegment(start, end, deps, status = null, children = []) {
  if (status === 'waiting') return { kind: 'wait', start, end, reason: 'children', blocked_by: children.map(child => child.id) };
  if (status === 'awaiting') return { kind: 'wait', start, end, reason: 'user' };
  // 父任务停着不动时，先看是不是在等子任务：子任务的存活区间和这段空隙重叠就是了。
  const covering = children.filter(child => child.created_at <= end && (!child.terminal_at || child.terminal_at >= start));
  if (covering.length) return { kind: 'wait', start, end, reason: 'children', blocked_by: covering.map(child => child.id) };
  const pending = deps.filter(dep => !dep.terminal_at || dep.terminal_at > start);
  if (pending.length) return { kind: 'wait', start, end, reason: 'dep', blocked_by: pending.map(dep => dep.id) };
  return { kind: 'wait', start, end, reason: 'slot' };
}
/** 把 lifecycle 事件配成 run/wait 区间；最后一段没闭合的就是"现在还在跑/还在等"。 */
function timelineSegments(task, events, deps, children, now) {
  const segments = [];
  let cursor = task.created_at, open = null, started = false;
  for (const event of events) {
    if (event.type === 'invocation.started') {
      if (cursor < event.created_at) segments.push(waitSegment(cursor, event.created_at, deps, null, children));
      open = event.created_at; started = true;
    } else {
      // invocation.completed 与终态事件（completed/failed/cancelled）都闭合当前这段调用。
      if (open && open < event.created_at) segments.push({ kind: 'run', start: open, end: event.created_at });
      open = null; cursor = event.created_at;
    }
  }
  // 一行事件都没有就结束的任务（比如建 worktree 就失败了）不能画成空白：它就是“没跑起来”。
  if (!segments.length && !started && TERMINAL.has(task.status)) return [{ kind: 'wait', start: task.created_at, end: cursor, reason: 'setup' }];
  if (open) segments.push({ kind: 'run', start: open, end: now, open: true });
  else if (!TERMINAL.has(task.status) && cursor < now) segments.push({ ...waitSegment(cursor, now, deps, task.status, children), open: true });
  return segments;
}

/** One project, a persistent task tree, and a bounded pool of disposable agents. */
export class Project {
  constructor(config, store, provider = null) {
    this.config = config; this.store = store;
    this.provider = provider || (config.provider === 'mock' ? new MockProvider() : new PiProvider(config));
    this.workspaces = new Workspaces(config, store);
    this.running = new Map(); this.stopping = false; this.scheduled = false; this.ancestry = new Map();
  }
  status() {
    const alive = this.store.get("SELECT count(*) AS count FROM tasks WHERE status NOT IN ('completed','failed','cancelled')").count;
    return { project: this.config.project, home: this.config.home, provider: this.config.provider,
      concurrency: this.config.concurrency, tasks: this.store.all('SELECT status, count(*) AS count FROM tasks GROUP BY status'),
      specs: { ...this.store.specStats(),
        batches: bounded(this.store.all("SELECT t.id, t.status, t.role, (SELECT count(*) FROM task_specs s WHERE s.batch_id=t.id) AS count FROM tasks t WHERE t.role='scheduler' ORDER BY t.id DESC LIMIT 100"), 100000) },
      drafts: this.store.draftCount(),
      agents: [...this.running].map(([task_id, run]) => agentView(this.store.task(task_id), run)),
      agents_total: alive, agents_idle: alive - this.running.size,
      pending_merges: this.store.all("SELECT id, substr(goal,1,500) AS goal, branch, integration FROM tasks WHERE integration IN ('pending','review','conflict') ORDER BY id LIMIT 100"),
      // 未解决的冲突冻结同一目标分支上的合并：界面据此禁用按钮并说清原因。
      // resolves_task_id 取真正在服务这条冲突的解冲突任务（他不在 W 自己的列上，而是它指向 W）。
      merge_freeze: this.store.all(`SELECT id AS task_id, target_branch,
        (SELECT r.id FROM tasks r WHERE r.resolves_task_id = tasks.id AND r.status NOT IN ('failed','cancelled')
          ORDER BY r.id DESC LIMIT 1) AS resolves_task_id
        FROM tasks WHERE integration='conflict' ORDER BY id LIMIT 50`),
      notices: this.store.get("SELECT count(*) AS count FROM notices WHERE status='open'").count };
  }
  /** The single place a root planner is created; input.submit and draft.commit both land here. */
  createInput(content) {
    text(content, 'input');
    return this.store.transaction(() => {
      const row = this.store.run('INSERT INTO inputs(content) VALUES (?)', content);
      const inputId = Number(row.lastInsertRowid);
      const task = this.store.create({ input_id: inputId, role: 'planner', goal: content });
      this.store.run('UPDATE inputs SET task_id=? WHERE id=?', task.id, inputId);
      return { id: inputId, content, task };
    });
  }
  submit(content) {
    const result = this.createInput(content);
    this.kick(); return result;
  }
  /** Buffering is user-only: agents submit work through task.spawn, never through the input buffer. */
  draft(content) {
    text(content, 'draft');
    check(this.store.draftCount() < MAX_DRAFTS, 'too many buffered drafts; submit or remove some first');
    return this.store.addDraft(content);
  }
  drafts() { return bounded(this.store.openDrafts(), 400000); }
  dropDraft(draftId) {
    const draft = this.store.draft(draftId);
    check(draft.input_id === null, `draft ${draft.id} was already submitted as input ${draft.input_id}; inputs are never removed`);
    this.store.run('DELETE FROM drafts WHERE id=?', draft.id);
    return { id: draft.id };
  }
  /** Edit a buffered draft in place. Submitted drafts are the audit chain of an input and never change. */
  editDraft(draftId, content) {
    text(content, 'draft');
    const draft = this.store.draft(draftId);
    check(draft.input_id === null, `draft ${draft.id} was already submitted as input ${draft.input_id}; inputs are never changed`);
    return this.store.updateDraft(draft.id, content);
  }
  /**
   * Hands buffered drafts to one planner as a single batch. ids omitted: every open draft.
   * With ids: only the selected subset, ascending by id (= input order); unselected drafts stay buffered.
   */
  commitDrafts(ids = null) {
    let drafts;
    if (ids === null || ids === undefined) {
      drafts = this.store.openDrafts();
    } else {
      check(Array.isArray(ids), 'commit ids must be an array of draft ids');
      check(ids.length > 0, 'select at least one draft to submit');
      check(ids.length <= MAX_DRAFTS, 'too many drafts in one commit');
      const selected = new Set();
      for (const raw of ids) {
        const draftId = id(raw);
        check(!selected.has(draftId), `draft ${draftId} listed twice`);
        selected.add(draftId);
      }
      drafts = [...selected].sort((a, b) => a - b).map(draftId => {
        const draft = this.store.draft(draftId);
        check(draft.input_id === null, `draft ${draft.id} was already submitted as input ${draft.input_id}; inputs are never committed twice`);
        return draft;
      });
    }
    check(drafts.length > 0, 'no buffered drafts to submit');
    const result = this.store.transaction(() => {
      const content = batchContent(drafts);
      const row = this.store.run('INSERT INTO inputs(content) VALUES (?)', content);
      const inputId = Number(row.lastInsertRowid);
      const task = this.store.create({ input_id: inputId, role: 'planner', goal: content });
      this.store.run('UPDATE inputs SET task_id=? WHERE id=?', task.id, inputId);
      for (const draft of drafts) this.store.run('UPDATE drafts SET input_id=? WHERE id=?', inputId, draft.id);
      return { id: inputId, content, task, drafts: drafts.map(draft => draft.id) };
    });
    this.store.event(result.task.id, 'input.batch', { draft_ids: result.drafts });
    this.kick(); return result;
  }
  inputs() {
    return this.store.all(`SELECT inputs.id, inputs.flow, substr(inputs.content,1,2000) AS content, inputs.task_id, inputs.created_at, tasks.status,
      (SELECT count(*) FROM drafts WHERE drafts.input_id=inputs.id) AS draft_count
      FROM inputs JOIN tasks ON tasks.id=inputs.task_id ORDER BY inputs.id DESC LIMIT 100`);
  }
  /** The root planner decides which flow an input takes; runtime only records it and enforces the explain constraint in spawn(). */
  setInputFlow(taskId, flow) {
    const task = this.store.task(taskId);
    check(FLOWS.has(flow), 'flow must be develop or explain');
    check(task.parent_id === null, 'only a root task can classify an input');
    check(task.input_id !== null, 'task belongs to no input');
    this.store.transaction(() => {
      this.store.run('UPDATE inputs SET flow=? WHERE id=?', flow, task.input_id);
      this.store.event(task.id, 'input.flow', { input_id: task.input_id, flow });
    });
    return { input_id: task.input_id, task_id: task.id, flow };
  }
  /**
   * The one place a scheduler task is born: a planner has finished its round and no live scheduler owns the queue.
   * 批次 = 那个 planner 这一轮写下的全部 spec，所以等待只由「planner 结束」触发，不由写入时刻决定。
   */
  ensureScheduler() {
    const group = this.store.nextSpecPlanner();
    if (!group) return null;
    if (this.store.get("SELECT id FROM tasks WHERE role='scheduler' AND status NOT IN ('completed','failed','cancelled')")) return null;
    return this.store.transaction(() => {
      const task = this.store.create({ input_id: null, role: 'scheduler', name: null,
        goal: `调度拆解队列：planner #${group.planner_task_id} 写下的 ${group.count} 条 spec，一次性编排完本批（不允许遗留）` });
      this.store.assignSpecs(task.id, MAX_BATCH_SPECS, group.planner_task_id);
      return task;
    });
  }
  /** Task rows plus their dependency edges, so every read model shows what a queued task waits for. */
  decorate(tasks) {
    const edges = this.store.depMap();
    return tasks.map(task => {
      const deps = edges.get(task.id) || [];
      return { ...task, deps, blocked: deps.some(edge => !TERMINAL.has(edge.status)) };
    });
  }
  blockedBy(taskId) { return (this.store.depMap().get(taskId) || []).filter(edge => !TERMINAL.has(edge.status)).map(edge => edge.id); }
  /** Structural dependency checks. Semantic conflicts (duplicate work, same files) stay the planner's job. */
  assertDeps(taskId, parent, edges) {
    const ancestors = new Set();
    for (let node = parent; node; node = node.parent_id ? this.store.task(node.parent_id) : null) ancestors.add(node.id);
    let code = 0;
    for (const edge of edges) {
      check(edge.id !== taskId, 'a task cannot depend on itself');
      check(!ancestors.has(edge.id), `cannot depend on ancestor task #${edge.id}: an ancestor waits for its children, so both sides would wait forever`);
      const dep = this.store.task(edge.id);
      // Edges are only ever written here, so this cannot fire today; it keeps a future edit-DAG API honest.
      check(!this.store.reaches(edge.id, taskId), `dependency on #${edge.id} would create a cycle`);
      if (edge.kind !== 'code') continue;
      code += 1;
      check(code <= 1, 'a task can stack on at most one code dependency; use order for the rest, or add a task that merges both');
      check(dep.role === 'worker', `code dependency #${dep.id} is a ${dep.role} task; only a worker gets a branch to stack on`);
      check(!['failed','cancelled'].includes(dep.status), `code dependency #${dep.id} is ${dep.status}; it cannot serve as a code base`);
    }
  }
  /** planner 只写队列：把一条拆解结果变成 task_specs 行，同样只允许引用自己写的 spec。 */
  addSpec(plannerTaskId, spec = {}) {
    const planner = this.store.task(plannerTaskId);
    check(planner.role === 'planner', 'only a planner writes to the spec queue (lush spec add)');
    text(spec.goal, 'goal');
    const role = spec.role ?? null;
    check(role === null || ['worker','coordinator','research'].includes(role), 'spec role must be worker, coordinator or research');
    // explain 输入只允许写 research 的 spec，否则 scheduler 一定会 spawn 出一个被拒的任务。
    const flowInput = planner.input_id === null ? null : this.store.get('SELECT id, flow FROM inputs WHERE id=?', planner.input_id);
    check(!flowInput || flowInput.flow !== 'explain' || role === 'research',
      `input #${flowInput?.id} is classified as explain (了解); only research specs are allowed`);
    const name = spec.name ?? null;
    const slug = taskSlug(name, spec.goal);
    const deps = spec.deps ?? [];
    check(Array.isArray(deps) && deps.length <= 32, 'at most 32 spec dependencies');
    const hints = [];
    for (const raw of deps) {
      const value = isPlainObject(raw) ? raw : { spec: raw };
      const specId = id(value.spec);
      const kind = value.kind ?? 'code';
      check(DEP_KINDS.has(kind), 'spec dependency kind must be code or order');
      check(!hints.some(hint => hint.spec === specId), `duplicate spec dependency on #${specId}`);
      const target = this.store.spec(specId);
      check(target.planner_task_id === planner.id, `spec #${specId} belongs to another planner; link only your own specs`);
      hints.push({ spec: specId, kind });
    }
    const pending = this.store.get("SELECT count(*) AS n FROM task_specs WHERE planner_task_id=? AND status='pending'", planner.id).n;
    check(pending < MAX_BATCH_SPECS, `a planner may hold at most ${MAX_BATCH_SPECS} pending specs; let the scheduler drain the queue first`);
    const row = this.store.addSpec({ input_id: planner.input_id, planner_task_id: planner.id, goal: spec.goal, role, name: slug, deps: hints });
    this.store.event(planner.id, 'spec.added', { spec_id: row.id, role, name: slug, deps: hints });
    this.kick();
    return row;
  }
  /** Only the planner that wrote a pending spec, or the scheduler holding its batch, may drop it. */
  dropSpec(specId, note = null, actor = null) {
    const spec = this.store.spec(specId);
    check(spec.status === 'pending', `spec #${spec.id} is ${spec.status}; only a pending spec can be dropped`);
    if (actor !== null) {
      const owner = actor === spec.planner_task_id || (spec.batch_id !== null && actor === spec.batch_id);
      check(owner, `task #${actor} may not drop spec #${spec.id}`);
    }
    if (note !== null && note !== undefined) text(note, 'note');
    this.store.dropSpec(spec.id, note ?? null);
    this.store.event(actor ?? spec.planner_task_id, 'spec.dropped', { spec_id: spec.id, note: note ?? null });
    return this.store.spec(spec.id);
  }
  /** name is the planner's short slug for the work; it becomes the branch/worktree name and stays fixed for the task's life. */
  spawn(parentId, goal, role = 'worker', deps = [], name = null, specId = null) {
    const parent = this.store.task(parentId);
    check(!TERMINAL.has(parent.status), 'cannot delegate from a terminal task');
    check(parent.role !== 'planner', 'planner 不再直接派活；用 lush spec add 写拆解队列，由 scheduler 编排');
    text(goal, 'goal'); check(['worker','coordinator','research'].includes(role), 'role must be worker, coordinator or research');
    const edges = normalizeDeps(deps);
    const resolved = new Map(edges.map(edge => [edge.id, edge.kind]));
    let spec = null;
    if (specId !== null && specId !== undefined) {
      spec = this.store.spec(specId);
      check(spec.status === 'pending', `spec #${spec.id} is ${spec.status}; only a pending spec can be spawned`);
      if (parent.role === 'scheduler') check(spec.batch_id === parent.id, `spec #${spec.id} is not in scheduler #${parent.id}'s batch`);
      // Turn the planner's dependency hints into real edges. A dependency cannot be spawned after its consumer.
      for (const hint of spec.deps) {
        const target = this.store.spec(hint.spec);
        check(target.status !== 'dropped', `spec #${hint.spec} was dropped; its dependency can never be met, so drop spec #${spec.id} instead of spawning it`);
        check(target.task_id !== null, `spec #${hint.spec} has not been spawned yet; spawn the dependency before spec #${spec.id}`);
        const existing = resolved.get(target.task_id);
        if (existing !== undefined) check(existing === hint.kind, `conflicting dependency on task #${target.task_id}: explicit ${existing} vs spec hint ${hint.kind}`);
        else resolved.set(target.task_id, hint.kind);
      }
    } else {
      check(parent.role !== 'scheduler', 'a scheduler must spawn every spec with --spec SPEC_ID; the spec queue is its only input');
    }
    const merged = [...resolved].map(([edgeId, kind]) => ({ id: edgeId, kind }));
    // 硬约束：了解类输入只能派生只读的 research，不能产生 worker/coordinator（因此不会创建 worktree 或待合并改动）。
    // scheduler 自己没有 input，所以它 spawn 的 spec 要把 spec 的 input_id 接过来，explain 约束才能覆盖整棵子树。
    const inheritedInput = parent.input_id ?? (spec ? spec.input_id : null);
    const input = inheritedInput === null ? null : this.store.get('SELECT id, flow FROM inputs WHERE id=?', inheritedInput);
    check(!input || input.flow !== 'explain' || role === 'research',
      `input #${input?.id} is classified as explain (了解); delegate research or answer directly, not ${role}`);
    let depth = 1, ancestor = parent;
    while (ancestor.parent_id) { ancestor = this.store.task(ancestor.parent_id); depth++; }
    check(depth < this.config.maxDepth, 'task nesting limit reached');
    check(this.store.get("SELECT count(*) AS n FROM tasks WHERE status NOT IN ('completed','failed','cancelled')").n < 1000, 'too many active tasks');
    const slug = taskSlug(name, goal);
    const task = this.store.transaction(() => {
      const created = this.store.create({ parent_id: parent.id, input_id: inheritedInput, role, goal, name: slug });
      this.assertDeps(created.id, parent, merged);
      for (const edge of merged) { this.store.addDep(created.id, edge.id, edge.kind); this.store.event(created.id, 'dep.added', edge); }
      if (spec) this.store.plannedSpec(spec.id, created.id);
      return created;
    });
    this.kick(); return task;
  }
  inspect(taskId) {
    const task = this.store.task(taskId);
    return { ...task, deps: this.store.depsDetail(task.id), dependents: this.store.dependentsDetail(task.id),
      ...(task.role === 'planner' ? { specs: bounded(this.store.specsByPlanner(task.id), 200000) } : {}),
      ...(task.role === 'scheduler' ? { specs: bounded(this.store.specsForBatch(task.id), 200000) } : {}),
      children: bounded(this.store.summaries().filter(child => child.parent_id === task.id), 100000),
      messages: bounded(this.store.all('SELECT * FROM messages WHERE task_id=? ORDER BY id DESC LIMIT 100', task.id), 200000),
      notices: bounded(this.store.all('SELECT * FROM notices WHERE task_id=? ORDER BY id DESC LIMIT 100', task.id), 200000),
      // worker 带着自己的检验记录与合并冲突处理记录；verifier 带着自己的报告路径。都是只读投影。
      verifications: task.role === 'worker' ? bounded(this.store.verifications(task.id).map(row => ({ ...row, has_report: this.hasReport(row.id) })), 200000) : undefined,
      resolutions: task.role === 'worker' ? bounded(this.store.resolutions(task.id), 200000) : undefined,
      report: task.role === 'verifier' && this.hasReport(task.id) ? this.reportPath(task.id) : null,
      agent: agentView(task, this.running.get(task.id) ?? null) };
  }
  diff(taskId) { return this.workspaces.diff(this.store.task(taskId)); }
  /** 自包含 HTML 检验报告：由 verifier 自己写文件，runtime 只决定它在哪。 */
  reportPath(taskId) { return path.join(this.config.home, 'verify', String(taskId), 'report.html'); }
  hasReport(taskId) { return fs.existsSync(this.reportPath(taskId)); }
  /**
   * 用户点「检验」：为一个已完成的 worker 派一个只读 verifier，
   * 由它自己判断最直观的演示方式，并对照目标分支的同一场景。
   * 终态任务不能有活动子任务，所以 verifier 是独立根任务，用 verifies_task_id 关联而非 parent_id。
   */
  verify(taskId) {
    const target = this.store.task(taskId);
    check(target.role === 'worker', `only a worker task can be verified; #${target.id} is a ${target.role}`);
    check(target.status === 'completed', `only a completed task can be verified; #${target.id} is ${target.status}`);
    check(target.workspace && fs.existsSync(target.workspace) && target.head_commit,
      `task #${target.id} has no worktree or commit to verify`);
    check(target.target_branch, `task #${target.id} has no target branch to compare against`);
    const active = this.store.activeVerification(target.id);
    check(!active, `verification #${active?.id} is still running; wait for it or cancel it`);
    const goal = `检验 #${target.id}：用最直观的方式演示它这一步改动的实际运行结果，并对照 ${target.target_branch} 分支在当前同样场景下的表现。`;
    const task = this.store.transaction(() => this.store.create({
      parent_id: null, input_id: target.input_id, role: 'verifier', goal,
      name: `verify-${target.id}`, verifies_task_id: target.id }));
    this.store.event(target.id, 'verify.requested', { verify_task: task.id, baseline: target.target_branch });
    // 让界面知道被检验任务刚刚有了新状态，否则轮询不会重新渲染它的详情。
    this.store.touch(target.id);
    this.kick();
    return task;
  }
  /** verifier 的上下文：它要演示哪次改动、对照在哪个目录、报告写到哪。 */
  verificationContext(task) {
    const target = this.store.task(task.verifies_task_id);
    return {
      verified_task: { id: target.id, goal: target.goal, name: target.name, status: target.status, result: target.result },
      branch: target.branch, base_commit: target.base_commit, head_commit: target.head_commit,
      target_branch: target.target_branch, workspace: target.workspace,
      baseline_workspace: task.baseline_workspace, baseline_commit: task.baseline_commit,
      report_path: this.reportPath(task.id),
    };
  }
  /**
   * 用户明确批准合并。干净合并一键完成；**内容冲突是正常结局**：它变成一个专用任务加一条待决问题。
   * 冲突未解决期间同一目标分支上的合并被冻结：解冲突的产物要靠 --ff-only 原样落地，
   * main 一旦被别的合并推走，agent 测过的那棵树就不再是要落地的树。
   */
  async approveMerge(taskId) {
    const task = this.store.task(taskId);
    // 这条冲突不算冻结自己的三种情况：冲突就是我自己（重试）；我就是它现在的解冲突任务；它为当前这次落地服务。
    const frozen = this.store.conflictsOn(task.target_branch).filter(row => row.id !== task.id
      && row.resolves_task_id !== task.id && task.resolves_task_id !== row.id);
    const blocker = frozen[0];
    check(!blocker, blocker
      ? `merging into ${task.target_branch} is frozen by the unresolved conflict on #${blocker.id}; answer its notice, cancel its resolution task, or retry that merge first`
      : '');
    const result = await this.workspaces.merge(task.id);
    if (!result.conflict) {
      const resolvedTaskId = result.task.resolves_task_id;
      // 解冲突任务落地 = 原任务的提交也进了目标分支：两个任务一起收尾，冻结随之消失。
      if (resolvedTaskId) this.settleResolution(result.task);
      return { ...result.task, merge: resolvedTaskId ? { status: 'resolved', resolved_task_id: resolvedTaskId } : { status: 'merged' } };
    }
    return this.openResolution(result.task.id, result.conflict);
  }
  /**
   * 批量合并：用户一次选中多个任务，运行时按依赖顺序逐个走**同一个** approveMerge，
   * 不绕过它的任何门槛（资格、code 上游、冲突冻结），也绝不并行写主树。
   * 遇到第一个冲突或硬失败就停下：后续条目标 skipped，避免在未知现场上继续合并。
   * 顺序只看「本次选中集合内」的依赖边（code 与 order 都算先后），并列者按 id 升序——逻辑在 mergeOrder。
   */
  async approveMergeMany(ids) {
    check(Array.isArray(ids), 'ids must be an array of task ids');
    check(ids.length > 0, 'batch merge needs at least one task id');
    const unique = [...new Set(ids.map(value => id(value)))];
    check(unique.length <= 50, 'at most 50 tasks per batch merge');
    const ordered = mergeOrder(unique, this.store.edgesOf(unique));
    const merges = [];
    let stopped = null;
    const integrationOf = taskId => this.store.get('SELECT integration FROM tasks WHERE id=?', taskId)?.integration ?? 'none';
    for (const taskId of ordered) {
      if (stopped) {
        merges.push({ id: taskId, status: 'skipped', integration: integrationOf(taskId),
          error: `batch stopped at #${stopped.id}: ${stopped.reason}` });
        continue;
      }
      try {
        const result = await this.approveMerge(taskId);
        if (result.merge?.status === 'conflict') {
          const files = result.merge.files ?? [];
          stopped = { id: taskId, reason: `merge conflict on ${files.length ? files.join(', ') : 'unknown files'}` };
          merges.push({ id: taskId, status: 'conflict', integration: result.integration,
            resolution_task_id: result.merge.resolution_task_id, error: stopped.reason });
        } else {
          merges.push({ id: taskId, status: 'merged', integration: result.integration });
        }
      } catch (error) {
        stopped = { id: taskId, reason: error.message };
        merges.push({ id: taskId, status: 'failed', integration: integrationOf(taskId), error: error.message });
      }
    }
    return { merges, merged: merges.filter(row => row.status === 'merged').length, stopped };
  }
  /**
   * 内容冲突的收口：主树已经 abort 回合并前的干净状态，现在把「怎么并」变成一次用户决定。
   * 解冲突任务不在原任务的子树里（终态任务不允许有活动后代），用 resolves_task_id 关联；
   * 它的 worktree 以目标分支顶端为基线，agent 把那次审阅过的提交并进来解冲突，产物是一个合并提交，
   * 所以批准时能 --ff-only 落地：审阅过的树就是落地的树，不会再有第二轮冲突。
   * 任务先预置成 awaiting（不占并发槽、不烧 token），答复那条 notice 才开工，忽略则整件事撤销。
   */
  openResolution(taskId, conflict) {
    const task = this.store.task(taskId);
    check(['pending', 'review'].includes(task.integration), `#${task.id} is not waiting for a merge`);
    const active = this.store.activeResolver(task.id);
    check(!active, `resolution task #${active?.id} is still running; wait for it or cancel it before asking for another round`);
    const stale = this.store.unlandedResolver(task.id);
    const goal = `解决 #${task.id} 合并到 ${task.target_branch} 的冲突。\n`
      + `你的 worktree 以 ${task.target_branch} 的顶端为基线；把 #${task.id} 已审阅的提交 ${task.head_commit ?? task.branch}（分支 ${task.branch}）并进来，\n`
      + `解决下面这些冲突，提交这次 merge，然后跑能重复的测试证明并完的结果可用。只解决冲突，不要顺手重构或改与冲突无关的行为。\n`
      + `冲突文件：\n${conflict.files.map(file => `  ${file}`).join('\n')}\n\ngit：\n${conflict.output}`;
    const resolution = this.store.transaction(() => {
      const created = this.store.create({ parent_id: null, input_id: task.input_id, role: 'merger', goal,
        name: `resolve-${task.id}`, resolves_task_id: task.id });
      // 上一轮完成了却没落地（比如 main 前进导致 --ff-only 失败）：重试就是明确抛弃那一轮，
      // 但分支与 worktree 一律不删，只把它标成 superseded，让用户在可回收和可追溯之间自己选。
      if (stale) {
        this.store.update(stale.id, { integration: 'superseded' });
        this.store.event(stale.id, 'resolution.superseded', { by: created.id });
      }
      this.store.update(task.id, { integration: 'conflict', integration_error: conflict.output });
      this.store.event(task.id, 'merge.conflict', { resolution: created.id, target_branch: task.target_branch,
        commit: task.head_commit, files: conflict.files });
      return this.store.update(created.id, { status: 'awaiting', target_branch: task.target_branch });
    });
    const notice = this.notice(resolution.id, `#${task.id} 合并到 ${task.target_branch} 冲突：要开一个解冲突任务吗？`, [
      `冲突文件：\n${conflict.files.map(file => `  ${file}`).join('\n')}`,
      `git 的输出：\n${conflict.output}`,
      `${task.target_branch} 已经 abort 回合并前的干净状态，没有留下中间态。`,
      `答复任意内容：批准解冲突任务 #${resolution.id} 开工。它在自己的 worktree 里（基线＝${task.target_branch} 顶端）把 #${task.id} 已审阅的提交并进来、解冲突、跑测试，完成后由你决定要不要落地。`,
      `解冲突任务落地时用 --ff-only：落地的树就是它测过的那棵树，不会再冲突一次。`,
      `忽略这条问题：撤销 #${resolution.id}，#${task.id} 回到「待合并」。`,
      `在冲突解决之前，同一目标分支 ${task.target_branch} 上的其它合并会被冻结，防止 main 前进让解冲突的结果失效。`,
    ].join('\n\n'));
    return { ...task, integration: 'conflict', merge: { status: 'conflict', files: conflict.files,
      resolution_task_id: resolution.id, notice_id: notice.id, superseded_task_id: stale?.id ?? null } };
  }
  /** 解冲突任务落地：原任务的提交已经在目标分支里，两个任务一起标成已合并。 */
  settleResolution(resolution) {
    const target = this.store.task(resolution.resolves_task_id);
    if (target.integration === 'merged') return target;
    this.store.transaction(() => {
      this.store.update(target.id, { integration: 'merged', integration_error: null });
      this.store.event(target.id, 'merge.resolved', { via: resolution.id, commit: resolution.head_commit });
    });
    return this.store.task(target.id);
  }
  /** 解冲突任务的上下文：并谁、并到哪、冲突在哪几个文件。 */
  mergeConflictContext(task) {
    const target = this.store.task(task.resolves_task_id);
    const event = this.store.get("SELECT data FROM events WHERE task_id=? AND type='merge.conflict' ORDER BY id", target.id);
    return {
      conflicted_task: { id: target.id, goal: target.goal, name: target.name, result: target.result },
      branch: target.branch, commit: target.head_commit, target_branch: target.target_branch,
      files: event ? JSON.parse(event.data).files ?? [] : [],
    };
  }
  /** Read-only agent process log from pi's session files; never touches the database. */
  transcript(taskId, after = 0, limit = 100) {
    this.store.task(taskId);
    return readTranscript(this.config, taskId, after, limit);
  }
  /** Read-only agent usage (model, context, cost) from the same session files, without the bodies. */
  usage(taskId) {
    this.store.task(taskId);
    return readUsage(this.config, taskId);
  }
  tree(taskId = null) {
    const tasks = this.decorate(this.store.summaries());
    const rows = new Map(tasks.map(task => [task.id, { ...task, children: [] }]));
    const roots = [];
    for (const row of rows.values()) {
      // verifier 与 merger 都不是子任务（终态任务不能有活动后代），但界面上挂在它们服务的任务下面。
      const parent = row.parent_id ?? row.verifies_task_id ?? row.resolves_task_id;
      if (parent !== null && parent !== undefined && rows.has(parent)) rows.get(parent).children.push(row); else roots.push(row);
    }
    if (taskId !== null) { this.store.task(taskId); return rows.get(id(taskId)); }
    return roots;
  }
  /**
   * 只读时间轴：面板上看不出"谁和谁同时在跑"，因为并行只是并发池的副产品、串行只是依赖边的后果。
   * 这里把 events 配成真实的调用区间，空隙就是排队（等依赖或等并发槽），界面据此画泳道与槽位。
   */
  timeline({ limit = 40 } = {}) {
    const size = Number(limit);
    check(Number.isInteger(size) && size >= 1 && size <= 200, 'timeline limit must be 1..200');
    const tasks = this.store.timelineTasks(size);
    const ids = tasks.map(task => task.id);
    const edges = this.store.edgesOf(ids);
    const upstreamIds = edges.map(edge => edge.depends_on).filter(depId => !ids.includes(depId));
    const events = this.store.lifecycleEvents([...new Set([...ids, ...upstreamIds])]);
    const children = new Map();
    for (const row of this.store.childSpans(ids)) {
      if (!children.has(row.parent_id)) children.set(row.parent_id, []);
      children.get(row.parent_id).push(row);
    }
    const byTask = new Map();
    for (const event of events) {
      if (!byTask.has(event.task_id)) byTask.set(event.task_id, []);
      byTask.get(event.task_id).push(event);
    }
    const terminalAt = taskId => (byTask.get(taskId) || []).filter(row => TERMINAL.has(row.type)).at(-1)?.created_at ?? null;
    const now = new Date().toISOString();
    const rows = tasks.map(task => {
      const deps = edges.filter(edge => edge.task_id === task.id)
        .map(edge => ({ id: edge.depends_on, kind: edge.kind, terminal_at: terminalAt(edge.depends_on) }));
      return { id: task.id, parent_id: task.parent_id, input_id: task.input_id, role: task.role, name: task.name,
        status: task.status, integration: task.integration, created_at: task.created_at, updated_at: task.updated_at,
        terminal_at: terminalAt(task.id), deps, segments: timelineSegments(task, byTask.get(task.id) || [], deps, children.get(task.id) || [], now) };
    });
    const floor = Date.parse(now) - TIMELINE_WINDOW_MS;
    const earliest = Math.min(...rows.map(row => Date.parse(row.created_at)), Date.parse(now));
    return { now, concurrency: this.config.concurrency, start: new Date(Math.max(earliest, floor)).toISOString(), end: now,
      clamped: earliest < floor, truncated: this.store.get('SELECT count(*) AS count FROM tasks').count > rows.length,
      tasks: bounded(rows, 300000) };
  }
  /**
   * 合并阶梯：未合并分支之间的依赖，以及"谁已经含了谁的提交"。
   * code 边是下游 worktree 的基线，runtime 要求上游先进目标分支才允许合下游；
   * order 边只要求上游终态，所以下游可以先合——那时它是否已经把上游带进来，只能问 git。
   * merge-base 的答案只取决于两个不可变 commit，所以缓存是准确的，不是过期近似。
   */
  async ladder() {
    const rows = this.store.all(`SELECT id, role, substr(goal,1,200) AS goal, branch, target_branch, head_commit, integration
      FROM tasks WHERE integration IN ('pending','review','conflict') ORDER BY id LIMIT 50`);
    const pendingIds = new Set(rows.map(row => row.id));
    const nodes = new Map(rows.map(row => [row.id, { id: row.id, role: row.role, goal: row.goal, branch: row.branch,
      target_branch: row.target_branch, integration: row.integration, deps: [], covered_by: [] }]));
    const head = new Map(this.store.all('SELECT id, branch, head_commit, integration FROM tasks').map(row => [row.id, row]));
    const edges = this.store.edgesOf([...pendingIds]);
    for (const id of pendingIds) {
      const node = nodes.get(id);
      for (const edge of edges.filter(row => row.task_id === id)) {
        const upstream = head.get(edge.depends_on) ?? {};
        // code 边＝下游 worktree 以它为基线，所以下游分支一定含上游提交；
        // order 边只保证顺序，含不含提交只能问 git。
        const contains = edge.kind === 'code' ? true : await this.containsCommit(upstream.head_commit, head.get(id)?.head_commit);
        node.deps.push({ id: edge.depends_on, kind: edge.kind, branch: upstream.branch ?? null,
          merged: upstream.integration === 'merged', pending: pendingIds.has(edge.depends_on), contains });
        // 只有 order 上游"可能已被带进来"：code 上游本来就必须先合，把它标成被覆盖会和 runtime 的守卫自相矛盾。
        if (edge.kind === 'order' && pendingIds.has(edge.depends_on) && contains) nodes.get(edge.depends_on).covered_by.push(id);
      }
    }
    for (const node of nodes.values()) node.covered_by = [...new Set(node.covered_by)];
    // 合并顺序只看 code 边：层级 = 必须先合的上游在它前面。order 边不改变顺序。
    const level = new Map();
    const depth = (taskId, seen = new Set()) => {
      if (level.has(taskId)) return level.get(taskId);
      if (seen.has(taskId)) return 0;
      seen.add(taskId);
      const codes = (nodes.get(taskId)?.deps ?? []).filter(dep => dep.kind === 'code' && dep.pending).map(dep => dep.id);
      const value = codes.length ? 1 + Math.max(...codes.map(dep => depth(dep, seen))) : 0;
      level.set(taskId, value); return value;
    };
    for (const id of pendingIds) depth(id);
    const pending = this.store.get("SELECT count(*) AS count FROM tasks WHERE integration IN ('pending','review')").count;
    return { target_branch: rows[0]?.target_branch ?? null, truncated: pending > rows.length,
      nodes: [...nodes.values()].map(node => ({ ...node, level: level.get(node.id) })) };
  }
  /** git merge-base --is-ancestor 的答案只取决于两个不可变 commit，缓存下来，轮询就不必反复跑 git。 */
  async containsCommit(upstream, downstream) {
    if (!upstream || !downstream || upstream === downstream) return false;
    const key = `${upstream}..${downstream}`;
    if (!this.ancestry.has(key)) this.ancestry.set(key, await this.workspaces.isAncestor(this.config.project, upstream, downstream));
    return this.ancestry.get(key);
  }
  message(taskId, body, sender = null) {
    const target = this.store.task(taskId); text(body, 'message');
    check(!TERMINAL.has(target.status), 'task has ended; retry it or submit a new input');
    if (sender !== null) {
      const from = this.store.task(sender);
      check(target.parent_id === from.id || from.parent_id === target.id, 'agents may message only a direct parent or child');
    }
    this.store.message(target.id, body, sender);
    this.store.event(target.id, 'message', { sender, body });
    this.wake(target.id); return this.store.task(target.id);
  }
  notice(taskId, title, body = '') {
    const task = this.store.task(taskId); text(title, 'title');
    check(typeof body === 'string' && body.length <= 32000, 'invalid notice body');
    check(!TERMINAL.has(task.status), 'task has ended');
    const row = this.store.run('INSERT INTO notices(task_id,title,body) VALUES (?,?,?)', task.id, title, body);
    this.store.event(task.id, 'notice.opened', { notice_id: Number(row.lastInsertRowid), title });
    return this.store.get('SELECT * FROM notices WHERE id=?', Number(row.lastInsertRowid));
  }
  answer(noticeId, answer, dismiss = false) {
    const notice = this.store.get('SELECT * FROM notices WHERE id=?', id(noticeId));
    check(notice && notice.status === 'open', 'notice is not open');
    if (!dismiss) text(answer, 'answer');
    this.store.transaction(() => {
      this.store.run('UPDATE notices SET status=?,answer=? WHERE id=?', dismiss ? 'dismissed' : 'answered', answer || '', notice.id);
      this.store.message(notice.task_id, JSON.stringify({ notice_id: notice.id, title: notice.title, dismissed: dismiss, answer: answer || '' }));
      this.store.event(notice.task_id, 'notice.answered', { notice_id: notice.id, answer, dismiss });
    });
    const owner = this.store.task(notice.task_id);
    // 预置任务（从未被唤醒过的解冲突任务）唯一没答过的请求就是这条 notice：
    // 忽略它意味着这件事不要做了，唤醒 agent 只会让它去做用户刚拒绝的事，所以直接让它结束。
    if (dismiss && owner.agent_wakes === 0) this.cancel(owner.id, `user dismissed notice ${notice.id}: ${notice.title}`);
    else this.wake(notice.task_id);
    return this.store.get('SELECT * FROM notices WHERE id=?', notice.id);
  }
  wake(taskId) {
    const task = this.store.task(taskId);
    if (!TERMINAL.has(task.status) && !this.running.has(task.id)) this.store.update(task.id, { status: 'queued' });
    this.kick();
  }
  finish(taskId, status, result = null, error = null) {
    const task = this.store.task(taskId);
    if (TERMINAL.has(task.status)) return task;
    check(this.store.children(task.id).every(child => TERMINAL.has(child.status)), 'cannot finish with active children');
    this.store.transaction(() => {
      this.store.update(task.id, { status, result, error });
      this.store.run("UPDATE notices SET status='dismissed',answer='task ended' WHERE task_id=? AND status='open'", task.id);
      this.store.event(task.id, status, { result, error });
      // 一个 scheduler 要么把 spec 编成任务，要么明确 drop；取消则把未处理的 spec 还给队列，绝不静默丢弃。
      if (task.role === 'scheduler') {
        if (status === 'cancelled') this.store.releaseBatch(task.id, 'scheduler 被取消，spec 回到 pending');
        else if (status === 'completed' || status === 'failed') this.store.discardBatch(task.id, `scheduler 未覆盖该 spec（${status}）`);
      }
      if (task.parent_id && !TERMINAL.has(this.store.task(task.parent_id).status)) {
        this.store.message(task.parent_id, JSON.stringify({ child: task.id, status, result, error }), task.id);
      }
      // 检验结算后让被检验任务的详情重新渲染，看得到最新结论。
      if (task.verifies_task_id) this.store.touch(task.verifies_task_id);
      // 解冲突任务没做成（失败 / 被取消）：原任务回到待合并，冻结随之解除，错误留在解冲突任务上。
      // 分支与 worktree 都保留，用户可以重试或自己处理。
      if (task.resolves_task_id && status !== 'completed') {
        const target = this.store.task(task.resolves_task_id);
        if (target.integration === 'conflict') {
          this.store.update(target.id, { integration: 'pending',
            integration_error: `resolution task #${task.id} ${status}${error ? `: ${error}` : ''}` });
          this.store.event(target.id, 'merge.conflict.abandoned', { resolution: task.id, status });
        }
      }
    });
    if (task.parent_id) this.wake(task.parent_id);
    // A settled dependency releases every queued dependent; still-blocked ones stay queued.
    for (const edge of this.store.dependents(task.id)) this.wake(edge.task_id);
    // 一个没有父子/依赖边的 planner（根任务）也要在自己结束时把这一轮拆解交给 scheduler。
    this.kick();
    return this.store.task(task.id);
  }
  cancel(taskId, reason = 'cancelled by user', status = 'cancelled') {
    const task = this.store.task(taskId);
    if (TERMINAL.has(task.status)) return task;
    // Children first; the event loop cannot schedule their parents until this synchronous cascade ends.
    for (const child of this.store.children(task.id)) if (!TERMINAL.has(child.status)) this.cancel(child.id, reason);
    this.running.get(task.id)?.controller.abort();
    return this.finish(task.id, status, null, reason);
  }
  /**
   * 用户专属的一键清空：删掉全部已结束任务，连同 inputs / drafts / notices / events。
   * 有活动任务（或刚 abort、invocation 尚未收尾的 agent）时拒绝，不做隐式取消——
   * 删除正在被调用的任务行会让 agent 的收尾路径读到不存在的 task。
   * 先按与 task cleanup 相同的安全门回收磁盘状态（worktree 目录、对照检出、已进目标分支的分支），
   * 再清库；回收不掉的任务连同分支与目录一起保留，返回值里列出原因。
   * 状态检查是同步的（调用方立即拿到拒绝），磁盘回收在返回的 Promise 里串行执行。
   */
  clear() {
    check(this.running.size === 0, 'an agent invocation is still unwinding; clear must wait');
    check(this.workspaces.busy.size === 0, 'worktree cleanup is in progress; clear must wait');
    const active = this.store.activeTasks();
    check(active.length === 0,
      `#${active.slice(0, 20).map(task => task.id).join(', #')} still active (${active.length}); cancel them or wait until they finish`);
    // 分支名、worktree 路径与对照目录都记在即将被删的行里，所以先回收再 purge。
    return this.reclaimThenPurge(this.store.tasks());
  }
  async reclaimThenPurge(tasks) {
    const outcomes = await this.workspaces.reclaim(tasks);
    const reason = new Map(outcomes.map(row => [row.id, row.reason]));
    const retained = this.store.all(`SELECT id, branch, workspace, baseline_workspace FROM tasks
      WHERE workspace IS NOT NULL OR baseline_workspace IS NOT NULL OR branch IS NOT NULL ORDER BY id`);
    const counts = this.store.purge();
    return {
      cleared: { tasks: counts.tasks, inputs: counts.inputs, drafts: counts.drafts, notices: counts.notices,
        messages: counts.messages, events: counts.events, task_deps: counts.task_deps, task_specs: counts.task_specs },
      reclaimed: {
        worktrees: outcomes.filter(row => row.worktree === 'removed').length,
        branches: outcomes.filter(row => row.branch === 'removed').length,
      },
      retained: { note: 'unmerged work, unreviewed branches and pi sessions stay on disk; remove them by hand',
        tasks: bounded(retained.map(row => ({ ...row, reason: reason.get(row.id) ?? null })), 200000) },
      next_task_id: this.store.taskIdHigh() + 1,
    };
  }
  retry(taskId) {
    const task = this.store.task(taskId);
    check(['failed','cancelled'].includes(task.status), 'only failed/cancelled tasks can be retried');
    check(!this.running.has(task.id), 'agent is still stopping; retry shortly');
    check(!this.workspaces.busy.has(task.id), 'worktree cleanup is in progress; retry shortly');
    if (task.parent_id) check(!TERMINAL.has(this.store.task(task.parent_id).status), 'parent has ended; retry the parent or submit a new input');
    this.store.update(task.id, { status: 'queued', error: null, result: null, calls: 0 });
    this.store.event(task.id, 'retry', {}); this.kick(); return this.store.task(task.id);
  }
  recover() {
    // A credential dies with the invocation that issued it; nothing survives a restart.
    this.store.run('UPDATE tasks SET agent_token_hash=NULL');
    // Never replay an invocation with unknown filesystem side effects.
    for (const task of this.store.tasks()) if (task.status === 'running') this.cancel(task.id, 'daemon interrupted; inspect worktree and explicitly retry', 'failed');
    this.store.run("UPDATE tasks SET integration='review',integration_error='merge interrupted; inspect git history manually' WHERE integration='merging'");
    // A crash can land between committing an inbox message and queueing its owner.
    for (const task of this.store.tasks()) {
      if (!TERMINAL.has(task.status) && this.store.unread(task.id).length) this.wake(task.id);
    }
    // 中断的检验已经标成失败；对照基线是派生状态，顺手回收掉。
    for (const task of this.store.tasks()) {
      if (task.baseline_workspace && TERMINAL.has(task.status)) {
        this.workspaces.removeBaseline(task.id).catch(error => console.error(`verification ${task.id}: baseline cleanup failed: ${error.message}`));
      }
    }
    this.kick();
  }
  kick() {
    if (this.stopping || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (!this.stopping) this.pump();
    });
  }
  pump() {
    // 唯一的并发上限就是总池大小：planner 之间可并行，scheduler 与 worker 一样占一个槽。
    this.ensureScheduler();
    const dependencies = this.store.depMap();
    for (const task of this.store.all("SELECT * FROM tasks WHERE status='queued' ORDER BY id")) {
      if (this.running.has(task.id)) continue;
      // A queued task whose dependencies are not settled stays queued; finish() re-kicks when they are.
      if ((dependencies.get(task.id) || []).some(edge => !TERMINAL.has(edge.status))) continue;
      if (this.running.size >= this.config.concurrency) continue;
      const run = { role: task.role, controller: new AbortController(), token: randomBytes(32).toString('hex'), pid: null, promise: null };
      this.running.set(task.id, run);
      this.store.armAgent(task.id, tokenHash(run.token));
      run.promise = this.invoke(task.id, run).catch(error => {
        console.error(`task ${task.id}: ${error.stack || error}`);
      }).finally(() => {
        this.running.delete(task.id);
        // The credential is valid only while this invocation owns the task.
        this.store.armAgent(task.id, null);
        // A child can settle after its parent parked but before this cleanup.
        // Recheck the inbox after releasing ownership to avoid a lost wake-up.
        if (!TERMINAL.has(this.store.task(task.id).status) && this.store.unread(task.id).length) this.wake(task.id);
        this.kick();
      });
    }
  }
  /** Resolve an agent credential to its task. Only the invocation that was issued the token is an actor. */
  actor(token) {
    if (token === undefined || token === null || token === '') return null;
    check(typeof token === 'string', 'invalid agent token');
    const task = this.store.agentByToken(tokenHash(token));
    const run = task ? this.running.get(task.id) : null;
    if (!run) throw new LushError('invalid or expired agent token');
    check(!TERMINAL.has(task.status) && !run.controller.signal.aborted, 'agent task is no longer active');
    this.store.touchAgent(task.id);
    return task.id;
  }
  async invoke(taskId, run) {
    let timer;
    const messages = this.store.unread(taskId);
    try {
      let task = this.store.task(taskId);
      check(task.calls < this.config.maxCalls, 'task invocation limit reached');
      this.store.update(taskId, { status: 'running', calls: task.calls + 1, agent_wakes: task.agent_wakes + 1 });
      this.store.touchAgent(taskId);
      const cwd = await this.workspaces.ensure(task);
      if (run.controller.signal.aborted) throw new Error('cancelled');
      task = this.store.task(taskId);
      this.store.event(taskId, 'invocation.started', { call: task.calls, cwd, message_ids: messages.map(message => message.id) });
      timer = setTimeout(() => run.controller.abort(), this.config.timeout * 1000);
      const result = await this.provider.run({ task, cwd, token: run.token, signal: run.controller.signal,
        onSpawn: pid => { run.pid = pid; }, messages, api: this,
        context: {
          children: this.store.summaries().filter(child => child.parent_id === taskId),
          open_notices: this.store.all("SELECT * FROM notices WHERE task_id=? AND status='open'", taskId),
          // scheduler 拿到整批 spec 全文，并把每条 dep hint 解析成真实 task id，方便直接建依赖。
          ...(task.role === 'scheduler' ? { specs: this.store.specsForBatch(taskId).map(spec => ({
            id: spec.id, seq: spec.seq, goal: spec.goal, role: spec.role, name: spec.name, status: spec.status,
            input_id: spec.input_id, planner_task_id: spec.planner_task_id,
            deps: spec.deps.map(hint => {
              const target = this.store.get('SELECT id, task_id FROM task_specs WHERE id=?', hint.spec);
              return { spec: hint.spec, task_id: target ? target.task_id : null, kind: hint.kind };
            }),
          })) } : {}),
          ...(task.role === 'planner' ? { queued_specs: this.store.specs({ planner_task_id: taskId, status: 'pending', limit: 50 }) } : {}),
          recent_tasks: this.decorate(this.store.all('SELECT id,parent_id,role,status,substr(goal,1,500) AS goal,integration FROM tasks ORDER BY id DESC LIMIT 100')),
          verification: task.role === 'verifier' ? this.verificationContext(task) : undefined,
          merge_conflict: task.resolves_task_id ? this.mergeConflictContext(task) : undefined,
        },
      });
      clearTimeout(timer);
      if (TERMINAL.has(this.store.task(taskId).status)) return;
      if (run.controller.signal.aborted) throw new Error('agent invocation timed out');
      check(typeof result === 'string' && Buffer.byteLength(result) <= 256000, 'agent result exceeds 256000 bytes');
      this.store.transaction(() => {
        for (const message of messages) this.store.run('UPDATE messages SET consumed=1 WHERE id=?', message.id);
        this.store.event(taskId, 'invocation.completed', { result });
        this.store.update(taskId, { result });
      });
      // Messages that arrived during this invocation are deliberately delivered next time.
      if (this.store.unread(taskId).length) { this.store.update(taskId, { status: 'queued' }); return; }
      if (this.store.get("SELECT id FROM notices WHERE task_id=? AND status='open'", taskId)) {
        this.store.update(taskId, { status: 'awaiting' }); return;
      }
      if (this.store.children(taskId).some(child => !TERMINAL.has(child.status))) {
        this.store.update(taskId, { status: 'waiting' }); return;
      }
      await this.workspaces.finish(this.store.task(taskId));
      // git is asynchronous: input, cancellation or delegation may have arrived meanwhile.
      if (TERMINAL.has(this.store.task(taskId).status)) return;
      if (this.store.unread(taskId).length) { this.store.update(taskId, { status: 'queued' }); return; }
      if (this.store.get("SELECT id FROM notices WHERE task_id=? AND status='open'", taskId)) {
        this.store.update(taskId, { status: 'awaiting' }); return;
      }
      if (this.store.children(taskId).some(child => !TERMINAL.has(child.status))) {
        this.store.update(taskId, { status: 'waiting' }); return;
      }
      this.finish(taskId, 'completed', result);
    } catch (error) {
      if (!TERMINAL.has(this.store.task(taskId).status)) this.cancel(taskId, error.message, 'failed');
    } finally {
      clearTimeout(timer);
      // 对照基线是派生的只读检出：invocation 一结束就回收，不把每次检验都堆在磁盘上。
      // 失败也不保留——结论/错误已入库，重建一次基线很便宜。
      if (this.store.task(taskId).verifies_task_id) {
        await this.workspaces.removeBaseline(taskId).catch(error => console.error(`verification ${taskId}: ${error.message}`));
      }
    }
  }
  async shutdown() {
    this.stopping = true;
    for (const taskId of this.running.keys()) this.cancel(taskId, 'daemon stopped; inspect before retrying', 'failed');
    await Promise.allSettled([...this.running.values()].map(run => run.promise));
    await this.workspaces.queue;
  }
}
