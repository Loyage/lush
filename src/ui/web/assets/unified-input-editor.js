import { $, el, button } from './dom.js';
import { ui } from './state.js';
import { api, projectApi } from './api.js';
import { show } from './messages.js';
import { registerPageLeaveGuard } from './page-leave-guard.js';
import { createEmissionConditions, createEmissionWorkerPicker } from './emission-form.js';
import { createInputSession, draftValues } from './input-session.js';
import { composerReferences, setComposerReferences } from './context-references.js';
import { draftLabel } from './draft-label.js';
import { editableDraft } from './draft-editor.js';
import { isValet } from './work-type.js';
import { createDraftConditionValet } from './draft-condition-valet.js';
import { createDraftRunSettings } from './draft-run-settings.js';

/** The form and textarea are MOVED, never cloned. Hosts have no editable state or submit lock. */
export function createUnifiedInputEditor({ authorize, accepted, history, sync, workspace, onCreated = () => {} }) {
  const { currentEdit, rememberComposer, finishComposerEdit, activateComposerDraft, newComposerEntry, paintComposerWorkspace, openComposer, retargetComposerEntry, applyEntry } = workspace;
  const form = $('input-form'), shell = $('composer-shell'), input = $('input'), details = $('composer-details'), scope = projectApi('/api/');
  const managementSettings = $('composer-management-settings');
  let bound = null, conditions = null, conditionValet = null, picker = null, detailHost = null, origin = null, generation = 0, hostGeneration = 0, disposed = false, composing = false, receiptPresenter = null;
  const owns = () => !disposed && projectApi('/api/') === scope && ui.inputEditor === controller;
  const advanced = el('div', undefined, 'unified-editor-advanced');
  const target = el('div', undefined, 'unified-editor-target');
  const conditionSection = el('section', undefined, 'unified-editor-condition-section');
  const conditionHost = el('details', undefined, 'unified-editor-conditions'); conditionHost.open = false;
  conditionSection.append(conditionHost);
  const runtime = el('details', undefined, 'unified-editor-runtime'), runtimeSummary = el('summary', '运行设置');
  const runtimeBody = el('div', undefined, 'unified-editor-section-body'); runtime.append(runtimeSummary, runtimeBody);
  const extras = el('details', undefined, 'unified-editor-references'), extrasSummary = el('summary', '引用 · 0 条'); extras.append(extrasSummary);
  const emptyReferences = el('p', '暂无引用。', 'hint'); extras.append(emptyReferences);
  let runSettings = null, runEntry = null, runRequest = null, runTarget = null;
  function ensureRunSettings(entry = currentEdit()) {
    if (!entry) return;
    const targetKey = `${entry.mode}:${entry.target_id ?? ''}`;
    if (runEntry === entry && runRequest === entry.request && runTarget === targetKey) return;
    runSettings?.dispose(); runtime.open = false;
    runEntry = entry; runRequest = entry.request; runTarget = targetKey;
    const request = entry.request;
    runSettings = createDraftRunSettings({ entry,
      current: () => owns() && currentEdit() === entry && entry.request === request && `${entry.mode}:${entry.target_id ?? ''}` === targetKey,
      changed: () => {
        if (entry.mode === 'management') ui.composerManagementProfile = entry.profile;
        else ui.composerProfile = entry.profile;
        ui.composerEditRevision++; rememberComposer(); sync();
      } });
    runtimeBody.replaceChildren(runSettings.node, managementSettings);
  }
  runtime.addEventListener('toggle', () => { if (runtime.open) void runSettings?.load(); });
  const error = el('section', undefined, 'unified-editor-recovery'); error.hidden = true; error.setAttribute('role', 'status');
  const errorText = el('p'), serverText = el('pre', undefined, 'input-original');
  const retry = button('重试保存', () => controller.save());
  const latest = button('读取服务器最新版', async () => { try { await session()?.latest(); paintRecovery(); } catch (e) { show(e.message, 'error'); } });
  const keep = button('以最新版为基线整理本地修改', () => reconcile(true), 'ghost', { help: '保留全部本地内容，明确以所显示的服务器版本为新基线；不会立即保存或覆盖服务器，请整理后再保存。' });
  const use = button('使用显示的服务器版本', () => reconcile(false), 'ghost', { help: '用上方显示的服务器版本替换本地编辑；未保存的本地正文保留在撤销历史中，不立即提交。' });
  const detachLocal = button('保留本地为新条目', () => {
    capture(); finishComposerEdit({ detached: true, options: currentEdit().localOptions });
    bound = null; bind(); rememberComposer(); sync();
  }, 'ghost', { help: '服务器草稿已不可编辑；显式把本地修改保留为新的未提交条目，旧草稿收据不变，不执行。' });
  detachLocal.hidden = true;
  error.append(errorText, retry, latest, serverText, keep, use, detachLocal);
  advanced.append(conditionSection, runtime, extras);
  form.insertBefore(target, form.querySelector('.composer-input'));
  form.insertBefore(advanced, form.querySelector('.composer-foot'));
  form.append(error);
  const receipt = button('收据', async () => {
    if (!ui.lastInputReceipt || !await controller.leave()) return;
    const { openInputs } = await import('./render-inputs.js');
    if (owns()) await openInputs({ item: { kind: 'draft', id: ui.lastInputReceipt.draft_id } });
  }, 'nav-link composer-receipt', { help: '查看最近一次提交的回执，不是当前编辑的保存状态，也不代表 Agent 已收到或执行完成；不会重新提交。' });
  receipt.setAttribute('aria-label', '查看最近一次提交收据');
  receipt.hidden = !ui.lastInputReceipt; ($('composer-meta') || form).append(receipt);
  const back = button('到底部继续编辑', () => controller.continuePortable(), 'nav-link');
  const fresh = button('新一条', async () => {
    if (!await newComposerEntry()) return;
    if (controller.inDetail) { const { openLocalInputEditor } = await import('./render-inputs.js'); if (owns()) await openLocalInputEditor(); }
  }, 'ghost composer-new', { help: '先保存当前条目，再开启同去向的新一条；原草稿保留，不提交或调用 Agent。' });
  fresh.setAttribute('aria-label', '写新的一条');
  $('composer-expand').parentNode?.append(fresh);
  // The DOM stub has independent id nodes; the browser always follows the static form hierarchy.
  if (!fresh.parentNode) form.append(fresh);
  runtimeBody.append(managementSettings);
  const refs = $('composer-references'); extras.append(refs);
  // Keep deletion in the existing action row; portable mode still hides it.
  function read() {
    const entry = currentEdit();
    return { content: input.value, references: composerReferences(), mode: entry.mode,
      ...(entry.mode === 'order' ? { branch: entry.branch } : { target_id: entry.target_id ?? null }),
      ...(entry.mode === 'management' ? { conditions: [], exclusive: false } : conditions?.collect() || entry.localOptions || { conditions: [], exclusive: false }) };
  }
  function capture() {
    const entry = currentEdit(); if (!entry || bound !== entry) return;
    entry.localOptions = entry.mode === 'management' ? { conditions: [], exclusive: false } : conditions?.collect() || entry.localOptions;
    entry.content = input.value; entry.references = composerReferences(); entry.undo = history()?.capture();
    entry.profile = entry.mode === 'management' ? ui.composerManagementProfile : ui.composerProfile;
  }
  function session() {
    const entry = currentEdit(); if (!entry) return null;
    if (!entry.session) entry.session = createInputSession({ entry, read,
      editVersion: () => [ui.composerEditRevision, ui.composerReferenceRevision],
      current: () => owns() && currentEdit() === entry,
      changed: () => {
        capture();
        if (entry.saved && entry.key !== `draft:${entry.saved.id}`) { finishComposerEdit({ saved: entry.saved }); void onCreated(entry.saved); }
        rememberComposer(); paintRecovery(); sync();
      },
      authorize: async saved => await runSettings?.confirm() ? authorize(saved) : null,
      accepted: (result, untouched, saved) => accepted(result, untouched, saved),
    });
    return entry.session;
  }
  function paintRecovery() {
    const entry = currentEdit(); ensureRunSettings(entry);
    runtimeSummary.textContent = `运行设置 · ${entry?.mode === 'append' || entry?.target_id != null ? '沿用目标设置' : entry?.profile ? '本条已设置' : entry?.mode === 'management' ? '管理默认' : '项目默认'}${ui.composerElevated ? ' · 本条管理员（提交须验密）' : ''}${runSettings?.issue ? ' · 有待修正项' : ''}`;
    extrasSummary.textContent = `引用 · ${composerReferences().length} 条`;
    emptyReferences.hidden = Boolean(composerReferences().length);
    extras.hidden = entry?.mode === 'management';
    runSettings?.paint();
    const summary = conditionHost.querySelector('summary'), options = entry?.localOptions;
    if (summary) summary.textContent = `手动配置条件与独占 · ${options?.conditions?.length || 0} 项${options?.exclusive ? ' · 独占' : ''}`;
    conditionValet?.paint();
    error.hidden = !entry?.error && !entry?.conflict;
    receipt.hidden = !ui.lastInputReceipt;
    errorText.textContent = entry?.error ? `保存/提交失败：${entry.error}。编辑仍在，站内离开已阻止；可重试或读取服务器版本整理。` : entry?.conflict ? '请对照服务器版本，明确选择整理方式；不会静默覆盖。' : '';
    retry.disabled = Boolean(entry?.flight || entry?.conflict); latest.hidden = !entry?.saved;
    const record = entry?.conflict?.latest; serverText.hidden = keep.hidden = use.hidden = !record;
    serverText.textContent = record ? `服务器版本 ${record.revision} · ${JSON.stringify(draftValues(record))}` : '';
    keep.disabled = use.disabled = Boolean(entry?.flight || record && !editableDraft(record));
    detachLocal.hidden = !record || editableDraft(record);
  }
  function reconcile(keepLocal) {
    const record = session()?.reconcile(keepLocal);
    if (record) {
      // Keep the displaced local body in the SAME undo stack.
      input.dispatchEvent?.(new Event('beforeinput', { bubbles: true }));
      input.value = record.content;
      input.dispatchEvent?.(new Event('input', { bubbles: true }));
      setComposerReferences(record.references);
      const entry = currentEdit(), mode = record.mode || 'order';
      if (entry.mode !== mode || record.target_id != null) entry.profile = null;
      entry.content = record.content; entry.references = record.references; entry.undo = history()?.capture();
      entry.mode = mode; entry.branch = mode === 'order' ? record.branch : null;
      entry.target_id = mode === 'order' ? null : record.target_id ?? null;
      entry.task = null; entry.taskFresh = false; delete entry.parent;
      entry.request = {}; entry.creation = null; ui.composerElevated = false;
      entry.localOptions = { conditions: record.conditions || [], exclusive: Boolean(record.exclusive) };
      // Rebind before capture/retarget: the old mode's controls/profile must not
      // overwrite the complete server definition, or reset the new undo step.
      bound = null; applyEntry(entry); retarget(entry);
    }
    rememberComposer(); paintRecovery(); sync();
  }
  function bind() {
    const entry = currentEdit(); if (!entry || bound === entry) return;
    generation++; bound = entry;
    ensureRunSettings(entry); extras.open = false;
    form.insertBefore(details, target);
    target.replaceChildren(); conditionHost.replaceChildren(); conditionValet?.node.remove(); conditionValet = null; picker = null;
    if (entry.mode === 'order') {
      target.insertBefore(details, null); details.hidden = false;
    } else {
      form.insertBefore(details, target); details.hidden = true;
      if (entry.mode === 'append') {
        picker = createEmissionWorkerPicker({ label: '追加目标 Worker', ownsPage: () => owns() && currentEdit() === entry,
          initial: entry.target_id ? { id: entry.target_id, worker_number: entry.saved?.target_worker_number } : null,
          onChange: async () => {
            const chosen = picker.value(); if (!chosen || !await controller.leave()) return;
            if (!owns() || currentEdit() !== entry) return;
            const token = ++generation;
            try {
              const task = await api(`/api/worker/${chosen.id}`);
              if (!owns() || currentEdit() !== entry || generation !== token) return;
              if (isValet(task)) throw Error('管理目标请通过管理输入选择，不能改为开发追加。');
              entry.target_id = task.id; entry.task = task; entry.taskFresh = true; ui.composerAppendTarget = { id: task.id, task }; retarget(entry); sync();
            } catch (e) { show(e.message, 'error'); }
          } }); target.append(picker.node);
      } else {
        picker = createEmissionWorkerPicker({ label: '原管家 V（不选择则新建）', numberPrefix: 'V',
          ownsPage: () => owns() && currentEdit() === entry, accept: task => isValet(task) || task.worker_number?.startsWith('V'),
          initial: entry.target_id ? { id: entry.target_id, worker_number: entry.saved?.target_worker_number || entry.task?.worker_number } : null,
          onChange: async () => {
            const chosen = picker.value(); if (!chosen || !await controller.leave()) return;
            if (!owns() || currentEdit() !== entry) return;
            const token = ++generation;
            try {
              const task = await api(`/api/worker/${chosen.id}`);
              if (!owns() || currentEdit() !== entry || generation !== token) return;
              if (!isValet(task)) throw Error('只能选择本项目真实原生 V 管家。');
              entry.target_id = task.id; entry.task = task; entry.taskFresh = true; ui.composerAppendTarget = { id: task.id, task };
              ui.composerManagementProfile = null; ui.composerElevated = false; retarget(entry); sync();
            } catch (e) { show(e.message, 'error'); }
          } });
        const create = button('去向改为新建管家', async () => {
          if (!await controller.leave() || !owns() || currentEdit() !== entry) return;
          entry.target_id = null; entry.task = null; ui.composerAppendTarget = null; ui.composerElevated = false;
          retarget(entry); bound = null; bind(); sync();
        });
        target.append(picker.node, create, el('p', '可保存到忙碌管家；提交时必须真实可用且空闲。恢复和下一条默认普通权限。', 'hint'));
      }
    }
    conditionSection.hidden = entry.mode === 'management'; conditionHost.open = false;
    conditions = entry.mode === 'management' ? null : createEmissionConditions({ ...(entry.localOptions || entry.saved || {}), mode: entry.mode,
      ownsPage: () => owns() && currentEdit() === entry, onChange: () => { capture(); sync(); } });
    if (conditions) {
      conditionHost.append(el('summary', '手动配置条件与独占'), conditions.node);
      conditionValet = createDraftConditionValet({ entry: () => entry, session, prepare: () => runSettings.confirm(),
        current: () => owns() && currentEdit() === entry && bound === entry,
        composing: () => composing,
        changed: () => { if (owns() && currentEdit() === entry) { capture(); rememberComposer(); sync(); } } });
      conditionSection.insertBefore(conditionValet.node, conditionHost);
    }
    history()?.restore(entry.undo); paintRecovery();
  }
  function retarget(entry) { retargetComposerEntry(entry); }
  async function perform(kind, quiet = false) {
    if (!owns() || composing) return false;
    const active = session(); if (!active) return true;
    if (!read().content.trim() && !read().references.length && !active.entry.saved) return true;
    try {
      if (kind === 'submit' && runSettings?.validate()) throw Error(runSettings.validate());
      const result = await active[kind]();
      if (kind === 'save' && !quiet) show(`${draftLabel(active.entry.saved)}已保存，尚未提交；内容保留。`);
      return result || true;
    } catch (e) {
      if (owns()) {
        active.entry.error = e.message;
        if (kind === 'submit' && /已有管家|忙碌|busy/i.test(e.message)) (active.entry.request ||= {}).blocked = e.message;
        rememberComposer(); paintRecovery(); sync(); show(e.message, 'error');
      }
      return false;
    }
  }
  function portable() {
    hostGeneration++;
    if (!detailHost) return;
    if (!owns()) { shell.insertBefore(form, null); detailHost = null; back.remove(); return; }
    shell.insertBefore(form, null); detailHost = null; receiptPresenter = null; form.dataset.host = 'portable'; advanced.hidden = target.hidden = true; back.remove();
    ui.composerElevated = false;
    paintComposerWorkspace(); sync();
  }
  const controller = { get inDetail() { return Boolean(detailHost); }, get host() { return detailHost; }, get draft() { return currentEdit()?.saved; }, get receiptPresenter() { return receiptPresenter; }, capture, bind, portable, paint: paintRecovery,
    get busy() { return Boolean(currentEdit()?.flight || currentEdit()?.operation); }, get dirty() { return session()?.dirty() || false; },
    get profileIssue() { ensureRunSettings(); return runSettings?.validate() || ''; },
    save: () => perform('save'), submit: () => perform('submit'),
    async leave() {
      if (!owns()) return true;
      capture(); rememberComposer();
      if (currentEdit()?.operation) return false;
      const profileIssue = runSettings?.validate();
      if (profileIssue) { runtime.open = true; show(`运行设置未完成：${profileIssue}；请修正或恢复默认，编辑仍保留。`, 'error'); return false; }
      if (composing) { show('请先完成输入法候选确认；编辑保留。', 'error'); return false; }
      if (currentEdit()?.consumed) return true;
      if (!await perform('save', true)) return false;
      // Authorization may have completed while this leave waited on the queue.
      // A detached in-flight edit is a new item and must be saved before navigating.
      if (read().content.trim() && session()?.dirty()) return controller.leave();
      return true;
    },
    async detail() {
      const entry = currentEdit(), view = ui.view, token = ++hostGeneration;
      if (!await controller.leave() || !owns() || currentEdit() !== entry || ui.view !== view || hostGeneration !== token) return;
      if (!origin && !detailHost) origin = { hash: globalThis.location?.hash || '', scroll: $('detail').scrollTop };
      const saved = currentEdit()?.saved;
      const { openInputs, openLocalInputEditor } = await import('./render-inputs.js');
      if (!owns() || currentEdit() !== entry || ui.view !== view || hostGeneration !== token) return;
      if (saved) await openInputs({ item: { kind: 'draft', id: saved.id } });
      else await openLocalInputEditor();
    },
    async mount(host, record, { embedded = false, onReceipt = null, current = () => true } = {}) {
      const token = ++hostGeneration, view = ui.view;
      const active = () => owns() && current() && ui.view === view && hostGeneration === token;
      if (!active() || record && !await activateComposerDraft(record, { current: active }) || !active()) return false;
      bind(); detailHost = host; receiptPresenter = onReceipt;
      if (embedded && !origin) origin = { hash: globalThis.location?.hash || '', scroll: $('detail').scrollTop };
      form.dataset.host = 'detail'; advanced.hidden = target.hidden = false;
      host.insertBefore(form, null); form.insertBefore(back, form.children[0] || null); form.hidden = false;
      ui.composerWorkspace.open = false; paintComposerWorkspace(); sync(); return true;
    },
    async continuePortable() {
      const entry = currentEdit(), view = ui.view, token = ++hostGeneration;
      if (!await controller.leave() || !owns() || currentEdit() !== entry || ui.view !== view || hostGeneration !== token) return;
      const context = origin; origin = null; portable();
      let restored = true;
      if (ui.restoreInputContext) restored = await ui.restoreInputContext(context || { hash: '#drafts', scroll: 0 });
      else { const { overview } = await import('./navigate.js'); await overview(); }
      if (owns() && restored !== false) openComposer();
    },
    detach() { portable(); },
    dispose() {
      if (disposed) return;
      portable(); disposed = true; generation++; unregister();
      form.insertBefore(details, advanced); form.insertBefore(managementSettings, advanced); form.insertBefore(refs, advanced);
      runSettings?.dispose();
      input.removeEventListener('compositionstart', compositionStart); input.removeEventListener('compositionend', compositionEnd);
      globalThis.removeEventListener?.('beforeunload', beforeUnload); globalThis.removeEventListener?.('pagehide', pageHide);
      advanced.remove(); target.remove(); error.remove(); receipt.remove(); fresh.remove();
    },
  };
  const unregister = registerPageLeaveGuard(() => controller.leave(), { key: 'input-session', stay: () => {
    if (owns()) globalThis.window?.history?.replaceState?.(null, '', ui.currentPageHash || globalThis.location?.pathname || '/');
    return false;
  } });
  const compositionStart = () => { composing = true; }, compositionEnd = () => { composing = false; };
  const pageHide = () => { if (owns()) rememberComposer(); };
  const beforeUnload = event => {
    if (!owns()) return; rememberComposer();
    if (session()?.dirty() && (input.value.trim() || composerReferences().length || currentEdit()?.saved) || currentEdit()?.flight || currentEdit()?.error || runSettings?.validate()) { event.preventDefault(); event.returnValue = ''; }
  };
  input.addEventListener('compositionstart', compositionStart); input.addEventListener('compositionend', compositionEnd);
  globalThis.addEventListener?.('beforeunload', beforeUnload); globalThis.addEventListener?.('pagehide', pageHide);
  $('composer-expand').onclick = () => controller.detail();
  ui.inputEditor = controller; advanced.hidden = target.hidden = true; form.dataset.host = 'portable'; bind();
  return controller;
}
