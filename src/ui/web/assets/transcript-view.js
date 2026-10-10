import { $, el, button } from './dom.js';
import { ui, transcriptCache, transcriptOpen } from './state.js';
import { loadTranscript, paintTranscript, transcriptContent, transcriptMatch, locateTranscriptStep, transcriptOrder } from './render-transcript.js';
import { api } from './api.js';
import { transcriptReader, releaseTranscriptReader, pauseTranscriptReader, searchTranscriptPath, openTranscriptStep } from './transcript-reader.js';
import { createCodeView } from './code-view.js';
import { devicePreferencesStatus, onDevicePreferences, saveDevicePreference, onPrefChange, TRANSCRIPT_ORDER_MODES } from './prefs.js';
import { closeExplanationPanel } from './explanations.js';
import { statusOf } from './format.js';
import { workerLabel } from './worker-label.js';

let current = null;
export function closeTranscriptView() {
  const state = current;
  if (!state) return;
  current = null;
  state.code?.dispose(); state.disposePreference?.();
  releaseTranscriptReader(state.taskId);
  removeEventListener('hashchange', state.onNavigate);
  if (state.panel.querySelector('.reading-panel')) { closeExplanationPanel(); ui.closeQuickExplanationPanel?.(); }
  if (state.menu) { state.menu.hidden = true; (state.menuParent || document.body).append(state.menu); }
  state.panel.close?.(); state.panel.remove();
  $('project-app').inert = state.wasInert;
  transcriptOpen.delete(state.taskId); ui.transcriptView = null;
  state.returnTarget?.focus?.({ preventScroll: true });
  $('detail').scrollTop = state.returnScroll;
}

/** Fullscreen rich reader; the existing bounded transcript projection remains authoritative. */
export async function openTranscriptView(taskId, seq) {
  closeTranscriptView();
  const panel = el('dialog', undefined, 'transcript-dialog');
  panel.setAttribute('aria-label', `Worker ${workerLabel(taskId)} 执行详情`);
  const holder = el('div', undefined, 'transcript');
  const state = { panel, holder, taskId, returnTarget: document.activeElement,
    returnScroll: $('detail').scrollTop, wasInert: $('project-app').inert,
    menu: $('context-menu'), menuParent: $('context-menu')?.parentNode };
  state.mode = 'transcript';
  current = state; ui.transcriptView = state; transcriptOpen.add(taskId);
  const toolbar = el('header', undefined, 'transcript-toolbar');
  const back = button('返回 Worker', closeTranscriptView, 'ghost transcript-back');
  const order = el('select'); order.setAttribute('aria-label', '执行过程排序');
  for (const mode of TRANSCRIPT_ORDER_MODES) {
    const label = mode.id === 'desc' ? '最新在前' : mode.id === 'asc' ? '最早在前' : mode.label;
    const option = el('option', label); option.value = mode.id; order.append(option);
  }
  order.value = transcriptOrder();
  const orderHost = el('span', undefined, 'help-host'); orderHost.tabIndex = 0; orderHost.append(order);
  const syncOrder = () => {
    const device = devicePreferencesStatus();
    order.disabled = Boolean(state.filtered) || device.saving || !device.ready || Boolean(device.error);
    orderHost.setAttribute('data-help', state.filtered ? '搜索结果按步骤编号排列，退出搜索后可修改阅读偏好。' : !device.ready || device.error ? `设备偏好当前不可用，不能保存排序。${device.error || '正在读取权威配置。'}` : '设备统一的执行记录阅读顺序，不改变项目记录。');
  };
  order.onchange = async () => {
    order.disabled = true;
    try { await saveDevicePreference('transcriptOrder', order.value); }
    catch (error) { if (current === state) { order.value = transcriptOrder(); state.notice.textContent = `阅读偏好未保存：${error.message}`; } }
    finally { if (current === state) syncOrder(); }
  };
  state.order = order; state.disposePreference = onDevicePreferences(syncOrder);
  const taskStatus = el('span', '状态未知', 'badge');
  const heading = el('strong', `Worker ${workerLabel(taskId)}`);
  state.paintStatus = task => {
    if (!task || task.id !== taskId) return;
    taskStatus.textContent = statusOf(task).label; taskStatus.className = `badge b-${task.status}`;
    heading.textContent = `Worker ${workerLabel(task)}`;
    panel.setAttribute('aria-label', `Worker ${workerLabel(task)} 执行详情`);
  };
  state.paintStatus(ui.lastSnapshot?.tasks?.find(task => task.id === taskId));
  const identity = el('div', undefined, 'transcript-identity');
  identity.append(heading, el('span', '执行详情', 'transcript-view-label'), taskStatus);
  toolbar.append(back, identity);
  const tabs = el('div', undefined, 'execution-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '执行详情视图');
  const recordsTab = button('执行记录', () => switchMode('transcript'), 'ghost');
  const codeTab = button('代码与改动', () => switchMode('code'), 'ghost');
  for (const [tab, name] of [[recordsTab, 'transcript'], [codeTab, 'code']]) {
    tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(name === state.mode));
    tab.setAttribute('aria-controls', `execution-${name}-${taskId}`);
    tab.id = `execution-tab-${name}-${taskId}`;
    tab.tabIndex = name === state.mode ? 0 : -1;
    tab.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const mode = event.key === 'Home' ? 'transcript' : event.key === 'End' ? 'code' : state.mode === 'code' ? 'transcript' : 'code';
      void switchMode(mode); (mode === 'code' ? codeTab : recordsTab).focus();
    };
  }
  tabs.append(recordsTab, codeTab);
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
    toggleSearch.textContent = open ? '收起搜索' : '搜索';
    toggleSearch.setAttribute('aria-expanded', String(open));
    if (focus) (open ? reader.querySelector('input') : toggleSearch).focus?.({ preventScroll: true });
  }
  toggleSearch.setAttribute('aria-expanded', 'false');
  readingTools.append(orderHost, toggleSearch); navigation.append(tabs, readingTools);
  async function switchMode(mode) {
    if (current !== state || mode === state.mode) return;
    state.mode = mode;
    layout.hidden = mode !== 'transcript'; readingTools.hidden = mode !== 'transcript';
    for (const [tab, value] of [[recordsTab, 'transcript'], [codeTab, 'code']]) {
      tab.setAttribute('aria-selected', String(mode === value)); tab.tabIndex = mode === value ? 0 : -1;
    }
    if (mode === 'code') {
      pauseTranscriptReader(taskId); transcriptOpen.delete(taskId);
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
    } else {
      if (state.code) { state.code.root.hidden = true; await state.code.setActive(false); }
      if (current !== state || state.mode !== 'transcript') return;
      transcriptOpen.add(taskId);
      if (!state.filtered && transcriptCache.get(taskId)?.order && transcriptCache.get(taskId).order !== transcriptOrder()) await loadTranscript(taskId);
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
      state.filtered = true; order.disabled = true; notice.textContent = '搜索命中按步骤编号排列；包含配对输入输出。';
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
  state.onNavigate = closeTranscriptView; addEventListener('hashchange', state.onNavigate);
  panel.oncancel = event => { event.preventDefault(); closeTranscriptView(); };
  panel.onkeydown = event => {
    if (event.defaultPrevented) return;
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      void switchMode('transcript'); setSearchOpen(true, true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (mobile() && state.searchOpen && state.mode === 'transcript') setSearchOpen(false, true);
      else closeTranscriptView();
    }
  };
  if (state.menu) { state.menu.hidden = true; panel.append(state.menu); }
  document.body.append(panel); panel.showModal?.(); $('project-app').inert = true;
  back.focus?.({ preventScroll: true });
  holder.replaceChildren(...transcriptContent(taskId));
  try {
    if (!transcriptCache.has(taskId)) await loadTranscript(taskId);
    if (current !== state) return;
    if (seq !== undefined && !state.filtered) await locateTranscriptStep(taskId, seq);
  } catch (error) {
    if (current === state && !state.filtered) holder.replaceChildren(el('p', `读取执行记录失败：${error.message}`, 'error'),
      button('重试读取', () => loadTranscript(taskId), 'ghost'));
  }
}
onPrefChange('transcriptOrder', () => { if (current) current.order.value = transcriptOrder(); });
