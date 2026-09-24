import { $, el } from './dom.js';
import { action } from './api.js';
import { show } from './messages.js';
import { draftUnchecked, ui } from './state.js';
import { composerReferences, renderComposerReferences, setComposerReferences } from './context-references.js';
import { matchInputRoute } from './input-routes.js';

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
/**
 * 输入区展开态：默认只留一行输入 + 一行操作；展开后才出现父分支与快捷键说明。
 * 折叠态仍把非空的父分支写在展开控件上，避免用户在不知情的情况下提交到别的分支。
 */
export function paintComposerDetails() {
  const open = Boolean(ui.composerExpanded);
  const details = $('composer-details'), shortcuts = $('composer-shortcuts'), toggle = $('composer-expand');
  if (details) details.hidden = !open;
  if (shortcuts) shortcuts.hidden = !open;
  if (!toggle) return;
  const branch = String($('input-branch')?.value ?? '').trim();
  toggle.setAttribute('aria-expanded', String(open));
  toggle.title = open ? '收起：只留一行输入与操作按钮' : `展开：可以指定父分支，并查看键盘快捷键${branch ? `（当前父分支：${branch}）` : ''}`;
  toggle.textContent = open ? '⌃ 收起' : (branch ? `⌃ 更多 · 父分支：${branch}` : '⌃ 更多');
}
/** 默认折叠；force 省略时就是开关。展开状态只在本次会话内保留，不写进本地偏好。 */
export function toggleComposerDetails(force) {
  ui.composerExpanded = force === undefined ? !ui.composerExpanded : Boolean(force);
  paintComposerDetails();
}
export async function buffer() {
  const value = $('input').value.trim();
  if (!value) return;
  const references = composerReferences();
  const signature = JSON.stringify(references);
  await action('draft.add', { content: value, references });
  if ($('input').value.trim() === value) $('input').value = '';
  // 网络请求期间用户可能又引用了一项；只清掉实际随这条草稿提交的那一组。
  if (JSON.stringify(composerReferences()) === signature) setComposerReferences([]);
}
export const selectedDraftIds = () => ui.draftIds.filter(draftId => !draftUnchecked.has(draftId));
// 按钮的可用性同时看输入框与勾选：都没内容就没什么可提交的。
export function syncComposer() {
  const busy = Boolean(ui.composerSubmitting);
  $('draft-commit').disabled = busy || (!$('input').value.trim() && selectedDraftIds().length === 0);
  $('draft-add').disabled = busy;
  if ($('input-direct')) $('input-direct').disabled = busy || !$('input').value.trim();
  paintInputHighlight();
}

/**
 * 输入框就地高亮命中的快速路由前缀：从当前运行设置读前缀表，用与 core 一致的规则匹配，
 * 只在命中时把前缀那段文本包进 <mark class="input-prefix">。全部用 textContent / createElement
 * 构造，绝不拼 innerHTML。前缀之后的空白与标点不被高亮（那不属于前缀本身）。
 * 未命中或没装好 DOM 时清空 overlay；textarea 滚动时同步偏移，避免长文本错位。
 */
export function paintInputHighlight() {
  const input = $('input'), highlight = $('input-highlight');
  if (!input || !highlight) return;
  const value = input.value;
  const routes = ui.lastSnapshot?.status?.settings?.input_routes?.value || [];
  const match = value ? matchInputRoute(routes, value) : null;
  if (!match) { highlight.replaceChildren(); highlight.hidden = true; return; }
  const offset = value.length - value.replace(/^\s+/u, '').length;
  const end = offset + match.prefix.length;
  const mark = el('mark', value.slice(offset, end), 'input-prefix');
  highlight.replaceChildren(value.slice(0, offset), mark, value.slice(end));
  highlight.hidden = false;
  highlight.scrollTop = input.scrollTop;
  highlight.scrollLeft = input.scrollLeft;
}
/** 接上输入框与两个按钮：回车=缓存，⌘/Ctrl+回车=整体提交，Shift+回车=换行。 */
export function initComposer() {
  $('draft-toggle').onclick = () => toggleDraftPanel();
  paintDraftPanel(); renderComposerReferences();
  $('composer-expand').onclick = () => toggleComposerDetails();
  paintComposerDetails();
  // 父分支值可能在展开态被改动：折叠回去时控件上要显示最新值。
  $('input-branch').addEventListener('input', paintComposerDetails);
  $('draft-add').onclick = async () => {
    if (ui.composerSubmitting) return;
    ui.composerSubmitting = true; syncComposer();
    try { await buffer(); } catch (error) { show(error.message, 'error'); }
    finally { ui.composerSubmitting = false; syncComposer(); }
  };
  if ($('input-direct')) $('input-direct').onclick = async () => {
    if (ui.composerSubmitting) return;
    const content = $('input').value.trim();
    if (!content) return;
    const references = composerReferences(), signature = JSON.stringify(references);
    const branch = $('input-branch').value.trim();
    ui.composerSubmitting = true; syncComposer();
    try {
      const result = await action('input.submit', { content, references, direct: true, ...(branch ? { branch } : {}) });
      if ($('input').value.trim() === content) $('input').value = '';
      if (JSON.stringify(composerReferences()) === signature) setComposerReferences([]);
      if (result.route) {
        const target = result.route.target;
        const task = target === 'worker' ? result.worker : result.research;
        show(`前缀 ${result.route.prefix} 命中，已创建 ${target} #${task.id}；未调用规划模型。待提交草稿未变。`);
      } else {
        show(`已直接创建 worker #${result.worker.id}；未调用规划模型，合并仍需批准。待提交草稿未变。`);
      }
      paintInputHighlight();
    } catch (error) { show(error.message, 'error'); }
    finally { ui.composerSubmitting = false; syncComposer(); }
  };
  $('input-form').onsubmit = async event => {
    event.preventDefault();
    if (ui.composerSubmitting) return;
    ui.composerSubmitting = true; syncComposer();
    try {
      if ($('input').value.trim()) await buffer();
      const ids = selectedDraftIds();
      if (!ids.length) throw new Error('没有勾选任何待提交意图；勾选要提交的，或者先在输入框里写点什么');
      const branch = $('input-branch').value.trim();
      const result = await action('draft.commit', { ids, ...(branch ? { branch } : {}) });
      if (result.route) {
        const target = result.route.target;
        const task = target === 'worker' ? result.worker : result.research;
        show(`前缀 ${result.route.prefix} 命中，已创建 ${target} #${task.id}；未调用规划模型。`);
      } else {
        show(`已提交 ${result.drafts.length} 条输入；planner #${result.task.id} 正在拆解任务并建依赖`);
      }
    } catch (error) { show(error.message, 'error'); } finally { ui.composerSubmitting = false; syncComposer(); }
  };
  $('input').addEventListener('input', syncComposer);
  // textarea 变高滚动时 overlay 不跟着动，会把高亮留在原处；这里只同步偏移，不改样式。
  $('input').addEventListener('scroll', () => {
    const highlight = $('input-highlight');
    if (!highlight) return;
    highlight.scrollTop = $('input').scrollTop;
    highlight.scrollLeft = $('input').scrollLeft;
  });
  // 回车=缓存，⌘/Ctrl+回车=整体提交，Shift+回车=换行。
  $('input').addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing || event.shiftKey) return;
    event.preventDefault();
    if (event.metaKey || event.ctrlKey) $('input-form').requestSubmit(); else $('draft-add').click();
  });
}
