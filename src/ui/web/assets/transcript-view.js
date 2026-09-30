import { $, el, button } from './dom.js';
import { ui, transcriptCache, transcriptOpen } from './state.js';
import { loadTranscript, transcriptContent, locateTranscriptStep, transcriptOrder } from './render-transcript.js';
import { setPref, onPrefChange, TRANSCRIPT_ORDER_MODES } from './prefs.js';
import { closeExplanationPanel } from './explanations.js';

let current = null;
export function closeTranscriptView() {
  const state = current;
  if (!state) return;
  current = null;
  removeEventListener('hashchange', state.onNavigate);
  if (state.panel.querySelector('.reading-panel')) closeExplanationPanel();
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
  panel.setAttribute('aria-label', `任务 #${taskId} 执行过程`);
  const holder = el('div', undefined, 'transcript');
  const state = { panel, holder, taskId, returnTarget: document.activeElement,
    returnScroll: $('detail').scrollTop, wasInert: $('project-app').inert,
    menu: $('context-menu'), menuParent: $('context-menu')?.parentNode };
  current = state; ui.transcriptView = state; transcriptOpen.add(taskId);
  const toolbar = el('header', undefined, 'transcript-toolbar');
  const back = button('返回任务 · Esc', closeTranscriptView, 'ghost');
  const order = el('select'); order.setAttribute('aria-label', '执行过程排序');
  for (const mode of TRANSCRIPT_ORDER_MODES) { const option = el('option', mode.label); option.value = mode.id; order.append(option); }
  order.value = transcriptOrder(); order.onchange = () => setPref('transcriptOrder', order.value);
  state.order = order;
  toolbar.append(back, el('strong', `任务 #${taskId} · 执行过程`), order);
  const viewport = el('div', undefined, 'transcript-viewport'); viewport.tabIndex = 0;
  viewport.append(holder); panel.append(toolbar, viewport);
  state.onNavigate = closeTranscriptView; addEventListener('hashchange', state.onNavigate);
  panel.oncancel = event => { event.preventDefault(); closeTranscriptView(); };
  panel.onkeydown = event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); closeTranscriptView(); } };
  if (state.menu) { state.menu.hidden = true; panel.append(state.menu); }
  document.body.append(panel); panel.showModal?.(); $('project-app').inert = true;
  back.focus?.({ preventScroll: true });
  holder.replaceChildren(...transcriptContent(taskId));
  try {
    if (!transcriptCache.has(taskId)) await loadTranscript(taskId);
    if (current !== state) return;
    if (seq !== undefined) await locateTranscriptStep(taskId, seq);
  } catch (error) {
    if (current === state) holder.replaceChildren(el('p', `读取执行记录失败：${error.message}`, 'error'),
      button('重试读取', () => loadTranscript(taskId), 'ghost'));
  }
}
onPrefChange('transcriptOrder', () => { if (current) current.order.value = transcriptOrder(); });
