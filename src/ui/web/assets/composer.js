import { $, el } from './dom.js';
import { action } from './api.js';
import { show } from './messages.js';
import { ui } from './state.js';
import { composerReferences, renderComposerReferences, setComposerReferences } from './context-references.js';
import { agentHelp } from './help.js';

// 草稿只缓存；输入框发送仅提交当前正文，绝不连带发送其它草稿。
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
// 发送按钮只看当前输入框；草稿只能从各自的发送按钮提交。
export function syncComposer() {
  const busy = Boolean(ui.composerSubmitting);
  $('draft-commit').disabled = busy || !$('input').value.trim();
  $('draft-add').disabled = busy;
}
/** 接上输入框与操作按钮：回车=存草稿，⌘/Ctrl+回车=发送当前正文，Shift+回车=换行。 */
export function initComposer() {
  $('draft-commit').setAttribute('data-help', agentHelp('只发送输入框中的这一条，不会连带发送缓存的草稿。'));
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
  $('input-form').onsubmit = async event => {
    event.preventDefault();
    if (ui.composerSubmitting) return;
    ui.composerSubmitting = true; syncComposer();
    try {
      const value = $('input').value.trim();
      if (!value) return;
      const references = composerReferences();
      const signature = JSON.stringify(references);
      const branch = $('input-branch').value.trim();
      const result = await action('say.submit', { content: value, references, ...(branch ? { branch } : {}) });
      if ($('input').value.trim() === value) $('input').value = '';
      if (JSON.stringify(composerReferences()) === signature) setComposerReferences([]);
      show(`已发送输入 #${result.id}；其它草稿仍在缓存中`);
    } catch (error) { show(error.message, 'error'); } finally { ui.composerSubmitting = false; syncComposer(); }
  };
  $('input').addEventListener('input', syncComposer);
  // 回车=存草稿，⌘/Ctrl+回车=发送当前正文，Shift+回车=换行。
  $('input').addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing || event.shiftKey) return;
    event.preventDefault();
    if (event.metaKey || event.ctrlKey) $('input-form').requestSubmit(); else $('draft-add').click();
  });
}
