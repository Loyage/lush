import { $ } from './dom.js';
import { action } from './api.js';
import { show } from './messages.js';
import { draftUnchecked, ui } from './state.js';

// 待提交意图：只落库不规划；可改、可勾选，只把选中的交给一个 planner 拆解成任务并建依赖。
/** 面板开合状态画到 DOM：.open 控制展开，aria-expanded 同步给读屏。 */
export function paintDraftPanel() {
  const open = Boolean(ui.draftPanelOpen);
  $('draft-panel')?.classList.toggle('open', open);
  $('draft-toggle')?.setAttribute('aria-expanded', String(open));
}
/** 默认折叠；force 省略时就是开关。 */
export function toggleDraftPanel(force) {
  ui.draftPanelOpen = force === undefined ? !ui.draftPanelOpen : Boolean(force);
  paintDraftPanel();
}
export async function buffer() {
  const value = $('input').value.trim();
  if (!value) return;
  await action('draft.add', { content: value });
  if ($('input').value.trim() === value) $('input').value = '';
}
export const selectedDraftIds = () => ui.draftIds.filter(draftId => !draftUnchecked.has(draftId));
// 按钮的可用性同时看输入框与勾选：都没内容就没什么可提交的。
export function syncComposer() { $('draft-commit').disabled = !$('input').value.trim() && selectedDraftIds().length === 0; }
/** 接上输入框与两个按钮：回车=缓存，⌘/Ctrl+回车=整体提交，Shift+回车=换行。 */
export function initComposer() {
  $('draft-toggle').onclick = () => toggleDraftPanel();
  paintDraftPanel();
  $('draft-add').onclick = async event => {
    const target = event.currentTarget; target.disabled = true;
    try { await buffer(); } catch (error) { show(error.message, 'error'); } finally { target.disabled = false; }
  };
  $('input-form').onsubmit = async event => {
    event.preventDefault();
    const submit = $('draft-commit'); submit.disabled = true;
    try {
      if ($('input').value.trim()) await buffer();
      const ids = selectedDraftIds();
      if (!ids.length) throw new Error('没有勾选任何待提交意图；勾选要提交的，或者先在输入框里写点什么');
      const branch = $('input-branch').value.trim();
      const result = await action('draft.commit', { ids, ...(branch ? { branch } : {}) });
      show(`已提交 ${result.drafts.length} 条输入；planner #${result.task.id} 正在拆解任务并建依赖`);
    } catch (error) { show(error.message, 'error'); } finally { syncComposer(); }
  };
  $('input').addEventListener('input', syncComposer);
  // 回车=缓存，⌘/Ctrl+回车=整体提交，Shift+回车=换行。
  $('input').addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing || event.shiftKey) return;
    event.preventDefault();
    if (event.metaKey || event.ctrlKey) $('input-form').requestSubmit(); else $('draft-add').click();
  });
}
