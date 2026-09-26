import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { check, TERMINAL, LushError } from '../types.js';
import { tokenHash } from './internal.js';
import { AgentPreempted } from '../../agent/provider.js';

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

  hasActionableMessages(taskId) {
    if (!this.store.get('SELECT id FROM messages WHERE task_id=? AND consumed=0 LIMIT 1', taskId)) return false;
    const task = this.store.get('SELECT role FROM tasks WHERE id=?', taskId);
    if (task.role !== 'coordinator' || !this.store.get(`SELECT id FROM tasks WHERE parent_id=?
      AND status NOT IN ('completed','failed','cancelled') LIMIT 1`, taskId)) return true;
    // Only runtime-attested success receipts wait; explicit messages remain urgent.
    return Boolean(this.store.get(`SELECT m.id FROM messages m WHERE m.task_id=? AND m.consumed=0
      AND NOT EXISTS (SELECT 1 FROM events e WHERE e.task_id=m.task_id AND e.type='child.completed'
        AND json_extract(e.data,'$.message_id')=m.id) LIMIT 1`, taskId));
  },

  wake(taskId) {
    const task = this.store.task(taskId);
    if (['main','owner','merge'].includes(task.task_kind)) return; // runtime-driven roots and merge orchestration never run providers
    if (task.task_kind === 'say' && task.reservation && JSON.parse(task.reservation).status === 'started') return;
    if (!TERMINAL.has(task.status) && !this.running.has(task.id)) {
      const deferred = task.role === 'coordinator' && this.store.get('SELECT id FROM messages WHERE task_id=? AND consumed=0 LIMIT 1', task.id)
        && !this.hasActionableMessages(task.id);
      this.store.update(task.id, { status: this.questionPending(task.id) ? 'awaiting' : deferred ? 'waiting' : 'queued' });
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
    const sleep = this.sleepStatus();
    if (this.stopping || sleep.paused) return;
    if (sleep.enabled && !this.sleepAdmitted) { void this.sleepTick(); return; }
    // Finished planner output is compiled by code, not by a scheduler model invocation.
    this.compilePlans();
    const dependencies = this.store.depMap();
    let controlRunning = [...this.running.values()].filter(run => ['planner','scheduler'].includes(run.role)).length;
    let butlerRunning = [...this.running.values()].filter(run => run.role === 'butler').length;
    let executionRunning = this.running.size - controlRunning - butlerRunning;
    for (const task of this.store.all("SELECT * FROM tasks WHERE status='queued' ORDER BY id")) {
      if (['main','owner','merge'].includes(task.task_kind)) continue; // Bound parent roots and merge orchestration do not run unrestricted providers.
      if (task.task_kind === 'say' && task.reservation && JSON.parse(task.reservation).status === 'started') continue;
      if (this.running.has(task.id)) continue;
      if (this.questionPending(task.id)) { this.store.update(task.id, { status: 'awaiting' }); continue; }
      // A queued task whose dependencies are not settled stays queued; finish() re-kicks when they are.
      if ((dependencies.get(task.id) || []).some(edge => !TERMINAL.has(edge.status))) continue;
      const control = ['planner','scheduler'].includes(task.role);
      const butler = task.role === 'butler';
      if (butler && !sleep.enabled) continue;
      if (butler ? butlerRunning >= 1 : control ? controlRunning >= this.config.controlConcurrency : executionRunning >= this.config.concurrency) continue;
      const run = { role: task.role, controller: new AbortController(), token: randomBytes(32).toString('hex'), pid: null, promise: null, recordId: null };
      if (butler) butlerRunning += 1; else if (control) controlRunning += 1; else executionRunning += 1;
      this.running.set(task.id, run);
      this.store.armAgent(task.id, tokenHash(run.token));
      run.promise = this.invoke(task.id, run).catch(error => {
        console.error(`task ${task.id}: ${error.stack || error}`);
      }).finally(async () => {
        this.running.delete(task.id);
        // The credential is valid only while this invocation owns the task.
        this.store.armAgent(task.id, null);
        // A child can settle after its parent parked but before this cleanup.
        // Recheck the inbox after releasing ownership to avoid a lost wake-up.
        if (!TERMINAL.has(this.store.task(task.id).status) && this.hasActionableMessages(task.id)) this.wake(task.id);
        if (!this.stopping) {
          const settled = this.store.task(task.id);
          let reservation = null;
          try { reservation = settled.task_kind === 'say' && settled.reservation ? JSON.parse(settled.reservation) : null; }
          catch { /* invalid state stays visible for inspection */ }
          if (settled.status === 'waiting' && reservation?.kind === 'merge') {
            await this.settleReservedMerge(task.id).catch(error => this.noteReservationBlocked(task.id, error.message));
          }
          if (settled.status === 'waiting' && reservation?.kind === 'showcase' && reservation.status === 'preparing') {
            await this.signalReservedShowcase(task.id).catch(error => this.noteReservationBlocked(task.id, error.message));
          }
          if (settled.status === 'waiting' && reservation?.kind === 'showcase' && reservation.status === 'pending') {
            await this.startReservedShowcase(task.id).catch(error => this.noteReservationBlocked(task.id, error.message));
          }
          // 展示准备阶段完成：若原 say 已真正完成且满足准入，立刻补发信号让它进入交付。
          if (settled.role === 'showcase' && settled.status === 'waiting' && settled.parent_id) {
            let phase = null;
            try { phase = settled.showcase ? JSON.parse(settled.showcase).phase : null; } catch { /* leave visible */ }
            if (phase === 'preparing') {
              await this.signalReservedShowcase(settled.parent_id)
                .catch(error => this.noteReservationBlocked(settled.parent_id, error.message));
            }
          }
        }
        this.kick();
      });
    }
  },

  /**
   * 安全抢占请求：用户给运行中的 Task 追加输入时，请 Agent 在**下一个安全边界**收尾，而不是杀进程。
   * 只有 pi 后端有可验证的边界（扩展在 `turn_end` 落 stop 标记，见 `agent/pi-runtime.js`）；
   * 其它后端保持“轮末投递”，不假装能抢占。真正的记账发生在 invoke 的 catch 里。
   */
  requestPreempt(taskId, reason = 'new user input') {
    const task = this.store.task(taskId);
    const run = this.running.get(task.id);
    if (!run || TERMINAL.has(task.status)) return false;
    if (run.agent?.agent !== 'pi') return false;
    const dir = path.join(this.config.home, 'preempt');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, `task-${task.id}.request.json`), JSON.stringify({ task_id: task.id,
      run_id: run.recordId ?? null, reason, requested_at: new Date().toISOString() }) + '\n', { mode: 0o600 });
    this.store.event(task.id, 'preempt.requested', { run_id: run.recordId ?? null, reason });
    return true;
  },

  /** Resolve an agent credential to its task. Only the invocation that was issued the token is an actor. */
  actor(token) {
    if (token === undefined || token === null || token === '') return null;
    check(typeof token === 'string', 'invalid agent token');
    const task = this.store.agentByToken(tokenHash(token));
    const run = task ? this.running.get(task.id) : null;
    if (!run) throw new LushError('invalid or expired agent token');
    check(!['explainer','butler'].includes(task.role), 'isolated agents have no RPC capability');
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
      // An explicit retry may freeze a complete task-local profile. It wins over dynamic
      // project defaults for every invocation in this attempt and is cleared at settlement.
      const retryProfile = task.retry_profile ? this.agentSettings.retryProfile(task.role, JSON.parse(task.retry_profile)) : null;
      const agent = retryProfile || this.provider.resolve?.(task) || { agent: this.config.provider, model: '', thinking: '', default_prompt: '', append_prompt: '' };
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
      const context = await this.invocationContext(task, run);
      if (run.controller.signal.aborted) throw new Error(abortMessage());
      // retry_profile contains system instructions and local resource paths. It is runtime
      // configuration, not task data, so do not copy it into the provider's untrusted input JSON.
      const { retry_profile: _retryProfile, ...providerTask } = this.progressView(task);
      const result = await this.provider.run({ task: providerTask, cwd, token: run.token, signal: run.controller.signal, agent,
        onSpawn: pid => { run.pid = pid; }, messages, api: this,
        context,
      });
      clearTimeout(timer);
      if (TERMINAL.has(this.store.task(taskId).status) || run.parked) return;
      if (run.controller.signal.aborted) throw new Error(timedOut ? timeoutMessage : abortMessage());
      check(typeof result === 'string' && Buffer.byteLength(result) <= 256000, 'agent result exceeds 256000 bytes');
      // G-02: re-check the pinned tree after the invocation. Drift or dirt means the evidence no longer
      // describes the frozen commit, so the invocation fails instead of being recorded as a pass.
      if (task.role === 'verifier' && task.review_candidate_id) {
        await this.assertCandidateVerification(this.store.candidate(task.review_candidate_id), task);
      }
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
      if (task.role === 'butler') await this.completeButler(taskId, result);
      if (TERMINAL.has(this.store.task(taskId).status)) return;
      // Deliver actionable arrivals next time; ordinary coordinator receipts wait for the wave.
      if (this.hasActionableMessages(taskId)) { this.store.update(taskId, { status: 'queued' }); return; }
      if (this.store.get("SELECT id FROM notices WHERE task_id=? AND status='open'", taskId)) {
        this.store.update(taskId, { status: 'awaiting' }); return;
      }
      if (this.store.children(taskId).some(child => !TERMINAL.has(child.status))) {
        this.store.update(taskId, { status: 'waiting' }); return;
      }
      await this.workspaces.finish(this.store.task(taskId));
      // git is asynchronous: input, cancellation or delegation may have arrived meanwhile.
      if (TERMINAL.has(this.store.task(taskId).status)) return;
      if (this.hasActionableMessages(taskId)) { this.store.update(taskId, { status: 'queued' }); return; }
      if (this.store.get("SELECT id FROM notices WHERE task_id=? AND status='open'", taskId)) {
        this.store.update(taskId, { status: 'awaiting' }); return;
      }
      if (this.store.children(taskId).some(child => !TERMINAL.has(child.status))) {
        this.store.update(taskId, { status: 'waiting' }); return;
      }
      if (task.task_kind === 'say') {
        // A say Task keeps ownership of its branch between invocations. Only an explicit
        // later reservation/termination may close it; a normal provider return is not completion.
        // 这条分支自己前进了（本轮新提交）：挂在它上面的未集成请求要如实变成失效状态，
        // 而不是继续显示“等待集成”。daemon 阻止不了这次提交，所以只如实记录检查结果。
        await this.noteBranchAdvance(taskId);
        this.store.transaction(() => {
          this.store.update(taskId, { status: 'waiting' });
          this.store.event(taskId, 'task.idle', { run_id: run.recordId, head_commit: this.store.task(taskId).head_commit });
        });
        return;
      }
      if (task.role === 'showcase') {
        const snapshot = JSON.parse(this.store.task(taskId).showcase);
        if (snapshot.phase === 'preparing') {
          // 第一阶段只做准备：不要求 report，也不结算展示 Task；保留现场等原 say 的工作完成信号。
          this.store.transaction(() => {
            this.store.update(taskId, { status: 'waiting' });
            this.store.event(taskId, 'showcase.preparation_done', { run_id: run.recordId });
          });
          return;
        }
        const payload = this.showcaseReport(this.store.task(taskId));
        this.store.addArtifact({ task_id: taskId, run_id: run.recordId, input_id: task.input_id,
          kind: 'showcase.result', payload, metadata: { role: 'showcase' } });
      }
      this.finish(taskId, 'completed', result);
    } catch (error) {
      // 安全抢占：Agent 在本轮工具都结束后自行收尾，不是失败、不是超时也不是取消。
      // 工作区按现状保留，这条输入下一轮就会被读到；不重建、不重放本轮已发生的副作用。
      if (error instanceof AgentPreempted) {
        if (run.recordId && this.store.get('SELECT status FROM agent_runs WHERE id=?', run.recordId)?.status === 'running') {
          this.store.finishRun(run.recordId, 'preempted', { error: error.details?.reason ?? 'preempted by new input' });
        }
        if (!run.parked && !TERMINAL.has(this.store.task(taskId).status)) {
          this.store.transaction(() => {
            this.store.event(taskId, 'invocation.preempted', { run_id: run.recordId, ...error.details });
            this.store.update(taskId, { status: this.hasActionableMessages(taskId) ? 'queued' : 'waiting' });
          });
          this.kick();
        }
        return;
      }
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
      // 对照基线 / 只读分析检出都是派生的只读检出：invocation 一结束就回收，不把每次调用都堆在磁盘上。
      // 失败也不保留——结论/错误已入库，重建一次很便宜；下次调用会在那时的分支顶端重建。
      const settled = this.store.task(taskId);
      if (settled.verifies_task_id || settled.task_kind === 'analysis') {
        await this.workspaces.removeBaseline(taskId).catch(error => console.error(`derived checkout ${taskId}: ${error.message}`));
      }
    }
  }
};
