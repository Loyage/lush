import { randomBytes } from 'node:crypto';
import { check, TERMINAL, LushError } from '../types.js';
import { tokenHash } from './internal.js';

/** 调度、invocation 生命周期、凭证。 */
export default {
  questionPending(taskId) {
    return Boolean(this.store.get("SELECT id FROM notices WHERE task_id=? AND kind='questionnaire' AND status='open'", taskId));
  },

  // Called inside the notice transaction. Only messages delivered to this invocation are consumed.
  parkForQuestion(taskId, noticeId) {
    const run = this.running.get(taskId);
    const result = `等待用户回答待决问题 #${noticeId}。`;
    if (run) {
      run.parked = true;
      for (const message of run.messages || []) this.store.run('UPDATE messages SET consumed=1 WHERE id=?', message.id);
      this.store.event(taskId, 'invocation.completed', { result, suspended: true, notice_id: noticeId });
    }
    this.store.update(taskId, { status: 'awaiting', result });
  },

  wake(taskId) {
    const task = this.store.task(taskId);
    if (!TERMINAL.has(task.status) && !this.running.has(task.id)) {
      this.store.update(task.id, { status: this.questionPending(task.id) ? 'awaiting' : 'queued' });
    }
    this.kick();
  },

  kick() {
    if (this.stopping || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (!this.stopping) this.pump();
    });
  },

  pump() {
    // Finished planner output is compiled by code, not by a scheduler model invocation.
    this.compilePlans();
    const dependencies = this.store.depMap();
    let controlRunning = [...this.running.values()].filter(run => ['planner','scheduler'].includes(run.role)).length;
    let executionRunning = this.running.size - controlRunning;
    for (const task of this.store.all("SELECT * FROM tasks WHERE status='queued' ORDER BY id")) {
      if (this.running.has(task.id)) continue;
      if (this.questionPending(task.id)) { this.store.update(task.id, { status: 'awaiting' }); continue; }
      // A queued task whose dependencies are not settled stays queued; finish() re-kicks when they are.
      if ((dependencies.get(task.id) || []).some(edge => !TERMINAL.has(edge.status))) continue;
      const control = ['planner','scheduler'].includes(task.role);
      if (control ? controlRunning >= this.config.controlConcurrency : executionRunning >= this.config.concurrency) continue;
      const run = { role: task.role, controller: new AbortController(), token: randomBytes(32).toString('hex'), pid: null, promise: null, recordId: null };
      if (control) controlRunning += 1; else executionRunning += 1;
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
  },

  /** Resolve an agent credential to its task. Only the invocation that was issued the token is an actor. */
  actor(token) {
    if (token === undefined || token === null || token === '') return null;
    check(typeof token === 'string', 'invalid agent token');
    const task = this.store.agentByToken(tokenHash(token));
    const run = task ? this.running.get(task.id) : null;
    if (!run) throw new LushError('invalid or expired agent token');
    check(task.role !== 'explainer', 'explanation agents have no RPC capability');
    check(!TERMINAL.has(task.status) && !run.parked && !run.controller.signal.aborted, 'agent task is no longer active');
    this.store.touchAgent(task.id);
    return task.id;
  },

  async invoke(taskId, run) {
    let timer, timedOut = false;
    const timeoutMessage = `agent invocation timed out after ${this.config.timeout} second${this.config.timeout === 1 ? '' : 's'}`;
    const abortMessage = () => run.controller.signal.reason instanceof Error
      ? run.controller.signal.reason.message
      : typeof run.controller.signal.reason === 'string' && run.controller.signal.reason
        ? run.controller.signal.reason : 'agent invocation interrupted';
    const messages = this.store.unread(taskId);
    try {
      let task = this.store.task(taskId);
      check(task.calls < this.config.maxCalls, 'task invocation limit reached');
      const agent = this.provider.resolve?.(task) || { agent: this.config.provider, model: '', thinking: '', default_prompt: '', append_prompt: '' };
      run.agent = agent;
      const record = this.store.startRun(task, agent);
      run.recordId = record.id;
      this.store.update(taskId, { status: 'running', calls: task.calls + 1, agent_wakes: task.agent_wakes + 1 });
      // 新一轮拆解：上一轮被驳回的闸门清零，这一轮要不要再请你批准由 planner 自己判断。
      if (task.role === 'planner' && task.plan_gate === 'rejected') this.store.update(taskId, { plan_gate: null });
      this.store.touchAgent(taskId);
      const cwd = await this.workspaces.ensure(task);
      if (run.controller.signal.aborted) throw new Error('cancelled');
      task = this.store.task(taskId);
      if (task.role === 'showcase') this.prepareShowcaseReport(task, run.recordId);
      this.store.event(taskId, 'invocation.started', { call: task.calls, cwd, message_ids: messages.map(message => message.id),
        agent: agent.agent, model: agent.model || null, thinking: agent.thinking || null });
      timer = setTimeout(() => {
        timedOut = true;
        run.controller.abort(new Error(timeoutMessage));
      }, this.config.timeout * 1000);
      run.messages = messages;
      // 引用快照固定在 Input 上；每次 planner 唤醒都重新解析当前状态。
      const referencedContext = task.role === 'planner' && task.input_id !== null
        ? await this.resolveInputReferences(task.input_id) : undefined;
      const result = await this.provider.run({ task: this.progressView(task), cwd, token: run.token, signal: run.controller.signal, agent,
        onSpawn: pid => { run.pid = pid; }, messages, api: this,
        context: {
          children: this.store.summaries().filter(child => child.parent_id === taskId),
          open_notices: this.store.all("SELECT * FROM notices WHERE task_id=? AND status='open'", taskId),
          ...(task.role === 'planner' ? { queued_specs: this.store.specs({ planner_task_id: taskId, status: 'pending', limit: 50 }),
            referenced_context: referencedContext } : {}),
          recent_tasks: this.decorate(this.store.all('SELECT id,parent_id,role,status,substr(goal,1,500) AS goal,integration FROM tasks ORDER BY id DESC LIMIT 100')),
          verification: task.role === 'verifier' ? this.verificationContext(task) : undefined,
          showcase: task.role === 'showcase' ? this.showcaseContext(task) : undefined,
          explanation: task.role === 'explainer' ? this.explanationContext(taskId) : undefined,
          merge_conflict: task.resolves_task_id ? this.mergeConflictContext(task) : undefined,
          branch_sync: task.role === 'merger' && !task.resolves_task_id
            ? (() => { const row = this.store.get("SELECT data FROM events WHERE task_id=? AND type='branch.sync.requested' ORDER BY id DESC LIMIT 1", task.id); return row ? JSON.parse(row.data) : undefined; })()
            : undefined,
        },
      });
      clearTimeout(timer);
      if (TERMINAL.has(this.store.task(taskId).status) || run.parked) return;
      if (run.controller.signal.aborted) throw new Error(timedOut ? timeoutMessage : abortMessage());
      check(typeof result === 'string' && Buffer.byteLength(result) <= 256000, 'agent result exceeds 256000 bytes');
      this.store.transaction(() => {
        for (const message of messages) this.store.run('UPDATE messages SET consumed=1 WHERE id=?', message.id);
        this.store.event(taskId, 'invocation.completed', { result, run_id: run.recordId });
        this.store.update(taskId, { result });
        this.store.finishRun(run.recordId, 'completed', { result });
        const verification = task.role === 'verifier' ? this.verificationEvidence(task) : {
          status: 'unverified', tested_commit: null, baseline_commit: null, commands: [],
          summary: 'This invocation did not perform verification.', report: { task_id: task.id,
            path: this.reportPath(task.id), available: false }, failures: [],
          unverified: ['The task role was not verifier.'], baseline_failures: [], residual_risks: [],
        };
        this.store.addArtifact({ task_id: taskId, run_id: run.recordId, input_id: task.input_id, kind: 'run.result',
          payload: { schema_version: 2, invocation: { status: 'completed' }, outcome: 'success', summary: result,
            changes: [], evidence: [], decisions: [], risks: [], artifacts: [], followups: [], verification },
          metadata: { role: task.role, call: task.calls, agent: agent.agent, model: agent.model || null, thinking: agent.thinking || null } });
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
      if (task.role === 'showcase') {
        const payload = this.showcaseReport(this.store.task(taskId));
        this.store.addArtifact({ task_id: taskId, run_id: run.recordId, input_id: task.input_id,
          kind: 'showcase.result', payload, metadata: { role: 'showcase' } });
      }
      this.finish(taskId, 'completed', result);
    } catch (error) {
      // Provider adapters may only know that their AbortSignal fired. The scheduler owns the deadline,
      // so normalize that generic interruption into an exact timeout and keep user cancellation distinct.
      const message = timedOut ? timeoutMessage : run.controller.signal.aborted ? abortMessage() : error.message;
      if (run.recordId && this.store.get('SELECT status FROM agent_runs WHERE id=?', run.recordId)?.status === 'running') {
        this.store.finishRun(run.recordId, timedOut ? 'failed' : run.controller.signal.aborted ? 'cancelled' : 'failed', { error: message });
      }
      if (!run.parked && !TERMINAL.has(this.store.task(taskId).status)) this.cancel(taskId, message, 'failed');
    } finally {
      clearTimeout(timer);
      if (run.recordId && this.store.get('SELECT status FROM agent_runs WHERE id=?', run.recordId)?.status === 'running') {
        const task = this.store.task(taskId);
        this.store.finishRun(run.recordId, task.status === 'cancelled' ? 'cancelled' : task.status === 'failed' ? 'failed' : 'completed',
          { result: task.result, error: task.error });
      }
      // 对照基线是派生的只读检出：invocation 一结束就回收，不把每次检验都堆在磁盘上。
      // 失败也不保留——结论/错误已入库，重建一次基线很便宜。
      if (this.store.task(taskId).verifies_task_id) {
        await this.workspaces.removeBaseline(taskId).catch(error => console.error(`verification ${taskId}: ${error.message}`));
      }
    }
  }
};
