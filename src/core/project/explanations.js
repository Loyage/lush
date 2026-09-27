import { check, id } from '../types.js';

export default {
  async startExplanation(apId, seq, quote) {
    check(!this.stopping, 'daemon is stopping');
    const source = this.store.ap(id(apId));
    this.checkExplanationInput(quote);
    this.checkExplanationProvider();
    const record = await this.transcriptStep(apId, seq, 0);
    const snapshot = { version: 1, ap_id: apId, seq, quote, goal: source.goal.slice(0, 12000),
      captured_at: new Date().toISOString(), step: record.step, related: record.related,
      body_truncated: record.has_more, pairing_ambiguous: record.pairing_ambiguous, related_truncated: record.related_truncated };
    check(!this.stopping, 'daemon is stopping');
    check(this.store.activeAPs().length < 1000, 'too many active aps');
    const ap = this.store.transaction(() => {
      const created = this.store.create({ role: 'explainer', input_id: null, name: 'explanation',
        goal: `介绍 AP #${apId} 的执行步骤 #${seq}：${quote.slice(0, 180)}` });
      this.store.event(created.id, 'explanation.requested', snapshot);
      return created;
    });
    this.kick();
    return this.explanation(ap.id);
  },

  checkExplanationInput(quote) {
    check(typeof quote === 'string' && quote.trim().length > 0 && quote.length <= 8192, '请选择 1–8192 字的文字');
  },

  checkExplanationProvider() {
    const profile = this.provider.resolve?.({ role: 'explainer' });
    check(!profile || ['pi', 'mock'].includes(profile.agent), '解释 agent 需要 Pi 的无工具模式；请在 Agent 设置中为 explainer 选择 Pi');
  },

  explanationContext(apId) {
    const row = this.store.get("SELECT data FROM events WHERE ap_id=? AND type='explanation.requested' ORDER BY id LIMIT 1", id(apId));
    check(row, 'explanation source not found');
    return JSON.parse(row.data);
  },

  explanation(apId) {
    const ap = this.store.ap(id(apId));
    check(ap.role === 'explainer', 'AP is not an explanation');
    return { id: ap.id, status: ap.status, result: ap.result, error: ap.error, source: this.explanationContext(apId) };
  },

  explanations(apId, before = null) {
    id(apId);
    check(before === null || (Number.isSafeInteger(before) && before > 0), 'invalid explanation cursor');
    const rows = this.store.all(`SELECT t.id,t.status,t.updated_at,json_extract(e.data,'$.seq') AS seq,
      substr(json_extract(e.data,'$.quote'),1,180) AS quote FROM aps t JOIN events e ON e.ap_id=t.id
      WHERE t.role='explainer' AND e.type='explanation.requested' AND json_extract(e.data,'$.ap_id')=?
      ${before === null ? '' : 'AND t.id<?'} ORDER BY t.id DESC LIMIT 51`, apId, ...(before === null ? [] : [before]));
    return { explanations: rows.slice(0, 50), has_more: rows.length > 50, next: rows.slice(0, 50).at(-1)?.id ?? null };
  },
};
