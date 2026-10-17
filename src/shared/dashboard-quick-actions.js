/** Device dashboard action catalogue: data-only, shared by validation and browser UI. */
export const QUICK_ACTIONS = Object.freeze([
  { id: 'safe_restart', label: '一键安全重启', service: 'safe', default: true },
  { id: 'auto_select', label: '全局自动选择', default: true },
  { id: 'interrupt_all', label: '全部中断', service: 'pause' },
  { id: 'resume_all', label: '全部继续', service: 'resume' },
  { id: 'restart_all', label: '全部重启', service: 'all' },
].map(Object.freeze));
export const DEFAULT_QUICK_ACTION_BUTTONS = Object.freeze(QUICK_ACTIONS.filter(item => item.default).map(item => item.id));
export function normalizeQuickActionButtons(value) {
  if (!Array.isArray(value) || value.length > 100 || value.some(id => typeof id !== 'string' || !QUICK_ACTIONS.some(item => item.id === id))) {
    throw new Error('invalid dashboard quick_action_buttons');
  }
  return QUICK_ACTIONS.filter(item => value.includes(item.id)).map(item => item.id);
}
