import { $, el } from './dom.js';
import { action } from './api.js';
import { show } from './messages.js';
import { ui } from './state.js';
import { composerReferences, renderComposerReferences, setComposerReferences } from './context-references.js';
import { matchInputRoute } from './input-routes.js';

// 待提交意图：只落库不规划；可改、可移除，可单条执行，也可一次性全部逐条执行。
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
// 按钮的可用性同时看输入框与待提交意图：都没内容就没什么可执行的。
export function syncComposer() {
  const busy = Boolean(ui.composerSubmitting);
  $('draft-commit').disabled = busy || (!$('input').value.trim() && ui.draftIds.length === 0);
  $('draft-add').disabled = busy;
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
/** 接上输入框与操作按钮：回车=缓存，⌘/Ctrl+回车=全部执行，Shift+回车=换行。 */
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
  $('input-form').onsubmit = async event => {
    event.preventDefault();
    if (ui.composerSubmitting) return;
    ui.composerSubmitting = true; syncComposer();
    try {
      // 正文先暂存：不带 ids 的整体执行会把刚缓存的这条一起逐条提交。
      if ($('input').value.trim()) await buffer();
      const branch = $('input-branch').value.trim();
      const result = await action('draft.commit', { ...(branch ? { branch } : {}) });
      const inputs = result.inputs || [];
      const routed = inputs.filter(input => input.route);
      const hits = routed.map(input => {
        const target = input.route.target;
        const task = input[target] ?? input.task;
        return `${input.route.prefix} → ${target} #${task.id}`;
      });
      const planners = inputs.length - routed.length;
      const summary = [`已逐条执行 ${inputs.length} 条`];
      if (hits.length) summary.push(`快速路由命中 ${hits.length} 条（${hits.join('、')}）`);
      if (planners) summary.push(`${planners} 条交给 planner 拆解任务并建依赖`);
      show(summary.join('；'));
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
  // 回车=缓存，⌘/Ctrl+回车=全部执行，Shift+回车=换行。
  $('input').addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing || event.shiftKey) return;
    event.preventDefault();
    if (event.metaKey || event.ctrlKey) $('input-form').requestSubmit(); else $('draft-add').click();
  });
}
