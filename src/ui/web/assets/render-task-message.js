import { button, el } from './dom.js';
import { absolute } from './format.js';
import { agentText, markdownEnabled } from './text.js';
import { structuredValue } from './structured-value.js';

const SIGNALS = {
  'child.completed': '子任务完成', 'child.failed': '子任务失败', 'child.cancelled': '子任务已取消',
  'merge.requested': '请求合并', 'merge.completed': '已合并', 'merge.repair': '合并分歧 · 需要修复',
};
const FIELDS = {
  branch: '分支', commit: '提交', baseline: '合并基线', source_commit: '源提交',
  parent_commit: '固定父提交', parent_head: '父分支提交',
};
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

// Populate details only on explicit expansion; raw text is authoritative and never reconstructed.
function fold(label, content, className = '') {
  const node = el('details', undefined, className);
  node.append(el('summary', label));
  let loaded = false;
  node.addEventListener('toggle', () => {
    if (node.open && !loaded) { loaded = true; node.append(content()); }
  });
  return node;
}

function prose(text, className = 'message-prose') {
  const root = el('div', undefined, className);
  const preview = text.split('\n').slice(0, 12).join('\n').slice(0, 1800);
  const body = agentText(preview, { className: 'message-prose' });
  root.append(body);
  if (preview.length < text.length) {
    const toggle = button('展开完整正文', () => {
      const expanded = toggle.getAttribute('aria-expanded') !== 'true';
      root.replaceChildren(agentText(expanded ? text : preview, { className: 'message-prose' }), toggle);
      toggle.textContent = expanded ? '收起正文' : '展开完整正文';
      toggle.setAttribute('aria-expanded', String(expanded));
    }, 'ghost');
    toggle.setAttribute('aria-expanded', 'false'); root.append(toggle);
  }
  return root;
}

function signalView(parsed) {
  if (!record(parsed)) return null;
  if (parsed.version === 1 && typeof parsed.signal === 'string' && own(SIGNALS, parsed.signal) && record(parsed.payload)) {
    return { title: SIGNALS[parsed.signal], payload: parsed.payload, failed: parsed.signal === 'child.failed' };
  }
  // Historical settlement messages did not have a versioned signal envelope.
  const status = { completed: '子任务完成', failed: '子任务失败', cancelled: '子任务已取消' };
  if (!own(parsed, 'version') && Number.isSafeInteger(parsed.child) && typeof parsed.status === 'string' && own(status, parsed.status)) {
    const { child, status: _status, ...payload } = parsed;
    return { title: `${status[parsed.status]} · #${child}`, payload, failed: parsed.status === 'failed' };
  }
  return null;
}

function renderPayload(root, payload) {
  const handled = new Set();
  for (const [key, label] of [['result', '结果'], ['error', '错误'], ['instruction', '处理说明']]) {
    if (typeof payload[key] !== 'string' || !payload[key]) continue;
    handled.add(key);
    const section = el('div', undefined, `message-section${key === 'error' ? ' message-error' : ''}`);
    section.append(el('h4', label), prose(payload[key])); root.append(section);
  }
  if (payload.result_truncated === true) {
    handled.add('result_truncated');
    root.append(el('p', '结果已在消息生成时截断；展开原文也不能恢复缺失部分，请查看来源任务的结果。', 'hint'));
  }
  const fields = el('dl', undefined, 'message-fields');
  for (const [key, label] of Object.entries(FIELDS)) {
    if (typeof payload[key] !== 'string' || !payload[key]) continue;
    handled.add(key); fields.append(el('dt', label), el('dd', payload[key], 'mono'));
  }
  if (fields.children.length) root.append(fields);
  const rest = Object.fromEntries(Object.entries(payload).filter(([key, value]) => !handled.has(key)
    && value !== null && !(key === 'result_truncated' && value === false)));
  if (Object.keys(rest).length) root.append(fold('更多消息字段', () => structuredValue(JSON.stringify(rest), { openRoot: true }), 'message-extra'));
}

function renderDecision(root, parsed) {
  root.append(el('h3', parsed.dismissed ? '未做决定' : '已答复决策', 'message-title'));
  if (parsed.title) root.append(el('p', parsed.title, 'message-decision-title'));
  root.append(el('p', `决策 #${parsed.notice_id}`, 'hint'));
  if (parsed.dismissed) { root.append(el('p', '这次没有选择任何方案，不代表接受推荐项。', 'hint')); return; }
  const answer = parsed.answer;
  if (typeof answer === 'string' && answer) root.append(prose(answer));
  else if (answer?.version === 1 && Array.isArray(answer.answers)) {
    for (const item of answer.answers.slice(0, 100)) {
      if (!record(item)) continue;
      const row = el('div', undefined, 'message-section');
      row.append(el('h4', String(item.question || item.header || '答复')));
      const labels = Array.isArray(item.labels) ? item.labels.filter(label => typeof label === 'string') : [];
      if (labels.length) row.append(prose(labels.join('、')));
      if (typeof item.custom === 'string' && item.custom) row.append(prose(item.custom));
      if (!labels.length && !item.custom) row.append(el('p', '未选择选项', 'hint'));
      root.append(row);
    }
    if (answer.answers.length > 100) root.append(el('p', '仅显示前 100 项答复，完整内容见原文。', 'hint'));
  } else if (answer != null) root.append(structuredValue(JSON.stringify(answer), { openRoot: true }));
}

/** Read-only presentation; it never infers current task state from a historical message. */
export function renderTaskMessage(message, taskId, previous = null) {
  const text = String(message.body ?? '');
  const signature = JSON.stringify([taskId, message.id, text, message.sender_id, message.created_at, message.signal_type, markdownEnabled()]);
  if (previous?.messageSignature === signature) return previous;
  const root = el('article', undefined, 'msg task-message');
  root.dataset.messageId = String(message.id); root.messageSignature = signature;
  const from = message.sender_id === taskId ? `发给任务 #${message.task_id}`
    : message.sender_id != null ? `来自任务 #${message.sender_id}` : '来自你';
  const meta = el('div', undefined, 'message-meta');
  meta.append(el('span', from));
  if (message.created_at) {
    const time = el('time', absolute(message.created_at)); time.setAttribute('datetime', message.created_at); meta.append(time);
  }
  root.append(meta);
  let parsed;
  try { parsed = JSON.parse(text); } catch { /* malformed JSON is text, not a repaired object */ }
  const signal = signalView(parsed);
  if (signal) {
    root.classList.add('message-system');
    if (signal.failed) root.classList.add('message-failed');
    root.append(el('h3', signal.title, 'message-title')); renderPayload(root, signal.payload);
  } else if (record(parsed) && Number.isSafeInteger(parsed.notice_id) && typeof parsed.dismissed === 'boolean' && own(parsed, 'answer')) {
    root.classList.add('message-system'); renderDecision(root, parsed);
  } else if (record(parsed) || Array.isArray(parsed)) {
    root.append(el('h3', '结构化消息', 'message-title'), structuredValue(text, { openRoot: true }));
  } else if (text) root.append(prose(text));
  else root.append(el('p', '（空消息）', 'hint'));
  root.append(fold('查看完整原文', () => el('pre', text, 'raw-value'), 'message-original'));
  return root;
}
