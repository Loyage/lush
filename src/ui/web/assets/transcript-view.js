import { $, el, button } from './dom.js';
import { ui, transcriptCache, transcriptOpen } from './state.js';
import { loadTranscript, paintTranscript, transcriptContent, transcriptMatch, locateTranscriptStep, transcriptOrder } from './render-transcript.js';
import { api } from './api.js';
import { transcriptReader, releaseTranscriptReader, openTranscriptStep } from './transcript-reader.js';
import { setPref, onPrefChange, TRANSCRIPT_ORDER_MODES } from './prefs.js';
import { closeExplanationPanel } from './explanations.js';

let current = null;
export function closeTranscriptView() {
  const state = current;
  if (!state) return;
  current = null;
  releaseTranscriptReader(state.taskId);
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
  const layout = el('div', undefined, 'transcript-layout');
  const sidebar = el('aside', undefined, 'transcript-sidebar'); sidebar.setAttribute('aria-label', '执行过程搜索与筛选');
  const viewport = el('div', undefined, 'transcript-viewport'); viewport.tabIndex = 0;
  viewport.setAttribute('aria-label', '执行过程正文');
  const notice = el('p', '', 'hint'); notice.setAttribute('role', 'status'); state.notice = notice;
  state.filtered = false;
  const active = valid => current === state && valid();
  const reader = transcriptReader(taskId, {
    locate: (_id, target) => {
      const card = [...holder.children].find(node => node.dataset.matchSeq === String(target));
      if (!card) return;
      for (const row of sidebar.querySelectorAll('.search-hit')) {
        const selected = row.dataset.hitSeq === String(target);
        row.querySelector('button').setAttribute('aria-current', String(selected));
      }
      card.scrollIntoView?.({ block: 'start' });
      for (const item of holder.children) item.classList.toggle('step-located', item === card);
    },
    onStart: () => {
      state.filtered = true; order.disabled = true; notice.textContent = '搜索结果按步骤编号排列，左栏与正文一一对应。';
      holder.replaceChildren(el('p', '正在搜索完整记录…', 'hint'));
      viewport.scrollTop = 0;
    },
    onError: error => holder.replaceChildren(el('p', `搜索未完成：${error.message}`, 'error')),
    onClear: () => {
      state.filtered = false; order.disabled = false; notice.textContent = '';
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
          const page = await api(`/api/task/${taskId}/transcript-step?seq=${step.seq}&offset=0`);
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
  viewport.append(notice, holder); layout.append(sidebar, viewport); panel.append(toolbar, layout);
  state.onNavigate = closeTranscriptView; addEventListener('hashchange', state.onNavigate);
  panel.oncancel = event => { event.preventDefault(); closeTranscriptView(); };
  panel.onkeydown = event => {
    if (event.defaultPrevented) return;
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
      event.preventDefault(); reader.querySelector('input').focus?.({ preventScroll: true });
    } else if (event.key === 'Escape') { event.preventDefault(); closeTranscriptView(); }
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
