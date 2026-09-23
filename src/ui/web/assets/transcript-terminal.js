import { $, el, button } from './dom.js';
import { api } from './api.js';
import { ui } from './state.js';
import { agentText } from './text.js';
import { referenceable } from './context-references.js';
import { closeExplanationPanel } from './explanations.js';

let current = null;
const LABELS = { input: '❯ 输入', thinking: '思考', text: '● 回答', tool: '↳ 调用', result: '↳ 输出', meta: '─ 会话信息' };

export function closeTranscriptTerminal() {
  const state = current;
  if (!state) return;
  current = null; state.version++;
  state.abort?.abort();
  removeEventListener('hashchange', state.onNavigate);
  if (state.panel.querySelector('.reading-panel')) closeExplanationPanel();
  if (state.menu) { state.menu.hidden = true; (state.menuParent || document.body).append(state.menu); }
  state.panel.close?.(); state.panel.remove();
  $('project-app').inert = state.wasInert;
  ui.terminalOpen = false;
  state.returnTarget?.focus?.({ preventScroll: true });
  $('detail').scrollTop = state.returnScroll;
}

/** Decode tool strings without a collapsed JSON tree; bound formatting work, never drop fields. */
function toolValue(value, depth = 0, budget = { left: 500 }) {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object' || depth >= 12 || --budget.left < 0) return JSON.stringify(value, null, 2);
  const entries = Object.entries(value);
  if (!entries.length) return Array.isArray(value) ? '[]' : '{}';
  return entries.map(([key, item]) => `${Array.isArray(value) ? `[${key}]` : key}:\n${toolValue(item, depth + 1, budget).split('\n').map(line => `  ${line}`).join('\n')}`).join('\n');
}

/** A document reader, not a terminal emulator: never interprets ANSI or starts a process. */
function recordNode(taskId, step) {
  const node = el('article', undefined, `terminal-record terminal-${step.kind}${step.is_error ? ' terminal-failed' : ''}`);
  node.dataset.seq = String(step.seq);
  const partial = step.offset > 0 || step.body.length < step.body_length;
  const label = LABELS[step.kind] || step.kind;
  const head = el('header');
  head.append(el('strong', `${label}${['tool', 'result'].includes(step.kind) ? ` ${step.tool_name || step.title}` : ''}${step.is_error ? ' · 失败' : ''}`),
    el('span', `#${step.seq}${step.offset ? ' · 续段' : ''}${step.call_id ? ` · ${step.call_id}` : ''}`, 'hint'));
  node.append(head);
  const body = step.body || '';
  if (partial) node.append(el('p', `原文分段 · 字符 ${step.offset + 1}–${step.offset + body.length} / ${step.body_length}（未裁剪）`, 'hint'));
  // Partial Markdown/JSON is faithfully rendered as text, not guessed or repaired.
  if (!partial && ['text', 'thinking'].includes(step.kind)) node.append(agentText(body, { plain: 'pre' }));
  else if (!partial && step.kind === 'tool') {
    let args;
    try { args = JSON.parse(body); } catch { /* keep raw */ }
    if (args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).length <= 100) {
      for (const [name, value] of Object.entries(args)) {
        node.append(el('div', name === 'command' ? '$ command' : name, 'terminal-field'),
          el('pre', toolValue(value), 'terminal-text'));
      }
      if (!Object.keys(args).length) node.append(el('pre', body, 'terminal-text'));
    } else node.append(el('pre', body, 'terminal-text'));
  } else node.append(el('pre', body, 'terminal-text'));
  const source = el('details', undefined, 'terminal-source');
  source.append(el('summary', `来源 · ${step.file}:${step.line}`));
  source.addEventListener('toggle', () => {
    if (source.open && !source.dataset.loaded) {
      source.dataset.loaded = 'true'; source.append(el('pre', body, 'terminal-text'));
    }
  });
  node.append(source);
  referenceable(node, { kind: 'transcript_step', target: { task_id: taskId, seq: step.seq },
    label: `执行步骤 #${taskId}:${step.seq}`, quote: body, location: { task_id: taskId, section: 'transcript' } });
  return node;
}

export async function openTranscriptTerminal(taskId, seq = 1) {
  closeTranscriptTerminal();
  const panel = el('dialog', undefined, 'terminal-dialog');
  panel.setAttribute('aria-label', `任务 #${taskId} 终端模式`);
  const state = { panel, version: 0, seq, offset: 0, first: seq, file: null, count: 0,
    returnTarget: document.activeElement, returnScroll: $('detail').scrollTop, wasInert: $('project-app').inert,
    menu: $('context-menu'), menuParent: $('context-menu')?.parentNode };
  current = state; ui.terminalOpen = true;
  const toolbar = el('header', undefined, 'terminal-toolbar');
  const back = button('返回任务 · Esc', closeTranscriptTerminal, 'ghost');
  const beginning = button('从头阅读', () => reset(1), 'ghost');
  const earlier = button('前 50 步', () => reset(Math.max(1, state.first - 50)), 'ghost');
  earlier.hidden = seq <= 1;
  toolbar.append(back, el('strong', `任务 #${taskId} · 终端模式`), earlier, beginning);
  const viewport = el('div', undefined, 'terminal-viewport'); viewport.tabIndex = 0;
  const content = el('div', undefined, 'terminal-records');
  const status = el('p', '', 'hint'); status.setAttribute('role', 'status');
  const more = button('继续读取', () => load(), 'ghost');
  const note = el('p', 'Pi 风格 · 只读记录，不是 Pi 原生终端。按会话顺序显示已保存的文字；不执行命令，不自动滚动。', 'hint');
  viewport.append(note, content, status, more); panel.append(toolbar, viewport);
  state.onNavigate = () => closeTranscriptTerminal();
  addEventListener('hashchange', state.onNavigate);
  panel.oncancel = event => { event.preventDefault(); closeTranscriptTerminal(); };
  panel.onkeydown = event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); closeTranscriptTerminal(); } };
  // Context actions must live in the native dialog's top layer, not behind its backdrop.
  if (state.menu) { state.menu.hidden = true; panel.append(state.menu); }
  document.body.append(panel); panel.showModal?.();
  $('project-app').inert = true;
  back.focus?.({ preventScroll: true });

  async function reset(start) {
    state.seq = start; state.offset = 0; state.first = start; state.file = null; state.count = 0;
    state.version++; state.abort?.abort();
    content.replaceChildren(); viewport.scrollTop = 0; earlier.hidden = start <= 1;
    await load();
  }
  async function load() {
    if (current !== state) return;
    const version = ++state.version;
    state.abort?.abort(); state.abort = new AbortController();
    more.disabled = true; status.textContent = '正在读取完整记录…';
    try {
      const data = await api(`/api/task/${taskId}/transcript-page?seq=${state.seq}&offset=${state.offset}`, { signal: state.abort.signal });
      if (current !== state || version !== state.version) return;
      for (const step of data.steps) {
        if (step.file !== state.file) {
          content.append(el('h3', `─ 会话 ${step.file}`, 'terminal-session')); state.file = step.file;
        }
        content.append(recordNode(taskId, step)); state.count++;
      }
      state.seq = data.next_seq; state.offset = data.next_offset;
      status.textContent = !data.files.length ? '没有可读取的会话文件，可能尚未记录或已被清理。'
        : `${state.first > 1 ? `从步骤 #${state.first} 开始 · ` : ''}已读取 ${state.count} 段${data.has_more ? ' · 后面还有内容，请继续读取' : ' · 已到当前记录末尾；可手动检查新记录'}`;
      more.textContent = data.has_more ? '继续读取后续记录' : '检查新记录';
    } catch (error) {
      if (current === state && version === state.version) { status.textContent = `读取未完成：${error.message}`; more.textContent = '重试读取'; }
    } finally { if (current === state && version === state.version) more.disabled = false; }
  }
  await load();
}
