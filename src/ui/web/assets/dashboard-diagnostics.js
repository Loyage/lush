import { api } from './api.js';
import { el } from './dom.js';
import { diagnosticsLink } from './diagnostics-route.js';
import { formDialog } from './dialog.js';
import { onPrefChange, pollingIntervals } from './prefs.js';

export const DIAGNOSTICS_ID = 'widget:diagnostics';
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = value => Number.isSafeInteger(value) && value >= 0;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const format = (value, digits = 2) => value.toLocaleString(undefined, { maximumFractionDigits: digits });
const clock = value => timestamp(value) ? new Date(value).toLocaleTimeString() : '时间未知';
const STATES = { online: '在线', offline: '离线', unavailable: '不可达', unsupported: '不支持诊断' };
const METRICS = [['input', '输入 token/s', 'input_per_second', 1 / 10], ['output', '输出 token/s', 'output_per_second', 1 / 10], ['cost', '估算 USD/min', 'cost_per_minute', 6]];

/** Reject malformed snapshots, never turn missing/unknown observations into a complete zero. */
export function validateDiagnostics(value) {
  if (value?.version !== 1 || !timestamp(value.generated_at) || value.currency !== 'USD' || value.estimated !== true
    || !Array.isArray(value.windows) || value.windows.length !== 2 || ![60, 300].every(seconds => value.windows.some(window => window.seconds === seconds))
    || !Array.isArray(value.buckets) || value.buckets.length !== 60 || !Array.isArray(value.projects)
    || !['projects_total', 'projects_online', 'projects_reporting'].every(key => count(value.coverage?.[key]))
    || typeof value.coverage.complete !== 'boolean' || value.coverage.projects_reporting > value.coverage.projects_online
    || value.coverage.projects_online > value.coverage.projects_total
    || value.windows.some(window => !['input', 'output', 'cost', 'input_per_second', 'output_per_second', 'cost_per_minute'].every(key => window[key] === null || number(window[key]))
      || !['requests', 'unknown_tokens', 'unknown_cost'].every(key => count(window[key])) || typeof window.complete !== 'boolean')
    || value.buckets.some(bucket => !timestamp(bucket.at) || !['input', 'output', 'cost'].every(key => bucket[key] === null || number(bucket[key]))
      || !count(bucket.unknown_tokens) || !count(bucket.unknown_cost))
    || value.projects.some(project => typeof project.id !== 'string' || typeof project.name !== 'string' || !Object.hasOwn(STATES, project.state)
      || !(project.generated_at === null || timestamp(project.generated_at)) || (project.error !== undefined && typeof project.error !== 'string'))) {
    throw new Error('运行诊断响应无效，当前流量未确认');
  }
  return value;
}
export function diagnosticsRate(window, metric, coverage) {
  const key = METRICS.find(([name]) => name === metric)[2], value = window?.[key];
  if (!number(value) || !coverage?.projects_reporting) return '未知';
  const complete = coverage.complete && window.complete && !(metric === 'cost' ? window.unknown_cost : window.unknown_tokens);
  return !complete && value === 0 ? '未知' : `${complete ? '' : '≥'}${format(value, metric === 'cost' ? 6 : 2)}`;
}
function unknownBucket(snapshot, bucket, metric) {
  return !snapshot.coverage.projects_reporting || !number(bucket[metric])
    || (metric === 'cost' ? bucket.unknown_cost : bucket.unknown_tokens) > 0;
}
export function diagnosticsTrend(snapshot, metric) {
  const factor = METRICS.find(([name]) => name === metric)[3];
  // A positive subtotal remains useful even when another contribution is unknown.
  // An uncertain zero is not evidence of no consumption.
  return snapshot.buckets.map(bucket => !snapshot.coverage.projects_reporting || !number(bucket[metric])
    || unknownBucket(snapshot, bucket, metric) && bucket[metric] === 0 ? null : bucket[metric] * factor);
}
function coverageText(snapshot) {
  if (!snapshot) return '覆盖情况未知';
  const coverage = snapshot.coverage;
  if (!coverage.projects_total) return '无登记项目，流量未知';
  const unavailable = [...new Set(snapshot.projects.filter(project => project.state !== 'online').map(project => STATES[project.state]))];
  return `覆盖 ${coverage.projects_reporting}/${coverage.projects_total} 项目 · ${coverage.complete ? '完整' : `不完整（${unavailable.join('／') || '来源或用量未确认'}）`}`;
}
function trends(snapshot) {
  const root = el('section', undefined, 'diagnostics-trends'); root.setAttribute('aria-label', '最近10分钟趋势（10秒桶）');
  for (const [key, label] of METRICS) {
    const values = diagnosticsTrend(snapshot, key), max = Math.max(0, ...values.filter(number));
    const uncertain = snapshot.buckets.map(bucket => unknownBucket(snapshot, bucket, key));
    const incomplete = uncertain.filter(Boolean).length;
    const peak = !values.some(number) || incomplete && max === 0 ? '未知' : `${incomplete ? '≥' : ''}${format(max, key === 'cost' ? 6 : 2)}`;
    const graph = el('figure', undefined, `diagnostics-trend diagnostics-trend-${key}`);
    graph.append(el('figcaption', `${label} · 峰值 ${peak}`));
    const bars = el('div', undefined, 'diagnostics-trend-bars');
    bars.setAttribute('role', 'img'); bars.setAttribute('aria-label', `${label}，最近10分钟；独立刻度；${incomplete} 个不完整桶；柱高为已知小计，不完整时仅为下界；未知值不补零`);
    values.forEach((value, index) => {
      const slot = el('span', undefined, 'diagnostics-trend-slot');
      slot.dataset.known = String(value !== null);
      slot.dataset.complete = String(!uncertain[index]);
      if (value !== null && value > 0) { const bar = el('span', undefined, 'diagnostics-trend-bar'); bar.style.setProperty('height', `${Math.max(0, value / max * 100)}%`); slot.append(bar); }
      bars.append(slot);
    });
    graph.append(bars); root.append(graph);
  }
  root.append(el('p', `10分钟 · 每桶10秒 · ${snapshot.coverage.complete ? '已报告数据' : '仅已报告部分，未覆盖来源不补零'} · 柱=已知小计`, 'diagnostics-note'));
  return root;
}
function windows(snapshot, compact = false) {
  const root = el('div', undefined, 'diagnostics-windows');
  for (const window of [...snapshot.windows].sort((a, b) => a.seconds - b.seconds)) {
    const row = el('div', undefined, 'diagnostics-window'); row.dataset.seconds = window.seconds;
    row.append(el('span', `${window.seconds / 60}分钟`, 'diagnostics-period'));
    for (const [key, label] of METRICS) {
      const value = el('div', undefined, 'diagnostics-rate');
      value.append(el('span', compact ? ({ input: '入/s', output: '出/s', cost: '估USD/min' })[key] : label), el('strong', diagnosticsRate(window, key, snapshot.coverage)));
      row.append(value);
    }
    root.append(row);
  }
  return root;
}

/** Independent read owner. Polling touches no account, config, project summary, or focus. */
export function createDiagnosticsController({ ownsPage = () => true, request = api, onChange = () => {},
  intervalMs = () => Math.max(10000, pollingIntervals().snapshot * 6), timers = globalThis } = {}) {
  const owner = globalThis.document;
  let enabled = false, disposed = false, pageVisible = true, epoch = 0, pending = null, abort = null, timer = null, snapshot = null, error = null;
  const active = () => !disposed && pageVisible && owner === globalThis.document && ownsPage() && enabled && owner?.visibilityState !== 'hidden';
  const notify = () => onChange({ snapshot, error, pending: !!pending });
  function clearTimer() { if (timer !== null) timers.clearTimeout(timer); timer = null; }
  function schedule() {
    clearTimer();
    if (active()) timer = timers.setTimeout(() => { timer = null; if (!ownsPage()) { dispose(); return; } void refresh(); }, intervalMs());
  }
  function refresh() {
    if (!active()) return Promise.resolve();
    if (pending) return pending;
    clearTimer(); const currentEpoch = epoch; abort = new AbortController();
    pending = Promise.resolve().then(() => request('/api/host/diagnostics', { signal: abort.signal })).then(value => {
      if (active() && currentEpoch === epoch) { snapshot = validateDiagnostics(value); error = null; }
    }).catch(failure => { if (active() && currentEpoch === epoch) error = failure?.message || '运行诊断读取失败'; }).finally(() => {
      pending = null; abort = null;
      clearTimer();
      if (active()) { notify(); if (currentEpoch !== epoch) void refresh(); else schedule(); }
      else if (!ownsPage() || owner !== globalThis.document) dispose();
    });
    notify(); return pending;
  }
  function suspend() { ++epoch; clearTimer(); abort?.abort(); }
  function visibility() { if (!active()) suspend(); else { void refresh(); schedule(); } }
  const stopPreference = onPrefChange('polling', schedule);
  owner?.addEventListener?.('visibilitychange', visibility);
  const pagehide = () => { pageVisible = false; suspend(); };
  const pageshow = () => { pageVisible = true; visibility(); };
  globalThis.addEventListener?.('pagehide', pagehide); globalThis.addEventListener?.('pageshow', pageshow);
  function dispose() {
    if (disposed) return;
    disposed = true; suspend(); stopPreference(); owner?.removeEventListener?.('visibilitychange', visibility);
    globalThis.removeEventListener?.('pagehide', pagehide); globalThis.removeEventListener?.('pageshow', pageshow);
  }
  return { refresh, dispose, state: () => ({ snapshot, error, pending: !!pending }),
    setEnabled(value) { if (enabled === value || disposed) return; enabled = value; if (!value) suspend(); else { void refresh(); schedule(); } } };
}

/** Retained card controls. Data-only updates never replace the card, resize it, or steal focus. */
export function renderDiagnosticsCard(row, { geometry = row.geometry, state, refresh, ownsPage = () => true } = {}) {
  const root = el('li', undefined, 'project-item dashboard-widget dashboard-diagnostics-card');
  root.dataset.cardId = row.id; root.dataset.cardType = root.dataset.widgetType = 'diagnostics';
  const header = el('header', undefined, 'dashboard-widget-header'); header.append(el('strong', '运行诊断', 'dashboard-widget-title'));
  const body = el('div', undefined, 'dashboard-widget-body diagnostics-body');
  const footer = el('footer', undefined, 'dashboard-widget-footer');
  const updated = el('span', '尚未更新', 'diagnostics-updated');
  const control = el('button', '刷新', 'ghost dashboard-diagnostics-refresh'); control.type = 'button';
  control.dataset.help = '仅重新读取已登记项目的运行诊断，不查询服务商、不启动后台或调用模型。';
  const host = el('span', undefined, 'help-host'); host.append(control);
  const details = el('button', '快照', 'ghost dashboard-diagnostics-details'); details.type = 'button';
  details.dataset.help = '查看本卡片的 1／5 分钟小计和 10 分钟趋势；自选时间、来源与模型请打开分析页。';
  control.onclick = () => { if (ownsPage() && !state().pending) return refresh(); };
  details.onclick = () => {
    if (!ownsPage()) return;
    const { snapshot, error } = state(), content = el('div', undefined, 'diagnostics-details');
    content.append(el('p', '估算费用不是账单。响应／回合结束后入账，不是实时流式速率；输入包含缓存。缺失 token 或金额、离线及不支持来源不补零。未知项是无法完整统计的贡献项计数，不是缺失 token 数或金额；在线来源也可能报告不完整。'));
    content.append(el('p', coverageText(snapshot)));
    if (error) content.append(el('p', `读取失败：${error}；旧值不是当前确认值`, 'error'));
    if (snapshot) {
      content.append(el('p', `最近更新：${new Date(snapshot.generated_at).toLocaleString()}`), windows(snapshot), trends(snapshot));
      for (const window of snapshot.windows) content.append(el('p', `${window.seconds / 60}分钟：${window.requests}次响应 · 未知用量项 ${window.unknown_tokens} · 未知费用项 ${window.unknown_cost} · ${window.complete ? '窗口完整' : '窗口不完整'}`));
      const sources = el('ul', undefined, 'diagnostics-sources');
      for (const project of snapshot.projects) sources.append(el('li', `${project.name} · ${STATES[project.state]} · ${project.generated_at ? clock(project.generated_at) : '无更新时间'}${project.error ? ` · ${project.error}` : ''}`));
      content.append(sources);
    }
    void formDialog({ title: '简版诊断快照（1／5分钟及10分钟趋势）', content, confirmLabel: '关闭', confirmPrimary: false });
  };
  const analysis = diagnosticsLink(el, {}, '分析'); analysis.setAttribute('aria-label', '打开完整运行诊断分析页');
  footer.append(updated, host, details, analysis); root.append(header, body, footer);
  function paint() {
    const { snapshot, error, pending } = state();
    const compact = (geometry?.h || 18) < 18;
    body.replaceChildren(); root.dataset.compact = String(compact);
    if (snapshot) {
      body.append(windows(snapshot, true));
      const incomplete = snapshot.windows.some(window => !window.complete || window.unknown_cost || window.unknown_tokens);
      body.append(el('p', error ? `更新失败，旧值 · ${coverageText(snapshot)}` : `${coverageText(snapshot)}${incomplete ? ' · token／金额有缺失' : ''}`, 'diagnostics-coverage'));
      if (!compact) body.append(trends(snapshot), el('p', '估算非账单 · 响应结束后入账 · 输入含缓存', 'diagnostics-note'));
      updated.textContent = `${error ? '上次 ' : ''}${clock(snapshot.generated_at)}`;
    } else body.append(el('p', error ? `诊断不可用：${error}` : '正在读取运行诊断，流量未知', 'diagnostics-coverage'));
    // Native disabled blurs the focused button in Firefox. Keep its focus with
    // aria-disabled + the same action gate; unfocused controls use native disabled.
    control.setAttribute('aria-disabled', String(!!pending));
    control.disabled = !!pending && globalThis.document.activeElement !== control;
    if (pending) { host.dataset.help = '诊断读取尚未结束，不会重复请求。'; host.setAttribute('tabindex', '0'); }
    else { delete host.dataset.help; host.removeAttribute('tabindex'); }
  }
  root.dashboardDiagnosticsChange = paint;
  root.dashboardGeometryChange = next => { geometry = next; paint(); };
  paint(); return root;
}
