import { $, el, button } from './dom.js';
import { sortControl, paintDisclosure } from './view-controls.js';
import { ui, transcriptCache, transcriptOpen } from './state.js';
import { loadTranscript, paintTranscript, transcriptContent, transcriptMatch, locateTranscriptStep, transcriptOrder } from './render-transcript.js';
import { api } from './api.js';
import { transcriptReader, releaseTranscriptReader, pauseTranscriptReader, searchTranscriptPath, openTranscriptStep, clearTranscriptSearch } from './transcript-reader.js';
import { createCodeView } from './code-view.js';
import { createPerformanceView } from './performance-view.js';
import { detailWorkerCli, disposeWorkerCli } from './worker-cli-detail.js';
import { devicePreferencesStatus, onDevicePreferences, saveDevicePreference, onPrefChange } from './prefs.js';
import { statusOf } from './format.js';
import { workerLabel } from './worker-label.js';

let current = null;
import { isValet, workTypeLabel } from './work-type.js';

export function closeTranscriptView() {
  const state = current;
  if (!state) return;
  current = null;
  state.code?.dispose(); state.performance?.dispose(); state.cli?.dispose(); disposeWorkerCli(); state.disposePreference?.();
  if (state.modal) { state.modal.remove(); (state.modalParent || document.body).append(state.modal); }
  if (ui.disposeWorkerCli === state.disposeCliPage) ui.disposeWorkerCli = null;
  releaseTranscriptReader(state.taskId);
  removeEventListener('hashchange', state.onNavigate);
  if (state.menu) { state.menu.hidden = true; (state.menuParent || document.body).append(state.menu); }
  state.panel.close?.(); state.panel.remove();
  $('project-app').inert = state.wasInert;
  transcriptOpen.delete(state.taskId); ui.transcriptView = null;
  state.returnTarget?.focus?.({ preventScroll: true });
  $('detail').scrollTop = state.returnScroll;
}

/** Fullscreen rich reader; the existing bounded transcript projection remains authoritative. */
export async function openTranscriptView(taskId, seq, { mode = 'transcript', task = null, cli = {}, standalone = ui.transcriptView?.standalone === true } = {}) {
  closeTranscriptView();
  const knownTask = task || (ui.composerTask?.id === taskId ? ui.composerTask : null) || ui.lastSnapshot?.tasks?.find(item => item.id === taskId);
  const valet = isValet(knownTask) || workerLabel(taskId).startsWith('V');
  const type = valet ? 'Valet' : 'Worker';
  const panel = el('dialog', undefined, 'transcript-dialog');
  panel.setAttribute('aria-label', `${type} ${workerLabel(knownTask || taskId)} 执行详情`);
  const holder = el('div', undefined, 'transcript');
  const state = { panel, holder, taskId, standalone, document, path: location.pathname, hash: location.hash, boot: ui.workerNumbers, returnTarget: document.activeElement,
    returnScroll: $('detail').scrollTop, wasInert: $('project-app').inert,
    menu: $('context-menu'), menuParent: $('context-menu')?.parentNode,
    modal: $('modal'), modalParent: $('modal')?.parentNode };
  state.mode = 'transcript';
  current = state; ui.transcriptView = state; transcriptOpen.add(taskId);
  state.disposeCliPage = () => { if (current === state) closeTranscriptView(); };
  ui.disposeWorkerCli = state.disposeCliPage;
  const toolbar = el('header', undefined, 'transcript-toolbar');
  // A dedicated reader tab has no underlying Worker page to return to.
  const leaveReader = () => { if (!standalone) closeTranscriptView(); };
  const back = standalone ? null : button(`返回 ${type}`, leaveReader, 'ghost transcript-back');
  const order = el('div', undefined, 'transcript-order');
  order.setAttribute('role', 'group'); order.setAttribute('aria-label', '执行过程排序');
  const sort = sortControl({ getOrder: transcriptOrder, setOrder: async value => {
    try { await saveDevicePreference('transcriptOrder', value); }
    catch (error) { if (current === state) state.notice.textContent = `阅读偏好未保存：${error.message}`; }
  }, scope: '保存设备统一执行记录阅读偏好；已打开记录重新读取对应头／尾窗口，未打开记录不读取。不改变项目记录或调用 Agent。',
  disabled: () => {
    const device = devicePreferencesStatus();
    return state.filtered ? '搜索结果按步骤编号排列，退出搜索后可修改阅读偏好。'
      : !device.ready || device.error ? `设备偏好当前不可用，不能保存排序。${device.error || '正在读取权威配置。'}`
      : device.saving ? '正在保存设备阅读偏好，请等待保存完成。' : '';
  } });
  sort.button.dataset.transcriptOrder = 'toggle'; order.append(sort.root);
  const orderHost = order;
  const syncOrder = sort.sync;
  state.syncOrder = syncOrder; state.disposePreference = onDevicePreferences(syncOrder);
  const taskStatus = el('span', '状态未知', 'badge');
  const heading = el('strong', `${type} ${workerLabel(knownTask || taskId)}`);
  state.paintStatus = task => {
    if (!task || task.id !== taskId) return;
    // Overview polling sends a partial status summary: omitted fields are not
    // removals. Preserve inspect context, while explicit nulls still invalidate it.
    state.task = { ...state.task, ...task }; state.cli?.update(state.task);
    taskStatus.textContent = statusOf(task).label; taskStatus.className = `badge b-${task.status}`;
    heading.textContent = `${workTypeLabel(task)} ${workerLabel(task)}`;
    panel.setAttribute('aria-label', `${workTypeLabel(task)} ${workerLabel(task)} 执行详情`);
  };
  state.paintStatus(knownTask);
  const identity = el('div', undefined, 'transcript-identity');
  identity.append(heading, el('span', '执行详情', 'transcript-view-label'), taskStatus);
  if (standalone) heading.tabIndex = -1;
  if (back) toolbar.append(back);
  toolbar.append(identity);
  const tabs = el('div', undefined, 'execution-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '执行详情视图');
  const recordsTab = button('执行记录', () => switchMode('transcript'), 'ghost');
  const codeTab = button('代码与改动', () => switchMode('code'), 'ghost');
  const performanceTab = button('性能分析', () => switchMode('performance'), 'ghost');
  const cliTab = button('CLI 交互', () => switchMode('cli'), 'ghost');
  const supportsCli = !valet && ['main', 'order', 'child'].includes(knownTask?.task_kind) && knownTask?.execution_retired !== true;
  const viewTabs = valet ? [[recordsTab, 'transcript']] : [[recordsTab, 'transcript'], [codeTab, 'code'], [performanceTab, 'performance'], ...(supportsCli ? [[cliTab, 'cli']] : [])];
  for (const [tab, name] of viewTabs) {
    tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(name === state.mode));
    tab.setAttribute('aria-controls', `execution-${name}-${taskId}`);
    tab.id = `execution-tab-${name}-${taskId}`;
    tab.tabIndex = name === state.mode ? 0 : -1;
    tab.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = viewTabs.findIndex(([, name]) => name === state.mode);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? viewTabs.length - 1
        : (index + (event.key === 'ArrowLeft' ? -1 : 1) + viewTabs.length) % viewTabs.length;
      void switchMode(viewTabs[next][1]); viewTabs[next][0].focus();
    };
  }
  codeTab.hidden = valet;
  tabs.append(...viewTabs.map(([tab]) => tab));
  const navigation = el('div', undefined, 'execution-navigation');
  const readingTools = el('div', undefined, 'transcript-reading-tools');
  const toggleSearch = button('搜索', () => setSearchOpen(!state.searchOpen, true), 'ghost transcript-search-toggle',
    { help: '展开全文搜索、筛选与命中列表；点击命中后收起搜索并定位正文，不调用 Agent。' });
  toggleSearch.setAttribute('aria-controls', `execution-search-${taskId}`);
  state.searchOpen = false;
  const mobile = () => globalThis.matchMedia?.('(max-width:760px)').matches === true;
  function setSearchOpen(open, focus = false) {
    state.searchOpen = open;
    panel.classList.toggle('transcript-search-open', open);
    paintDisclosure(toggleSearch, open, { expand: '搜索', collapse: '收起搜索' });
    if (focus) (open ? reader.querySelector('input') : toggleSearch).focus?.({ preventScroll: true });
  }
  paintDisclosure(toggleSearch, false, { expand: '搜索', collapse: '收起搜索' });
  readingTools.append(orderHost, toggleSearch); navigation.append(tabs, readingTools);
  async function switchMode(mode) {
    if (current !== state || mode === state.mode || !viewTabs.some(([, value]) => value === mode)) return;
    state.mode = mode;
    layout.hidden = mode !== 'transcript'; readingTools.hidden = mode !== 'transcript';
    for (const [tab, value] of viewTabs) {
      tab.setAttribute('aria-selected', String(mode === value)); tab.tabIndex = mode === value ? 0 : -1;
    }
    state.cli?.setActive(mode === 'cli');
    if (state.code && mode !== 'code') { state.code.root.hidden = true; await state.code.setActive(false); }
    if (state.performance && mode !== 'performance') { state.performance.root.hidden = true; await state.performance.setActive(false); }
    if (current !== state || state.mode !== mode) return;
    if (mode !== 'transcript') { pauseTranscriptReader(taskId); transcriptOpen.delete(taskId); }
    if (mode === 'code') {
      if (!state.code) {
        state.code = createCodeView(taskId, { onSearch: async path => {
          await switchMode('transcript');
          if (current === state && state.mode === 'transcript') {
            setSearchOpen(true, true); await searchTranscriptPath(taskId, path);
          }
        } });
        state.code.root.id = `execution-code-${taskId}`;
        state.code.root.setAttribute('role', 'tabpanel'); state.code.root.setAttribute('aria-labelledby', codeTab.id);
        panel.append(state.code.root);
      }
      state.code.root.hidden = false; await state.code.setActive(true);
    } else if (mode === 'performance') {
      if (!state.performance) {
        state.performance = createPerformanceView(taskId, { onStep: async seq => {
          await switchMode('transcript');
          if (current !== state || state.mode !== 'transcript') return;
          await clearTranscriptSearch(taskId); setSearchOpen(false);
          await locateTranscriptStep(taskId, seq);
        } });
        state.performance.root.id = `execution-performance-${taskId}`;
        state.performance.root.setAttribute('role', 'tabpanel'); state.performance.root.setAttribute('aria-labelledby', performanceTab.id);
        panel.append(state.performance.root);
      }
      state.performance.root.hidden = false; await state.performance.setActive(true);
    } else if (mode === 'cli') {
      if (!state.cli) {
        state.cli = detailWorkerCli(state.task || knownTask, cli);
        if (!state.cli) return;
        state.cli.id = `execution-cli-${taskId}`;
        state.cli.setAttribute('role', 'tabpanel'); state.cli.setAttribute('aria-labelledby', cliTab.id);
        panel.append(state.cli);
      }
      state.cli.setActive(true);
    } else {
      transcriptOpen.add(taskId);
      if (!state.filtered && (!transcriptCache.has(taskId) || (transcriptCache.get(taskId)?.order && transcriptCache.get(taskId).order !== transcriptOrder()))) await loadTranscript(taskId);
    }
  }
  const layout = el('div', undefined, 'transcript-layout');
  layout.id = `execution-transcript-${taskId}`; layout.setAttribute('role', 'tabpanel'); layout.setAttribute('aria-labelledby', recordsTab.id);
  const sidebar = el('aside', undefined, 'transcript-sidebar'); sidebar.setAttribute('aria-label', '执行过程搜索与筛选');
  sidebar.id = `execution-search-${taskId}`;
  const viewport = el('div', undefined, 'transcript-viewport'); viewport.tabIndex = 0;
  viewport.setAttribute('aria-label', '执行过程正文');
  const notice = el('p', '', 'hint'); notice.setAttribute('role', 'status'); state.notice = notice;
  state.filtered = false;
  const active = valid => current === state && state.mode === 'transcript' && valid();
  const reader = transcriptReader(taskId, {
    locate: (_id, target) => {
      const card = [...holder.children].find(node => node.dataset.matchSeq === String(target));
      if (!card) return;
      for (const row of sidebar.querySelectorAll('.search-hit')) {
        const selected = row.dataset.hitSeq === String(target);
        row.querySelector('button').setAttribute('aria-current', String(selected));
      }
      if (mobile()) { setSearchOpen(false); viewport.focus?.({ preventScroll: true }); }
      card.scrollIntoView?.({ block: 'start' });
      for (const item of holder.children) item.classList.toggle('step-located', item === card);
    },
    onStart: () => {
      state.filtered = true; syncOrder(); notice.textContent = '搜索命中按步骤编号排列；包含配对输入输出。';
      holder.replaceChildren(el('p', '正在搜索完整记录…', 'hint'));
      viewport.scrollTop = 0;
    },
    onError: error => holder.replaceChildren(el('p', `搜索未完成：${error.message}`, 'error')),
    onClear: () => {
      state.filtered = false; syncOrder(); notice.textContent = '';
      paintTranscript(taskId); viewport.scrollTop = 0;
    },
    onPage: async (data, valid) => {
      if (!active(valid)) return;
      if (!data.steps.length) {
        holder.replaceChildren(el('p', data.files.length ? '没有命中。未写完的记录不参与检索。' : '没有可读取的会话文件，可能已被清理或未记录执行过程。', 'hint'));
        return;
      }
      const slots = data.steps.map(step => {
        const slot = el('section', undefined, 'transcript-match'); slot.dataset.matchSeq = String(step.seq);
        slot.append(el('h3', `命中 #${step.seq}`), el('p', '正在读取正文与配对输入输出…', 'hint'));
        return slot;
      });
      holder.replaceChildren(...slots);
      // At most four bounded step reads in flight; never fetch the whole task into memory.
      let next = 0;
      const load = async index => {
        const step = data.steps[index], slot = slots[index];
        try {
          const page = await api(`/api/worker/${taskId}/transcript-step?seq=${step.seq}&offset=0`);
          if (!active(valid)) return;
          if (!page.step) throw new Error('步骤已不存在，记录可能已被清理');
          const card = transcriptMatch(taskId, page.step, page.related || []);
          if (page.has_more) card.append(el('p', '正文仅显示首段；可在步骤旁分段读取完整原文。', 'hint'),
            button('读取完整原文', () => openTranscriptStep(taskId, step.seq, { root: slot }), 'ghost'));
          if (page.pairing_ambiguous || page.related_truncated) card.append(el('p', page.pairing_ambiguous ? '调用身份重复，无法可靠配对；没有猜测输入输出关系。' : '配对内容超过上限，只展示前 8 条。', 'hint'));
          if (page.context?.length) {
            const context = el('details', undefined, 'transcript-match-context');
            context.append(el('summary', '查看相邻上下文（非命中）'));
            context.addEventListener('toggle', () => {
              if (!context.open || context.dataset.loaded) return;
              context.dataset.loaded = 'true';
              for (const neighbour of page.context) context.append(transcriptMatch(taskId, neighbour));
            });
            card.append(context);
          }
          slot.replaceChildren(...card.children);
        } catch (error) {
          if (active(valid)) slot.replaceChildren(el('h3', `命中 #${step.seq}`), el('p', `正文读取未完成：${error.message}`, 'error'),
            button('重试读取正文', () => load(index), 'ghost'));
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, slots.length) }, async () => {
        while (next < slots.length && active(valid)) await load(next++);
      }));
    },
  });
  sidebar.append(el('h2', '搜索'), reader);
  viewport.append(notice, holder); layout.append(sidebar, viewport); panel.append(toolbar, navigation, layout);
  state.onNavigate = () => { if (current === state && (location.hash !== state.hash || location.pathname !== state.path)) closeTranscriptView(); }; addEventListener('hashchange', state.onNavigate);
  panel.oncancel = event => { event.preventDefault(); leaveReader(); };
  panel.onkeydown = event => {
    if (event.defaultPrevented) return;
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      void switchMode('transcript'); setSearchOpen(true, true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (mobile() && state.searchOpen && state.mode === 'transcript') setSearchOpen(false, true);
      else leaveReader();
    }
  };
  if (state.menu) { state.menu.hidden = true; panel.append(state.menu); }
  // App confirmations must be in the native modal's top layer, not its inert background.
  if (state.modal) { state.modal.remove(); panel.append(state.modal); }
  document.body.append(panel); panel.showModal?.(); $('project-app').inert = true;
  (back || heading).focus?.({ preventScroll: true });
  holder.replaceChildren(...transcriptContent(taskId));
  if (['code', 'performance', 'cli'].includes(mode) && viewTabs.some(([, value]) => value === mode)) { await switchMode(mode); return; }
  try {
    if (!transcriptCache.has(taskId)) await loadTranscript(taskId);
    if (current !== state) return;
    if (seq !== undefined && !state.filtered) await locateTranscriptStep(taskId, seq);
  } catch (error) {
    if (current === state && !state.filtered) holder.replaceChildren(el('p', `读取执行记录失败：${error.message}`, 'error'),
      button('重试读取', () => loadTranscript(taskId), 'ghost'));
  }
}
onPrefChange('transcriptOrder', () => { current?.syncOrder(); });
