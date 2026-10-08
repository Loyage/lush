import { block, button, el } from './dom.js';
import { api } from './api.js';
import { usageWindow, usageErrorLabels } from './usage-window.js';

const list = value => Array.isArray(value) ? value : [];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const amount = value => finite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 8 }) : '未知';
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : '时间未知';
const pointStatus = point => point.status === 'available' ? '查询成功' : usageErrorLabels[point.error_code] || '查询失败 / 未知';
const isKnown = point => point.status === 'available' && finite(point.remaining) && Number.isFinite(Date.parse(point.at));
const text = (parent, value, warning = false) => parent.append(el('p', value, warning ? 'agent-status-warning' : 'hint'));
function selectControl(parent, label, entries, value, className) {
  const wrap = el('label', label, 'agent-usage-field'), select = el('select', undefined, className);
  select.setAttribute('aria-label', label);
  for (const [id, name] of entries) { const option = el('option', name); option.value = id; select.append(option); }
  select.value = value; wrap.append(select); parent.append(wrap); return select;
}
function svg(tag, attrs = {}, content) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (content !== undefined) node.textContent = content;
  return node;
}
function resetBetween(previous, point) {
  return Boolean(previous && ((previous.reset_at && point.reset_at && previous.reset_at !== point.reset_at)
    || (previous.reset_at && Date.parse(previous.at) < Date.parse(previous.reset_at) && Date.parse(point.at) >= Date.parse(previous.reset_at))
    || (isKnown(previous) && isKnown(point) && point.remaining > previous.remaining)));
}

/** One series per chart: accounts, units, quota windows and source versions never share an axis. */
const READINGS = [['remaining', '剩余量'], ['used', '已用量'], ['used_percent', '已用比例'], ['total', '总量']];

/** Structured readings only; never derive a missing percentage or mix it with money. */
export function renderUsageSeries(series, range, config = {}) {
  if (!config.selectMetric) return renderMetricSeries(series, range, config);
  const root = el('div', undefined, 'agent-usage-metrics'), controls = el('div', undefined, 'agent-usage-filters');
  const choices = READINGS.filter(([key]) => list(series.points).some(point => point.status === 'available' && finite(point[key])));
  const available = choices.length ? choices : [READINGS[0]];
  const selected = available.some(([key]) => key === config.metric) ? config.metric : available[0][0];
  const metric = selectControl(controls, '曲线读数', available, selected, 'agent-usage-reading');
  const content = el('div');
  const paint = () => content.replaceChildren(renderMetricSeries(series, range, { ...config, metric: metric.value }));
  metric.onchange = paint; paint(); root.append(controls, content); return root;
}

function renderMetricSeries(series, range, config = {}) {
  const root = el('div', undefined, 'agent-usage-series'), points = list(series.points);
  const metric = READINGS.some(([key]) => key === config.metric) ? config.metric : 'remaining';
  const reading = metric === 'remaining' ? '剩余' : READINGS.find(([key]) => key === metric)[1];
  const unit = metric === 'used_percent' ? '%' : series.unit || '未知';
  const isKnownValue = point => point.status === 'available' && finite(point[metric]) && Number.isFinite(Date.parse(point.at));
  root.append(el('h3', `${series.provider} · ${series.label || '未命名指标'}`));
  text(root, `${series.kind === 'balance' ? '现金余额' : '订阅 / API 额度（非现金余额）'} · 单位 ${series.unit || '未知'} · 账号 ${series.account_key || '未知'} · ${usageWindow(series.window_seconds)}`);
  text(root, `范围：${time(range.from)} — ${time(range.to)}；显示 ${points.length} / ${series.sample_count ?? points.length} 个样本。时间均为 UTC。`);
  const known = points.filter(isKnownValue), latest = points.at(-1), lastKnown = known.at(-1);
  if (latest && !isKnownValue(latest)) {
    text(root, `最近记录：${pointStatus(latest)}（${time(latest.at)}）。未知不等于零。`, true);
    if (lastKnown) text(root, `最后成功${metric === 'remaining' ? '剩余量' : reading} ${amount(lastKnown[metric])} ${unit}，采样于 ${time(lastKnown.at)}；这是旧值，并非最新状态。`, true);
  }
  if (!points.length) text(root, '此指标在所选范围内暂无采样。');
  else if (!known.length) text(root, `没有可绘制的已知${metric === 'remaining' ? '剩余量' : reading}；失败和未知记录保留在下方数据表。`, true);
  else {
    const width = 760, height = 270, left = 85, right = 25, top = 28, bottom = 55;
    const plotWidth = width - left - right, plotHeight = height - top - bottom;
    const from = Number.isFinite(Date.parse(range.from)) ? Date.parse(range.from) : Math.min(...known.map(point => Date.parse(point.at)));
    const to = Number.isFinite(Date.parse(range.to)) && Date.parse(range.to) > from ? Date.parse(range.to) : Math.max(from + 1, ...known.map(point => Date.parse(point.at)));
    const values = known.map(point => point[metric]), min = Math.min(0, ...values), max = Math.max(0, ...values);
    const scale = max - min || 1;
    const x = point => left + Math.max(0, Math.min(1, (Date.parse(point.at) - from) / (to - from))) * plotWidth;
    const y = point => top + plotHeight * (1 - (point[metric] - min) / scale);
    const graph = svg('svg', { viewBox: `0 0 ${width} ${height}`, role: 'group', 'aria-label': `${series.label || '未命名指标'} · ${reading}曲线，单位 ${unit}，时间为 UTC`, class: 'agent-usage-chart' });
    graph.append(svg('title', {}, `采样时刻的${reading}；虚线仅连接相邻观测，不代表期间真实消耗。`));
    for (let i = 0; i <= 4; i++) {
      const lineY = top + plotHeight * i / 4;
      graph.append(svg('line', { x1: left, x2: width - right, y1: lineY, y2: lineY, class: 'agent-usage-gridline' }));
      graph.append(svg('text', { x: left - 8, y: lineY + 4, 'text-anchor': 'end', class: 'agent-usage-axis' }, amount(min + scale * (1 - i / 4))));
    }
    graph.append(svg('text', { x: left, y: height - 24, class: 'agent-usage-axis' }, new Date(from).toISOString().slice(5, 16).replace('T', ' ')),
      svg('text', { x: width - right, y: height - 24, 'text-anchor': 'end', class: 'agent-usage-axis' }, new Date(to).toISOString().slice(5, 16).replace('T', ' ')),
      svg('text', { x: left, y: 16, class: 'agent-usage-axis' }, `${reading} · ${unit}`));
    let previous = null, resets = 0;
    for (const point of points) {
      if (!isKnownValue(point)) { previous = null; continue; }
      const reset = resetBetween(previous, point) || Boolean(previous && ['used', 'used_percent'].includes(metric) && point[metric] < previous[metric]);
      const gap = config.enabled && previous && Date.parse(point.at) - Date.parse(previous.at) > (Number(config.interval_minutes) || 5) * 120000;
      if (previous && !reset && !gap && !range.truncated) graph.append(svg('line', { x1: x(previous), y1: y(previous), x2: x(point), y2: y(point), class: 'agent-usage-connection' }));
      if (reset) { resets++; graph.append(svg('line', { x1: x(point), x2: x(point), y1: top, y2: top + plotHeight, class: 'agent-usage-reset' })); }
      const description = `${time(point.at)}：${reading} ${amount(point[metric])} ${unit}${point.reset_at ? `；重置时间 ${time(point.reset_at)}` : ''}${reset ? '；重置 / 额度补充，曲线在此断开' : ''}`;
      const dot = svg('circle', { cx: x(point), cy: y(point), r: 3.5, tabindex: 0, class: 'agent-usage-dot', 'aria-label': description });
      const detail = el('p', description, 'hint agent-usage-point-detail'); detail.hidden = true;
      dot.onfocus = dot.onmouseenter = () => { detail.hidden = false; };
      dot.onblur = dot.onmouseleave = () => { detail.hidden = true; };
      dot.onclick = () => { detail.hidden = !detail.hidden; };
      dot.append(svg('title', {}, description)); graph.append(dot); root.append(detail);
      previous = point;
    }
    const wrap = el('div', undefined, 'agent-usage-chart-scroll'); wrap.append(graph); root.append(wrap);
    text(root, `虚线只连接观测点，不推测两次采样之间的实际消耗。失败 / 未知、额度重置 / 补充处断开；${config.enabled ? '后台采样超过两倍间隔也留空。' : '未采样时期无法还原。'}`);
    if (range.truncated) text(root, '历史已截断 / 降采样，仅显示观测点，不跨缺失记录连线。', true);
    if (resets) text(root, `${resets} 处重置时间变化或额度回升已标注为重置 / 补充，不视为负消耗。`);
  }
  const details = el('details', undefined, 'agent-usage-data'); details.append(el('summary', `查看采样数据 · ${points.length} 条`));
  const scroll = el('div', undefined, 'agent-status-table-scroll'), table = el('table', undefined, 'agent-status-model-table');
  table.append(el('caption', `原始采样读数 · ${series.unit || '单位未知'} · UTC；未知不等于零`));
  const head = el('thead'), row = el('tr');
  for (const label of ['采样时间', '剩余', '总量', '已用', '已用百分比 (%)', '状态', '重置时间']) { const th = el('th', label); th.setAttribute('scope', 'col'); row.append(th); }
  head.append(row); table.append(head); const body = el('tbody');
  for (const point of points) {
    const tr = el('tr');
    for (const value of [time(point.at), amount(point.status === 'available' ? point.remaining : null), amount(point.status === 'available' ? point.total : null),
      amount(point.status === 'available' ? point.used : null), amount(point.status === 'available' ? point.used_percent : null),
      pointStatus(point), point.reset_at ? time(point.reset_at) : '未知']) tr.append(el('td', value));
    body.append(tr);
  }
  table.append(body); scroll.append(table); details.append(scroll); root.append(details); return root;
}

/** Read-only archive; creation never reads configuration, credentials or history. */
export function createLegacyUsageHistory({ ownsPage }) {
  const node = el('div', undefined, 'agent-usage-panel');
  const history = block('旧余额历史存档'), filters = el('div', undefined, 'agent-usage-filters');
  const days = selectControl(filters, '历史范围', [['1', '24 小时'], ['7', '7 天'], ['30', '30 天'], ['90', '90 天']], '7', 'agent-usage-days');
  const account = selectControl(filters, '账号', [['', '全部账号']], '', 'agent-usage-account-filter');
  const metric = selectControl(filters, '指标 / 单位 / 窗口', [], '', 'agent-usage-metric-filter');
  const feedback = el('p', undefined, 'hint agent-usage-history-feedback'); feedback.setAttribute('role', 'status');
  const content = el('div', undefined, 'agent-usage-history-content');
  let historyFlight = null, historyRequest = 0, data = null;
  const accountChoices = new Map();
  const current = () => ownsPage();
  function paintSeries() {
    if (!data) return;
    const all = list(data.series), selectedAccount = account.value, previousMetric = metric.value;
    const choices = all.filter(series => !selectedAccount || `${series.provider}\n${series.account_key}` === selectedAccount);
    metric.replaceChildren();
    for (const series of choices) { const option = el('option', `${series.provider} · ${series.label} · ${series.unit || '单位未知'} · ${usageWindow(series.window_seconds)} · ${String(series.account_key).slice(0, 12)}`); option.value = series.id; metric.append(option); }
    metric.value = choices.some(series => series.id === previousMetric) ? previousMetric : choices[0]?.id || '';
    metric.disabled = !choices.length;
    const selected = choices.find(series => series.id === metric.value);
    content.replaceChildren(selected ? renderUsageSeries(selected, data) : el('p', '所选范围 / 账号暂无缓存样本。旧历史只保留已有观测，不能还原未采样时期；此存档不会产生新观测。', 'hint'));
  }
  function paintHistory(value) {
    data = value; const previousAccount = account.value;
    account.replaceChildren(); const all = el('option', '全部账号'); all.value = ''; account.append(all);
    for (const item of list(value.series)) {
      if (!item.account_key || !item.provider) continue;
      accountChoices.set(`${item.provider}\n${item.account_key}`, `${item.provider} · ${item.account_key}`);
    }
    for (const [key, label] of accountChoices) { const option = el('option', label); option.value = key; account.append(option); }
    account.value = accountChoices.has(previousAccount) ? previousAccount : '';
    paintSeries();
  }
  async function loadHistory() {
    if (!current()) return;
    const params = new URLSearchParams({ days: days.value });
    if (account.value) { const [provider, account_key] = account.value.split('\n'); params.set('provider', provider); params.set('account_key', account_key); }
    const key = params.toString();
    if (historyFlight?.key === key) return historyFlight.promise;
    const request = ++historyRequest;
    node.setAttribute('aria-busy', 'true');
    feedback.textContent = '正在读取项目本地历史缓存…'; feedback.setAttribute('role', 'status');
    feedback.className = 'hint agent-usage-history-feedback';
    const promise = (async () => {
      try {
        const value = await api(`/api/agent/usage/history?${key}`);
        if (!current() || request !== historyRequest) return;
        if (value?.version !== 1 || !Array.isArray(value.series)) throw new Error('历史数据格式不兼容，请更新后台服务。');
        paintHistory(value);
        const retention = finite(value.retention_days) && value.retention_days > 0
          ? `旧配置元数据：历史保留 ${value.retention_days} 天（存档不执行清理）。`
          : '旧配置元数据：历史保留期限未知（存档不执行清理）。';
        feedback.textContent = `已读取本地缓存；${retention}${value.truncated ? '结果已截断 / 降采样，不能视为完整连续历史；可缩小时间范围。' : '切换范围和账号不访问服务商。'}`;
        feedback.className = value.truncated ? 'agent-status-warning agent-usage-history-feedback' : 'hint agent-usage-history-feedback';
      } catch (error) {
        if (!current() || request !== historyRequest) return;
        feedback.textContent = `历史读取失败：${error.message}${data ? '；以下保留上次范围的历史，并非本次结果。' : '；可重新读取缓存。'}`;
        feedback.className = 'agent-status-warning agent-usage-history-feedback'; feedback.setAttribute('role', 'alert');
      } finally {
        if (historyFlight?.request === request) historyFlight = null;
        if (current() && request === historyRequest) node.setAttribute('aria-busy', 'false');
      }
    })();
    historyFlight = { key, request, promise }; return promise;
  }
  const help = '只重新读取项目本地用量历史，不访问服务商，也不启动 Agent 或模型。';
  const host = el('span', undefined, 'help-host'); host.setAttribute('data-help', help);
  host.append(button('刷新历史缓存', loadHistory, 'agent-usage-history-refresh', { help })); filters.append(host);
  days.onchange = () => loadHistory(); account.onchange = () => { paintSeries(); return loadHistory(); }; metric.onchange = () => {
    const series = list(data?.series).find(series => series.id === metric.value);
    if (series) content.replaceChildren(renderUsageSeries(series, data));
  };
  history.append(el('p', '只读旧余额观测存档，不归到任何正式连接，不联网、不查询账号或旧凭证，不提供旧采样或 HTTP 查询设置。账号和指标分别成图；没有采样的时期无法还原，本页不会自动轮询。', 'hint'), filters, feedback, content);
  node.append(history);
  const invalidate = () => { historyRequest++; historyFlight = null; node.setAttribute('aria-busy', 'false'); };
  return { node, loadHistory, invalidate };
}
