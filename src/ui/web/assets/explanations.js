import { el, button } from './dom.js';
import { api } from './api.js';
import { agentText } from './text.js';
import { structuredValue } from './structured-value.js';

let panel = null, generation = 0, timer = null;
export function closeExplanationPanel() { generation++; clearTimeout(timer); panel?.remove(); panel = null; }
function shell(title) {
  closeExplanationPanel();
  panel = el('aside', undefined, 'reading-panel');
  panel.setAttribute('aria-label', title);
  const close = button('关闭', closeExplanationPanel, 'ghost');
  panel.onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation?.(); close.onclick(); } };
  panel.append(el('h3', title), close);
  const content = el('div'); panel.append(content);
  (document.body.querySelector('.terminal-dialog') || document.body).append(panel);
  close.focus?.({ preventScroll: true });
  return { content, version: generation };
}
function paint(content, data) {
  const source = data.source;
  content.replaceChildren(el('p', `解释 #${data.id} · ${data.status} · 模型解释，不是执行事实`, 'hint'),
    el('p', `来源：任务 #${source.task_id} / 步骤 #${source.seq} · ${source.captured_at}`, 'hint'),
    el('blockquote', source.quote),
    source.body_truncated ? el('p', '关联步骤较长，解释上下文仅含首段；选中文字完整保留。', 'hint') : el('span'),
    data.error ? el('p', data.error, 'error') : agentText(data.result || '正在排队或解释…'));
  const snapshot = el('details'); snapshot.append(el('summary', '当时的来源快照'), el('p', `任务目标：${source.goal}`));
  for (const step of [source.step, ...(source.related || [])]) {
    snapshot.append(el('h4', `步骤 #${step.seq} · ${step.title}`), structuredValue(step.body));
    if (step.body_truncated) snapshot.append(el('p', '此关联记录为截断摘要。', 'hint'));
  }
  content.append(snapshot);
}
async function watch(content, version, id) {
  if (version !== generation) return;
  try {
    const data = await api(`/api/explanation/${id}`);
    if (version !== generation) return;
    // Do not repaint an unchanged body or destroy a reading selection.
    const signature = JSON.stringify([data.status, data.result, data.error]);
    if (content.dataset.signature !== signature) { paint(content, data); content.dataset.signature = signature; }
    if (!['completed', 'failed', 'cancelled'].includes(data.status)) timer = setTimeout(() => watch(content, version, id), 1500);
  } catch (error) {
    if (version === generation) content.append(el('p', error.message, 'error'), button('重试读取', () => watch(content, version, id), 'ghost'));
  }
}
export async function startExplanation(taskId, seq, quote) {
  const { content, version } = shell('介绍所选文字');
  content.append(el('p', '正在启动专用解释 Agent…', 'hint'));
  try {
    const data = await api('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'explanation.start', params: { id: taskId, seq, quote } }) });
    if (version === generation) { paint(content, data); await watch(content, version, data.id); }
  } catch (error) { if (version === generation) content.replaceChildren(el('p', error.message, 'error')); }
}
export async function openExplanation(id) {
  const { content, version } = shell('执行过程介绍');
  await watch(content, version, id);
}
export async function explanationHistory(taskId) {
  const { content, version } = shell(`任务 #${taskId} 的解释历史`);
  const load = async before => {
    try {
      const data = await api(`/api/task/${taskId}/explanations${before ? `?before=${before}` : ''}`);
      if (version !== generation) return;
      if (!before && !data.explanations.length) content.append(el('p', '还没有解释记录。选中文字后右键选择“介绍”。', 'hint'));
      for (const row of data.explanations) content.append(button(`#${row.id} · 步骤 ${row.seq} · ${row.status} · ${row.quote}`, () => openExplanation(row.id), 'history-explanation'));
      if (data.has_more) {
        const more = button('更早的解释', async () => { more.disabled = true; await load(data.next); more.remove(); }, 'ghost'); content.append(more);
      }
    } catch (error) { if (version === generation) content.append(el('p', error.message, 'error')); }
  };
  await load(null);
}
