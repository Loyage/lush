import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { check, id, text, TERMINAL, bounded, isPlainObject, LushError } from './types.js';
import { Workspaces } from './workspaces.js';
import { taskSlug } from './naming.js';
import { readTranscript } from './transcript.js';
import { PiProvider, MockProvider } from '../agent/provider.js';

const DEP_KINDS = new Set(['code', 'order']);
/** 两类用户输入：develop 会派生 worker 产码，explain 只出结论、不产生待合并改动。 */
export const FLOWS = new Set(['develop', 'explain']);
/** Buffered drafts are a cache, not a queue: bounded so a forgotten tab cannot grow the db forever. */
const MAX_DRAFTS = 500;
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
      drafts: this.store.draftCount(),
      agents: [...this.running].map(([task_id, run]) => agentView(this.store.task(task_id), run)),
      agents_total: alive, agents_idle: alive - this.running.size,
      pending_merges: this.store.all("SELECT id, substr(goal,1,500) AS goal, branch FROM tasks WHERE integration IN ('pending','review') ORDER BY id LIMIT 100"),
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
  /** Hands every buffered draft to one planner as a single batch. All-or-nothing. */
  commitDrafts() {
    const drafts = this.store.openDrafts();
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
  /** name is the planner's short slug for the work; it becomes the branch/worktree name and stays fixed for the task's life. */
  spawn(parentId, goal, role = 'worker', deps = [], name = null) {
    const parent = this.store.task(parentId);
    check(!TERMINAL.has(parent.status), 'cannot delegate from a terminal task');
    text(goal, 'goal'); check(['worker','coordinator','research'].includes(role), 'role must be worker, coordinator or research');
    // 硬约束：了解类输入只能派生只读的 research，不能产生 worker/coordinator（因此不会创建 worktree 或待合并改动）。
    // 所有后代都复制 parent.input_id，所以查一次 parent 即可覆盖整棵子树。
    const input = parent.input_id === null ? null : this.store.get('SELECT id, flow FROM inputs WHERE id=?', parent.input_id);
    check(!input || input.flow !== 'explain' || role === 'research',
      `input #${input?.id} is classified as explain (了解); delegate research or answer directly, not ${role}`);
    const edges = normalizeDeps(deps);
    let depth = 1, ancestor = parent;
    while (ancestor.parent_id) { ancestor = this.store.task(ancestor.parent_id); depth++; }
    check(depth < this.config.maxDepth, 'task nesting limit reached');
    check(this.store.get("SELECT count(*) AS n FROM tasks WHERE status NOT IN ('completed','failed','cancelled')").n < 1000, 'too many active tasks');
    const slug = taskSlug(name, goal);
    const task = this.store.transaction(() => {
      const created = this.store.create({ parent_id: parent.id, input_id: parent.input_id, role, goal, name: slug });
      this.assertDeps(created.id, parent, edges);
      for (const edge of edges) { this.store.addDep(created.id, edge.id, edge.kind); this.store.event(created.id, 'dep.added', edge); }
      return created;
    });
    this.kick(); return task;
  }
  inspect(taskId) {
    const task = this.store.task(taskId);
    return { ...task, deps: this.store.depsDetail(task.id), dependents: this.store.dependentsDetail(task.id),
      children: bounded(this.store.summaries().filter(child => child.parent_id === task.id), 100000),
      messages: bounded(this.store.all('SELECT * FROM messages WHERE task_id=? ORDER BY id DESC LIMIT 100', task.id), 200000),
      notices: bounded(this.store.all('SELECT * FROM notices WHERE task_id=? ORDER BY id DESC LIMIT 100', task.id), 200000),
      // worker 带着自己的检验记录；verifier 带着自己的报告路径。两边都是只读投影。
      verifications: task.role === 'worker' ? bounded(this.store.verifications(task.id).map(row => ({ ...row, has_report: this.hasReport(row.id) })), 200000) : undefined,
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
  /** Read-only agent process log from pi's session files; never touches the database. */
  transcript(taskId, after = 0, limit = 100) {
    this.store.task(taskId);
    return readTranscript(this.config, taskId, after, limit);
  }
  tree(taskId = null) {
    const tasks = this.decorate(this.store.summaries());
    const rows = new Map(tasks.map(task => [task.id, { ...task, children: [] }]));
    const roots = [];
    for (const row of rows.values()) {
      // verifier 不是子任务（终态任务不能有活动后代），但界面上挂在它检验的那个任务下面。
      const parent = row.parent_id ?? row.verifies_task_id;
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
      FROM tasks WHERE integration IN ('pending','review') ORDER BY id LIMIT 50`);
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
    this.wake(notice.task_id);
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
      if (task.parent_id && !TERMINAL.has(this.store.task(task.parent_id).status)) {
        this.store.message(task.parent_id, JSON.stringify({ child: task.id, status, result, error }), task.id);
      }
      // 检验结算后让被检验任务的详情重新渲染，看得到最新结论。
      if (task.verifies_task_id) this.store.touch(task.verifies_task_id);
    });
    if (task.parent_id) this.wake(task.parent_id);
    // A settled dependency releases every queued dependent; still-blocked ones stay queued.
    for (const edge of this.store.dependents(task.id)) this.wake(edge.task_id);
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
        messages: counts.messages, events: counts.events, task_deps: counts.task_deps },
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
    // Reserve one separate planning slot: a saturated worker pool cannot block input parsing.
    let planners = 0, workers = 0;
    for (const run of this.running.values()) { if (run.role === 'planner') planners++; else workers++; }
    const dependencies = this.store.depMap();
    for (const task of this.store.all("SELECT * FROM tasks WHERE status='queued' ORDER BY id")) {
      if (this.running.has(task.id)) continue;
      // A queued task whose dependencies are not settled stays queued; finish() re-kicks when they are.
      if ((dependencies.get(task.id) || []).some(edge => !TERMINAL.has(edge.status))) continue;
      if (task.role === 'planner' ? planners >= 1 : workers >= this.config.concurrency) continue;
      if (task.role === 'planner') planners++; else workers++;
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
          recent_tasks: this.decorate(this.store.all('SELECT id,parent_id,role,status,substr(goal,1,500) AS goal,integration FROM tasks ORDER BY id DESC LIMIT 100')),
          verification: task.role === 'verifier' ? this.verificationContext(task) : undefined,
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
