import { $, el } from './dom.js';
import { api } from './api.js';
import { ui } from './state.js';
import { activateDetailView } from './sidebar-ui.js';
import { openTranscriptView } from './transcript-view.js';

/** A reloadable project-scoped destination; the reader retains its existing bounded reads. */
export async function openExecutionPage({ taskId, mode }) {
  const view = activateDetailView({ view: 'execution', key: `execution-${taskId}-${mode}`, title: '执行详情', push: false });
  const owner = document, path = location.pathname, hash = location.hash;
  const current = () => document === owner && ui.view === view && location.pathname === path && location.hash === hash;
  $('detail').replaceChildren(el('p', '正在读取执行详情…', 'hint'));
  try {
    const task = await api(`/api/worker/${taskId}`);
    if (!current()) return;
    // Existing live polling follows the selected Worker, without loading its detail page.
    ui.selected = taskId;
    await openTranscriptView(taskId, undefined, { mode, task, standalone: true });
  } catch (error) {
    if (current()) $('detail').replaceChildren(el('p', `无法打开执行详情：${error.message}`, 'error'));
  }
}
