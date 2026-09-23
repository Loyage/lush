import { check, id } from '../types.js';

export default {
  async startExplanation(taskId, seq, quote) {
    check(!this.stopping, 'daemon is stopping');
    const source = this.store.task(id(taskId));
    this.checkExplanationInput(quote);
    this.checkExplanationProvider();
    const record = await this.transcriptStep(taskId, seq, 0);
    const snapshot = { version: 1, task_id: taskId, seq, quote, goal: source.goal.slice(0, 12000),
      captured_at: new Date().toISOString(), step: record.step, related: record.related,
      body_truncated: record.has_more, pairing_ambiguous: record.pairing_ambiguous, related_truncated: record.related_truncated };
    check(!this.stopping, 'daemon is stopping');
    check(this.store.activeTasks().length < 1000, 'too many active tasks');
    const task = this.store.transaction(() => {
      const created = this.store.create({ role: 'explainer', input_id: null, name: 'explanation',
        goal: `介绍任务 #${taskId} 的执行步骤 #${seq}：${quote.slice(0, 180)}` });
      this.store.event(created.id, 'explanation.requested', snapshot);
      return created;
    });
    this.kick();
    return this.explanation(task.id);
  },

  /** Read-only explanation of any page selection; no task/step source, so the snapshot carries kind=selection. */
  async startSelectionExplanation(quote, location) {
    check(!this.stopping, 'daemon is stopping');
    this.checkExplanationInput(quote);
    const normalized = this.normalizeLocation(location);
    this.checkExplanationProvider();
    const snapshot = { version: 1, kind: 'selection', quote,
      location: normalized, captured_at: new Date().toISOString() };
    check(!this.stopping, 'daemon is stopping');
    check(this.store.activeTasks().length < 1000, 'too many active tasks');
    const task = this.store.transaction(() => {
      const created = this.store.create({ role: 'explainer', input_id: null, name: 'explanation',
        goal: `介绍所选页面文字：${quote.slice(0, 180)}` });
      this.store.event(created.id, 'explanation.requested', snapshot);
      return created;
    });
    this.kick();
    return this.explanation(task.id);
  },

  checkExplanationInput(quote) {
    check(typeof quote === 'string' && quote.trim().length > 0 && quote.length <= 8192, '请选择 1–8192 字的文字');
  },

  checkExplanationProvider() {
    const profile = this.provider.resolve?.({ role: 'explainer' });
    check(!profile || ['pi', 'mock'].includes(profile.agent), '解释 agent 需要 Pi 的无工具模式；请在 Agent 设置中为 explainer 选择 Pi');
  },

  explanationContext(taskId) {
    const row = this.store.get("SELECT data FROM events WHERE task_id=? AND type='explanation.requested' ORDER BY id LIMIT 1", id(taskId));
    check(row, 'explanation source not found');
    return JSON.parse(row.data);
  },

  explanation(taskId) {
    const task = this.store.task(id(taskId));
    check(task.role === 'explainer', 'task is not an explanation');
    return { id: task.id, status: task.status, result: task.result, error: task.error, source: this.explanationContext(taskId) };
  },

  explanations(taskId, before = null) {
    id(taskId);
    check(before === null || (Number.isSafeInteger(before) && before > 0), 'invalid explanation cursor');
    const rows = this.store.all(`SELECT t.id,t.status,t.updated_at,json_extract(e.data,'$.seq') AS seq,
      substr(json_extract(e.data,'$.quote'),1,180) AS quote FROM tasks t JOIN events e ON e.task_id=t.id
      WHERE t.role='explainer' AND e.type='explanation.requested' AND json_extract(e.data,'$.task_id')=?
      ${before === null ? '' : 'AND t.id<?'} ORDER BY t.id DESC LIMIT 51`, taskId, ...(before === null ? [] : [before]));
    return { explanations: rows.slice(0, 50), has_more: rows.length > 50, next: rows.slice(0, 50).at(-1)?.id ?? null };
  },
};
