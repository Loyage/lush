import { $, button, el } from './dom.js';
import { ui } from './state.js';
import { api } from './api.js';
import { taskTitle } from './format.js';
import { workerLabel } from './worker-label.js';
import { composerReferences, setComposerReferences } from './context-references.js';
import { show } from './messages.js';
import { readStored, writeStored, scopedKey } from './prefs.js';

const workspace = () => ui.composerWorkspace;
export const currentEdit = () => workspace()?.active;
const destinationKey = ({ mode, target_id, branch = 'main' }) => mode === 'append' ? `append:${target_id}` : mode === 'order' ? `order:${branch}` : 'management';
const hasContent = entry => Boolean(entry?.content?.trim() || entry?.references?.length || entry?.saved || entry?.localOptions?.conditions?.length || entry?.localOptions?.exclusive || entry?.profile || entry?.expanded);
const cacheKey = destination => scopedKey(`lush.composer.edit.v1:${encodeURIComponent(destination)}`);
function cacheEntry(entry) {
  const { content, references, profile, expanded, scroll, selection, panelScroll, saved, localOptions, request } = entry;
  const ok = writeStored(cacheKey(entry.destination), JSON.stringify(hasContent(entry)
    ? { version: 1, content, references, profile, expanded, scroll, selection, panelScroll, saved, localOptions, request } : null));
  if (!ok) show('浏览器自动保存失败；编辑仍保留在本页，刷新前请手动暂存或复制原文。', 'error');
  entry.cached = ok;
}
function createEntry(spec) {
  const destination = destinationKey(spec);
  const entry = { ...spec, key: destination, destination, content: '', references: [], request: {} };
  try {
    const value = JSON.parse(readStored(cacheKey(destination)) || 'null');
    if (!value) return entry;
    if (value.version !== 1 || typeof value.content !== 'string' || value.content.length > 32000 || !Array.isArray(value.references))
      throw new Error('自动保存格式不完整');
    if (value.saved && (!Number.isSafeInteger(value.saved.id) || value.saved.id <= 0 || destinationKey(value.saved) !== destination))
      throw new Error('自动保存的草稿去向不匹配');
    Object.assign(entry, value, { cached: true, key: value.saved ? `draft:${value.saved.id}` : destination });
  } catch { show('浏览器自动保存读取失败；不会覆盖当前输入或改投其他目标。', 'error'); }
  return entry;
}
export function rememberComposer() {
  const entry = currentEdit(); if (!entry) return;
  Object.assign(entry, { content: $('input').value, references: composerReferences(), profile: ui.composerManagement ? ui.composerManagementProfile : ui.composerProfile,
    expanded: ui.composerExpanded, scroll: $('input').scrollTop,
    selection: [$('input').selectionStart, $('input').selectionEnd], panelScroll: $('composer-shell').scrollTop });
  cacheEntry(entry);
}
function applyEntry(entry) {
  const space = workspace(), changed = space.active !== entry; space.active = entry; space.menu = false; space.read++;
  ui.composerManagement = entry.mode === 'management';
  ui.composerAppendTarget = entry.mode === 'append' ? { id: entry.target_id, task: entry.task } : null;
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
}
export function selectComposerMode(mode, task = null, branch = 'main', { open = true } = {}) {
  if (ui.composerSubmitting) { show('请求正在处理；编辑内容仍可修改，请稍后切换去向。'); return; }
  if (mode === 'append' && !Number.isSafeInteger(task?.id)) return;
  rememberComposer();
  const space = workspace(), spec = { mode, branch, ...(task ? { target_id: task.id, task } : {}) }, dest = destinationKey(spec);
  let entry = space.entries.get(space.last.get(dest) || dest);
  if (!entry) { entry = createEntry(spec); space.entries.set(entry.key, entry); space.last.set(dest, entry.key); }
  if (task) entry.task = task;
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
const menuWorker = () => currentWorker() || (currentEdit()?.mode === 'append' ? currentEdit().task : null);
export function toggleComposerMenu() {
  const space = workspace(); if (!space) return;
  space.menu = !space.menu; paintComposerWorkspace();
  if (space.menu) $('composer-menu').querySelector('button:not([hidden])')?.focus?.();
}
export function paintComposerWorkspace() {
  const space = workspace(); if (!space) return;
  const active = space.active, shell = $('composer-shell'), input = $('input');
  shell.dataset.open = String(space.open);
  $('input-form').hidden = !space.open;
  $('composer-menu').hidden = !space.menu;
  const task = menuWorker(), append = $('composer-menu-append');
  append.hidden = !task; append.textContent = task ? `追加 ${workerLabel(task)} · ${taskTitle(task)}` : '追加当前 Worker';
  const launcher = $('composer-launcher');
  launcher.textContent = space.open ? '⌄' : space.menu ? '×' : '＋';
  launcher.setAttribute('aria-expanded', String(space.open || space.menu));
  const pending = Boolean(input.value.trim() || composerReferences().length || active?.saved || [...space.entries.values()].some(hasContent));
  launcher.dataset.pending = String(pending);
  launcher.setAttribute('aria-label', space.open ? '收起输入' : '选择输入方式');
  launcher.setAttribute('data-help', space.open ? '收起面板并隐藏软键盘；自动保存文字、引用、设置与位置到当前浏览器，不提交或调用 Agent。' : '选择新建工作、追加当前 Worker 或管理 Lush；按类别和目标恢复浏览器自动保存的编辑，不提交或调用 Agent。');
  $('composer-project').textContent = `项目：${$('project')?.textContent || '当前项目'}`;
  const management = active?.mode === 'management';
  $('composer-resume').hidden = management || Boolean(input.value.trim() || composerReferences().length || active?.saved);
  $('composer-choose-draft').hidden = management;
  $('composer-draft-status').textContent = active?.cached === false ? '浏览器自动保存失败；本页编辑仍在，刷新前请手动暂存或复制原文' : active?.saved ? `草稿 #${active.saved.id} · 版本 ${active.saved.revision ?? '旧版'} · ${active.saved.content === input.value && JSON.stringify(active.saved.references) === JSON.stringify(composerReferences()) ? '正文与引用已保存' : '有本地修改，尚未保存'}`
    : '未手动暂存；收起时自动保存到当前浏览器，不进入项目草稿';
  $('composer-draft-status').hidden = !space.open || !pending;
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
    for (const item of local) list.append(button(`本页未完成 · ${item.saved ? `草稿 #${item.saved.id}` : '未暂存'} · ${item.content.slice(0, 60)}`, () => {
      if (!current()) return; rememberComposer(); space.last.set(entry.destination, item.key); applyEntry(item); openComposer();
    }, 'ghost'));
    for (const record of records) list.append(button(`草稿 #${record.id} · ${record.content.slice(0, 80)}`, () => load(record), 'ghost'));
  } catch (error) { if (current()) { list.replaceChildren(el('p', `草稿读取失败：${error.message}；未能确认是否有可续写内容。`, 'hint')); show(error.message, 'error'); } }
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
  ui.composerWorkspace = { entries: new Map(), last: new Map(), active: null, open: false, menu: false, read: 0, serial: 0, resetEditor };
  const space = workspace(), entry = createEntry({ mode: 'order', branch: 'main' });
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
  paintComposerWorkspace();
}
