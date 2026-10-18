import { $, button, el } from './dom.js';
import { ui } from './state.js';
import { api, action } from './api.js';
import { confirmDialog } from './dialog.js';
import { taskTitle } from './format.js';
import { workerLabel } from './worker-label.js';
import { waitingFirstInput } from './worker-create.js';
import { composerReferences, setComposerReferences } from './context-references.js';
import { show } from './messages.js';
import { draftLabel } from './draft-label.js';
import { destinationKey, hasContent, loadComposerCache, cacheComposerWorkspace } from './composer-cache.js';

const workspace = () => ui.composerWorkspace;
export const currentEdit = () => workspace()?.active;
function createEntry(spec) {
  const destination = destinationKey(spec);
  return { ...spec, key: destination, destination, content: '', references: [], request: {} };
}
export function rememberComposer() {
  const entry = currentEdit(); if (!entry) return;
  Object.assign(entry, { content: $('input').value, references: composerReferences(), profile: ui.composerManagement ? ui.composerManagementProfile : ui.composerProfile,
    expanded: ui.composerExpanded, scroll: $('input').scrollTop,
    selection: [$('input').selectionStart, $('input').selectionEnd], panelScroll: $('composer-shell').scrollTop });
  if (entry.mode === 'order') entry.parent = ui.composerParents?.find(parent => parent.branch === entry.branch) || entry.parent;
  cacheComposerWorkspace(workspace());
}
function applyEntry(entry) {
  const space = workspace(), changed = space.active !== entry; space.active = entry; space.menu = false; space.read++;
  ui.composerManagement = entry.mode === 'management';
  ui.composerAppendTarget = entry.mode === 'append' ? { id: entry.target_id, task: entry.taskFresh === false ? null : entry.task } : null;
  ui.composerProfile = entry.mode === 'order' ? entry.profile : null;
  ui.composerManagementProfile = entry.mode === 'management' ? entry.profile : null;
  ui.composerExpanded = Boolean(entry.expanded);
  $('input-parent').value = entry.branch === 'main' ? '' : entry.branch || '';
  $('input').value = entry.content || ''; ui.composerEditRevision++;
  if (changed) space.resetEditor?.(); setComposerReferences(entry.references || []);
  $('input').scrollTop = entry.scroll || 0;
  if (entry.selection?.every(Number.isInteger)) $('input').setSelectionRange?.(...entry.selection);
  $('composer-shell').scrollTop = entry.panelScroll || 0;
  $('composer-draft-list').hidden = true; ui.syncComposer?.();
  if (entry.mode === 'append' && entry.taskFresh === false) void refreshEntryTarget(space, entry);
}
async function refreshEntryTarget(space, entry) {
  const target = ui.composerAppendTarget, read = space.read;
  const current = () => workspace() === space && space.active === entry && space.read === read && ui.composerAppendTarget === target;
  try {
    const task = await api(`/api/worker/${entry.target_id}`);
    if (!current()) return;
    if (task?.id !== entry.target_id) throw Error('Worker 身份不匹配');
    entry.task = task; entry.taskFresh = true; target.task = task; ui.syncComposer?.();
  } catch (error) {
    if (!current()) return;
    target.error = `原目标读取失败：${error.message}；内容保留，不会改投。请重新选择此条目重试。`;
    ui.syncComposer?.(); show(target.error, 'error');
  }
}
export function selectComposerMode(mode, task = null, branch = 'main', { open = true } = {}) {
  if (ui.composerSubmitting) { show('请求正在处理；编辑内容仍可修改，请稍后切换去向。'); return; }
  if (mode === 'append' && !Number.isSafeInteger(task?.id)) return;
  rememberComposer();
  const space = workspace(), spec = { mode, branch, ...(task ? { target_id: task.id, task } : {}) }, dest = destinationKey(spec);
  let entry = space.entries.get(space.last.get(dest) || dest);
  if (!entry) { entry = createEntry(spec); space.entries.set(entry.key, entry); space.last.set(dest, entry.key); }
  if (task) { entry.task = task; entry.taskFresh = true; }
  applyEntry(entry); if (open) openComposer();
}
export function openComposer({ focus = true } = {}) {
  const space = workspace(); if (!space) return;
  space.open = true; space.menu = false; paintComposerWorkspace();
  if (focus) $('input').focus({ preventScroll: true });
}
export function collapseComposer() {
  const space = workspace(); if (!space) return;
  const wasOpen = space.open || space.menu;
  rememberComposer(); space.open = false; space.menu = false; space.read++;
  if ($('composer-shell').contains?.(document.activeElement) || document.activeElement === $('input')) document.activeElement?.blur?.();
  $('input').blur?.(); paintComposerWorkspace();
  if (wasOpen) $('composer-launcher').focus({ preventScroll: true });
}
function currentWorker() {
  const task = ui.composerTask;
  return task && ui.selected === task.id && (ui.view?.id === 'task' || ui.view?.id === 'task-graph' && ui.taskGraphIds?.has(task.id)) ? task : null;
}
// Away from Worker detail, an explicitly pinned inbox remains a valid named menu destination.
const menuWorker = () => currentWorker() || (currentEdit()?.mode === 'append' && currentEdit().taskFresh !== false ? currentEdit().task : null);
export function toggleComposerMenu() {
  const space = workspace(); if (!space) return;
  space.menu = !space.menu; paintComposerWorkspace();
  if (space.menu) $('composer-menu').querySelector('button:not([hidden])')?.focus?.();
}
const liveEntry = entry => entry === currentEdit() ? { ...entry, content: $('input').value, references: composerReferences() } : entry;
function editStatus(entry) {
  if (entry.cached === false) return '浏览器自动保存失败 · 刷新前请暂存或复制';
  if (entry.saved) return entry.saved.content === entry.content && JSON.stringify(entry.saved.references) === JSON.stringify(entry.references)
    ? `项目已暂存 · ${draftLabel(entry.saved)}` : `有本地修改 · ${draftLabel(entry.saved)}`;
  return entry.key === currentEdit()?.key && workspace().open ? '编辑中 · 收起时保留在本浏览器' : '已保留在本浏览器';
}
function entryTarget(entry) {
  if (entry.mode === 'management') return '继续管理 · 当前项目';
  if (entry.mode === 'append') return `继续追加 ${workerLabel(entry.task || entry.target_id)}`;
  const parent = ui.composerParents?.find(parent => parent.branch === entry.branch) || entry.parent;
  return `继续新建 · 父 ${entry.branch === 'main' ? 'main' : parent ? workerLabel(parent) : entry.branch}`;
}
function paintPendingMenu(space, pending, task) {
  const modes = ['append', 'order', 'management'];
  const labels = [task ? `${waitingFirstInput(task) ? '输入工作指令' : '追加'} ${workerLabel(task)} · ${taskTitle(task)}` : '追加输入', '新建工作 · 默认 main', '管理 Lush · 当前项目'];
  modes.forEach((mode, index) => {
    const items = pending.filter(entry => entry.mode === mode), category = $(`composer-menu-${mode}`), list = $(`composer-pending-${mode}`);
    const text = `${labels[index]}${items.length ? ` · ${items.length} 条未完成` : ''}`;
    category.dataset.pending = String(Boolean(items.length));
    category.setAttribute('aria-label', text);
    if (category.dataset.label !== text) {
      category.dataset.label = text;
      const count = el('span', items.length ? `${items.length} 条未完成` : '', 'composer-pending-count'); count.hidden = !items.length;
      category.replaceChildren(el('span', labels[index]), count);
    }
    if (mode === 'append') {
      category.hidden = !task;
      const summary = $('composer-pending-append-summary'); summary.hidden = Boolean(task) || !items.length;
      summary.textContent = `追加输入 · ${items.length} 条未完成`;
    }
    list.hidden = !items.length;
    const signature = JSON.stringify([ui.composerSubmitting, items.map(entry => [entry.key, entryTarget(entry), entry.content, entry.references.length, editStatus(entry)])]);
    if (list.dataset.signature === signature) return;
    list.dataset.signature = signature; list.replaceChildren();
    for (const entry of items) {
      const row = button('', () => {
        if (ui.composerSubmitting || workspace() !== space) return;
        const chosen = space.entries.get(entry.key); if (!chosen) return;
        rememberComposer(); space.last.set(chosen.destination, chosen.key); applyEntry(chosen); openComposer();
      }, 'ghost composer-pending-entry', { help: '恢复此条编辑及其原目标、引用和设置；当前编辑会保留，不提交或调用 Agent。' });
      row.dataset.editKey = entry.key;
      const status = editStatus(entry), title = entryTarget(entry);
      const body = entry.content.trim().replace(/\s+/g, ' ') || (entry.references.length ? `${entry.references.length} 条引用` : '空正文草稿');
      row.setAttribute('aria-label', `${title} · ${body.slice(0, 80)} · ${status}`);
      row.append(el('strong', title), el('span', body, 'composer-pending-preview'), el('span', status, entry.cached === false ? 'composer-pending-status failed' : 'composer-pending-status'));
      row.disabled = Boolean(ui.composerSubmitting); list.append(row);
    }
  });
  $('composer-menu-note').hidden = !pending.length;
}
export function paintComposerWorkspace() {
  const space = workspace(); if (!space) return;
  const active = space.active, shell = $('composer-shell'), input = $('input');
  shell.dataset.open = String(space.open);
  $('input-form').hidden = !space.open;
  $('composer-menu').hidden = !space.menu;
  const task = menuWorker();
  const pendingEntries = [...space.entries.values()].map(liveEntry).filter(hasContent);
  paintPendingMenu(space, pendingEntries, task);
  const launcher = $('composer-launcher');
  launcher.textContent = space.open ? '⌄' : space.menu ? '×' : '＋';
  launcher.setAttribute('aria-expanded', String(space.open || space.menu));
  const pending = pendingEntries.length > 0;
  launcher.dataset.pending = String(pending);
  launcher.setAttribute('aria-label', `${space.open ? '收起输入' : '选择输入方式'}${pending ? ` · 有 ${pendingEntries.length} 条未完成输入` : ''}`);
  launcher.setAttribute('data-help', space.open ? '收起面板并隐藏软键盘；自动保存文字、引用、设置与位置到当前浏览器，不提交或调用 Agent。' : '选择输入方式；黄点表示有未完成输入，菜单按类别列出原目标、摘要与保存状态。只恢复编辑，不提交或调用 Agent。');
  $('composer-project').textContent = `项目：${$('project')?.textContent || '当前项目'}`;
  const management = active?.mode === 'management';
  $('composer-resume').hidden = management || Boolean(input.value.trim() || composerReferences().length || active?.saved);
  $('composer-choose-draft').hidden = management;
  $('composer-remove-draft-help').hidden = $('composer-remove-draft').hidden = management || !active?.saved;
  $('composer-remove-draft').disabled = Boolean(ui.composerSubmitting);
  $('composer-remove-draft-help').setAttribute('data-help', ui.composerSubmitting ? '请求正在处理，请稍后再删除；不会重复提交。' : '经确认后永久删除当前未发送草稿及对应浏览器恢复内容；请求期间的新编辑会保留，不删除已发送输入或 Worker。');
  $('composer-draft-status').textContent = active?.cached === false ? '浏览器自动保存失败；本页编辑仍在，刷新前请手动暂存或复制原文' : active?.saved ? `${draftLabel(active.saved)} · 版本 ${active.saved.revision ?? '旧版'} · ${active.saved.content === input.value && JSON.stringify(active.saved.references) === JSON.stringify(composerReferences()) ? '正文与引用已保存' : '有本地修改，尚未保存'}`
    : '未手动暂存；收起时自动保存到当前浏览器，不进入项目草稿';
  $('composer-draft-status').hidden = !space.open || !hasContent(liveEntry(active));
  const source = active?.saved || active?.localOptions;
  const options = source ? { conditions: source.conditions || [], exclusive: source.exclusive } : null;
  $('composer-condition-summary').hidden = !options || !options.conditions.length && !options.exclusive;
  $('composer-condition-summary').textContent = options ? `执行条件：${options.conditions.map(condition => `${({ worker_settled: '工作安全收尾', worker_merged: '本轮成果已合入 main', parent_quiet: '父 Worker 静息' })[condition.kind] || condition.kind}${condition.worker_id ? ` ${workerLabel(condition.worker_id)}` : ''}`).join('、') || '安全准入'}${options.exclusive ? ' · 独占' : ''}（保留原条件；在草稿页可调整）` : '';
  $('input-parent').disabled = Boolean(active?.saved || ui.composerSubmitting);
  $('input-parent-help').textContent = active?.saved ? '续写绑定原草稿父 Worker；如需改投，请在草稿页显式更改。选择其他类别不会携带此正文改投。' : '新 Worker 从所选父 Worker 的分支创建独立 worktree；更换父 Worker 会打开该去向的独立编辑。';
  for (const id of ['composer-menu-order', 'composer-menu-append', 'composer-menu-management', 'composer-choose-draft', 'composer-resume']) $(id).disabled = Boolean(ui.composerSubmitting);
}
function targetOfEntry(entry) {
  return { mode: entry.mode, target_id: entry.target_id, branch: entry.branch,
    parent_id: entry.saved?.parent_id ?? ui.composerParents?.find(parent => parent.branch === entry.branch)?.id };
}
/** Restore the complete identity, never just copy the preview into a new input. */
async function loadComposerDraft(record, { space, entry, target, current }) {
  const { editableDraft, matchesDraft } = await import('./draft-editor.js');
  if (!current()) return;
  const full = await api(`/api/input/draft/${record.id}`); if (!current()) return;
  if (!editableDraft(full) || !matchesDraft(full, target) || typeof full.content !== 'string' || !Array.isArray(full.references))
    throw new Error('此草稿已授权、已发送、去向改变或版本不完整；不会覆盖本地内容');
  const key = `draft:${record.id}`;
  let chosen = space.entries.get(key);
  if (!chosen) {
    chosen = { ...entry, key, saved: full, content: full.content, references: full.references, profile: null, scroll: 0, selection: null, request: {} };
    space.entries.set(key, chosen);
  }
  rememberComposer(); space.last.set(entry.destination, key); applyEntry(chosen); openComposer();
  return chosen;
}

/** Start only from an empty editor; recalled, unmodified drafts keep the CLI-style cursor alive. */
export function navigateComposerDraft(direction) {
  const space = workspace(), entry = currentEdit();
  if (!space || !entry || entry.mode === 'management' || ui.composerSubmitting || $('input').disabled) return null;
  let history = space.history;
  const unchanged = () => space.history === history && space.active === history.entry && space.read === history.read
    && ui.composerEditRevision === history.revision && ui.composerReferenceRevision === history.refs;
  if (!history || !unchanged()) {
    space.history = null;
    if ($('input').value || composerReferences().length || entry.saved) return null;
    if (direction < 0) return Promise.resolve();
    history = { origin: entry, entry, read: space.read, revision: ui.composerEditRevision, refs: ui.composerReferenceRevision, index: -1 };
    space.history = history;
  }
  if (history.pending) return history.pending;
  const current = () => workspace() === space && unchanged() && !ui.composerSubmitting;
  history.pending = (async () => {
    try {
      const target = targetOfEntry(entry);
      if (!history.records) {
        if (entry.mode === 'order' && target.parent_id == null) throw new Error('父 Worker 身份尚未读取或已失效，请稍后重试；不会改投其他父 Worker');
        const { matchingDrafts } = await import('./draft-editor.js'); if (!current()) return;
        const records = await matchingDrafts(target, current); if (!current() || !records) return;
        history.records = records;
      }
      const index = Math.max(-1, Math.min(history.records.length - 1, history.index + direction));
      if (index === history.index) return;
      if (index === -1) {
        rememberComposer(); space.last.set(entry.destination, history.origin.key); applyEntry(history.origin); openComposer();
      } else if (!await loadComposerDraft(history.records[index], { space, entry, target, current })) return;
      history.index = index; history.entry = currentEdit(); history.read = space.read;
      history.revision = ui.composerEditRevision; history.refs = ui.composerReferenceRevision;
    } catch (error) {
      if (current()) { space.history = null; show(`草稿读取失败：${error.message}；当前编辑已保留。`, 'error'); }
    }
  })().finally(() => { history.pending = null; });
  return history.pending;
}

/** Both empty-editor continuation and selection read the complete same-project destination scope. */
export async function resumeComposerDraft(latest = true) {
  if (ui.composerSubmitting || currentEdit()?.mode === 'management') return;
  rememberComposer();
  const space = workspace(), entry = currentEdit(), read = ++space.read;
  const revision = ui.composerEditRevision, refs = ui.composerReferenceRevision;
  const current = () => workspace() === space && space.read === read && space.active === entry
    && ui.composerEditRevision === revision && ui.composerReferenceRevision === refs && !ui.composerSubmitting;
  const target = targetOfEntry(entry), list = $('composer-draft-list');
  list.hidden = false; list.replaceChildren(el('p', '正在检索本项目同模式、同目标的全部未发送草稿…', 'hint'));
  try {
    if (entry.mode === 'order' && target.parent_id == null) throw new Error('父 Worker 身份尚未读取或已失效，请稍后重试；不会改投其他父 Worker');
    const { matchingDrafts } = await import('./draft-editor.js');
    if (!current()) return;
    const records = await matchingDrafts(target, current); if (!current() || !records) return;
    const local = [...space.entries.values()].filter(item => item.destination === entry.destination && item !== entry && hasContent(item));
    const load = async record => {
      if (!current()) return;
      try { await loadComposerDraft(record, { space, entry, target, current }); }
      catch (error) { if (current()) show(error.message, 'error'); }
    };
    if (latest && records.length) { await load(records[0]); return; }
    list.replaceChildren(el('p', records.length || local.length ? '选择草稿；当前编辑仍保留在本页，不会被覆盖。' : '已查完：此模式与目标没有可编辑的未发送草稿。授权等待、结果未知及已发送记录不在此列。', 'hint'));
    for (const item of local) list.append(button(`本页未完成 · ${item.saved ? draftLabel(item.saved) : '未暂存'} · ${item.content.slice(0, 60)}`, () => {
      if (!current()) return; rememberComposer(); space.last.set(entry.destination, item.key); applyEntry(item); openComposer();
    }, 'ghost'));
    for (const record of records) list.append(button(`${draftLabel(record)} · ${record.content.slice(0, 80)}`, () => load(record), 'ghost'));
  } catch (error) { if (current()) { list.replaceChildren(el('p', `草稿读取失败：${error.message}；未能确认是否有可续写内容。`, 'hint')); show(error.message, 'error'); } }
}
/** Delete only the confirmed server identity/version; new typing survives as a detached local edit. */
export async function removeComposerDraft() {
  const space = workspace(), entry = currentEdit(), saved = entry?.saved;
  if (!saved || entry.mode === 'management' || ui.composerSubmitting || !space.open) return;
  const input = $('input'), view = ui.view, read = ++space.read;
  const revision = ui.composerEditRevision, refs = ui.composerReferenceRevision;
  const content = input.value, signature = JSON.stringify(composerReferences()), profile = ui.composerProfile;
  const current = () => workspace() === space && currentEdit() === entry;
  space.history = null; $('composer-draft-list').hidden = true;
  ui.composerSubmitting = true; ui.syncComposer?.();
  try {
    const { editableDraft, draftOptions } = await import('./draft-editor.js');
    if (!current() || space.read !== read || ui.view !== view || !space.open) return;
    if (!editableDraft(saved)) throw new Error('草稿已授权、已发送或版本不完整，不能删除；请先核验草稿状态');
    const confirmed = await confirmDialog({ title: `删除${draftLabel(saved)}？`,
      message: '永久删除这条未发送草稿、引用及对应浏览器恢复内容，无法恢复；当前未保存的修改也会清空。确认或请求期间产生的新编辑将保留，不删除已发送输入或 Worker。',
      confirmLabel: '删除草稿', danger: true, confirmHelp: '永久删除当前草稿及对应浏览器恢复内容；不会调用 Agent。' });
    if (!confirmed || !current() || space.read !== read || ui.view !== view || !space.open) return;
    const result = await action('draft.remove', { id: saved.id, expected_revision: saved.revision }, { refresh: false });
    if (!current()) return;
    if (result.id !== saved.id) throw new Error('删除响应缺少可靠草稿身份；请核验草稿列表，本地内容保留，不会自动重试');
    const untouched = ui.composerEditRevision === revision && ui.composerReferenceRevision === refs
      && input.value === content && JSON.stringify(composerReferences()) === signature && ui.composerProfile === profile;
    if (untouched) {
      input.value = ''; ui.composerEditRevision++; setComposerReferences([]); ui.composerProfile = null;
      finishComposerEdit({ consume: true });
    } else finishComposerEdit({ detached: true, options: draftOptions(saved) });
    rememberComposer();
    show(`${draftLabel(saved)}已删除。${untouched ? '对应输入已清空。' : '新编辑已保留为未暂存输入，再次暂存会创建新草稿。'}${entry.cached === false ? '浏览器恢复内容未能更新，旧缓存可能仍存在；新编辑刷新前请复制保留。' : untouched ? '对应浏览器恢复内容已清空。' : ''}`, entry.cached === false ? 'error' : 'info');
    ui.draftsPage?.added?.();
  } catch (error) { if (current()) show(`删除失败：${error.message}；编辑内容已保留。`, 'error'); }
  finally { if (workspace() === space) { ui.composerSubmitting = false; ui.syncComposer?.(); } }
}

export function finishComposerEdit({ consume, detached = false, saved = null, options = null } = {}) {
  const space = workspace(), entry = currentEdit(); if (!entry) return;
  if (consume || detached) {
    space.entries.delete(entry.key);
    entry.key = space.entries.has(entry.destination) ? `${entry.destination}:local:${++space.serial}` : entry.destination;
    entry.saved = null; entry.request = {}; entry.localOptions = detached ? options : null;
    if (consume) { entry.content = ''; entry.references = []; entry.profile = null; }
    space.entries.set(entry.key, entry); space.last.set(entry.destination, entry.key);
    if (consume) space.resetEditor?.();
  } else if (saved) {
    space.entries.delete(entry.key); entry.saved = saved; entry.key = `draft:${saved.id}`;
    space.entries.set(entry.key, entry); space.last.set(entry.destination, entry.key);
  }
}
export function initComposerWorkspace({ resetEditor }) {
  ui.composerWorkspace = { ...loadComposerCache(), active: null, open: false, menu: false, read: 0, resetEditor };
  for (const mode of ['append', 'order', 'management']) $(`composer-pending-${mode}`).dataset.signature = '';
  const space = workspace(), entry = space.entries.get(space.last.get('order:main') || 'order:main') || createEntry({ mode: 'order', branch: 'main' });
  if ($('input').value || composerReferences().length) Object.assign(entry, { content: $('input').value, references: composerReferences() });
  space.entries.set(entry.key, entry); space.last.set(entry.destination, entry.key); applyEntry(entry);
  ui.openComposer = openComposer; ui.collapseComposer = collapseComposer;
  $('composer-launcher').onclick = () => {
    if (space.open) collapseComposer();
    else if (space.menu) { space.menu = false; paintComposerWorkspace(); }
    else toggleComposerMenu();
  };
  $('composer-menu-order').onclick = () => selectComposerMode('order');
  $('composer-menu-management').onclick = () => selectComposerMode('management');
  $('composer-menu-append').onclick = () => { const task = menuWorker(); if (task) selectComposerMode('append', task); };
  $('composer-menu').onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); space.menu = false; paintComposerWorkspace(); $('composer-launcher').focus(); } };
  $('composer-resume').onclick = () => resumeComposerDraft(true);
  $('composer-choose-draft').onclick = () => resumeComposerDraft(false);
  $('composer-remove-draft').onclick = removeComposerDraft;
  paintComposerWorkspace();
}
