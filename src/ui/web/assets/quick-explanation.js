import { el, button } from './dom.js';
import { api } from './api.js';
import { agentText } from './text.js';
import { ui } from './state.js';
import { workbenchStatus } from './project-picker.js';

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
    location.task_id != null && `Worker #${location.task_id}`, location.path].filter(Boolean).join(' · ') || '当前页面';
}
const configurationLink = () => { const link = el('a', '打开快捷解释设置'); link.href = '#quick-explain'; link.onclick = closeQuickExplanationPanel; return link; };
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
  current = { panel, content, timer: null, version: generation, view: ui.view, onEscape };
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
function paint(state, data) {
  const signature = JSON.stringify(data);
  if (state.signature === signature) return;
  state.signature = signature;
  const content = state.content;
  const legacyRunning = data.status === 'running' && !data.source;
  const status = legacyRunning ? '历史状态：运行中（未恢复）' : { running: '解释中', completed: '已完成', failed: '失败' }[data.status] || data.status;
  content.replaceChildren(el('p', `解释 #${data.id} · ${status} · 模型解释，不是执行事实`, 'hint'),
    el('p', `${explanationLocation(data.location)} · ${data.created_at || ''}`, 'hint'), el('blockquote', data.quote || ''));
  content.append(data.error ? el('p', data.error, 'error') : agentText(data.result || (legacyRunning ? '旧调用未记录结果，不会自动重新执行。' : '正在调用所选模型…')));
  content.append(el('p', `调用来源：${data.source?.label || '历史来源未知'} · 模型：${data.model || '未知'}`, 'hint'));
  const snapshot = el('details'); snapshot.append(el('summary', '当时的配置快照'));
  snapshot.append(el('p', data.source?.endpoint || '历史端点未知', 'hint'),
    el('pre', data.prompt || '历史 Prompt 未记录', 'quick-explanation-prompt-snapshot'));
  content.append(snapshot);
}
async function watch(state, id) {
  if (!owns(state)) return;
  try {
    const data = await api(`/api/quick-explain/${id}`);
    if (!owns(state)) return;
    // A final response must not replace text the user is currently selecting in this panel.
    const reading = selectedWithin(state.content);
    if (!reading) paint(state, data);
    if ((data.status === 'running' && data.source) || reading) state.timer = setTimeout(() => watch(state, id), 1500);
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
