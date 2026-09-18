import { createHash, randomBytes } from 'node:crypto';
import { check, id, text, TERMINAL, bounded, isPlainObject, LushError } from './types.js';
import { Workspaces } from './workspaces.js';
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

/** One project, a persistent task tree, and a bounded pool of disposable agents. */
export class Project {
  constructor(config, store, provider = null) {
    this.config = config; this.store = store;
    this.provider = provider || (config.provider === 'mock' ? new MockProvider() : new PiProvider(config));
    this.workspaces = new Workspaces(config, store);
    this.running = new Map(); this.stopping = false; this.scheduled = false;
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
  spawn(parentId, goal, role = 'worker', deps = []) {
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
    const task = this.store.transaction(() => {
      const created = this.store.create({ parent_id: parent.id, input_id: parent.input_id, role, goal });
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
      agent: agentView(task, this.running.get(task.id) ?? null) };
  }
  diff(taskId) { return this.workspaces.diff(this.store.task(taskId)); }
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
      if (row.parent_id) rows.get(row.parent_id).children.push(row); else roots.push(row);
    }
    if (taskId !== null) { this.store.task(taskId); return rows.get(id(taskId)); }
    return roots;
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
    } finally { clearTimeout(timer); }
  }
  async shutdown() {
    this.stopping = true;
    for (const taskId of this.running.keys()) this.cancel(taskId, 'daemon stopped; inspect before retrying', 'failed');
    await Promise.allSettled([...this.running.values()].map(run => run.promise));
    await this.workspaces.queue;
  }
}
