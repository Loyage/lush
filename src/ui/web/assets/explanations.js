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
const locationText = location => {
  const bits = [];
  if (location?.view) bits.push(`页面 ${location.view}`);
  if (location?.section) bits.push(`位置 ${location.section}`);
  if (location?.task_id != null) bits.push(`任务 #${location.task_id}`);
  if (location?.input_id != null) bits.push(`意图 #${location.input_id}`);
  if (location?.spec_id != null) bits.push(`规划条目 #${location.spec_id}`);
  if (location?.notice_id != null) bits.push(`事项 #${location.notice_id}`);
  if (location?.path) bits.push(location.path);
  return bits.join(' · ') || '当前页面';
};
function paint(content, data) {
  const source = data.source || {};
  // 通用选区快照只有 quote + location；步骤快照才有 task_id / seq / step / related。
  const generic = source.kind === 'selection';
  content.replaceChildren(el('p', `解释 #${data.id} · ${data.status} · 模型解释，不是执行事实`, 'hint'));
  content.append(el('p', generic
    ? `来源：所选文字（${locationText(source.location)}） · ${source.captured_at || ''}`
    : `来源：任务 #${source.task_id} / 步骤 #${source.seq} · ${source.captured_at || ''}`, 'hint'));
  content.append(el('blockquote', source.quote || ''));
  if (!generic && source.body_truncated) content.append(el('p', '关联步骤较长，解释上下文仅含首段；选中文字完整保留。', 'hint'));
  content.append(data.error ? el('p', data.error, 'error') : agentText(data.result || '正在排队或解释…'));
  const snapshot = el('details');
  snapshot.append(el('summary', '当时的来源快照'));
  if (generic) {
    snapshot.append(el('p', `页面位置：${locationText(source.location)}`));
  } else {
    snapshot.append(el('p', `任务目标：${source.goal || '（没有记录）'}`));
    const steps = [source.step, ...(source.related || [])].filter(Boolean);
    for (const step of steps) {
      snapshot.append(el('h4', `步骤 #${step.seq} · ${step.title}`), structuredValue(step.body));
      if (step.body_truncated) snapshot.append(el('p', '此关联记录为截断摘要。', 'hint'));
    }
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
  const { content, version } = shell('介绍执行步骤');
  content.append(el('p', '正在启动专用解释 Agent…', 'hint'));
  try {
    const data = await api('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'explanation.start', params: { id: taskId, seq, quote } }) });
    if (version === generation) { paint(content, data); await watch(content, version, data.id); }
  } catch (error) { if (version === generation) content.replaceChildren(el('p', error.message, 'error')); }
}

// 「快速介绍」：选中文字后直连设置里的模型 API，不经过 Agent；结果保存进解释历史。
function paintIntro(content, data) {
  content.replaceChildren(el('p', `快速介绍 #${data.id} · ${data.status} · 模型解释，不是执行事实`, 'hint'));
  content.append(el('p', `来源：所选文字（${locationText(data.location)}） · ${data.created_at || ''}`, 'hint'));
  content.append(el('blockquote', data.quote || ''));
  content.append(data.error ? el('p', data.error, 'error') : agentText(data.result || '正在调用配置的模型…'));
  if (data.model) content.append(el('p', `模型：${data.model}`, 'hint'));
}
async function watchIntro(content, version, id) {
  if (version !== generation) return;
  try {
    const data = await api(`/api/intro/${id}`);
    if (version !== generation) return;
    const signature = JSON.stringify([data.status, data.result, data.error]);
    if (content.dataset.signature !== signature) { paintIntro(content, data); content.dataset.signature = signature; }
    if (!['completed', 'failed', 'cancelled'].includes(data.status)) timer = setTimeout(() => watchIntro(content, version, id), 1500);
  } catch (error) {
    if (version === generation) content.append(el('p', error.message, 'error'), button('重试读取', () => watchIntro(content, version, id), 'ghost'));
  }
}
export async function startIntro(quote, location) {
  const { content, version } = shell('快速介绍所选文字');
  content.append(el('p', '正在调用设置里配置的模型…', 'hint'));
  try {
    const data = await api('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'intro.start', params: { quote, location } }) });
    if (version === generation) { paintIntro(content, data); await watchIntro(content, version, data.id); }
  } catch (error) { if (version === generation) content.replaceChildren(el('p', error.message, 'error')); }
}
export async function openIntro(id) {
  const { content, version } = shell('快速介绍');
  await watchIntro(content, version, id);
}
export async function openExplanation(id) {
  const { content, version } = shell('执行过程介绍');
  await watch(content, version, id);
}
export async function explanationHistory(taskId) {
  const { content, version } = shell(`任务 #${taskId} 的解释历史`);
  const quick = el('div'), agent = el('div');
  content.append(quick, agent);
  const quickHead = el('h4', '快速介绍'); quick.append(quickHead);
  const quickEmpty = el('p', '还没有快速介绍记录。选中文字后右键选择「快速介绍」。', 'hint'); quick.append(quickEmpty);
  const loadIntros = async before => {
    try {
      const data = await api(`/api/task/${taskId}/intros${before ? `?before=${before}` : ''}`);
      if (version !== generation) return;
      for (const row of data.introductions) {
        quickEmpty.remove();
        quick.append(button(`#${row.id} · ${row.status} · ${row.quote}`, () => openIntro(row.id), 'history-explanation'));
      }
      if (data.has_more) {
        const more = button('更早的快速介绍', async () => { more.disabled = true; await loadIntros(data.next); more.remove(); }, 'ghost'); quick.append(more);
      }
    } catch (error) { if (version === generation) quick.append(el('p', error.message, 'error')); }
  };
  const agentHead = el('h4', '执行步骤解释'); agent.append(agentHead);
  const agentEmpty = el('p', '还没有执行步骤解释记录。在执行过程里选中文字后右键选择「介绍」。', 'hint'); agent.append(agentEmpty);
  const loadAgent = async before => {
    try {
      const data = await api(`/api/task/${taskId}/explanations${before ? `?before=${before}` : ''}`);
      if (version !== generation) return;
      for (const row of data.explanations) {
        agentEmpty.remove();
        agent.append(button(`#${row.id} · 步骤 ${row.seq} · ${row.status} · ${row.quote}`, () => openExplanation(row.id), 'history-explanation'));
      }
      if (data.has_more) {
        const more = button('更早的执行步骤解释', async () => { more.disabled = true; await loadAgent(data.next); more.remove(); }, 'ghost'); agent.append(more);
      }
    } catch (error) { if (version === generation) agent.append(el('p', error.message, 'error')); }
  };
  await Promise.all([loadIntros(null), loadAgent(null)]);
}
