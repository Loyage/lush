import { el, button } from './dom.js';
import { loadReadingRecord } from './api.js';
import { createPerformanceData } from './performance-data.js';
import { analyzePerformance } from './performance-model.js';
import { absolute, lifecycleDuration } from './format.js';

const scopes = { history: '生命周期', runs: '调用', steps: '工具记录', progress: '阶段历史' };
const stamp = value => value && Number.isFinite(Date.parse(value)) ? absolute(value) : '时间未知';

/** Foreground-only sampled analysis. Explicit full scans, never background polling or model calls. */
export function createPerformanceView(taskId, { onStep = async () => {} } = {}) {
  const root = el('section', undefined, 'performance-view'); root.setAttribute('aria-label', '当前 Worker 性能分析');
  const heading = el('h2', '性能分析');
  const controls = el('div', undefined, 'actions performance-controls');
  const status = el('p', '进入页签后读取有界计时证据；完整历史须显式扫描。', 'hint performance-status'); status.setAttribute('role', 'status');
  const summary = el('div', undefined, 'performance-summary');
  const ranks = el('div', undefined, 'performance-ranks');
  const stages = el('section', undefined, 'performance-stages'), waits = el('section', undefined, 'performance-waits'); ranks.append(stages, waits);
  const advanced = el('details', undefined, 'performance-advanced'); advanced.append(el('summary', '各轮调用、工具排行与统计口径'));
  const calls = el('section', undefined, 'performance-calls'), tools = el('section', undefined, 'performance-tools'), notes = el('ul', undefined, 'hint performance-notes');
  advanced.append(calls, tools, notes);
  const evidence = el('section', undefined, 'performance-evidence'); evidence.hidden = true; evidence.tabIndex = -1; evidence.setAttribute('aria-label', '性能计时证据');
  let collector = createPerformanceData(taskId), active = false, disposed = false, generation = 0, reading = null, evidenceRead = null, evidenceGeneration = 0;
  let loading = false, initialized = false, needsPaint = false, message = '', expanded = new Set();
  const refresh = button('刷新分析', () => { cancel(); collector = createPerformanceData(taskId); initialized = false; expanded.clear(); return load(false); }, 'ghost');
  const scan = button('分析全部历史', () => load(true), 'ghost', { help: '显式分批读取当前 Worker 的全部调用、生命周期、阶段与执行记录，达到预算或失败时保留局部结果；不读取子 Worker，不调用 Agent。' });
  const cancelButton = button('取消读取', () => { cancel(); message = '读取已取消，保留当前范围；可继续分析全部历史。'; paint(); }, 'ghost');
  controls.append(refresh, scan, cancelButton); root.append(heading, controls, status, summary, ranks, advanced, evidence);
  function cancelEvidence() { evidenceGeneration++; evidenceRead?.abort(); evidenceRead = null; }
  function cancel() { generation++; reading?.abort(); reading = null; loading = false; cancelEvidence(); }
  const current = () => active && !disposed;
  function section(host, title, rows, limit = 5) {
    host.replaceChildren(el('h3', title));
    if (!rows.length) { host.append(el('p', '没有可用的已记录计时证据；不是零耗时。', 'hint')); return; }
    const shown = expanded.has(host) ? rows.length : limit;
    const list = el('ol', undefined, 'performance-list');
    for (const row of rows.slice(0, shown)) {
      const item = el('li', undefined, 'performance-row'); item.dataset.performanceKey = row.key;
      const head = el('div', undefined, 'performance-row-head');
      head.append(el('strong', row.label), el('span', `${row.estimated ? '≈ ' : ''}${lifecycleDuration(row.duration_ms)}${row.open ? '（采样时仍进行中）' : ''}`, 'performance-duration'));
      item.append(head, el('p', `${stamp(row.start)} → ${row.end ? stamp(row.end) : row.open ? '采样时刻' : '结束边界未知'}`, 'hint'));
      if (row.kind === 'unknown' || row.timing_unknown) item.append(el('p', '计时或等待原因未知，不据此推断性能结论。', 'hint'));
      if (row.frozen) item.append(el('p', '历史冻结阶段', 'hint'));
      if (row.source) item.append(button('查看对应记录', () => showEvidence(row), 'ghost performance-source'));
      list.append(item);
    }
    host.append(list);
    if (rows.length > limit) host.append(button(expanded.has(host) ? '收起排行' : `展开全部 ${rows.length} 项`, () => {
      if (expanded.has(host)) expanded.delete(host); else expanded.add(host); paint();
    }, 'ghost'));
  }
  function paint() {
    if (!current()) return;
    const scroll = root.scrollTop, data = collector.snapshot();
    const complete = Object.values(data.coverage).every(Boolean);
    const counts = `已读取 ${data.scanned} 条证据 · ${Object.entries(data.coverage).map(([key, done]) => `${scopes[key]}${done ? '已扫描' : '未读全'}`).join(' / ')}`;
    status.textContent = `${loading ? '正在读取… ' : ''}${message ? `${message} ` : ''}${complete ? '当前采样范围已扫描完；旧记录缺失仍保持未知。' : '仅分析已读取范围，尚非全部历史。'} ${counts}${data.sampled_at ? ` · 采样 ${stamp(data.sampled_at)}` : ''}`;
    refresh.disabled = loading; scan.disabled = loading || complete || data.exhausted; cancelButton.hidden = !loading;
    if (!data.task) return;
    const model = analyzePerformance(data);
    summary.replaceChildren();
    for (const [label, value] of [['已知调用用时（区间去重）', lifecycleDuration(model.summary.call_ms)], ['已证实非执行等待', lifecycleDuration(model.summary.wait_ms)],
      ['未知计时／原因项', `${model.summary.unknown_intervals} 项`]]) {
      const card = el('div', undefined, 'performance-metric'); card.append(el('span', label, 'hint'), el('strong', value)); summary.append(card);
    }
    section(stages, model.stages.length ? '最耗时的阶段' : '最耗时的调用（暂无里程碑计时）', model.stages.length ? model.stages : model.calls);
    section(waits, '等待与未知间隔（单独分析）', model.waits);
    section(calls, '各轮调用排行', model.calls, 10); section(tools, '工具调用间隔排行（估算）', model.tools, 10);
    notes.replaceChildren(...model.notes.map(note => el('li', note)), el('li', '各读面分批采样，不是原子快照。运行中数据不会自动替换；需要更新时点击刷新分析。'));
    if (model.progress_waits.length) notes.append(el('li', '计划中的等待行不重复加入阶段排行或等待合计；生命周期等待以实际阶段边界为准。'));
    root.scrollTop = scroll;
  }
  async function load(all) {
    if (!current() || loading) return;
    cancel(); const ticket = generation, controller = new AbortController(); reading = controller; loading = true; message = ''; initialized = true; paint();
    const valid = () => current() && ticket === generation && !controller.signal.aborted;
    try { await collector.load({ all, signal: controller.signal, onProgress: () => { if (valid()) paint(); } }); }
    catch (error) { if (valid()) message = `读取未完成：${error.message}`; }
    finally { if (valid()) { loading = false; reading = null; paint(); } }
  }
  async function showEvidence(row) {
    if (!current()) return;
    if (row.source.kind === 'transcript_step') { await onStep(row.source.seq); return; }
    cancelEvidence(); evidence.hidden = false;
    const ticket = evidenceGeneration, controller = new AbortController(); evidenceRead = controller;
    const valid = () => current() && ticket === evidenceGeneration && !controller.signal.aborted;
    const body = el('pre', undefined, 'performance-evidence-body');
    evidence.replaceChildren(el('h3', `${row.label} · 原始计时证据`), button('关闭证据', () => { cancelEvidence(); evidence.hidden = true; }, 'ghost'), body);
    evidence.focus?.({ preventScroll: true }); evidence.scrollIntoView?.({ block: 'nearest' });
    if (row.source.kind !== 'history_event') {
      const data = collector.snapshot();
      const record = row.source.kind === 'run' ? data.runs.find(run => run.id === row.source.run_id)
        : (row.source.plan_id === 'current' ? data.task.progress : data.progressVersions.find(plan => plan.id === row.source.plan_id)?.progress)?.items?.find(item => item.key === row.source.step_key);
      body.textContent = record ? JSON.stringify(record, null, 2) : '对应证据未加载，不能补猜。'; return;
    }
    body.textContent = '正在读取原始事件…';
    let offset = 0, first = true;
    const more = button('继续读取原始事件', readMore, 'ghost'); evidence.append(more); more.hidden = true;
    async function readMore() {
      try {
        const page = await loadReadingRecord(taskId, 'event', row.source.event_id, offset, { signal: controller.signal });
        if (!valid()) return;
        if (typeof page.text !== 'string' || !Number.isSafeInteger(page.next_offset) || (page.has_more && page.next_offset <= offset)) throw new Error('原始事件分页不可用');
        body.textContent = first ? page.text : body.textContent + page.text; first = false; offset = page.next_offset; more.hidden = !page.has_more;
        if (body.textContent.length > 96000) { more.hidden = true; evidence.append(el('p', '达到证据显示预算；只显示已加载原文，不代表全文。', 'hint')); }
      } catch (error) { if (valid()) { evidence.append(el('p', `原始证据读取未完成：${error.message}`, 'error')); more.hidden = false; more.textContent = '重试读取证据'; } }
    }
    await readMore();
  }
  return { root,
    async setActive(value) {
      if (disposed) return; active = value;
      if (!value) { const interrupted = loading; cancel(); if (interrupted) { message = '读取已暂停，范围尚未完成；可继续分析全部历史。'; needsPaint = true; } return; }
      if (!initialized) await load(false);
      else if (needsPaint) { needsPaint = false; paint(); }
    },
    dispose() { disposed = true; active = false; cancel(); },
  };
}
