/** Pure shared contract for device preferences, settings and source-Event classification. */
export const NOTICE_CHANNELS = Object.freeze(['banner', 'system']);
export const NOTICE_CATEGORIES = Object.freeze([
  { id: 'created', label: 'Worker 待开始', note: '仅创建 Worker 后等待手动开始；尚未调用 Agent。', events: ['task.start_pending'] },
  // Keep the stored idle key and historical task.idle sources; do not rewrite preferences or Notices.
  { id: 'idle', label: 'Worker 待验收', note: '成果已交付，等待用户验收或直接父 Worker 确认；不代表已验收完成。',
    events: ['task.idle', 'task.delivered', 'task.merge_integrated', 'task.parent_synced', 'task.reopened'] },
  { id: 'analysis', label: '只读分析完成', note: '用户发起的只读分析已完成。', events: ['completed'] },
  { id: 'failed', label: '异常停止', note: '超时、调用失败或后台中断等异常。', events: ['failed', 'merge.repair_interrupted', 'analysis.fork_failed'] },
  { id: 'reported', label: 'Agent 主动告知', note: 'Agent 主动发送的结论或完成提醒；可能与待验收告知同时出现。', events: ['notice.reported'] },
].map(category => Object.freeze({ ...category, events: Object.freeze(category.events) })));

/** Cache/read normalization only; backend writes validate their shape separately. */
export function normalizeNoticeChannels(value) {
  return Object.fromEntries(NOTICE_CATEGORIES.map(({ id }) => [id,
    Object.fromEntries(NOTICE_CHANNELS.map(channel => [channel,
      typeof value?.[id]?.[channel] === 'boolean' ? value[id][channel] : true]))]));
}
