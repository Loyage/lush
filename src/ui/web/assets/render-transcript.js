import { $, button, el } from './dom.js';
import { api } from './api.js';
import { MD_STEP, STEP, relative } from './format.js';
import { detail } from './navigate.js';
import { transcriptCache, ui } from './state.js';
import { agentText } from './text.js';

/* ---------- agent 执行过程：只读投影 pi 会话记录 ---------- */
/** 单步折叠：默认每步只占一行（类型 + 标题 + 时间），点这一行才看正文；只有大模型的「回答」默认展开。 */
const STEP_OPEN = new Set(['text']);
const stepKey = (taskId, step) => `${taskId}:${step.seq}`;
const stepExpanded = (taskId, step) => ui.stepToggle.get(stepKey(taskId, step)) ?? STEP_OPEN.has(step.kind);

/** 一步：折叠状态只改这一个节点，不重建整个执行过程（否则滚动位置会跳）。 */
function stepNode(taskId, step) {
  const item = el('li', undefined, `step s-${step.kind}`);
  const head = el('button', undefined, 'step-head');
  head.type = 'button';
  const caret = el('span', '', 'step-caret');
  head.append(caret, el('span', STEP[step.kind] || step.kind, `step-kind k-${step.kind}`), el('span', step.title, 'step-title'));
  if (step.at) head.append(el('span', relative(step.at), 'when'));
  item.append(head);
  // 没有正文的步骤（运行时元数据）保持一行，也不做可点的样子。
  if (!step.body) { head.classList.add('static'); head.tabIndex = -1; return item; }
  const body = MD_STEP.has(step.kind) ? agentText(step.body, { className: 'step-body' }) : el('div', step.body, 'step-body');
  const paint = open => {
    item.classList.toggle('open', open);
    caret.textContent = open ? '▾' : '▸';
    body.hidden = !open;
    head.setAttribute('aria-expanded', String(open));
  };
  head.title = '点击展开／收起这一步的正文';
  head.onclick = () => { const open = !item.classList.contains('open'); ui.stepToggle.set(stepKey(taskId, step), open); paint(open); };
  paint(stepExpanded(taskId, step));
  item.append(body);
  return item;
}

export function transcriptContent(taskId) {
  const state = transcriptCache.get(taskId);
  if (!state) return [el('p', '正在读取会话记录…', 'hint')];
  const meta = el('p', transcriptMetaText(state), 'hint');
  meta.dataset.live = 'transcript-meta';
  if (!state.steps.length) return [meta];
  const list = el('ol', undefined, 'steps');
  list.dataset.live = 'transcript-steps';
  for (const step of state.steps) list.append(stepNode(taskId, step));
  const foldable = state.steps.filter(step => step.body);
  const actions = el('div', undefined, 'actions');
  // 一步一行，但轮到要看全文时不该点几十次：一个按钮把整段过程一次摊开或收起。
  if (foldable.length > 1) {
    const allOpen = foldable.every(step => stepExpanded(taskId, step));
    actions.append(button(allOpen ? '收起全部步骤' : '展开全部步骤', () => {
      for (const step of foldable) ui.stepToggle.set(stepKey(taskId, step), !allOpen);
      paintTranscript(taskId);
    }, 'ghost'));
  }
  if (state.has_more) { const more = button(`加载更多（已有 ${state.steps.length} 步）`, async () => {
    const page = await api(`/api/task/${taskId}/transcript?after=${state.next}`);
    state.steps.push(...page.steps); state.next = page.next; state.has_more = page.has_more;
    paintTranscript(taskId);
  }, 'ghost'); more.dataset.live = 'transcript-more'; actions.append(more); }
  actions.append(button('重新加载', async () => { await loadTranscript(taskId); await detail(taskId); }, 'ghost'));
  return [meta, list, actions, state.truncated ? el('p', '会话记录过大，只读取了前面一部分。', 'hint') : null].filter(Boolean);
}
/** 只替换执行过程区块，避免为了追加一页步骤重建整个详情面板。 */
export function paintTranscript(taskId) {
  if (ui.selected !== taskId) return;
  const holder = $('detail').querySelector('.transcript');
  if (holder) holder.replaceChildren(...transcriptContent(taskId));
}
const transcriptMetaText = state => state.steps.length
  ? `${state.steps.length} 步 \u00b7 来自 pi 会话记录：${state.files.join('\u3001')} \u00b7 默认折叠成一行，点标题展开（「回答」默认展开）`
  : (state.files.length ? '会话记录里还没有可显示的步骤。' : '这个任务还没有 pi 会话记录（可能从未被唤醒，或会话文件已被清理）。');
/**
 * 热任务轮询的增量续读：只往现有 <ol> 后面接新步骤，不重建列表、不动 #detail 的滚动位置，
 * 也不碰用户正在输入的 textarea。列表还没画出来（刚展开/之前没有步骤）时才整体重画那一个区块。
 */
export function appendTranscriptSteps(taskId, steps) {
  if (ui.selected !== taskId) return;
  const state = transcriptCache.get(taskId);
  const holder = $('detail').querySelector('.transcript');
  if (!state || !holder) return;
  const list = holder.querySelector('[data-live="transcript-steps"]');
  if (list) for (const step of steps) list.append(stepNode(taskId, step));
  else paintTranscript(taskId);
  const meta = holder.querySelector('[data-live="transcript-meta"]');
  if (meta) meta.textContent = transcriptMetaText(state);
  const more = holder.querySelector('[data-live="transcript-more"]');
  if (more) more.textContent = `加载更多（已有 ${state.steps.length} 步）`;
}
export async function loadTranscript(taskId) {
  const page = await api(`/api/task/${taskId}/transcript?after=0`);
  transcriptCache.set(taskId, { steps: page.steps, files: page.files, next: page.next, has_more: page.has_more, truncated: page.truncated });
  paintTranscript(taskId);
}
