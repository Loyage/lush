import { $, el } from './dom.js';
import { action } from './api.js';
import { taskTitle } from './format.js';
import { show } from './messages.js';
import { detail, refresh } from './navigate.js';
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
// 可作为父 Task 的只有拥有分支、仍在活动的主干 / owner / say Task；正在展示冻结提交的 say 会被后端拒绝。
const PARENT_KINDS = new Set(['main', 'owner', 'say']);
const PARENT_STATUSES = new Set(['queued', 'running', 'waiting', 'awaiting']);

/** 当前快照里可选的父 Task，按 id 升序。纯函数，便于单测。 */
export function parentTasks(tasks = ui.lastSnapshot?.tasks ?? []) {
  return tasks
    .filter(task => PARENT_KINDS.has(task.task_kind) && task.branch && PARENT_STATUSES.has(task.status)
      && task.reservation?.status !== 'started')
    .sort((a, b) => a.id - b.id);
}

/** 选中的父 Task 在折叠态留下的短标识；空值表示跟随当前检出分支。 */
function selectedParentLabel() {
  const select = $('input-parent');
  if (!select || !select.value) return null;
  const option = [...select.children].find(node => node.value === select.value);
  return option ? (option.dataset.label ?? option.textContent) : select.value;
}

/**
 * 输入区展开态：默认只留一行输入 + 一行操作；展开后才出现父 Task 与快捷键说明。
 * 折叠态仍把已选父 Task 写在展开控件上，避免用户在不知情的情况下提交到别的分支。
 */
export function paintComposerDetails() {
  const open = Boolean(ui.composerExpanded);
  const details = $('composer-details'), shortcuts = $('composer-shortcuts'), toggle = $('composer-expand');
  if (details) details.hidden = !open;
  if (shortcuts) shortcuts.hidden = !open;
  if (!toggle) return;
  const parent = selectedParentLabel();
  toggle.setAttribute('aria-expanded', String(open));
  toggle.title = open ? '收起：只留一行输入与操作按钮' : `展开：可以选择父 Task，并查看键盘快捷键${parent ? `（当前父 Task：${parent}）` : ''}`;
  toggle.textContent = open ? '⌃ 收起' : (parent ? `⌃ 更多 · 父 Task：${parent}` : '⌃ 更多');
}

/**
 * 把快照里最新的父 Task 列表画进下拉框。选项值仍是分支名，所以 `say.submit` 的语义不变；
 * 用户看到与选择的是 Task 身份。列表没变就不重建 DOM（避免每次轮询把打开的下拉框关掉），
 * 重建后保留仍在候选里的选择。
 */
export function renderParentOptions() {
  const select = $('input-parent');
  if (!select) return;
  const tasks = parentTasks();
  const signature = JSON.stringify(tasks.map(task => [task.id, task.branch, task.status, task.reservation?.status ?? null]));
  if (select.dataset.signature === signature) { paintComposerDetails(); return; }
  select.dataset.signature = signature;
  const previous = select.value;
  const placeholder = el('option', '当前检出分支（默认）');
  placeholder.value = '';
  select.replaceChildren(placeholder, ...tasks.map(task => {
    const option = el('option', `#${task.id} ${taskTitle(task)} · ${task.branch}`);
    option.value = task.branch;
    option.dataset.label = `#${task.id} ${taskTitle(task)}`;
    option.title = `#${task.id} ${task.goal ?? ''}\n分支：${task.branch}`;
    return option;
  }));
  select.value = [...select.children].some(option => option.value === previous) ? previous : '';
  paintComposerDetails();
}
/** 默认折叠；force 省略时就是开关。展开状态只在本次会话内保留，不写进本地偏好。 */
export function toggleComposerDetails(force) {
  ui.composerExpanded = force === undefined ? !ui.composerExpanded : Boolean(force);
  paintComposerDetails();
}
// 发送按钮只看当前输入框；草稿只能从各自的发送按钮提交。
/** 输入框发送按钮与父 Task 下拉框共用：刷新时先按最新快照重建候选，再决定能不能发。 */
export function syncComposer() {
  renderParentOptions();
  const busy = Boolean(ui.composerSubmitting);
  $('draft-commit').disabled = busy || !$('input').value.trim();
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
/** 接上输入框与操作按钮：回车=存草稿，⌘/Ctrl+回车=发送当前正文，Shift+回车=换行。 */
export function initComposer() {
  $('draft-commit').setAttribute('data-help', agentHelp('只发送输入框中的这一条，不会连带发送缓存的草稿。'));
  renderComposerReferences();
  $('composer-expand').onclick = () => toggleComposerDetails();
  renderParentOptions();
  // 父 Task 可能在展开态被改动：折叠回去时控件上要显示最新值。
  $('input-parent').addEventListener('change', paintComposerDetails);
  $('input-form').onsubmit = async event => {
    event.preventDefault();
    if (ui.composerSubmitting) return;
    ui.composerSubmitting = true; syncComposer();
    try {
      const value = $('input').value.trim();
      if (!value) return;
      const references = composerReferences();
      const signature = JSON.stringify(references);
      const branch = $('input-parent').value.trim();
      const result = await action('say.submit', { content: value, references, ...(branch ? { branch } : {}) });
      if ($('input').value.trim() === value) $('input').value = '';
      if (JSON.stringify(composerReferences()) === signature) setComposerReferences([]);
      show(`已创建 Task #${result.task.id}`);
      await refresh(); await detail(result.task.id);
    } catch (error) { show(error.message, 'error'); } finally { ui.composerSubmitting = false; syncComposer(); }
  };
  $('input').addEventListener('input', syncComposer);
  // 普通 Enter 换行；快捷键只发送当前正文，不误创建草稿。
  $('input').addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing || (!event.metaKey && !event.ctrlKey)) return;
    event.preventDefault(); $('input-form').requestSubmit();
  });
}
