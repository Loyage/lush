import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { check, TERMINAL, LushError } from '../types.js';
import { tokenHash } from './internal.js';
import { AgentPreempted } from '../../agent/provider.js';

/** 调度、invocation 生命周期、凭证。 */
export default {
  questionPending(apId) {
    return Boolean(this.store.get("SELECT id FROM notices WHERE ap_id=? AND kind='questionnaire' AND status='open'", apId));
  },

  // Called inside the notice transaction. Only messages delivered to this invocation are consumed.
  parkForQuestion(apId, noticeId) {
    const run = this.running.get(apId);
    const result = `等待用户回答待决问题 #${noticeId}。`;
    if (run) {
      run.parked = true;
      for (const message of run.messages || []) this.store.run('UPDATE messages SET consumed=1 WHERE id=?', message.id);
      this.store.event(apId, 'invocation.completed', { result, suspended: true, notice_id: noticeId });
    }
    this.store.update(apId, { status: 'awaiting', result });
  },

  hasActionableMessages(apId) {
    if (!this.store.get('SELECT id FROM messages WHERE ap_id=? AND consumed=0 LIMIT 1', apId)) return false;
    const ap = this.store.get('SELECT role FROM aps WHERE id=?', apId);
    if (ap.role !== 'coordinator' || !this.store.get(`SELECT id FROM aps WHERE parent_id=?
      AND status NOT IN ('completed','failed','cancelled') LIMIT 1`, apId)) return true;
    // Only runtime-attested success receipts wait; explicit messages remain urgent.
    return Boolean(this.store.get(`SELECT m.id FROM messages m WHERE m.ap_id=? AND m.consumed=0
      AND NOT EXISTS (SELECT 1 FROM events e WHERE e.ap_id=m.ap_id AND e.type='child.completed'
        AND json_extract(e.data,'$.message_id')=m.id) LIMIT 1`, apId));
  },

  wake(apId) {
    const ap = this.store.ap(apId);
    if (['main','owner','merge'].includes(ap.ap_kind)) return; // runtime-driven roots and merge orchestration never run providers
    if (ap.ap_kind === 'say' && ap.reservation && JSON.parse(ap.reservation).status === 'started') return;
    if (!TERMINAL.has(ap.status) && !this.running.has(ap.id)) {
      const deferred = ap.role === 'coordinator' && this.store.get('SELECT id FROM messages WHERE ap_id=? AND consumed=0 LIMIT 1', ap.id)
        && !this.hasActionableMessages(ap.id);
      this.store.update(ap.id, { status: this.questionPending(ap.id) ? 'awaiting' : deferred ? 'waiting' : 'queued' });
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
    if (this.stopping) return;
    // Legacy planner/spec rows are retained on disk but no longer scheduled.
    const dependencies = this.store.depMap();
    const freezes = new Map(this.branchFreeze().map(info => [info.branch, info]));
    const apBranch = ap => {
      if (ap.branch || ap.target_branch) return ap.branch ?? ap.target_branch;
      const seen = new Set([ap.id]);
      for (let parentId = ap.parent_id; parentId && !seen.has(parentId);) {
        seen.add(parentId);
        const parent = this.store.ap(parentId);
        if (parent.branch || parent.target_branch) return parent.branch ?? parent.target_branch;
        parentId = parent.parent_id;
      }
      return null;
    };
    let controlRunning = [...this.running.values()].filter(run => ['planner','scheduler'].includes(run.role)).length;
    let butlerRunning = [...this.running.values()].filter(run => run.role === 'butler').length;
    let executionRunning = this.running.size - controlRunning - butlerRunning;
    for (const ap of this.store.all("SELECT * FROM aps WHERE status='queued' ORDER BY id")) {
      if (!['say','child'].includes(ap.ap_kind)) continue; // Old aps stay untouched on disk.
      if (['main','owner','merge'].includes(ap.ap_kind)) continue; // Bound parent roots and merge orchestration do not run unrestricted providers.
      if (ap.ap_kind === 'say' && ap.reservation && JSON.parse(ap.reservation).status === 'started') continue;
      if (this.running.has(ap.id)) continue;
      const frozen = freezes.get(apBranch(ap));
      // 仅允许本次解分歧 AP 在隔离 worktree 内运行；所有其它 Agent 留在 queued，消息不丢。
      const resolution = frozen && this.store.get(`SELECT data FROM events WHERE ap_id=?
        AND type='ap.divergence_resolution_requested' ORDER BY id DESC LIMIT 1`, ap.id);
      if (frozen && !(resolution && (frozen.ap_id === ap.id || frozen.kind === 'merge_all'))
        && !(ap.role === 'merger' && (frozen.ap_id === ap.id || frozen.kind === 'merge_all'))) continue;
      if (resolution && this.running.has(JSON.parse(resolution.data).parent_ap_id)) continue;
      if (this.questionPending(ap.id)) { this.store.update(ap.id, { status: 'awaiting' }); continue; }
      // A queued AP whose dependencies are not settled stays queued; finish() re-kicks when they are.
      if ((dependencies.get(ap.id) || []).some(edge => !TERMINAL.has(edge.status))) continue;
      const control = ['planner','scheduler'].includes(ap.role);
      const butler = ap.role === 'butler';
      if (butler ? butlerRunning >= 1 : control ? controlRunning >= this.config.controlConcurrency : executionRunning >= this.config.concurrency) continue;
      const run = { role: ap.role, controller: new AbortController(), token: randomBytes(32).toString('hex'), pid: null, promise: null, recordId: null };
      if (butler) butlerRunning += 1; else if (control) controlRunning += 1; else executionRunning += 1;
      this.running.set(ap.id, run);
      this.store.armAgent(ap.id, tokenHash(run.token));
      run.promise = this.invoke(ap.id, run).catch(error => {
        console.error(`AP ${ap.id}: ${error.stack || error}`);
      }).finally(async () => {
        this.running.delete(ap.id);
        // 已冻结的编排此时才能按安全点重新核对两端 tip，并派隔离的解分歧 AP。
        for (const { target, run: mergeRun } of this.store.activeBranchMergeRuns()) {
          if (mergeRun.mode === 'orchestrate' && mergeRun.waiting_safe_ap_id === ap.id) this.scheduleMergeRun(target);
        }
        // The credential is valid only while this invocation owns the ap.
        this.store.armAgent(ap.id, null);
        // A child can settle after its parent parked but before this cleanup.
        // Recheck the inbox after releasing ownership to avoid a lost wake-up.
        if (!TERMINAL.has(this.store.ap(ap.id).status) && this.hasActionableMessages(ap.id)) this.wake(ap.id);
        if (!this.stopping) {
          const settled = this.store.ap(ap.id);
          let reservation = null;
          try { reservation = settled.ap_kind === 'say' && settled.reservation ? JSON.parse(settled.reservation) : null; }
          catch { /* invalid state stays visible for inspection */ }
          if (settled.status === 'waiting' && reservation?.kind === 'merge') {
            await this.settleReservedMerge(ap.id).catch(error => this.noteReservationBlocked(ap.id, error.message));
          }
          if (settled.status === 'waiting' && reservation?.kind === 'showcase' && reservation.status === 'preparing') {
            await this.signalReservedShowcase(ap.id).catch(error => this.noteReservationBlocked(ap.id, error.message));
          }
          if (settled.status === 'waiting' && reservation?.kind === 'showcase' && reservation.status === 'pending') {
            await this.startReservedShowcase(ap.id).catch(error => this.noteReservationBlocked(ap.id, error.message));
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
   * 安全抢占请求：用户给运行中的 AP 追加输入时，请 Agent 在**下一个安全边界**收尾，而不是杀进程。
   * 只有 pi 后端有可验证的边界（扩展在 `turn_end` 落 stop 标记，见 `agent/pi-runtime.js`）；
   * 其它后端保持“轮末投递”，不假装能抢占。真正的记账发生在 invoke 的 catch 里。
   */
  requestPreempt(apId, reason = 'new user input') {
    const ap = this.store.ap(apId);
    const run = this.running.get(ap.id);
    if (!run || TERMINAL.has(ap.status)) return false;
    if (run.agent?.agent !== 'pi') return false;
    const dir = path.join(this.config.home, 'preempt');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, `ap-${ap.id}.request.json`), JSON.stringify({ ap_id: ap.id,
      run_id: run.recordId ?? null, reason, requested_at: new Date().toISOString() }) + '\n', { mode: 0o600 });
    this.store.event(ap.id, 'preempt.requested', { run_id: run.recordId ?? null, reason });
    return true;
  },

  /** Resolve an agent credential to its ap. Only the invocation that was issued the token is an actor. */
  actor(token) {
    if (token === undefined || token === null || token === '') return null;
    check(typeof token === 'string', 'invalid agent token');
    const ap = this.store.agentByToken(tokenHash(token));
    const run = ap ? this.running.get(ap.id) : null;
    if (!run) throw new LushError('invalid or expired agent token');
    check(!['explainer','butler'].includes(ap.role), 'isolated agents have no RPC capability');
    check(!TERMINAL.has(ap.status) && !run.parked && !run.controller.signal.aborted, 'agent AP is no longer active');
    this.store.touchAgent(ap.id);
    return ap.id;
  },

  async invoke(apId, run) {
    let timer, timedOut = false;
    const timeoutMessage = `agent invocation timed out after ${this.config.timeout} second${this.config.timeout === 1 ? '' : 's'}`;
    const abortMessage = () => run.controller.signal.reason instanceof Error
      ? run.controller.signal.reason.message
      : typeof run.controller.signal.reason === 'string' && run.controller.signal.reason
        ? run.controller.signal.reason : 'agent invocation interrupted';
    const messages = this.store.unread(apId);
    try {
      let ap = this.store.ap(apId);
      check(ap.calls < this.config.maxCalls, 'AP invocation limit reached');
      // An explicit retry may freeze a complete ap-local profile. It wins over dynamic
      // project defaults for every invocation in this attempt and is cleared at settlement.
      const retryProfile = ap.retry_profile ? this.agentSettings.retryProfile(ap.role, JSON.parse(ap.retry_profile)) : null;
      const agent = retryProfile || this.provider.resolve?.(ap) || { agent: this.config.provider, model: '', thinking: '', default_prompt: '', append_prompt: '' };
      run.agent = agent;
      const record = this.store.startRun(ap, agent);
      run.recordId = record.id;
      this.store.update(apId, { status: 'running', calls: ap.calls + 1, agent_wakes: ap.agent_wakes + 1 });
      // 新一轮拆解：上一轮被驳回的闸门清零，这一轮要不要再请你批准由 planner 自己判断。
      if (ap.role === 'planner' && ap.plan_gate === 'rejected') this.store.update(apId, { plan_gate: null });
      this.store.touchAgent(apId);
      const cwd = await this.workspaces.ensure(ap);
      // 已冻结的两端 tip 必须仍成立；父 Agent 的上一轮可能恰在建立冻结前提交，外部 Git 也不受 daemon 控制。
      const fixedEvent = ap.ap_kind === 'child' ? this.store.get(`SELECT data FROM events WHERE ap_id=?
        AND type='ap.divergence_resolution_requested' ORDER BY id DESC LIMIT 1`, ap.id) : null;
      if (fixedEvent) {
        const fixed = JSON.parse(fixedEvent.data);
        const state = await this.workspaces.branchState(ap.target_branch);
        check(state.child_head === fixed.source_commit && state.parent_head === fixed.parent_commit,
          `解分歧两端提交在 AP #${ap.id} 开工前已移动；保留现场，检查后再派`);
      }
      if (run.controller.signal.aborted) throw new Error('cancelled');
      ap = this.store.ap(apId);
      if (ap.role === 'showcase') this.prepareShowcaseReport(ap, run.recordId);
      this.store.event(apId, 'invocation.started', { call: ap.calls, cwd, message_ids: messages.map(message => message.id),
        agent: agent.agent, model: agent.model || null, thinking: agent.thinking || null });
      timer = setTimeout(() => {
        timedOut = true;
        run.controller.abort(new Error(timeoutMessage));
      }, this.config.timeout * 1000);
      run.messages = messages;
      const context = await this.invocationContext(ap, run);
      if (run.controller.signal.aborted) throw new Error(abortMessage());
      // retry_profile contains system instructions and local resource paths. It is runtime
      // configuration, not AP data, so do not copy it into the provider's untrusted input JSON.
      const { retry_profile: _retryProfile, ...providerAP } = this.progressView(ap);
      const result = await this.provider.run({ ap: providerAP, cwd, token: run.token, signal: run.controller.signal, agent,
        onSpawn: pid => { run.pid = pid; }, messages, api: this,
        context,
      });
      clearTimeout(timer);
      if (TERMINAL.has(this.store.ap(apId).status) || run.parked) return;
      if (run.controller.signal.aborted) throw new Error(timedOut ? timeoutMessage : abortMessage());
      check(typeof result === 'string' && Buffer.byteLength(result) <= 256000, 'agent result exceeds 256000 bytes');
      // G-02: re-check the pinned tree after the invocation. Drift or dirt means the evidence no longer
      // describes the frozen commit, so the invocation fails instead of being recorded as a pass.
      if (ap.role === 'verifier' && ap.review_candidate_id) {
        await this.assertCandidateVerification(this.store.candidate(ap.review_candidate_id), ap);
      }
      this.store.transaction(() => {
        for (const message of messages) this.store.run('UPDATE messages SET consumed=1 WHERE id=?', message.id);
        this.store.event(apId, 'invocation.completed', { result, run_id: run.recordId });
        this.store.update(apId, { result });
        this.store.finishRun(run.recordId, 'completed', { result });
        const verification = ap.role === 'verifier' ? this.verificationEvidence(ap) : {
          status: 'unverified', tested_commit: null, baseline_commit: null, commands: [],
          summary: 'This invocation did not perform verification.', report: { ap_id: ap.id,
            path: this.reportPath(ap.id), available: false }, failures: [],
          unverified: ['The AP role was not verifier.'], baseline_failures: [], residual_risks: [],
        };
        this.store.addArtifact({ ap_id: apId, run_id: run.recordId, input_id: ap.input_id, kind: 'run.result',
          payload: { schema_version: 2, invocation: { status: 'completed' }, outcome: 'success', summary: result,
            changes: [], evidence: [], decisions: [], risks: [], artifacts: [], followups: [], verification },
          metadata: { role: ap.role, call: ap.calls, agent: agent.agent, model: agent.model || null, thinking: agent.thinking || null } });
      });
      if (ap.role === 'butler') await this.completeButler(apId, result);
      if (TERMINAL.has(this.store.ap(apId).status)) return;
      // Deliver actionable arrivals next time; ordinary coordinator receipts wait for the wave.
      if (this.hasActionableMessages(apId)) { this.store.update(apId, { status: 'queued' }); return; }
      if (this.store.get("SELECT id FROM notices WHERE ap_id=? AND status='open'", apId)) {
        this.store.update(apId, { status: 'awaiting' }); return;
      }
      if (this.store.children(apId).some(child => !TERMINAL.has(child.status))) {
        this.store.update(apId, { status: 'waiting' }); return;
      }
      await this.workspaces.finish(this.store.ap(apId));
      // git is asynchronous: input, cancellation or delegation may have arrived meanwhile.
      if (TERMINAL.has(this.store.ap(apId).status)) return;
      if (this.hasActionableMessages(apId)) { this.store.update(apId, { status: 'queued' }); return; }
      if (this.store.get("SELECT id FROM notices WHERE ap_id=? AND status='open'", apId)) {
        this.store.update(apId, { status: 'awaiting' }); return;
      }
      if (this.store.children(apId).some(child => !TERMINAL.has(child.status))) {
        this.store.update(apId, { status: 'waiting' }); return;
      }
      if (ap.ap_kind === 'say') {
        // A say AP keeps ownership of its branch between invocations. Only an explicit
        // later reservation/termination may close it; a normal provider return is not completion.
        // 这条分支自己前进了（本轮新提交）：挂在它上面的未集成请求要如实变成失效状态，
        // 而不是继续显示“等待集成”。daemon 阻止不了这次提交，所以只如实记录检查结果。
        await this.noteBranchAdvance(apId);
        this.store.transaction(() => {
          this.store.update(apId, { status: 'waiting' });
          this.store.event(apId, 'ap.idle', { run_id: run.recordId, head_commit: this.store.ap(apId).head_commit });
        });
        return;
      }
      if (ap.role === 'showcase') {
        const snapshot = JSON.parse(this.store.ap(apId).showcase);
        if (snapshot.phase === 'preparing') {
          // 第一阶段只做准备：不要求 report，也不结算展示 AP；保留现场等原 say 的工作完成信号。
          this.store.transaction(() => {
            this.store.update(apId, { status: 'waiting' });
            this.store.event(apId, 'showcase.preparation_done', { run_id: run.recordId });
          });
          return;
        }
        const payload = this.showcaseReport(this.store.ap(apId));
        this.store.addArtifact({ ap_id: apId, run_id: run.recordId, input_id: ap.input_id,
          kind: 'showcase.result', payload, metadata: { role: 'showcase' } });
      }
      this.finish(apId, 'completed', result);
    } catch (error) {
      // 安全抢占：Agent 在本轮工具都结束后自行收尾，不是失败、不是超时也不是取消。
      // 工作区按现状保留，这条输入下一轮就会被读到；不重建、不重放本轮已发生的副作用。
      if (error instanceof AgentPreempted) {
        if (run.recordId && this.store.get('SELECT status FROM agent_runs WHERE id=?', run.recordId)?.status === 'running') {
          this.store.finishRun(run.recordId, 'preempted', { error: error.details?.reason ?? 'preempted by new input' });
        }
        if (!run.parked && !TERMINAL.has(this.store.ap(apId).status)) {
          this.store.transaction(() => {
            this.store.event(apId, 'invocation.preempted', { run_id: run.recordId, ...error.details });
            this.store.update(apId, { status: this.hasActionableMessages(apId) ? 'queued' : 'waiting' });
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
      if (!run.parked && !TERMINAL.has(this.store.ap(apId).status)) this.cancel(apId, message, 'failed');
    } finally {
      clearTimeout(timer);
      if (run.recordId && this.store.get('SELECT status FROM agent_runs WHERE id=?', run.recordId)?.status === 'running') {
        const ap = this.store.ap(apId);
        this.store.finishRun(run.recordId, ap.status === 'cancelled' ? 'cancelled' : ap.status === 'failed' ? 'failed' : 'completed',
          { result: ap.result, error: ap.error });
      }
      // 对照基线 / 只读分析检出都是派生的只读检出：invocation 一结束就回收，不把每次调用都堆在磁盘上。
      // 失败也不保留——结论/错误已入库，重建一次很便宜；下次调用会在那时的分支顶端重建。
      const settled = this.store.ap(apId);
      if (settled.verifies_ap_id || settled.ap_kind === 'analysis') {
        await this.workspaces.removeBaseline(apId).catch(error => console.error(`derived checkout ${apId}: ${error.message}`));
      }
    }
  }
};
