import { $, button, el } from './dom.js';
import { workerKind } from './worker-kind.js';
import { action, api } from './api.js';
import { taskTitle, isHistoricalDelivery, TERMINAL_STATUS } from './format.js';
import { iterationBlocker } from './render-iteration.js';
import { show } from './messages.js';
import { detail, refresh } from './navigate.js';
import { ui } from './state.js';
import { composerReferences, renderComposerReferences, setComposerReferences } from './context-references.js';
import { agentHelp } from './help.js';
import { confirmDialog, closeDialog, formDialog } from './dialog.js';
import { createProfileForm } from './agent-profile-form.js';
import { normalizeConfigMode } from './agent-config-mode.js';
import { workerLabel } from './worker-label.js';

// 本条指令可选的运行设置：只打开设置，不调用 Agent；派生 Worker 由后端自动继承。
export const RUN_SETTINGS_HELP = '打开本条指令的运行设置：先选由 Lush 掌握配置，还是交给执行机器上用户自己的 Pi 默认配置。只打开设置，不调用 Agent；派生 Worker 自动继承本次选择，不逐个确认。';

/** 运行设置按钮文案：未选择覆盖时明确显示沿用项目默认。 */
export function runSettingsLabel() {
  if (!ui.composerProfile) return '运行设置：项目默认';
  return `运行设置：${normalizeConfigMode(ui.composerProfile.config_mode) === 'pi' ? 'Pi 默认配置' : 'Lush 配置'}`;
}

// 动态插入的按钮节点：DOM 测试的 stub 只能按 id 查静态元素，所以这里保留引用并统一经它重画。
let runSettingsButton = null;

export function paintRunSettings() {
  if (!runSettingsButton) return;
  runSettingsButton.textContent = runSettingsLabel();
  runSettingsButton.hidden = $('input-form')?.dataset.mode === 'append';
}

/**
 * 打开「本条指令的运行设置」弹窗：完整 Profile（Lush）或 Pi 默认模式，确认后只存在本次会话里，
 * 随下一次 order.submit 一起发送；取消或「恢复项目默认」不改变已有输入。
 */
export async function openComposerRunSettings() {
  const view = ui.view;
  const ownsPage = () => ui.view === view;
  if (!ownsPage()) return;
  let settings = ui.lastSnapshot?.status?.agent_config;
  if (!settings) {
    try { settings = await api('/api/agent/config'); }
    catch (error) { show(`无法读取项目 Agent 配置：${error.message}`, 'error'); return; }
  }
  if (!ownsPage() || !settings) return;
  const role = 'agent';
  const base = { ...(settings.resolved?.[role] || settings.default || {}) };
  const initial = ui.composerProfile ? { ...ui.composerProfile } : { ...base, config_mode: normalizeConfigMode(base.config_mode) };
  const form = createProfileForm({ profile: initial, settings, role, ownsPage });
  const content = el('div', undefined, 'retry-profile-form-wrap');
  content.append(form.node, el('p', '确认后，本条指令创建 Worker 时会带上这份运行设置；派生 Worker 自动继承，不逐个弹窗。', 'retry-scope-note'));
  let requestedDefault = false;
  const useDefault = button('恢复项目默认（本条不覆盖）', () => { requestedDefault = true; closeDialog(); }, 'ghost',
    { help: '本条指令改回沿用项目默认运行配置；不修改输入内容，也不调用 Agent' });
  content.append(useDefault);
  await form.ready;
  if (!ownsPage()) return;
  for (;;) {
    requestedDefault = false;
    const confirmed = await formDialog({
      title: '新建指令的运行设置', message: '默认使用 Lush 托管配置；也可以选择执行机器上用户自己的 Pi 默认配置。',
      content, confirmLabel: '使用这份设置', cancelLabel: '取消', agent: false,
      confirmHelp: '把这份运行设置固定给将要创建的那条指令；只保存设置，不调用 Agent、不创建 Worker。',
    });
    if (requestedDefault && ownsPage()) {
      ui.composerProfile = null; paintRunSettings();
      show('本条指令将沿用项目默认运行配置。'); return;
    }
    if (!confirmed || ui.view !== view) return;
    const error = form.validate();
    if (error) { show(error, 'error'); continue; }
    break;
  }
  const profile = form.collect();
  const builtIn = form.builtInPrompt;
  const entered = form.defaultPromptValue();
  const nextDefault = entered === builtIn.trim() ? '' : entered;
  if (form.mode() !== 'pi' && nextDefault && nextDefault !== (initial.default_prompt || '')) {
    const accepted = await confirmDialog({ title: '用自定义 Prompt 创建指令？',
      message: '自定义内容会替换 Lush 内置 Worker 规则，只对这一条指令及其派生 Worker 生效。',
      detail: '可能影响：Worker API 使用、权限边界、子 Worker 协作、工作区安全和交付流程。',
      confirmLabel: '仍然使用', cancelLabel: '取消', danger: true, agent: false,
      confirmHelp: '把这份自定义 Prompt 固定给将要创建的指令。' });
    if (!accepted || !ownsPage()) return;
  }
  ui.composerProfile = profile; paintRunSettings();
  show(`本条指令将使用${normalizeConfigMode(profile.config_mode) === 'pi' ? 'Pi 默认配置' : 'Lush 配置'}运行设置；创建 Worker 时生效。`);
}


// Historical panel helpers remain for legacy readers; new drafts live in #inputs.
export function paintDraftPanel() {
  const open = Boolean(ui.draftPanelOpen);
  $('draft-panel')?.classList.toggle('open', open);
  $('draft-toggle')?.setAttribute('aria-expanded', String(open));
}
export function toggleDraftPanel(force) {
  ui.draftPanelOpen = force === undefined ? !ui.draftPanelOpen : Boolean(force);
  paintDraftPanel();
}
// Legacy pure projection; the active composer uses the complete /api/input-parents read model.
export function parentTasks(tasks = []) {
  return tasks.filter(task => ['main', 'owner', 'order'].includes(workerKind(task)) && task.branch
    && ['queued', 'running', 'waiting', 'awaiting', 'awaiting_acceptance', 'paused'].includes(task.status)
    && !task.archived && !task.branch_archive?.archived && !task.branch_info?.archived && !task.freeze
    && !isHistoricalDelivery(task) && task.reservation?.status !== 'requested').sort((a, b) => a.id - b.id);
}
function creationTarget(branch, task = null) {
  const selected = task || ui.composerParents?.find(item => item.branch === branch);
  const freeze = selected?.freeze || selected?.branch_archive?.freeze
    || (ui.lastSnapshot?.status?.branch_freeze || []).find(item => item.branch === branch) || null;
  // A frozen root remains a valid identity for a deferred creation; missing/archived roots do not.
  const blocker = task ? iterationBlocker(task) : null;
  return { branch, task, freeze, reason: blocker && !/冻结/.test(blocker) ? blocker : null };
}
/** New work is the default on every page; only an explicit action selects an inbox. */
function destination() {
  if (!ui.composerAppendTarget) return creationTarget($('input-parent')?.value.trim() || 'main');
  const { id } = ui.composerAppendTarget;
  const task = ui.composerTask?.id === id ? ui.composerTask : null;
  if (!task) return { id, reason: ui.composerError || '正在读取 Worker；加载成功后才能输入。' };
  const reason = isHistoricalDelivery(task) || !['order', 'child'].includes(workerKind(task))
    ? '此 Worker 不支持追加输入。'
    : TERMINAL_STATUS.has(task.status)
      ? (task.status === 'completed' ? 'Worker 已完成；请先显式恢复开发。' : 'Worker 已结束；请先重试。')
      : iterationBlocker(task);
  return { id, task, reason };
}
function selectedParentLabel() {
  const select = $('input-parent');
  if (!select?.value) return null;
  const option = [...select.children].find(node => node.value === select.value);
  return option?.dataset.label ?? option?.textContent ?? select.value;
}
/** Select the current Worker without sending anything or discarding a draft. */
export function appendToWorker(task) {
  if (ui.view?.id !== 'task' || ui.selected !== task.id) return;
  ui.composerTask = task;
  ui.composerAppendTarget = { id: task.id };
  syncComposer();
  $('input').focus();
}
export function resetComposerMode() {
  ui.composerAppendTarget = null;
  syncComposer();
  $('input').focus();
}
export function paintComposerDetails() {
  const open = Boolean(ui.composerExpanded) && !ui.composerAppendTarget;
  if ($('composer-details')) $('composer-details').hidden = !open;
  if ($('composer-shortcuts')) $('composer-shortcuts').hidden = !open;
  const toggle = $('composer-expand');
  if (!toggle) return;
  const parent = selectedParentLabel();
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('data-help', open ? '收起：只留输入与操作按钮。' : `展开：可以选择父 Worker，并查看键盘快捷键${parent ? `（当前父 Worker：${parent}）` : ''}。`);
  toggle.textContent = open ? '⌃ 收起' : (parent ? `⌃ 更多 · 父 Worker：${parent}` : '⌃ 更多');
}
export function renderParentOptions() {
  const select = $('input-parent');
  if (!select) return;
  const tasks = ui.composerParents ?? [];
  const signature = JSON.stringify(tasks);
  if (select.dataset.signature === signature) { paintComposerDetails(); return; }
  select.dataset.signature = signature;
  const previous = select.value;
  const placeholder = el('option', 'main（默认父 Worker）'); placeholder.value = '';
  const options = tasks.map(task => {
    const option = el('option', `${workerLabel(task)} ${taskTitle(task)} · ${task.branch}${task.freeze ? ' · 冻结，可预约' : ''}`);
    option.value = task.branch; option.dataset.label = `${workerLabel(task)} ${taskTitle(task)}`;
    return option;
  });
  if (previous && !tasks.some(task => task.branch === previous)) {
    const missing = el('option', `${previous}（父 Worker 已不可选，请重选）`); missing.value = previous; options.push(missing);
  }
  select.replaceChildren(placeholder, ...options); select.value = previous || '';
  paintComposerDetails();
}
export function loadComposerParents() {
  const identity = ui.composerIdentity;
  if (!identity) return Promise.resolve();
  if (identity.parentsPending) return identity.parentsPending;
  const current = () => ui.composerIdentity === identity;
  identity.parentsPending = (async () => {
    try {
      const data = await api('/api/input-parents');
      if (!current()) return;
      if (!Array.isArray(data.items)) throw new Error('父 Worker 列表格式不兼容');
      ui.composerParents = data.items; syncComposer();
    } catch (error) { if (current()) show(`父 Worker 列表读取失败：${error.message}`, 'error'); }
    finally { identity.parentsPending = null; }
  })();
  return identity.parentsPending;
}
export function toggleComposerDetails(force) {
  ui.composerExpanded = force === undefined ? !ui.composerExpanded : Boolean(force);
  paintComposerDetails();
  if (ui.composerExpanded) return loadComposerParents();
}
export function syncComposer() {
  renderParentOptions();
  const target = destination(), followup = target.id != null;
  const input = $('input');
  const label = followup ? `Worker ${workerLabel(target.task || target.id)}` : target.task
    ? `Worker ${workerLabel(target.task)} · ${target.branch}` : selectedParentLabel() || 'main';
  $('input-form').dataset.mode = followup ? 'append' : 'create';
  $('input-form').dataset.blocked = String(Boolean(target.reason));
  const modeText = {
    'composer-mode-icon': followup ? '↳' : '＋',
    'composer-mode-title': followup ? '继续当前 Worker' : '新建独立 Worker',
    'composer-mode-target': followup ? `追加到 ${label}${target.task ? ` · ${taskTitle(target.task)}` : ''}` : `父 Worker：${label}`,
    'composer-mode-behavior': target.reason || (followup
      ? `不创建新 Worker · Enter 追加 · 空白时 Esc 返回${target.task.status === 'paused' ? ' · 暂停中，需开始 / 继续后处理' : ''}`
      : target.freeze ? `父分支冻结：${target.freeze.reason || '等待安全边界'} · Enter 暂存 · 点击预约后自动发射`
        : '独立工作区 · Enter 暂存 · 点击创建后待开始'),
  };
  // Keep mode/destination visible while typing, without repeating live announcements on every keystroke.
  for (const [id, text] of Object.entries(modeText)) {
    const node = $(id);
    if (node.textContent !== text) node.textContent = text;
  }
  input.placeholder = target.reason ? `${label}：${target.reason}` : followup
    ? `追加给 ${label} · Enter 发送 · Shift+Enter 换行${target.task.status === 'paused' ? ' · 暂停中，需开始 / 继续后处理' : ''}`
    : target.freeze ? `在 ${label} 挂载预约发射 Hook · Enter 暂存 · Ctrl/⌘+Enter 预约仅创建`
      : `在 ${label} 下创建子 Worker · Enter 暂存 · Ctrl/⌘+Enter 仅创建 · Shift+Enter 换行`;
  input.setAttribute('aria-label', input.placeholder);
  input.disabled = Boolean(target.reason);
  const disabled = Boolean(ui.composerSubmitting || target.reason) || !input.value.trim();
  $('draft-commit').disabled = disabled;
  $('draft-commit').classList.add('agent-call');
  $('draft-commit').textContent = followup ? '追加输入' : target.freeze ? '预约发射 Worker' : '创建 Worker';
  $('draft-commit').classList.toggle('hook-button', Boolean(!followup && target.freeze));
  const help = agentHelp(target.reason || (followup
    ? `追加给 ${label}，不创建新 Worker；运行中会在安全边界处理，暂停中需显式开始 / 继续。`
    : target.freeze ? `挂载到 ${label} 的可创建安全点 Hook；现在只保存正文、引用和完整运行参数，不创建 Worker 或调用 Agent。解除全部冻结并通过创建准入后，按当时父提交创建并开始；Ctrl/⌘+Enter 预约仅创建。`
      : `在 ${label} 下创建独立 Worker；默认待开始，Ctrl/⌘+Shift+Enter 直接开始。`));
  $('draft-commit').setAttribute('data-help', help);
  $('input-send-help')?.setAttribute('data-help', help);
  if ($('input-buffer')) { $('input-buffer').disabled = disabled; $('input-buffer').hidden = followup; }
  if ($('input-buffer-help')) $('input-buffer-help').hidden = followup;
  // Details are only for choosing the parent of a new Worker, not for changing an inbox destination.
  if (followup) {
    $('composer-details').hidden = true; $('composer-shortcuts').hidden = true;
  }
  $('composer-expand').hidden = followup;
  $('composer-reset').hidden = !followup;
  paintRunSettings();
}

/** One flight across buffering, button submission and all keyboard shortcuts. */
async function submitInput(mode) {
  const input = $('input'), value = input.value, content = value.trim();
  if (ui.composerSubmitting || !content) return;
  const identity = ui.composerIdentity, editRevision = ui.composerEditRevision, view = ui.view;
  const appendTarget = ui.composerAppendTarget;
  const referenceRevision = ui.composerReferenceRevision;
  const creationProfile = ui.composerProfile;
  const references = composerReferences(), signature = JSON.stringify(references);
  const target = destination(), branch = target.branch;
  if (target.reason) { show(target.reason, 'error'); return; }
  if (target.id != null && mode === 'buffer') return;
  ui.composerSubmitting = true; syncComposer();
  try {
    if (target.id != null && references.length) throw new Error('追加输入暂不支持引用附件；引用已保留，请先移除引用，或回到新建 Worker 模式暂存 / 创建带引用的新 Worker。');
    if (branch && branch !== 'main' && !target.task && !ui.composerParents?.some(task => task.branch === branch)) throw new Error('所选父 Worker 已不可用，请展开输入区重新选择。');
    const params = { content, references, ...(branch ? { branch } : {}) };
    const result = target.id != null
      ? await action('worker.message', { id: target.id, body: content })
      : await action(mode === 'buffer' ? 'draft.add' : 'order.submit', mode === 'buffer' ? params
        : { ...params, start: mode === 'start' || mode === 'defer_start', ...(target.freeze ? { defer: true } : {}), ...(creationProfile ? { profile: creationProfile } : {}) });
    if (ui.composerIdentity !== identity) return;
    // Never consume text or references authored while the request was in flight (even an edit-and-undo).
    const untouched = ui.view === view && ui.composerAppendTarget === appendTarget && ui.composerEditRevision === editRevision && input.value === value
      && ui.composerReferenceRevision === referenceRevision && JSON.stringify(composerReferences()) === signature;
    if (untouched) { input.value = ''; setComposerReferences([]); }
    if (target.id != null) {
      show(`已追加给 Worker ${workerLabel(target.task)}${target.task.status === 'paused' ? '；开始 / 继续后处理' : ''}。`);
      if (ui.view === view && ui.composerAppendTarget === appendTarget) await detail(target.id);
    } else if (mode === 'buffer') {
      show(`已暂存输入 #${result.id}，可到「历史输入」编辑或发射；未创建 Worker、未调用 Agent。`);
      ui.inputsPage?.added?.();
    } else {
      // Only consume the submitted selection; a newly edited override belongs to the next input.
      if (ui.composerProfile === creationProfile) ui.composerProfile = null;
      paintRunSettings();
      if (result.deferred) {
        show(`已在父 Worker ${workerLabel(result.parent_id)} 挂载预约 Hook；尚未创建 Worker。首个可创建安全点将${mode === 'start' || mode === 'defer_start' ? '创建并开始' : '仅创建'}。`);
        await refresh();
        if (ui.composerIdentity === identity && ui.view === view && ui.composerAppendTarget === appendTarget) await detail(result.parent_id);
      } else {
        show(mode === 'start' || mode === 'defer_start' ? `已创建并开始 Worker ${workerLabel(result.task)}` : `已创建 Worker ${workerLabel(result.task)}（待开始），可配置后开始`);
        await refresh();
        if (ui.composerIdentity === identity && ui.view === view && ui.composerAppendTarget === appendTarget) await detail(result.task.id);
      }
    }
  } catch (error) { if (ui.composerIdentity === identity) show(error.message, 'error'); }
  finally { if (ui.composerIdentity === identity) { ui.composerSubmitting = false; syncComposer(); } }
}
export function buffer() { return submitInput('buffer'); }

/** Enter buffers new work or appends in a Worker inbox; Shift+Enter always inserts a newline. */
export function initComposer() {
  ui.composerIdentity = {}; ui.composerEditRevision = 0; ui.syncComposer = syncComposer;
  ui.composerAppendTarget = null;
  // 每次装配（含 boot 重跑）都从项目默认开始，不让上一条指令的运行设置跨会话残留。
  ui.composerProfile = null;
  runSettingsButton = button(runSettingsLabel(), () => openComposerRunSettings(), 'ghost composer-run-settings', { help: RUN_SETTINGS_HELP });
  runSettingsButton.id = 'composer-run-settings'; runSettingsButton.dataset.composerRunSettings = '';
  const anchor = $('input-buffer-help');
  const host = anchor?.parentNode ?? $('composer-shell') ?? null;
  // 重复 boot 时先移除上次装的按钮，避免入口重复。
  host?.querySelector?.('.composer-run-settings')?.remove?.();
  if (anchor?.parentNode) anchor.parentNode.insertBefore(runSettingsButton, anchor);
  else host?.append(runSettingsButton);
  const sendHelp = agentHelp('发送后创建独立 Worker；默认先停在「待开始」，可配置后开始。⌘ / Ctrl+Shift+Enter 直接开始。');
  $('draft-commit').setAttribute('data-help', sendHelp);
  $('input-send-help')?.setAttribute('data-help', sendHelp);
  renderComposerReferences();
  $('composer-expand').onclick = () => toggleComposerDetails();
  $('composer-reset').onclick = resetComposerMode;
  if ($('input-buffer')) $('input-buffer').onclick = buffer;
  renderParentOptions();
  $('input-parent').onchange = syncComposer;
  $('input-form').onsubmit = event => { event.preventDefault(); return submitInput(ui.composerStartNow ? 'start' : destination().freeze ? 'defer_start' : 'create'); };
  $('input').oninput = () => { ui.composerEditRevision++; syncComposer(); };
  let composing = false;
  $('input').oncompositionstart = () => { composing = true; };
  $('input').oncompositionend = () => { composing = false; };
  $('input').onkeydown = event => {
    if (composing || event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      if (ui.composerAppendTarget && !event.repeat && !$('input').value.trim() && !composerReferences().length) {
        event.preventDefault(); resetComposerMode();
      }
      return;
    }
    if (event.key !== 'Enter') return;
    if (event.altKey) return;
    if (!event.metaKey && !event.ctrlKey && event.shiftKey) return;
    event.preventDefault();
    if (event.repeat) return;
    if (!event.metaKey && !event.ctrlKey) return destination().id != null ? submitInput('create') : buffer();
    return submitInput(event.shiftKey ? 'start' : 'create');
  };
  syncComposer();
  return loadComposerParents();
}
