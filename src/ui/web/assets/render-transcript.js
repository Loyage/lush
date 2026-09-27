import { $, button, el } from './dom.js';
import { api } from './api.js';
import { STEP, relative, tokensView } from './format.js';
import { onPrefChange, readPref } from './prefs.js';
import { transcriptCache, transcriptOpen, ui } from './state.js';
import { transcriptBody } from './transcript-body.js';
import { referenceable } from './context-references.js';
import { callKey, groupSteps, stepSummary } from './transcript-model.js';
import { transcriptReader, openTranscriptStep } from './transcript-reader.js';

/* ---------- agent 执行过程：只读投影 pi 会话记录 ---------- */
/** Reading defaults: meaningful content is visible; only runtime metadata starts collapsed. */
const STEP_OPEN = new Set(['input', 'text', 'thinking', 'tool', 'result']);
const stepKey = (apId, step) => `${apId}:${step.seq}`;
const stepExpanded = (apId, step) => ui.stepToggle.get(stepKey(apId, step)) ?? STEP_OPEN.has(step.kind);

/** 当前快速查看的阅读方向：默认倒序（最新在前），设置里可切回正序。 */
export const transcriptOrder = () => readPref('transcriptOrder');

/** 一步占用的上下文 chip：精确＝这次请求的合计，估算＝这一批新增（带 + 前缀）。同一组只在 first 那一步印一次。 */
export function tokensChip(tokens) {
  const view = tokensView(tokens);
  if (!view) return null;
  const chip = el('span', view.text, 'step-tokens');
  chip.title = view.title;
  return chip;
}

function sourceBody(apId, step) {
  const body = el('div', undefined, 'step-source');
  body.append(transcriptBody(step, { key: stepKey(apId, step) }));
  const source = el('details', undefined, 'step-original');
  source.append(el('summary', `原文与来源 · #${step.seq}`));
  source.addEventListener('toggle', () => {
    if (!source.open || source.dataset.loaded) return;
    source.dataset.loaded = 'true';
    source.append(el('p', `${step.file || '会话记录'}${step.line ? `:${step.line}` : ''}`, 'hint'), el('pre', step.body, 'raw-value'),
      button('在终端模式中查看', () => openTranscriptStep(apId, step.seq), 'ghost'));
  });
  body.append(source);
  if (/…（已截断 \d+ 字符）$/.test(step.body || '')) body.append(button('本段已截断 · 在终端模式中继续阅读', () => openTranscriptStep(apId, step.seq), 'ghost'));
  referenceable(body, { kind: 'transcript_step', target: { ap_id: apId, seq: step.seq }, label: `执行步骤 #${apId}:${step.seq}`,
    quote: step.body, location: { ap_id: apId, section: 'transcript' } });
  return body;
}
function attachResult(apId, item, step) {
  const results = item.querySelector('.step-results');
  if (!results || results.querySelector(`[data-result-seq="${step.seq}"]`)) return;
  const part = sourceBody(apId, step); part.dataset.resultSeq = String(step.seq);
  part.prepend(el('h4', step.is_error ? '输出 · 失败' : '输出'));
  if (step.is_error) { part.classList.add('step-failed'); item.classList.add('step-failed'); }
  const chip = step.tokens?.first ? tokensChip(step.tokens) : null;
  if (chip) part.prepend(chip);
  results.append(part);
  const status = item.querySelector('.step-call-status');
  if (status) { status.textContent = step.is_error || status.dataset.failed ? '失败' : '已有结果'; if (step.is_error) status.dataset.failed = 'true'; }
}

/** 一步：折叠状态只改这一个节点，不重建整个执行过程（否则滚动位置会跳）。 */
function stepNode(apId, step) {
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
    referenceable(item, { kind: 'transcript_step', target: { ap_id: apId, seq: step.seq }, label: `执行步骤 #${apId}:${step.seq}`,
      quote: `${STEP[step.kind] || step.kind} · ${step.title}`, location: { view: 'ap-detail', ap_id: apId, section: 'transcript' } });
    return item;
  }
  const body = el('div', undefined, 'step-body');
  body.append(sourceBody(apId, step));
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
  head.setAttribute('data-help', '点击展开／收起这一步的正文');
  head.onclick = () => { const open = !item.classList.contains('open'); ui.stepToggle.set(stepKey(apId, step), open); paint(open); };
  paint(stepExpanded(apId, step));
  item.append(body);
  for (const result of step.results || []) attachResult(apId, item, result);
  referenceable(item, { kind: 'transcript_step', target: { ap_id: apId, seq: step.seq }, label: `执行步骤 #${apId}:${step.seq}`,
    quote: `${STEP[step.kind] || step.kind} · ${step.title}\n${step.body}`, location: { view: 'ap-detail', ap_id: apId, section: 'transcript' } });
  return item;
}

/** 已加载的唯一步骤节点（配对结果挂在调用里，用 data-result-seq，不在此列）。 */
function nodeBySeq(container, seq) {
  for (const child of container.children) if (child.dataset?.seq === String(seq)) return child;
  return null;
}

/** 结果步按 (file, call_id) 找到唯一的已加载调用步；重复身份不猜配。 */
function callStepFor(state, step) {
  if (step.kind !== 'result') return null;
  const key = callKey(step);
  if (!key) return null;
  const calls = state.steps.filter(value => value.kind === 'tool' && callKey(value) === key);
  return calls.length === 1 ? calls[0] : null;
}

/** 增量续读：更新的一页合并到列表尾部（asc）或顶部（desc），结果并入已加载的调用节点。 */
function insertNewer(apId, list, state, steps) {
  const desc = state.order === 'desc';
  for (const step of steps) {
    const call = callStepFor(state, step);
    const node = call ? nodeBySeq(list, call.seq) : null;
    if (node) attachResult(apId, node, step);
    else if (desc) list.prepend(stepNode(apId, step));
    else list.append(stepNode(apId, step));
  }
}

/** 向旧翻页：一页更早的步骤插到列表顶部（asc）或底部（desc），跨边界配对不重复、不错配。 */
function insertOlder(apId, list, state, steps) {
  const staged = el('ol', undefined, 'steps');
  for (const step of steps) {   // 窗口内升序构建，调用先于结果，窗口内配对成立
    const call = callStepFor(state, step);
    const node = call ? nodeBySeq(staged, call.seq) : null;
    if (node) attachResult(apId, node, step);
    else staged.append(stepNode(apId, step));
  }
  // 边界配对：这一页加载的调用，其结果可能已经作为独立节点渲染在另一侧；折进调用，不留重复。
  // 重复的 (file, call_id) 身份不猜配，与 groupSteps 保持一致。
  for (const item of staged.children) {
    const callStep = state.steps.find(value => value.seq === Number(item.dataset.seq));
    if (!callStep || callStep.kind !== 'tool' || !callKey(callStep)) continue;
    const calls = state.steps.filter(value => value.kind === 'tool' && callKey(value) === callKey(callStep));
    if (calls.length !== 1) continue;
    for (const result of state.steps) {
      if (result.kind !== 'result' || callKey(result) !== callKey(callStep)) continue;
      const standalone = nodeBySeq(list, result.seq);
      if (standalone) { standalone.remove(); attachResult(apId, item, result); }
    }
  }
  // desc 列表最新在上，更早的页追加到底部并按倒序排列；asc 列表最早在上，整页前插并保持升序。
  if (state.order === 'desc') list.append(...[...staged.children].reverse());
  else list.prepend(...staged.children);
}

const transcriptMetaText = state => state.steps.length
  ? `已加载 ${state.steps.length} 条记录 · 按调用关联输入输出 · 长内容可就地展开${(state.has_older || state.has_more) ? ' · 尚有未加载记录' : ''}`
  : (state.files.length ? '会话记录里还没有可显示的步骤。' : '这个 AP 还没有 pi 会话记录（可能从未被唤醒，或会话文件已被清理）。');

/** 只替换执行过程区块，避免为了追加一页步骤重建整个详情面板。 */
export function paintTranscript(apId) {
  if (ui.selected !== apId) return;
  const holder = $('detail').querySelector('.transcript');
  if (holder) { holder.transcriptState = transcriptCache.get(apId); holder.replaceChildren(...transcriptContent(apId)); }
}

/** 只刷新过程区块之外的计数与翻页入口，不重建已渲染节点。 */
function syncTranscriptChrome(apId, state) {
  if (ui.selected !== apId) return;
  const holder = $('detail').querySelector('.transcript');
  if (!holder) return;
  const meta = holder.querySelector('[data-live="transcript-meta"]');
  if (meta) meta.textContent = transcriptMetaText(state);
  const older = holder.querySelector('[data-live="transcript-older"]');
  if (older) { older.textContent = `加载更早（已有 ${state.steps.length} 步）`; older.hidden = !state.has_older; }
  const newer = holder.querySelector('[data-live="transcript-newer"]');
  if (newer) { newer.textContent = `加载更多（已有 ${state.steps.length} 步）`; newer.hidden = !state.has_more; }
}

export function transcriptContent(apId) {
  const state = transcriptCache.get(apId);
  if (!state) return [el('p', '正在读取会话记录…', 'hint')];
  if (state.error) return [transcriptReader(apId, { locate: locateTranscriptStep }), el('p', `读取执行记录失败：${state.error}`, 'error'),
    button('重试读取', () => loadTranscript(apId), 'ghost')];
  const meta = el('p', transcriptMetaText(state), 'hint');
  meta.dataset.live = 'transcript-meta';
  if (!state.steps.length) return [meta, transcriptReader(apId, { locate: locateTranscriptStep })];
  const desc = state.order === 'desc';
  const grouped = groupSteps(state.steps);
  const list = el('ol', undefined, 'steps');
  list.dataset.live = 'transcript-steps';
  // state.steps 始终按 seq 升序保存为规范态；倒序只在渲染层反转。
  for (const step of desc ? [...grouped].reverse() : grouped) list.append(stepNode(apId, step));
  const foldable = grouped.filter(step => step.body || step.results.length);
  const actions = el('div', undefined, 'actions');
  // 一步一行，但轮到要看全文时不该点几十次：一个按钮把整段过程一次摊开或收起。
  if (foldable.length > 1) {
    const allOpen = foldable.every(step => stepExpanded(apId, step));
    actions.append(button(allOpen ? '收起全部步骤' : '展开全部步骤', () => {
      for (const step of foldable) ui.stepToggle.set(stepKey(apId, step), !allOpen);
      paintTranscript(apId);
    }, 'ghost'));
  }
  // 两个方向都给出明确的翻页入口：搜索定位后窗口两侧都可能有未加载记录。
  const older = olderButton(apId, state);
  const newer = newerButton(apId, state);
  if (older) actions.append(older);
  if (newer) actions.append(newer);
  actions.append(button('重新加载', () => loadTranscript(apId), 'ghost'));
  const latest = button(desc ? '有新记录 · 跳到最新' : '有新记录 · 跳到末尾', () => {
    const target = desc ? list.firstElementChild : list.lastElementChild;
    target?.scrollIntoView?.({ block: 'nearest' }); latest.hidden = true;
  }, 'ghost transcript-new');
  latest.hidden = true; latest.dataset.live = 'transcript-new';
  const sources = el('details', undefined, 'transcript-sources');
  sources.append(el('summary', `记录来源 · ${state.files.length} 个会话文件`), el('pre', state.files.join('\n'), 'raw-value'));
  return [transcriptReader(apId, { locate: locateTranscriptStep }), meta, latest, list, actions, sources, state.truncated ? el('p', '快速视图只读取了前面一部分；顶部全文搜索可访问后续会话与完整原文。', 'hint') : null].filter(Boolean);
}

/** 「加载更多」：向后读更新的一页，asc 追加到末尾、desc 前插到顶部。 */
function newerButton(apId, state) {
  if (!state.has_more) return null;
  const more = button(`加载更多（已有 ${state.steps.length} 步）`, async () => {
    more.disabled = true;
    try {
      const after = state.next;
      const page = await api(`/api/ap/${apId}/transcript?after=${after}`);
      if (state.next !== after || transcriptCache.get(apId) !== state) return;
      state.steps.push(...(page.steps || [])); state.next = page.next; state.has_more = page.has_more;
      state.truncated = Boolean(state.truncated || page.truncated);
      appendTranscriptSteps(apId, page.steps || []);
    } finally { more.disabled = false; }
  }, 'ghost'); more.dataset.live = 'transcript-newer';
  return more;
}

/** 「加载更早」：用 before=oldest 取上一页，asc 前插到顶部、desc 追加到底部。 */
function olderButton(apId, state) {
  if (!state.has_older) return null;
  const more = button(`加载更早（已有 ${state.steps.length} 步）`, async () => {
    more.disabled = true;
    try {
      const before = state.oldest;
      const page = await api(`/api/ap/${apId}/transcript-latest?before=${before}&limit=100`);
      if (state.oldest !== before || transcriptCache.get(apId) !== state) return;
      state.steps.unshift(...(page.steps || []));
      state.oldest = page.oldest ?? state.oldest;
      state.has_older = Boolean(page.has_older);
      state.truncated = Boolean(state.truncated || page.truncated);
      if (ui.selected === apId) {
        const holder = $('detail').querySelector('.transcript');
        const list = holder?.querySelector('[data-live="transcript-steps"]');
        if (list) insertOlder(apId, list, state, page.steps || []);
      }
      syncTranscriptChrome(apId, state);
    } finally { more.disabled = false; }
  }, 'ghost'); more.dataset.live = 'transcript-older';
  return more;
}

/**
 * 热 AP 轮询与终态补读的增量续读：只往现有 <ol> 里接新步骤，不重建列表、不动 #detail 的滚动位置，
 * 也不碰用户正在输入的 textarea。列表还没画出来（刚展开/之前没有步骤）时才整体重画那一个区块。
 */
export function appendTranscriptSteps(apId, steps) {
  if (ui.selected !== apId) return;
  const state = transcriptCache.get(apId);
  const holder = $('detail').querySelector('.transcript');
  if (!state || !holder) return;
  const list = holder.querySelector('[data-live="transcript-steps"]');
  if (list) insertNewer(apId, list, state, steps);
  else paintTranscript(apId);
  syncTranscriptChrome(apId, state);
  const latest = holder.querySelector('[data-live="transcript-new"]');
  if (latest && steps.length) latest.hidden = false;
}

/** 按当前阅读方向取「更新的一页」：asc 用前向端点，desc 用最新端点（after=已知最大 seq）。 */
export async function fetchTranscriptAfter(apId, after) {
  return transcriptOrder() === 'desc'
    ? api(`/api/ap/${apId}/transcript-latest?after=${after}`)
    : api(`/api/ap/${apId}/transcript?after=${after}`);
}

/**
 * 搜索命中定位：以目标 seq 为中心取一个有界窗口（前 100 + 后 100），两侧都保留「是否还有更多」的
 * 真实边界，之后在富文本执行过程里展开并滚动到该步，不切到终端模式。
 */
export async function loadTranscriptWindow(apId, seq) {
  const [backward, forward] = await Promise.all([
    api(`/api/ap/${apId}/transcript-latest?before=${seq + 1}&limit=100`),
    api(`/api/ap/${apId}/transcript?after=${seq}&limit=100`),
  ]);
  const merged = [];
  const seen = new Set();
  for (const step of [...(backward.steps || []), ...(forward.steps || [])]) {
    if (seen.has(step.seq)) continue;
    seen.add(step.seq); merged.push(step);
  }
  merged.sort((a, b) => a.seq - b.seq);
  transcriptCache.set(apId, {
    order: transcriptOrder(),
    steps: merged,
    files: (forward.files?.length ? forward.files : backward.files) || [],
    next: merged.length ? merged[merged.length - 1].seq : seq,
    oldest: merged.length ? merged[0].seq : seq,
    has_more: Boolean(forward.has_more),
    has_older: Boolean(backward.has_older),
    truncated: Boolean(forward.truncated || backward.truncated),
  });
  return transcriptCache.get(apId);
}

/** 找到承载 seq 的步骤节点：直接是它自己，或配对结果所在的调用步。 */
function stepTarget(root, seq) {
  const direct = root.querySelector(`[data-seq="${seq}"]`);
  const result = root.querySelector(`[data-result-seq="${seq}"]`);
  if (!result) return direct ? { step: direct, inner: direct } : null;
  let step = result;
  while (step && !step.classList?.contains?.('step')) step = step.parentNode;
  return { step: step || result, inner: result };
}

function revealStep({ step, inner }) {
  const head = step.querySelector?.('.step-head');
  if (head && !step.classList?.contains('open')) head.onclick?.();
  (inner || step).scrollIntoView?.({ block: 'center' });
  const nodes = [step, inner].filter(Boolean);
  for (const node of nodes) node.classList?.add('step-located');
  setTimeout(() => { for (const node of nodes) node.classList?.remove('step-located'); }, 2000);
}

/** 点搜索命中：停在富文本执行过程里定位该步；终端模式仍是显式的「不看渲染」入口。 */
export async function locateTranscriptStep(apId, seq) {
  if (ui.selected !== apId) return;
  const holder = $('detail').querySelector('.transcript');
  if (!holder) return;
  const state = transcriptCache.get(apId);
  if (!state || !state.steps.some(step => step.seq === seq)) {
    await loadTranscriptWindow(apId, seq);
    paintTranscript(apId);
  }
  const target = stepTarget($('detail'), seq);
  if (target) revealStep(target);
}

export async function loadTranscript(apId) {
  const order = transcriptOrder();
  if (order === 'desc') {
    const page = await api(`/api/ap/${apId}/transcript-latest?limit=100`);
    transcriptCache.set(apId, { order, steps: page.steps || [], files: page.files || [], next: page.next ?? 0,
      oldest: page.oldest ?? 0, has_older: Boolean(page.has_older), truncated: page.truncated });
  } else {
    const page = await api(`/api/ap/${apId}/transcript?after=0`);
    transcriptCache.set(apId, { order, steps: page.steps || [], files: page.files || [], next: page.next ?? 0,
      has_more: page.has_more, truncated: page.truncated });
  }
  paintTranscript(apId);
}

// 阅读方向切换：已展开的 AP 按新方向重新加载；未展开的只丢弃旧方向缓存，等下次展开再请求。
onPrefChange('transcriptOrder', () => {
  const order = transcriptOrder();
  for (const [id, state] of transcriptCache) if (state.order !== order) transcriptCache.delete(id);
  const apId = ui.selected;
  if (apId !== null && transcriptOpen.has(apId)) loadTranscript(apId).catch(() => { /* 网络抖动交给主刷新提示 */ });
});
