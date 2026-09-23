import { $, button, el } from './dom.js';
import { api } from './api.js';
import { STEP, relative, tokensView } from './format.js';
import { transcriptCache, ui } from './state.js';
import { transcriptBody } from './transcript-body.js';
import { referenceable } from './context-references.js';
import { callKey, groupSteps, stepSummary } from './transcript-model.js';
import { transcriptReader, openTranscriptStep } from './transcript-reader.js';

/* ---------- agent 执行过程：只读投影 pi 会话记录 ---------- */
/** Reading defaults: meaningful content is visible; only runtime metadata starts collapsed. */
const STEP_OPEN = new Set(['input', 'text', 'thinking', 'tool', 'result']);
const stepKey = (taskId, step) => `${taskId}:${step.seq}`;
const stepExpanded = (taskId, step) => ui.stepToggle.get(stepKey(taskId, step)) ?? STEP_OPEN.has(step.kind);

/** 一步占用的上下文 chip：精确＝这次请求的合计，估算＝这一批新增（带 + 前缀）。同一组只在 first 那一步印一次。 */
export function tokensChip(tokens) {
  const view = tokensView(tokens);
  if (!view) return null;
  const chip = el('span', view.text, 'step-tokens');
  chip.title = view.title;
  return chip;
}

function sourceBody(taskId, step) {
  const body = el('div', undefined, 'step-source');
  body.append(transcriptBody(step, { key: stepKey(taskId, step) }));
  const source = el('details', undefined, 'step-original');
  source.append(el('summary', `原文与来源 · #${step.seq}`));
  source.addEventListener('toggle', () => {
    if (!source.open || source.dataset.loaded) return;
    source.dataset.loaded = 'true';
    source.append(el('p', `${step.file || '会话记录'}${step.line ? `:${step.line}` : ''}`, 'hint'), el('pre', step.body, 'raw-value'),
      button('完整原文与上下文', () => openTranscriptStep(taskId, step.seq), 'ghost'));
  });
  body.append(source);
  if (/…（已截断 \d+ 字符）$/.test(step.body || '')) body.append(button('本段已截断 · 读取完整原文', () => openTranscriptStep(taskId, step.seq), 'ghost'));
  referenceable(body, { kind: 'transcript_step', target: { task_id: taskId, seq: step.seq }, label: `执行步骤 #${taskId}:${step.seq}`,
    quote: step.body, location: { task_id: taskId, section: 'transcript' } });
  return body;
}
function attachResult(taskId, item, step) {
  const results = item.querySelector('.step-results');
  if (!results || results.querySelector(`[data-result-seq="${step.seq}"]`)) return;
  const part = sourceBody(taskId, step); part.dataset.resultSeq = String(step.seq);
  part.prepend(el('h4', step.is_error ? '输出 · 失败' : '输出'));
  if (step.is_error) { part.classList.add('step-failed'); item.classList.add('step-failed'); }
  const chip = step.tokens?.first ? tokensChip(step.tokens) : null;
  if (chip) part.prepend(chip);
  results.append(part);
  const status = item.querySelector('.step-call-status');
  if (status) { status.textContent = step.is_error || status.dataset.failed ? '失败' : '已有结果'; if (step.is_error) status.dataset.failed = 'true'; }
}

/** 一步：折叠状态只改这一个节点，不重建整个执行过程（否则滚动位置会跳）。 */
function stepNode(taskId, step) {
  const item = el('li', undefined, `step s-${step.kind}${step.is_error ? ' step-failed' : ''}`);
  item.dataset.seq = String(step.seq);
  const head = el('button', undefined, 'step-head');
  head.type = 'button';
  const caret = el('span', '', 'step-caret');
  const summary = stepSummary(step);
  // Content belongs below the heading, not in a single-line button or tooltip.
  const heading = ['tool', 'result', 'meta'].includes(step.kind) ? step.tool_name || step.title : `#${step.seq}`;
  const title = el('span', heading, 'step-title');
  title.title = summary;
  head.append(caret, el('span', STEP[step.kind] || step.kind, `step-kind k-${step.kind}`), title);
  if (step.kind === 'tool') head.append(el('span', '尚未见到结果', 'step-call-status'));
  else if (step.is_error) head.append(el('span', '失败', 'step-call-status'));
  // 同一组（turn 或 batch）只认 first：翻页增量续读拿到的后续步骤没有 first，chip 不会重复印出来。
  const chip = step.tokens?.first ? tokensChip(step.tokens) : null;
  if (chip) head.append(chip);
  if (step.at) head.append(el('span', relative(step.at), 'when'));
  item.append(head);
  // 没有正文的步骤（运行时元数据）保持一行，也不做可点的样子。
  if (!step.body && step.kind !== 'tool') {
    head.classList.add('static'); head.tabIndex = -1;
    referenceable(item, { kind: 'transcript_step', target: { task_id: taskId, seq: step.seq }, label: `执行步骤 #${taskId}:${step.seq}`,
      quote: `${STEP[step.kind] || step.kind} · ${step.title}`, location: { view: 'task-detail', task_id: taskId, section: 'transcript' } });
    return item;
  }
  const body = el('div', undefined, 'step-body');
  body.append(sourceBody(taskId, step));
  if (step.kind === 'tool') body.append(el('div', undefined, 'step-results'));
  const closedSummary = el('p', summary, 'step-closed-summary');
  item.append(closedSummary);
  const paint = open => {
    closedSummary.hidden = open;
    item.classList.toggle('open', open);
    caret.textContent = open ? '▾' : '▸';
    body.hidden = !open;
    head.setAttribute('aria-expanded', String(open));
  };
  head.title = '点击展开／收起这一步的正文';
  head.onclick = () => { const open = !item.classList.contains('open'); ui.stepToggle.set(stepKey(taskId, step), open); paint(open); };
  paint(stepExpanded(taskId, step));
  item.append(body);
  for (const result of step.results || []) attachResult(taskId, item, result);
  referenceable(item, { kind: 'transcript_step', target: { task_id: taskId, seq: step.seq }, label: `执行步骤 #${taskId}:${step.seq}`,
    quote: `${STEP[step.kind] || step.kind} · ${step.title}\n${step.body}`, location: { view: 'task-detail', task_id: taskId, section: 'transcript' } });
  return item;
}

export function transcriptContent(taskId) {
  const state = transcriptCache.get(taskId);
  if (!state) return [el('p', '正在读取会话记录…', 'hint')];
  if (state.error) return [transcriptReader(taskId), el('p', `读取执行记录失败：${state.error}`, 'error'),
    button('重试读取', () => loadTranscript(taskId), 'ghost')];
  const meta = el('p', transcriptMetaText(state), 'hint');
  meta.dataset.live = 'transcript-meta';
  if (!state.steps.length) return [meta, transcriptReader(taskId)];
  const list = el('ol', undefined, 'steps');
  list.dataset.live = 'transcript-steps';
  for (const step of groupSteps(state.steps)) list.append(stepNode(taskId, step));
  const foldable = groupSteps(state.steps).filter(step => step.body || step.results.length);
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
    more.disabled = true;
    try {
      const after = state.next;
      const page = await api(`/api/task/${taskId}/transcript?after=${after}`);
      if (state.next !== after || transcriptCache.get(taskId) !== state) return;
      state.steps.push(...page.steps); state.next = page.next; state.has_more = page.has_more;
      state.truncated = Boolean(state.truncated || page.truncated);
      appendTranscriptSteps(taskId, page.steps);
    } finally { more.disabled = false; }
  }, 'ghost'); more.dataset.live = 'transcript-more'; actions.append(more); }
  actions.append(button('重新加载', () => loadTranscript(taskId), 'ghost'));
  const latest = button('有新记录 · 跳到末尾', () => {
    list.lastElementChild?.scrollIntoView?.({ block: 'nearest' }); latest.hidden = true;
  }, 'ghost transcript-new');
  latest.hidden = true; latest.dataset.live = 'transcript-new';
  const sources = el('details', undefined, 'transcript-sources');
  sources.append(el('summary', `记录来源 · ${state.files.length} 个会话文件`), el('pre', state.files.join('\n'), 'raw-value'));
  return [transcriptReader(taskId), meta, latest, list, actions, sources, state.truncated ? el('p', '快速视图只读取了前面一部分；顶部全文搜索可访问后续会话与完整原文。', 'hint') : null].filter(Boolean);
}
/** 只替换执行过程区块，避免为了追加一页步骤重建整个详情面板。 */
export function paintTranscript(taskId) {
  if (ui.selected !== taskId) return;
  const holder = $('detail').querySelector('.transcript');
  if (holder) { holder.transcriptState = transcriptCache.get(taskId); holder.replaceChildren(...transcriptContent(taskId)); }
}
const transcriptMetaText = state => state.steps.length
  ? `已加载 ${state.steps.length} 条记录 · 按调用关联输入输出 · 长内容可就地展开${state.has_more ? ' · 尚有未加载记录' : ''}`
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
  if (list) for (const step of steps) {
    const calls = step.kind === 'result' && callKey(step) ? state.steps.filter(value => value.kind === 'tool' && callKey(value) === callKey(step)) : [];
    const call = calls.length === 1 ? list.querySelector(`[data-seq="${calls[0].seq}"]`) : null;
    if (call) attachResult(taskId, call, step);
    else list.append(stepNode(taskId, step));
  }
  else paintTranscript(taskId);
  const meta = holder.querySelector('[data-live="transcript-meta"]');
  if (meta) meta.textContent = transcriptMetaText(state);
  const more = holder.querySelector('[data-live="transcript-more"]');
  if (more) { more.textContent = `加载更多（已有 ${state.steps.length} 步）`; more.hidden = !state.has_more; }
  const latest = holder.querySelector('[data-live="transcript-new"]');
  if (latest && steps.length) latest.hidden = false;
}
export async function loadTranscript(taskId) {
  const page = await api(`/api/task/${taskId}/transcript?after=0`);
  transcriptCache.set(taskId, { steps: page.steps || [], files: page.files || [], next: page.next ?? 0, has_more: page.has_more, truncated: page.truncated });
  paintTranscript(taskId);
}
