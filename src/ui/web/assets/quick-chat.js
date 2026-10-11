import { api } from './api.js';
import { $, el } from './dom.js';
import { show } from './messages.js';
import { projectRoute } from './route.js';
import { ui } from './state.js';

export const quickChatConfig = () => api('/api/host/quick-chat/config');
export const quickChatAction = (method, params) => api('/api/host/quick-chat/action', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }),
});
export function conversationHref(id) {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('对话编号无效');
  return `/#quick-chat-C${id}`;
}
/** Open synchronously in the user gesture, before any model/API await. */
export function prepareConversationTab() {
  try {
    const tab = window.open('about:blank', '_blank');
    if (tab) { tab.opener = null; if (tab.document?.body) tab.document.body.textContent = '正在创建快速对话，请稍候…'; }
    return tab;
  } catch { return null; }
}
export function closeConversationTab(tab) { try { if (tab && !tab.closed) tab.close(); } catch {} }
export function openConversationResult(record, tab, holder = null) {
  const href = conversationHref(record.id);
  try {
    if (tab && !tab.closed) { tab.location.replace(href); return; }
  } catch { /* The accepted conversation remains readable through the fallback link. */ }
  const box = holder || $('quick-chat-open-result');
  const targets = box ? [box] : [];
  // A modal dialog makes body-level links inert. Keep a separate top-layer result host;
  // removing the reader removes this host too, while the original link remains available.
  const panel = !holder && ui.transcriptView?.panel;
  if (panel) {
    let local = panel.querySelector('[data-chat-result="true"]');
    if (!local) {
      local = el('aside', undefined, 'quick-chat-open-result'); local.dataset.chatResult = 'true'; local.setAttribute('role', 'status'); panel.append(local);
    }
    targets.push(local);
  }
  for (const target of targets) {
    const link = el('a', `打开对话 ${record.number || `C${record.id}`}`); link.href = href; link.target = '_blank'; link.rel = 'noopener';
    target.replaceChildren(el('span', '对话已创建，浏览器未能打开新标签。请点击：'), link); target.hidden = false;
  }
  show(`对话 ${record.number || `C${record.id}`} 已创建；请点击“打开对话”，不要重复发送。`);
}
export function chatReferences(values) {
  const project = projectRoute();
  return values.map(value => ({ ...value, ...(project ? { project_id: project } : {}) }));
}
export async function startSelectionChat(promptId, quote, reference) {
  if (!quote.trim() || quote.length > 8192) { show('选区最多 8192 字；没有截断或发送，请缩短选区。', 'error'); return; }
  const tab = prepareConversationTab();
  try {
    const record = await quickChatAction('start', { prompt_id: promptId, content: '', references: chatReferences([{ ...reference, quote }]) });
    openConversationResult(record, tab);
    return record;
  } catch (error) { closeConversationTab(tab); show(`快速对话创建未确认：${error.message}；请先核对历史，不要自动重发。`, 'error'); }
}
