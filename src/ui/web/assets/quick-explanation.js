import { el, button } from './dom.js';
import { api } from './api.js';
import { agentText } from './text.js';
import { ui } from './state.js';
import { workbenchStatus } from './project-picker.js';
import { modelHelp } from './help.js';
import { workerLabel } from './worker-label.js';

let current = null, generation = 0;
export function closeQuickExplanationPanel() {
  generation++;
  if (current) {
    clearTimeout(current.timer);
    globalThis.removeEventListener?.('keydown', current.onEscape, true);
    current.panel.remove(); current = null;
  }
}
ui.closeQuickExplanationPanel = closeQuickExplanationPanel;
export function explanationLocation(location = {}) {
  return [location.view && `页面 ${location.view}`, location.section && `位置 ${location.section}`,
    location.task_id != null && `Worker ${workerLabel(location.task_id, location.task_worker_number)}`, location.path].filter(Boolean).join(' · ') || '当前页面';
}
const configurationLink = () => {
  const link = el('a', '打开设备快捷解释配置'); link.href = '/#quick-explain'; link.target = '_blank'; link.rel = 'noopener';
  link.setAttribute('data-help', '在独立用户工作台配置设备统一来源与 Prompt；当前项目解释结果、选区和输入保留。'); return link;
};
function shell() {
  closeQuickExplanationPanel();
  const panel = el('aside', undefined, 'reading-panel quick-explanation-panel');
  panel.setAttribute('aria-label', '快捷解释');
  const close = button('关闭', closeQuickExplanationPanel, 'ghost');
  panel.onkeydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation?.(); closeQuickExplanationPanel(); }
  };
  const content = el('div');
  panel.append(el('h3', '快捷解释'), close, content);
  const dialog = ui.transcriptView?.panel;
  (dialog || document.body).append(panel);
  // Mouse actions retain the source selection rather than focusing the panel.
  // Capture Escape even when focus stays outside it, before the enclosing dialog closes.
  const onEscape = event => {
    if (event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation?.(); closeQuickExplanationPanel();
  };
  current = { panel, content, timer: null, version: generation, view: ui.view, onEscape,
    signature: null, explanationId: null, input: null, send: null, status: null };
  globalThis.addEventListener?.('keydown', onEscape, true);
  return current;
}
const owns = state => current === state && state.version === generation && state.view === ui.view;
function selectedWithin(node) {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed) return false;
  for (const endpoint of [selection.anchorNode, selection.focusNode]) {
    for (let at = endpoint; at; at = at.parentNode) if (at === node) return true;
  }
  return false;
}
function statusLabel(data) {
  const legacyRunning = data.status === 'running' && !data.source;
  if (legacyRunning) return '历史状态：运行中（未恢复）';
  return { running: '解释中', completed: '已完成', failed: '失败' }[data.status] || data.status;
}
/** 追问问答按发生顺序渲染；运行中、失败、截断都在轮次内如实标注。 */
function renderThread(thread, data) {
  const followups = data.followups || [];
  thread.hidden = followups.length === 0;
  if (!followups.length) return;
  thread.append(el('h3', '追问', 'quick-explanation-thread-title'));
  for (const turn of followups) {
    const article = el('article', undefined, 'quick-explanation-turn');
    article.append(el('p', `你：${turn.question}`, 'quick-explanation-question'));
    const body = turn.status === 'running' ? '正在生成回答…'
      : turn.error ? turn.error : (turn.answer || '模型没有返回内容');
    article.append(el('p', body, turn.error ? 'error quick-explanation-answer' : 'quick-explanation-answer'));
    if (turn.truncated) article.append(el('p', '更早的追问已超出上下文上限，本轮未发送给模型。', 'hint'));
    thread.append(article);
  }
}
function buildForm(state, data) {
  const form = el('form', undefined, 'quick-explanation-followup-form');
  const input = el('textarea');
  input.rows = 3; input.maxLength = 8192; input.placeholder = '继续追问…';
  input.setAttribute('aria-label', '追问内容');
  const send = el('button', '发送追问');
  send.type = 'submit'; send.classList.add('agent-call');
  send.setAttribute('data-help', modelHelp('针对这条解释继续提问，会将原选区、原解释和之前的追问一起发送给原来的模型'));
  // One in-flight turn at a time: while an answer is generating, the next question waits its turn.
  const busy = (data.followups || []).some(turn => turn.status === 'running');
  input.disabled = busy; send.disabled = busy;
  const status = el('p', busy ? '正在等待上一条追问的回答…'
    : `沿用原解释固定的来源：${data.source?.label || '原来源'} · 模型：${data.model || '未知'}`, 'hint');
  form.append(el('label', '追问（沿用原解释的来源与 Prompt）'), input, send, status);
  form.onsubmit = event => { event.preventDefault(); return submitFollowup(state); };
  state.input = input; state.send = send; state.status = status;
  return form;
}
async function submitFollowup(state) {
  const input = state.input, send = state.send, status = state.status;
  if (!owns(state)) return;
  const question = String(input?.value || '').trim();
  if (!question) { if (status) status.textContent = '请输入追问内容。'; return; }
  if (question.length > 8192) { if (status) status.textContent = '追问最多 8192 字。'; return; }
  if (input) input.disabled = true; if (send) send.disabled = true;
  if (status) status.textContent = '正在发送追问…';
  try {
    const data = await api('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'quick_explain.followup', params: { id: state.explanationId, question } }) });
    if (!owns(state)) return;
    paint(state, data);
    if ((data.followups || []).some(turn => turn.status === 'running')) state.timer = setTimeout(() => watch(state, state.explanationId), 1500);
  } catch (error) {
    if (!owns(state)) return;
    if (input) input.disabled = false; if (send) send.disabled = false;
    if (status) status.textContent = `追问失败：${error.message}`;
  }
}
function paint(state, data) {
  const signature = JSON.stringify(data);
  if (state.signature === signature) return;
  state.signature = signature;
  state.explanationId = data.id;
  const content = state.content;
  const legacyRunning = data.status === 'running' && !data.source;
  const root = [
    el('p', `解释 #${data.id} · ${statusLabel(data)} · 模型解释，不是执行事实`, 'hint'),
    el('p', `${explanationLocation(data.location)} · ${data.created_at || ''}`, 'hint'),
    el('blockquote', data.quote || ''),
    data.error ? el('p', data.error, 'error')
      : agentText(data.result || (legacyRunning ? '旧调用未记录结果，不会自动重新执行。' : '正在调用所选模型…')),
    el('p', `调用来源：${data.source?.label || '历史来源未知'} · 模型：${data.model || '未知'}`, 'hint'),
  ];
  const snapshot = el('details'); snapshot.append(el('summary', '当时的配置快照'),
    el('p', data.source?.endpoint || '历史端点未知', 'hint'),
    el('pre', data.prompt || '历史 Prompt 未记录', 'quick-explanation-prompt-snapshot'));
  root.push(snapshot);
  const thread = el('div', undefined, 'quick-explanation-thread');
  renderThread(thread, data);
  const tail = [thread];
  if (data.status === 'completed' && data.source) tail.push(buildForm(state, data));
  else if (data.status === 'completed' && !data.source)
    tail.push(el('p', '这条解释没有来源快照，无法追问；请在原页面重新发起解释。', 'hint'));
  content.replaceChildren(...root, ...tail);
}
async function watch(state, id) {
  if (!owns(state)) return;
  try {
    const data = await api(`/api/quick-explain/${id}`);
    if (!owns(state)) return;
    // A final response must not replace text the user is currently selecting in this panel.
    const reading = selectedWithin(state.content);
    if (!reading) paint(state, data);
    const running = (data.status === 'running' && data.source)
      || (data.followups || []).some(turn => turn.status === 'running');
    if (running || reading) state.timer = setTimeout(() => watch(state, id), 1500);
  } catch (error) {
    if (owns(state)) state.content.append(el('p', error.message, 'error'),
      button('重试读取', () => watch(state, id), 'ghost'));
  }
}
export async function startQuickExplanation(quote, location) {
  const state = shell();
  if (!workbenchStatus().projectUsable) {
    state.content.append(el('p', '请先打开一个可用项目；快捷解释配置与历史按项目保存。', 'hint')); return;
  }
  if (!quote?.trim() || quote.length > 8192) {
    state.content.append(el('p', '请选择 1–8192 字的文字；超长选区没有截断或发送。', 'error')); return;
  }
  state.content.append(el('p', '正在检查快捷解释配置…', 'hint'));
  try {
    const config = await api('/api/quick-explain/config');
    if (!owns(state)) return;
    if (!config.ready) {
      state.content.replaceChildren(el('p', config.reason || '请先选择快捷解释的模型来源和模型。', 'hint'), configurationLink()); return;
    }
    state.content.replaceChildren(el('p', '正在调用所选模型…', 'hint'));
    const data = await api('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'quick_explain.start', params: { quote, location } }) });
    if (!owns(state)) return;
    paint(state, data);
    if (data.status === 'running') state.timer = setTimeout(() => watch(state, data.id), 1500);
  } catch (error) {
    if (owns(state)) state.content.replaceChildren(el('p', error.message, 'error'), configurationLink());
  }
}
export async function openQuickExplanation(id) {
  const state = shell(); state.content.append(el('p', '正在读取解释…', 'hint')); await watch(state, id);
}
