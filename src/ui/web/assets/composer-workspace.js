import { $, button, el } from './dom.js';
import { ui } from './state.js';
import { api } from './api.js';
import { taskTitle } from './format.js';
import { workerLabel } from './worker-label.js';
import { composerReferences, setComposerReferences } from './context-references.js';
import { show } from './messages.js';

const workspace = () => ui.composerWorkspace;
export const currentEdit = () => workspace()?.active;
const destinationKey = ({ mode, target_id, branch = 'main' }) => mode === 'append' ? `append:${target_id}` : mode === 'order' ? `order:${branch}` : 'management';
const hasContent = entry => Boolean(entry?.content?.trim() || entry?.references?.length || entry?.saved || entry?.localOptions?.conditions?.length || entry?.localOptions?.exclusive || entry?.profile || entry?.expanded || entry?.large);
export function rememberComposer() {
  const entry = currentEdit(); if (!entry) return;
  Object.assign(entry, { content: $('input').value, references: composerReferences(), profile: ui.composerManagement ? ui.composerManagementProfile : ui.composerProfile,
    expanded: ui.composerExpanded, large: workspace().large, scroll: $('input').scrollTop,
    selection: [$('input').selectionStart, $('input').selectionEnd], panelScroll: $('composer-shell').scrollTop });
}
function applyEntry(entry) {
  const space = workspace(); space.active = entry; space.menu = false; space.read++;
  ui.composerManagement = entry.mode === 'management';
  ui.composerAppendTarget = entry.mode === 'append' ? { id: entry.target_id, task: entry.task } : null;
  ui.composerProfile = entry.mode === 'order' ? entry.profile : null;
  ui.composerManagementProfile = entry.mode === 'management' ? entry.profile : null;
  ui.composerExpanded = Boolean(entry.expanded); space.large = Boolean(entry.large);
  $('input-parent').value = entry.branch === 'main' ? '' : entry.branch || '';
  $('input').value = entry.content || ''; ui.composerEditRevision++;
  space.resetEditor?.(); setComposerReferences(entry.references || []);
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
  if (!entry) { entry = { ...spec, key: dest, destination: dest, content: '', references: [], request: {} }; space.entries.set(dest, entry); }
  if (task) entry.task = task;
  applyEntry(entry); if (open) openComposer();
}
export function openComposer({ focus = true } = {}) {
  const space = workspace(); if (!space) return;
  space.chosen = true; space.open = true; space.menu = false; paintComposerWorkspace();
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
export function toggleComposerMenu() {
  const space = workspace(); if (!space) return;
  space.menu = !space.menu; paintComposerWorkspace();
  if (space.menu) $('composer-menu').querySelector('button:not([hidden])')?.focus?.();
}
export function paintComposerWorkspace() {
  const space = workspace(); if (!space) return;
  const active = space.active, shell = $('composer-shell'), input = $('input');
  shell.dataset.open = String(space.open); shell.dataset.large = String(space.large);
  $('input-form').hidden = !space.open;
  $('composer-menu').hidden = !space.menu;
  const task = currentWorker(), append = $('composer-menu-append');
  append.hidden = !task; append.textContent = task ? `追加 ${workerLabel(task)} · ${taskTitle(task)}` : '追加当前 Worker';
  const launcher = $('composer-launcher');
  launcher.textContent = space.open ? '⌄' : space.menu ? '×' : '＋';
  launcher.setAttribute('aria-expanded', String(space.open || space.menu));
  const pending = Boolean(input.value.trim() || composerReferences().length || active?.saved || [...space.entries.values()].some(hasContent));
  launcher.dataset.pending = String(pending);
  launcher.setAttribute('aria-label', space.open ? '收起输入' : pending ? '恢复未完成输入' : '选择输入方式');
  launcher.setAttribute('data-help', space.open ? '收起面板并隐藏软键盘；本页保留文字、引用、设置与滚动位置，不代表已保存到服务器。' : '选择新建工作、追加当前 Worker 或管理 Lush；有未完成编辑时一次恢复，不提交或调用 Agent。');
  $('composer-large').textContent = space.large ? '紧凑编辑' : '扩大编辑';
  $('composer-large').setAttribute('aria-expanded', String(space.large));
  $('composer-project').textContent = `项目：${$('project')?.textContent || '当前项目'}`;
  const management = active?.mode === 'management';
  $('composer-resume').hidden = management || Boolean(input.value.trim() || composerReferences().length || active?.saved);
  $('composer-choose-draft').hidden = management;
  $('composer-draft-status').textContent = active?.saved ? `草稿 #${active.saved.id} · 版本 ${active.saved.revision ?? '旧版'} · ${active.saved.content === input.value && JSON.stringify(active.saved.references) === JSON.stringify(composerReferences()) ? '正文与引用已保存' : '有本地修改，尚未保存'}`
    : '未暂存的编辑仅保留在本页，刷新或关闭页面会丢失';
  $('composer-draft-status').hidden = !space.open || !pending;
  const source = active?.saved || active?.localOptions;
  const options = source ? { conditions: source.conditions || [], exclusive: source.exclusive } : null;
  $('composer-condition-summary').hidden = !options || !options.conditions.length && !options.exclusive;
  $('composer-condition-summary').textContent = options ? `执行条件：${options.conditions.map(condition => `${({ worker_settled: '工作安全收尾', worker_merged: '本轮成果已合入 main', parent_quiet: '父 Worker 静息' })[condition.kind] || condition.kind}${condition.worker_id ? ` ${workerLabel(condition.worker_id)}` : ''}`).join('、') || '安全准入'}${options.exclusive ? ' · 独占' : ''}（保留原条件；在草稿页可调整）` : '';
  $('input-parent').disabled = Boolean(active?.saved || ui.composerSubmitting);
  $('input-parent-help').textContent = active?.saved ? '续写绑定原草稿父 Worker；如需改投，请在草稿页显式更改。切换方式不会携带此正文改投。' : '新 Worker 从所选父 Worker 的分支创建独立 worktree；更换父 Worker 会打开该去向的独立编辑。';
  $('composer-switch').setAttribute('aria-expanded', String(space.menu));
  for (const id of ['composer-menu-order', 'composer-menu-append', 'composer-menu-management', 'composer-choose-draft', 'composer-resume']) $(id).disabled = Boolean(ui.composerSubmitting);
}
function targetOfEntry(entry) {
  return { mode: entry.mode, target_id: entry.target_id, branch: entry.branch,
    parent_id: entry.saved?.parent_id ?? ui.composerParents?.find(parent => parent.branch === entry.branch)?.id };
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
  list.hidden = false; list.replaceChildren(el('p', '正在检索本项目同模式、同目标的全部未发送暂存…', 'hint'));
  try {
    if (entry.mode === 'order' && target.parent_id == null) throw new Error('父 Worker 身份尚未读取或已失效，请稍后重试；不会改投其他父 Worker');
    const { editableDraft, matchesDraft, matchingDrafts } = await import('./draft-editor.js');
    if (!current()) return;
    const records = await matchingDrafts(target, current); if (!current() || !records) return;
    const local = [...space.entries.values()].filter(item => item.destination === entry.destination && item !== entry && hasContent(item));
    const load = async record => {
      if (!current()) return;
      try {
        const key = `draft:${record.id}`;
        let chosen = space.entries.get(key);
        if (!chosen) {
          const full = await api(`/api/input/draft/${record.id}`); if (!current()) return;
          if (!editableDraft(full) || !matchesDraft(full, target) || typeof full.content !== 'string' || !Array.isArray(full.references))
            throw new Error('此草稿已授权、已发送、去向改变或版本不完整；不会覆盖本地内容');
          chosen = { ...entry, key, saved: full, content: full.content, references: full.references, profile: null, scroll: 0, selection: null, request: {} };
          space.entries.set(key, chosen);
        }
        rememberComposer(); space.last.set(entry.destination, key); applyEntry(chosen); openComposer();
      } catch (error) { if (current()) show(error.message, 'error'); }
    };
    if (latest && records.length) { await load(records[0]); return; }
    list.replaceChildren(el('p', records.length || local.length ? '选择暂存；当前编辑仍保留在本页，不会被覆盖。' : '已查完：此模式与目标没有可编辑的未发送暂存。授权等待、结果未知及已发送记录不在此列。', 'hint'));
    for (const item of local) list.append(button(`本页未完成 · ${item.saved ? `草稿 #${item.saved.id}` : '未暂存'} · ${item.content.slice(0, 60)}`, () => {
      if (!current()) return; rememberComposer(); space.last.set(entry.destination, item.key); applyEntry(item); openComposer();
    }, 'ghost'));
    for (const record of records) list.append(button(`草稿 #${record.id} · ${record.content.slice(0, 80)}`, () => load(record), 'ghost'));
  } catch (error) { if (current()) { list.replaceChildren(el('p', `暂存读取失败：${error.message}；未能确认是否有可续写内容。`, 'hint')); show(error.message, 'error'); } }
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
  ui.composerWorkspace = { entries: new Map(), last: new Map(), active: null, open: false, menu: false, large: false, read: 0, serial: 0, resetEditor };
  const space = workspace(), entry = { key: 'order:main', destination: 'order:main', mode: 'order', branch: 'main', content: $('input').value, references: composerReferences(), request: {} };
  space.active = entry; space.entries.set(entry.key, entry);
  ui.openComposer = openComposer; ui.collapseComposer = collapseComposer;
  $('composer-launcher').onclick = () => {
    if (space.open) collapseComposer();
    else if (space.menu) { space.menu = false; paintComposerWorkspace(); }
    else { rememberComposer(); if (space.chosen || hasContent(space.active)) openComposer(); else toggleComposerMenu(); }
  };
  $('composer-switch').onclick = toggleComposerMenu;
  $('composer-menu-order').onclick = () => selectComposerMode('order');
  $('composer-menu-management').onclick = () => selectComposerMode('management');
  $('composer-menu-append').onclick = () => { const task = currentWorker(); if (task) selectComposerMode('append', task); };
  $('composer-menu').onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); space.menu = false; paintComposerWorkspace(); $('composer-launcher').focus(); } };
  $('composer-large').onclick = () => { space.large = !space.large; paintComposerWorkspace(); };
  $('composer-resume').onclick = () => resumeComposerDraft(true);
  $('composer-choose-draft').onclick = () => resumeComposerDraft(false);
  paintComposerWorkspace();
}
