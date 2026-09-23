import { randomUUID } from 'node:crypto';
import { check, TERMINAL } from '../types.js';
import { readUsageStatistics } from '../usage-statistics.js';
import { sleepOptions, recommendedChoice, validateSleepChoice, SLEEP_WARNING } from '../sleep-policy.js';

const STATE_KEY = 'sleep_mode_v1';
const read = row => row ? JSON.parse(row.data) : null;
// 只有这些动作才算「管家作出选择」；acknowledge 是信息已阅，只进 handled 不进 decisions。
const DECISION_ACTION_SQL = ['approve','reject','answer','dismiss','merge'].map(action => `'${action}'`).join(',');

export default {
  sleepStatus() {
    const state = JSON.parse(this.store.get('SELECT value FROM meta WHERE key=?', STATE_KEY)?.value || '{}');
    return { enabled: false, paused: false, used_tokens: 0, ...state, ...this.sleepProgress(state), warning: SLEEP_WARNING };
  },

  /** 本会话进度：已给出结果（有 sleep.choice.finished）的 Notice 条数与其中作出实质选择的条数。
      只读既有 sleep.choice 事件，借 events_type_id 与 sleep.started 的 Event ID 限定扫描范围。 */
  sleepProgress(state) {
    if (!state?.session) return { handled: 0, decisions: 0 };
    const row = this.store.get(`SELECT count(*) AS handled,
      coalesce(sum(CASE WHEN json_extract(f.data,'$.decision.action') IN (${DECISION_ACTION_SQL}) THEN 1 ELSE 0 END),0) AS decisions
      FROM events e JOIN events f ON f.type='sleep.choice.finished' AND json_extract(f.data,'$.choice_id')=e.id
      WHERE e.type='sleep.choice.started' AND json_extract(e.data,'$.session')=? AND e.id>?`,
      state.session, state.after_event ?? 0);
    return { handled: row.handled, decisions: row.decisions };
  },

  saveSleepState(state) {
    const { warning, handled, decisions, ...stored } = state;
    this.store.run('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', STATE_KEY, JSON.stringify(stored));
    return this.sleepStatus();
  },

  startSleep(options, confirmed) {
    check(confirmed === true, `请先阅读并确认：${SLEEP_WARNING}`);
    check(!this.stopping, 'daemon is stopping');
    const previous = this.sleepStatus();
    check(!previous.enabled && !previous.paused, '先关闭当前睡觉模式；预算暂停需要显式恢复');
    const normalized = sleepOptions(options);
    const profile = this.provider.resolve?.({ role: 'butler' });
    check(!profile || ['pi','mock'].includes(profile.agent), '管家需要 Pi 无工具模式；请为 butler 配置 Pi');
    const state = this.store.transaction(() => {
      const state = { ...normalized, enabled: true, paused: false, session: randomUUID(),
        started_at: new Date().toISOString(), used_tokens: 0, reason: null };
      // Event identity survives deletion of the most recent task/notice; notice IDs alone can be reused.
      state.after_event = this.store.event(null, 'sleep.started', state);
      return this.saveSleepState(state);
    });
    this.startSleepMonitor(); this.kick();
    return state;
  },

  stopSleep() {
    const state = this.sleepStatus();
    if (state.enabled) {
      state.enabled = false; state.ended_at = new Date().toISOString();
      this.saveSleepState(state);
      this.store.event(null, 'sleep.stopped', { session: state.session });
    }
    clearInterval(this.sleepTimer); this.sleepTimer = null;
    for (const task of this.store.all("SELECT id FROM tasks WHERE role='butler' AND status NOT IN ('completed','failed','cancelled')")) {
      this.cancel(task.id, '睡觉模式已关闭，未执行的管家决定作废');
    }
    this.kick();
    return this.sleepStatus();
  },

  resumeSleepDevelopment() {
    check(!this.sleepStatus().enabled, '请先关闭睡觉模式再恢复开发');
    this.saveSleepState({ ...this.sleepStatus(), paused: false, reason: null });
    this.store.event(null, 'sleep.resumed', { note: '仅恢复排队任务；中止的任务不自动重试' });
    this.kick(); return this.sleepStatus();
  },

  startSleepMonitor() {
    if (this.sleepTimer || !this.sleepStatus().enabled) return;
    this.sleepTimer = setInterval(() => {
      // Budget sampling must not wait behind a slow Git approval in sleepTick.
      if (this.sleepWatchPromise) return;
      const session = this.sleepStatus().session;
      this.sleepWatchPromise = this.checkSleepBudget(session).then(allowed => {
        if (allowed) void this.sleepTick();
      }).catch(error => {
        if (this.sleepStatus().session === session) this.pauseSleep(`预算监控失败：${error.message}`);
      }).finally(() => { this.sleepWatchPromise = null; });
    }, 1000);
    this.sleepTimer.unref?.();
  },

  pauseSleep(reason) {
    const state = this.sleepStatus();
    if (!state.enabled) return;
    this.saveSleepState({ ...state, enabled: false, paused: true, reason, ended_at: new Date().toISOString() });
    clearInterval(this.sleepTimer); this.sleepTimer = null;
    this.store.event(null, 'sleep.paused', { session: state.session, reason });
    for (const [taskId] of this.running) {
      this.cancel(taskId, `${reason}；工作区保留，请检查后显式重试`, 'failed');
    }
    for (const task of this.store.all("SELECT id FROM tasks WHERE role='butler' AND status='queued'")) this.cancel(task.id, reason);
  },

  async checkSleepBudget(session) {
    let state = this.sleepStatus();
    if (!state.enabled || state.session !== session || this.stopping) return false;
    // Include every role, including already-running invocations and the isolated butler.
    const usage = await readUsageStatistics(this.config, { start: state.started_at });
    state = this.sleepStatus();
    if (!state.enabled || state.session !== session || this.stopping) return false;
    const used = Math.max(state.used_tokens, usage.totals.tokens);
    if (used !== state.used_tokens) { state.used_tokens = used; this.saveSleepState(state); }
    if (state.budget_tokens !== null) {
      if (usage.totals.unknown_tokens || usage.coverage.unreadable_files || usage.coverage.malformed_lines || usage.coverage.undated_requests) {
        this.pauseSleep('无法可靠读取 token 用量，已保守暂停开发'); return false;
      }
      if (state.used_tokens >= state.budget_tokens) {
        this.pauseSleep(`睡觉模式预算已耗尽（${state.used_tokens}/${state.budget_tokens} token）`); return false;
      }
    }
    return true;
  },

  sleepTick() {
    if (this.sleepTickPromise) return this.sleepTickPromise;
    const session = this.sleepStatus().session;
    this.sleepTickPromise = (async () => {
      if (!await this.checkSleepBudget(session)) return;
      const state = this.sleepStatus();
      const active = this.store.get("SELECT id FROM tasks WHERE role='butler' AND status NOT IN ('completed','failed','cancelled') LIMIT 1");
      if (!active) {
        // The intent is durable before either calling a model or touching Git. Never replay a claimed notice.
        const running = [...this.running.keys()];
        const notice = this.store.get(`SELECT n.* FROM notices n WHERE n.status IN ('open','sent')
          AND (? OR EXISTS (SELECT 1 FROM events e WHERE e.type='notice.opened' AND e.id>?
            AND e.task_id=n.task_id AND json_extract(e.data,'$.notice_id')=n.id))
          ${running.length ? `AND n.task_id NOT IN (${running.map(() => '?').join(',')})` : ''}
          AND NOT EXISTS (SELECT 1 FROM events e WHERE e.type='sleep.choice.started' AND json_extract(e.data,'$.notice.id')=n.id AND json_extract(e.data,'$.notice.task_id')=n.task_id)
          ORDER BY (n.status='open') DESC,n.id LIMIT 1`, state.include_existing ? 1 : 0, state.after_event, ...running);
        if (notice) {
          const owner = this.store.task(notice.task_id);
          // Let the originating invocation unwind before answering, especially Plan approval.
          if (!this.running.has(owner.id)) {
            let decision = state.mode === 'recommended' ? recommendedChoice(notice) : null;
            if (notice.kind === 'info') {
              const mergeable = owner.status === 'completed' && owner.integration === 'pending';
              decision = { action: state.allow_merge && mergeable ? 'merge' : 'acknowledge',
                reason: state.allow_merge && mergeable ? '按明确授权尝试安全合并已完成任务。' : '信息提醒已阅；无可合并改动或未授权自动合并。' };
            }
            const source = { version: 1, session, mode: state.mode, allow_merge: state.allow_merge, notice,
              task: { id: owner.id, goal: owner.goal.slice(0, 12000), role: owner.role, integration: owner.integration },
              history: state.mode === 'preferences' ? this.sleepPreferenceHistory() : [] };
            let choiceId;
            this.store.transaction(() => {
              choiceId = this.store.event(null, 'sleep.choice.started', source);
              if (!decision) {
                const task = this.store.create({ role: 'butler', name: 'butler', goal: `管家处理 Notice #${notice.id}：${notice.title}` });
                this.store.event(task.id, 'sleep.requested', { choice_id: choiceId, ...source });
              }
            });
            if (decision) await this.applySleepChoice(choiceId, source, decision);
          }
        }
      }
      if (this.sleepStatus().enabled && !this.stopping) {
        this.sleepAdmitted = true;
        try { this.pump(); } finally { this.sleepAdmitted = false; }
      }
    })().catch(error => {
      if (this.sleepStatus().session === session) this.pauseSleep(`管家监控失败：${error.message}`);
    }).finally(() => { this.sleepTickPromise = null; });
    return this.sleepTickPromise;
  },

  sleepPreferenceHistory() {
    return this.store.all(`SELECT n.id,n.title,substr(n.body,1,4000) AS body,substr(n.answer,1,4000) AS answer,
      CASE WHEN EXISTS (SELECT 1 FROM events e JOIN events f ON f.type='sleep.choice.finished'
        AND json_extract(f.data,'$.choice_id')=e.id AND json_extract(f.data,'$.status')='applied'
        WHERE e.type='sleep.choice.started' AND json_extract(e.data,'$.notice.id')=n.id
        AND json_extract(e.data,'$.notice.task_id')=n.task_id)
      THEN 'butler' ELSE 'user' END AS decided_by FROM notices n WHERE n.status='answered'
      ORDER BY n.id DESC LIMIT 20`);
  },

  butlerContext(taskId) {
    const value = read(this.store.get("SELECT data FROM events WHERE task_id=? AND type='sleep.requested' ORDER BY id LIMIT 1", taskId));
    check(value, 'missing butler context'); return value;
  },

  async completeButler(taskId, result) {
    const source = this.butlerContext(taskId);
    try {
      const decision = JSON.parse(result);
      await this.applySleepChoice(source.choice_id, source, decision);
    } catch (error) {
      this.finishSleepChoice(source.choice_id, { status: 'failed', error: error.message, raw: String(result).slice(0, 8000) });
      throw error;
    }
  },

  finishSleepChoice(choiceId, result) {
    if (!this.store.get("SELECT id FROM events WHERE type='sleep.choice.finished' AND json_extract(data,'$.choice_id')=?", choiceId)) {
      this.store.event(null, 'sleep.choice.finished', { choice_id: choiceId, ...result });
    }
  },

  async applySleepChoice(choiceId, source, raw) {
    if (this.store.get("SELECT id FROM events WHERE type='sleep.choice.finished' AND json_extract(data,'$.choice_id')=?", choiceId)) return;
    let decision;
    try {
      decision = validateSleepChoice(source.notice, raw);
      if (!await this.checkSleepBudget(source.session)) {
        this.finishSleepChoice(choiceId, { status: 'skipped', decision, reason: '授权已关闭或预算暂停，未执行' }); return;
      }
      const notice = this.store.get('SELECT * FROM notices WHERE id=?', source.notice.id);
      if (!notice || notice.status !== source.notice.status || notice.body !== source.notice.body) {
        this.finishSleepChoice(choiceId, { status: 'skipped', decision, reason: '原事项已变化或已由用户处理' }); return;
      }
      const state = this.sleepStatus();
      // Synchronous answers + their audit receipt are one transaction. Git has a durable intent instead.
      const execute = () => {
        switch (decision.action) {
          case 'approve': return this.approvePlan(notice.id, `管家批准：${decision.reason}`);
          case 'reject': return this.rejectPlan(notice.id, decision.reason);
          case 'answer': return this.answer(notice.id, decision.answer);
          case 'dismiss': return this.answer(notice.id, '', true);
          case 'acknowledge': return;
          default: throw new Error('invalid action');
        }
      };
      if (decision.action === 'merge') {
        check(state.allow_merge && source.allow_merge, '未授权自动合并');
        const task = this.store.task(notice.task_id);
        check(task.status === 'completed' && task.integration === 'pending', '当前任务不符合自动合并条件');
        this.store.event(null, 'sleep.choice.executing', { choice_id: choiceId, decision });
        const outcome = await this.approveMerge(task.id);
        this.finishSleepChoice(choiceId, { status: 'applied', decision, outcome });
      } else this.store.transaction(() => {
        execute(); this.finishSleepChoice(choiceId, { status: 'applied', decision });
      });
    } catch (error) {
      this.finishSleepChoice(choiceId, { status: 'failed', decision: decision || raw, error: error.message });
    }
  },

  sleepChoices(before = null, limit = 30) {
    check(before === null || (Number.isSafeInteger(before) && before > 0), 'invalid choice cursor');
    check(Number.isInteger(limit) && limit >= 1 && limit <= 50, 'limit must be 1..50');
    const rows = this.store.all(`SELECT id,created_at,data FROM events WHERE type='sleep.choice.started'
      ${before === null ? '' : 'AND id<?'} ORDER BY id DESC LIMIT ?`, ...(before === null ? [] : [before]), limit + 1);
    const choices = []; let bytes = 0;
    for (const row of rows.slice(0, limit)) {
      const source = JSON.parse(row.data);
      const result = read(this.store.get("SELECT data FROM events WHERE type='sleep.choice.finished' AND json_extract(data,'$.choice_id')=? ORDER BY id DESC LIMIT 1", row.id));
      const value = { id: row.id, created_at: row.created_at, session: source.session, mode: source.mode, notice: source.notice,
        result: result || { status: 'pending', reason: '处理尚未结束；中断的操作不会自动重放' } };
      const size = Buffer.byteLength(JSON.stringify(value));
      if (choices.length && bytes + size > 800000) break;
      bytes += size; choices.push(value);
    }
    return { choices, cursor: choices.at(-1)?.id ?? null, has_more: rows.length > choices.length };
  },

  recoverSleep() {
    // Nothing unknown is replayed. Ordinary queued work can continue under the persisted authorization.
    const pending = this.store.all(`SELECT id FROM events e WHERE type='sleep.choice.started'
      AND NOT EXISTS (SELECT 1 FROM events f WHERE f.type='sleep.choice.finished' AND json_extract(f.data,'$.choice_id')=e.id)`);
    for (const row of pending) this.finishSleepChoice(row.id, { status: 'interrupted', reason: 'daemon 中断，执行结果可能未知；请人工检查，不自动重放' });
    for (const task of this.store.all("SELECT id,status FROM tasks WHERE role='butler'")) {
      if (!TERMINAL.has(task.status)) this.cancel(task.id, '管家 invocation 中断，不自动重放');
    }
    this.startSleepMonitor();
  },
};
