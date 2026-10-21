import { $, button, el } from './dom.js';
import { ui } from './state.js';
import { api, action } from './api.js';
import { confirmDialog } from './dialog.js';
import { workerLabel } from './worker-label.js';
import { isValet } from './work-type.js';
import { composerReferences, setComposerReferences } from './context-references.js';
import { show } from './messages.js';
import { draftLabel } from './draft-label.js';
import { destinationKey, hasContent, loadComposerCache, cacheComposerWorkspace } from './composer-cache.js';
import { projectApi } from './route.js';
import { composerDrafts, composerDraftChoices } from './composer-drafts.js';
import { paintDisclosure } from './view-controls.js';

const workspace = () => ui.composerWorkspace;
export const currentEdit = () => workspace()?.active;
function setDraftListExpanded(expanded) {
  $('composer-draft-list').hidden = !expanded;
  paintDisclosure($('composer-choose-draft'), expanded, {
    expand: '展开草稿', collapse: '收起草稿',
    help: expanded ? '隐藏草稿列表，保留当前编辑内容，不保存或提交。' : '展开本项目同模式全部目标的草稿，明确恢复原目标；等待或结果未知仅查看原收据，不重复授权。',
  });
}
function createEntry(spec) {
  const destination = destinationKey(spec);
  return { ...spec, key: destination, destination, content: '', references: [], request: {} };
}
export function rememberComposer() {
  const entry = currentEdit(); if (!entry) return;
  ui.inputEditor?.capture?.();
  Object.assign(entry, { content: $('input').value, references: composerReferences(), profile: ui.composerManagement ? ui.composerManagementProfile : ui.composerProfile,
    expanded: ui.composerExpanded, scroll: $('input').scrollTop,
    selection: [$('input').selectionStart, $('input').selectionEnd], panelScroll: $('composer-shell').scrollTop });
  if (entry.mode === 'order') entry.parent = ui.composerParents?.find(parent => parent.branch === entry.branch) || entry.parent;
  const space = workspace();
  // An append landing state has no savable definition until a target is explicitly selected.
  cacheComposerWorkspace({ ...space, entries: new Map([...space.entries].filter(([, item]) => item.mode !== 'append' || item.target_id != null)) });
}
export function applyEntry(entry) {
  const space = workspace(), changed = space.active !== entry; space.active = entry; space.menu = false; space.read++;
  ui.composerManagement = entry.mode === 'management';
  // Elevation is an explicit choice for one input, never part of a cached draft or mode restore.
  ui.composerElevated = false;
  ui.composerAppendTarget = entry.target_id != null ? { id: entry.target_id, task: entry.taskFresh === false ? null : entry.task } : null;
  ui.composerProfile = entry.mode === 'order' ? entry.profile : null;
  ui.composerManagementProfile = entry.mode === 'management' ? entry.profile : null;
  ui.composerExpanded = Boolean(entry.expanded);
  $('input-parent').value = entry.branch === 'main' ? '' : entry.branch || '';
  $('input').value = entry.content || ''; ui.composerEditRevision++;
  if (changed) space.resetEditor?.(entry); setComposerReferences(entry.references || []);
  $('input').scrollTop = entry.scroll || 0;
  if (entry.selection?.every(Number.isInteger)) $('input').setSelectionRange?.(...entry.selection);
  $('composer-shell').scrollTop = entry.panelScroll || 0;
  setDraftListExpanded(false); ui.inputEditor?.bind?.(); ui.syncComposer?.();
  if (entry.target_id != null && entry.taskFresh === false) void refreshEntryTarget(space, entry);
}
async function refreshEntryTarget(space, entry) {
  const target = ui.composerAppendTarget, project = projectApi('/api/');
  const current = () => workspace() === space && projectApi('/api/') === project && space.active === entry && ui.composerAppendTarget === target;
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
export async function selectComposerMode(mode, task = null, branch = 'main', { open = true, savedLeave = false } = {}) {
  const spaceBefore = workspace(), transition = spaceBefore && (spaceBefore.transition = (spaceBefore.transition || 0) + 1);
  if (!savedLeave && ui.inputEditor && !await ui.inputEditor.leave()) return;
  if (!spaceBefore || workspace() !== spaceBefore || spaceBefore.transition !== transition) return;
  if (ui.composerSubmitting && !savedLeave) { show('请求正在处理；编辑内容仍可修改，请稍后切换去向。'); return; }
  if (mode === 'append' && isValet(task)) mode = 'management';
  rememberComposer();
  const space = workspace(), spec = { mode, branch, ...(task ? { target_id: task.id, task } : {}) }, dest = destinationKey(spec);
  let entry = space.entries.get(space.last.get(dest) || dest);
  if (!entry) { entry = createEntry(spec); space.entries.set(entry.key, entry); space.last.set(dest, entry.key); }
  if (task) { entry.task = task; entry.taskFresh = true; (entry.request ||= {}).uncertain = false; entry.request.blocked = null; }
  applyEntry(entry); if (open) openComposer();
}
export function openComposer({ focus = true } = {}) {
  const space = workspace(); if (!space) return;
  if (ui.inputEditor?.inDetail) { if (focus) $('input').focus({ preventScroll: true }); return; }
  space.open = true; space.menu = false; paintComposerWorkspace();
  if (focus) $('input').focus({ preventScroll: true });
}
export async function collapseComposer({ savedLeave = false } = {}) {
  const space = workspace(); if (!space) return;
  const transition = space.transition = (space.transition || 0) + 1;
  if (!savedLeave && ui.inputEditor && !await ui.inputEditor.leave()) return;
  if (workspace() !== space || space.transition !== transition) return;
  ui.inputEditor?.portable?.();
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
const menuWorker = () => {
  const task = currentWorker() || (currentEdit()?.target_id != null && currentEdit().taskFresh !== false ? currentEdit().task : null);
  return isValet(task) ? null : task;
};
export function toggleComposerMenu() {
  const space = workspace(); if (!space) return;
  space.menu = !space.menu; paintComposerWorkspace();
  if (space.menu) {
    void refreshDraftCounts(space);
    $('composer-menu').querySelector('button:not([hidden])')?.focus?.();
  }
}
const liveEntry = entry => entry === currentEdit() ? { ...entry, content: $('input').value, references: composerReferences() } : entry;
function editStatus(entry) {
  if (entry.error) return `保存失败 · ${entry.error}`;
  if (entry.cached === false) return '浏览器恢复保存失败 · 当前编辑仍在';
  if (entry.saved) return entry.saved.content === entry.content && JSON.stringify(entry.saved.references) === JSON.stringify(entry.references)
    ? `项目已暂存 · ${draftLabel(entry.saved)}` : `有本地修改 · ${draftLabel(entry.saved)}`;
  return entry.key === currentEdit()?.key && workspace().open ? '编辑中 · 收起时保留在本浏览器' : '已保留在本浏览器';
}
function entryTarget(entry) {
  if (entry.mode === 'management') return entry.target_id != null ? `追加原管家 ${workerLabel(entry.task || entry.target_id, entry.saved?.target_worker_number)}` : '新管家 · 当前项目';
  if (entry.mode === 'append') return entry.target_id != null ? `追加 ${workerLabel(entry.task || entry.target_id, entry.saved?.target_worker_number)}` : '追加 · 尚未选择目标';
  const parent = ui.composerParents?.find(parent => parent.branch === entry.branch) || entry.parent;
  return `继续新建 · 父 ${entry.branch === 'main' ? 'main' : parent ? workerLabel(parent) : entry.branch}`;
}
const modes = ['order', 'append', 'management'];
async function refreshDraftCounts(space) {
  const project = projectApi('/api/'), read = space.countRead = (space.countRead || 0) + 1;
  const edit = space.active, revision = ui.composerEditRevision, refs = ui.composerReferenceRevision;
  const current = () => workspace() === space && projectApi('/api/') === project && space.countRead === read
    && space.active === edit && ui.composerEditRevision === revision && ui.composerReferenceRevision === refs;
  space.catalogue = {}; paintComposerWorkspace();
  await Promise.all(modes.map(async mode => {
    try {
      const records = await composerDrafts(mode, current);
      if (current() && records) space.catalogue[mode] = { records };
    } catch (error) { if (current()) space.catalogue[mode] = { error: error.message }; }
    if (current()) paintComposerWorkspace();
  }));
}
function paintPendingMenu(space, pending) {
  modes.forEach((mode, index) => {
    const category = $(`composer-menu-${mode}`), result = space.catalogue?.[mode];
    const count = result?.records ? composerDraftChoices(result.records, pending.filter(entry => entry.mode === mode)).length : null;
    const label = ['新建工作', '追加输入', '管理 Lush'][index];
    const text = count == null ? result?.error ? '草稿数未知 · 读取失败' : '草稿数读取中…' : `${count} 份草稿`;
    category.dataset.pending = String(count > 0);
    category.setAttribute('aria-label', `${label} · ${text}`);
    category.hidden = false;
    category.replaceChildren(el('span', label), el('span', text, 'composer-pending-count'));
  });
}
export function paintComposerWorkspace() {
  const space = workspace(); if (!space) return;
  const active = space.active, shell = $('composer-shell'), input = $('input');
  shell.dataset.open = String(space.open);
  $('input-form').hidden = !space.open && !ui.inputEditor?.inDetail;
  shell.dataset.detail = String(Boolean(ui.inputEditor?.inDetail));
  $('composer-menu').hidden = !space.menu;
  const pendingEntries = [...space.entries.values()].map(liveEntry).filter(hasContent);
  paintPendingMenu(space, pendingEntries);
  const launcher = $('composer-launcher');
  launcher.textContent = space.open ? '⌄' : space.menu ? '×' : '＋';
  launcher.setAttribute('aria-expanded', String(space.open || space.menu));
  const pending = pendingEntries.length > 0 || modes.some(mode => space.catalogue?.[mode]?.records?.length);
  launcher.dataset.pending = String(pending);
  launcher.setAttribute('aria-label', `${space.open ? '收起输入' : '选择输入方式'}${pending ? ' · 有未发送草稿' : ''}`);
  launcher.setAttribute('data-help', space.open ? '自动保存此条项目草稿后收起；失败则保留编辑并阻止收起。浏览器恢复仅作断网与关闭兜底，不提交或调用 Agent。' : '选择输入方式；黄点表示有未完成输入，菜单仅显示三种输入状态和本项目草稿数，进入编辑器后可选择原目标的草稿。只打开编辑，不提交或调用 Agent。');
  const projectName = $('project')?.textContent || '当前项目';
  $('composer-project').textContent = projectName;
  $('composer-project').setAttribute('data-help', `本条输入属于项目：${projectName}。`);
  const management = active?.mode === 'management';
  $('composer-resume').hidden = Boolean(input.value.trim() || composerReferences().length || active?.saved);
  $('composer-choose-draft').hidden = false;
  setDraftListExpanded(!$('composer-draft-list').hidden);
  $('composer-remove-draft-help').hidden = $('composer-remove-draft').hidden = !ui.inputEditor?.inDetail || !active?.saved;
  $('composer-remove-draft').disabled = Boolean(ui.composerSubmitting);
  $('composer-remove-draft-help').setAttribute('data-help', ui.composerSubmitting ? '请求正在处理，请稍后再删除；不会重复提交。' : '经确认后永久删除当前未发送草稿及对应浏览器恢复内容；请求期间的新编辑会保留，不删除已发送输入或 Worker。');
  const source = active?.localOptions || active?.saved;
  const options = source ? { conditions: source.conditions || [], exclusive: source.exclusive } : null;
  const customProfile = Boolean(active?.profile), elevated = Boolean(ui.composerElevated);
  $('composer-condition-summary').hidden = !options?.conditions.length && !options?.exclusive && !customProfile && !elevated;
  $('composer-condition-summary').textContent = [options?.conditions.length ? `条件 ${options.conditions.length}` : '', options?.exclusive ? '独占' : '', customProfile ? '本条设置' : '', elevated ? '管理员' : ''].filter(Boolean).join(' · ');
  $('composer-condition-summary').setAttribute('data-help', `打开详细编辑核对${options?.conditions.length ? `执行条件：${options.conditions.map(condition => `${({ worker_settled: '工作安全收尾', worker_merged: '本轮成果已合入 main', parent_quiet: '父 Worker 静息' })[condition.kind] || condition.kind}${condition.worker_id ? ` ${workerLabel(condition.worker_id, condition.worker_number)}` : ''}`).join('、')}；` : ''}${options?.exclusive ? '独占会暂缓其它开发；' : ''}${customProfile ? '本条已选择运行设置；' : ''}${elevated ? '本条选择管理员权限，提交须重新验密；' : ''}仅查看，不提交或调用 Agent。`);
  $('input-parent').disabled = Boolean(ui.composerSubmitting);
  $('input-parent-help').textContent = '更改父 Worker 前先保存旧去向；明确选择后仍编辑同一草稿，提交时再次校验，不会静默改投 main。';
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
  if (ui.inputEditor && !await ui.inputEditor.leave()) return;
  const full = await api(`/api/input/draft/${record.id}`); if (!current()) return;
  if (full.id !== record.id || !editableDraft(full) || !matchesDraft(full, target) || typeof full.content !== 'string' || !Array.isArray(full.references))
    throw new Error('此草稿已授权、已发送、去向改变或版本不完整；不会覆盖本地内容');
  const key = `draft:${record.id}`;
  let chosen = space.entries.get(key);
  if (!chosen) {
    chosen = { mode: full.mode || 'order', branch: full.branch, target_id: full.target_id, task: null, taskFresh: false,
      destination: destinationKey(full), key, saved: full, content: full.content, references: full.references, localOptions: { conditions: full.conditions || [], exclusive: Boolean(full.exclusive) },
      profile: null, scroll: 0, selection: null, request: {} };
    space.entries.set(key, chosen);
  }
  if (!matchesDraft(full, targetOfEntry(chosen))) throw Error('本地草稿去向与项目版本不同，请在草稿详情核验；不会改投');
  rememberComposer(); space.last.set(chosen.destination, key); applyEntry(chosen); openComposer();
  return chosen;
}

/** Start only from an empty editor; recalled, unmodified drafts keep the CLI-style cursor alive. */
export function navigateComposerDraft(direction) {
  const space = workspace(), entry = currentEdit(), project = projectApi('/api/');
  if (!space || !entry || ui.composerSubmitting || $('input').disabled) return null;
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
  const current = () => workspace() === space && projectApi('/api/') === project && unchanged() && !ui.composerSubmitting;
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

/** Selection spans the mode, while quick/keyboard continuation retains the exact destination. */
export async function resumeComposerDraft(latest = true) {
  if (ui.composerSubmitting) return;
  rememberComposer();
  const space = workspace(), entry = currentEdit(), read = ++space.read, project = projectApi('/api/');
  const revision = ui.composerEditRevision, refs = ui.composerReferenceRevision;
  const current = () => workspace() === space && projectApi('/api/') === project && space.read === read && space.active === entry
    && ui.composerEditRevision === revision && ui.composerReferenceRevision === refs && !ui.composerSubmitting;
  const target = targetOfEntry(entry), list = $('composer-draft-list');
  setDraftListExpanded(true); list.replaceChildren(el('p', '正在检索本项目同模式全部目标的未发送草稿…', 'hint'));
  try {
    const { editableDraft, matchesDraft } = await import('./draft-editor.js');
    if (!current()) return;
    const records = await composerDrafts(entry.mode, current); if (!current() || !records) return;
    space.catalogue ||= {}; space.catalogue[entry.mode] = { records }; paintComposerWorkspace();
    const local = [...space.entries.values()].filter(item => item.mode === entry.mode && hasContent(item));
    const choices = composerDraftChoices(records, local);
    const load = async ({ record, entry: localEntry }) => {
      if (!current()) return;
      try {
        if (record) {
          if (!editableDraft(record)) {
            const { openInputs } = await import('./render-inputs.js');
            if (current()) await openInputs({ item: { kind: 'draft', id: record.id } });
          } else await loadComposerDraft(record, { space, entry, target: { mode: record.mode || 'order', target_id: record.target_id,
            parent_id: record.parent_id, branch: record.branch }, current });
        } else {
          if (ui.inputEditor && !await ui.inputEditor.leave() || !current()) return;
          rememberComposer(); space.last.set(localEntry.destination, localEntry.key); applyEntry(localEntry); openComposer();
        }
      } catch (error) { if (current()) show(error.message, 'error'); }
    };
    if (latest) {
      const choice = choices.find(choice => choice.record && editableDraft(choice.record) && matchesDraft(choice.record, target));
      if (choice) { await load(choice); return; }
    }
    list.replaceChildren(el('p', choices.length ? '选择草稿及其原目标；不会改投当前目标。等待或结果未知的条目只查看原收据。' : '已查完：本项目此模式没有未发送草稿。', 'hint'));
    for (const choice of choices) {
      const { record, entry: localEntry } = choice;
      const spec = localEntry || { ...record, saved: record }, readonly = record && !editableDraft(record);
      const row = button('', () => load(choice), 'ghost composer-draft-choice', {
        help: readonly ? '仅查看原授权收据，不恢复编辑或重复提交。' : '切换到此草稿的原目标与精确版本；当前编辑先自动保存，不提交或调用 Agent。' });
      row.dataset.editKey = localEntry?.key || `draft:${record.id}`;
      row.append(el('strong', `${record ? draftLabel(record) : '本地草稿'} · ${entryTarget(spec)}`),
        el('span', (localEntry?.content || record?.content || '').slice(0, 100), 'composer-draft-preview'),
        el('span', readonly ? `仅查看收据 · ${record.dispatch?.state || record.status || '状态待核验'}` : localEntry ? editStatus(localEntry) : '项目草稿 · 读取完整版本后编辑', 'composer-pending-status'));
      list.append(row);
    }
  } catch (error) { if (current()) { list.replaceChildren(el('p', `草稿读取失败：${error.message}；数量与内容未知，请重新选择草稿重试。`, 'hint')); show(error.message, 'error'); } }
}
/** Delete only the confirmed server identity/version; new typing survives as a detached local edit. */
export async function removeComposerDraft() {
  const space = workspace(), entry = currentEdit(), saved = entry?.saved;
  if (!saved || ui.composerSubmitting || !space.open && !ui.inputEditor?.inDetail) return;
  const input = $('input'), view = ui.view, read = ++space.read;
  const revision = ui.composerEditRevision, refs = ui.composerReferenceRevision;
  const content = input.value, signature = JSON.stringify(composerReferences()), profile = ui.composerProfile;
  const current = () => workspace() === space && currentEdit() === entry;
  space.history = null; setDraftListExpanded(false);
  entry.operation = 'remove'; ui.composerSubmitting = true; ui.syncComposer?.();
  try {
    const { editableDraft, draftOptions } = await import('./draft-editor.js');
    if (!current() || space.read !== read || ui.view !== view || !space.open && !ui.inputEditor?.inDetail) return;
    if (!editableDraft(saved)) throw new Error('草稿已授权、已发送或版本不完整，不能删除；请先核验草稿状态');
    const confirmed = await confirmDialog({ title: `删除${draftLabel(saved)}？`,
      message: '永久删除这条未发送草稿、引用及对应浏览器恢复内容，无法恢复；当前未保存的修改也会清空。确认或请求期间产生的新编辑将保留，不删除已发送输入或 Worker。',
      confirmLabel: '删除草稿', danger: true, confirmHelp: '永久删除当前草稿及对应浏览器恢复内容；不会调用 Agent。' });
    if (!confirmed || !current() || space.read !== read || ui.view !== view || !space.open && !ui.inputEditor?.inDetail) return;
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
  finally { entry.operation = null; if (workspace() === space) { ui.composerSubmitting = false; ui.syncComposer?.(); } }
}

export function finishComposerEdit({ consume, detached = false, saved = null, options = null } = {}) {
  const space = workspace(), entry = currentEdit(); if (!entry) return;
  space.catalogue = null; space.countRead = (space.countRead || 0) + 1;
  if (consume || detached) {
    ui.composerElevated = false;
    space.entries.delete(entry.key);
    entry.key = space.entries.has(entry.destination) ? `${entry.destination}:local:${++space.serial}` : entry.destination;
    entry.saved = null; entry.request = {}; entry.localOptions = detached ? options : null;
    if (consume) { entry.content = ''; entry.references = []; entry.profile = null; }
    space.entries.set(entry.key, entry); space.last.set(entry.destination, entry.key);
    delete entry.session; delete entry.consumed; delete entry.creation; delete entry.conflict; delete entry.error;
    if (consume) space.resetEditor?.();
  } else if (saved) {
    space.entries.delete(entry.key); entry.saved = saved; entry.key = `draft:${saved.id}`;
    space.entries.set(entry.key, entry); space.last.set(entry.destination, entry.key);
  }
}
export function retargetComposerEntry(entry = currentEdit()) {
  const space = workspace(), previous = entry.destination, destination = destinationKey(entry);
  if (previous === destination) return;
  if (space.last.get(previous) === entry.key) space.last.delete(previous);
  entry.destination = destination;
  if (!entry.saved) { space.entries.delete(entry.key); entry.key = `local:${++space.serial}`; space.entries.set(entry.key, entry); }
  space.last.set(destination, entry.key); rememberComposer();
}
export async function activateComposerDraft(record, { current = () => true } = {}) {
  const spaceBefore = workspace(), transition = spaceBefore && (spaceBefore.transition = (spaceBefore.transition || 0) + 1);
  if (ui.inputEditor && !await ui.inputEditor.leave()) return false;
  if (!current() || workspace() !== spaceBefore || spaceBefore.transition !== transition) return false;
  rememberComposer();
  const space = workspace(), key = `draft:${record.id}`;
  let entry = space.entries.get(key);
  if (!entry) {
    entry = { ...createEntry({ mode: record.mode || 'order', branch: record.branch,
      target_id: record.target_id ?? null }), key, saved: record, content: record.content,
      references: record.references || [], localOptions: { conditions: record.conditions || [], exclusive: Boolean(record.exclusive) }, taskFresh: false };
    space.entries.set(key, entry);
  }
  space.last.set(entry.destination, key); applyEntry(entry); return true;
}
export async function newComposerEntry() {
  const spaceBefore = workspace(), transition = spaceBefore && (spaceBefore.transition = (spaceBefore.transition || 0) + 1);
  if (ui.inputEditor && !await ui.inputEditor.leave()) return false;
  if (!spaceBefore || workspace() !== spaceBefore || spaceBefore.transition !== transition) return false;
  rememberComposer();
  const space = workspace(), previous = currentEdit();
  const entry = createEntry({ mode: previous.mode, branch: previous.branch, target_id: previous.target_id, task: previous.task });
  entry.key = `${entry.destination}:local:${++space.serial}`;
  space.entries.set(entry.key, entry); space.last.set(entry.destination, entry.key); applyEntry(entry); openComposer(); return true;
}
export function initComposerWorkspace({ resetEditor }) {
  ui.composerWorkspace = { ...loadComposerCache(), active: null, open: false, menu: false, read: 0, resetEditor };
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
  $('composer-menu-append').onclick = () => selectComposerMode('append', menuWorker());
  $('composer-menu').onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); space.menu = false; paintComposerWorkspace(); $('composer-launcher').focus(); } };
  $('composer-resume').onclick = () => resumeComposerDraft(true);
  $('composer-choose-draft').onclick = () => {
    if (ui.composerSubmitting) return;
    if ($('composer-draft-list').hidden) return resumeComposerDraft(false);
    space.read++; // Invalidate an in-flight lookup before hiding its list.
    setDraftListExpanded(false);
  };
  $('composer-remove-draft').onclick = removeComposerDraft;
  paintComposerWorkspace();
}
