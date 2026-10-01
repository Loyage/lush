import { block, button, el } from './dom.js';
import { api } from './api.js';
import { usageConfigForm } from './agent-usage-form.js';

const list = value => Array.isArray(value) ? value : [];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const amount = value => finite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 8 }) : '未知';
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : '时间未知';
const errorLabels = { expired: '凭证过期，请在 Pi 中更新', unconfigured: '缺少查询凭证', unauthorized: '授权失败', network: '网络查询失败', invalid_response: '响应格式无效', unsupported: '不支持查询', timeout: '查询超时' };
const pointStatus = point => point.status === 'available' ? '查询成功' : errorLabels[point.error_code] || '查询失败 / 未知';
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
export function renderUsageSeries(series, range, config = {}) {
  const root = el('div', undefined, 'agent-usage-series'), points = list(series.points);
  root.append(el('h3', `${series.provider} · ${series.label || '未命名指标'}`));
  text(root, `${series.kind === 'balance' ? '现金余额' : '订阅 / API 额度（非现金余额）'} · 单位 ${series.unit || '未知'} · 账号 ${series.account_key || '未知'}${series.window_seconds ? ` · ${series.window_seconds} 秒窗口` : ''}`);
  text(root, `范围：${time(range.from)} — ${time(range.to)}；显示 ${points.length} / ${series.sample_count ?? points.length} 个样本。时间均为 UTC。`);
  const known = points.filter(isKnown), latest = points.at(-1), lastKnown = known.at(-1);
  if (latest && !isKnown(latest)) {
    text(root, `最近记录：${pointStatus(latest)}（${time(latest.at)}）。未知不等于零。`, true);
    if (lastKnown) text(root, `最后成功剩余量 ${amount(lastKnown.remaining)} ${series.unit || ''}，采样于 ${time(lastKnown.at)}；这是旧值，并非最新状态。`, true);
  }
  if (!points.length) text(root, '此指标在所选范围内暂无采样。');
  else if (!known.length) text(root, '没有可绘制的已知剩余量；失败和未知记录保留在下方数据表。', true);
  else {
    const width = 760, height = 270, left = 85, right = 25, top = 28, bottom = 55;
    const plotWidth = width - left - right, plotHeight = height - top - bottom;
    const from = Number.isFinite(Date.parse(range.from)) ? Date.parse(range.from) : Math.min(...known.map(point => Date.parse(point.at)));
    const to = Number.isFinite(Date.parse(range.to)) && Date.parse(range.to) > from ? Date.parse(range.to) : Math.max(from + 1, ...known.map(point => Date.parse(point.at)));
    const values = known.map(point => point.remaining), min = Math.min(0, ...values), max = Math.max(0, ...values);
    const scale = max - min || 1;
    const x = point => left + Math.max(0, Math.min(1, (Date.parse(point.at) - from) / (to - from))) * plotWidth;
    const y = point => top + plotHeight * (1 - (point.remaining - min) / scale);
    const graph = svg('svg', { viewBox: `0 0 ${width} ${height}`, role: 'group', 'aria-label': `${series.label || '剩余量'}曲线，单位 ${series.unit || '未知'}，时间为 UTC`, class: 'agent-usage-chart' });
    graph.append(svg('title', {}, '采样时刻的剩余量；虚线仅连接相邻观测，不代表期间真实消耗。'));
    for (let i = 0; i <= 4; i++) {
      const lineY = top + plotHeight * i / 4;
      graph.append(svg('line', { x1: left, x2: width - right, y1: lineY, y2: lineY, class: 'agent-usage-gridline' }));
      graph.append(svg('text', { x: left - 8, y: lineY + 4, 'text-anchor': 'end', class: 'agent-usage-axis' }, amount(min + scale * (1 - i / 4))));
    }
    graph.append(svg('text', { x: left, y: height - 24, class: 'agent-usage-axis' }, new Date(from).toISOString().slice(5, 16).replace('T', ' ')),
      svg('text', { x: width - right, y: height - 24, 'text-anchor': 'end', class: 'agent-usage-axis' }, new Date(to).toISOString().slice(5, 16).replace('T', ' ')),
      svg('text', { x: left, y: 16, class: 'agent-usage-axis' }, series.unit || '单位未知'));
    let previous = null, resets = 0;
    for (const point of points) {
      if (!isKnown(point)) { previous = null; continue; }
      const reset = resetBetween(previous, point);
      const gap = config.enabled && previous && Date.parse(point.at) - Date.parse(previous.at) > (Number(config.interval_minutes) || 5) * 120000;
      if (previous && !reset && !gap && !range.truncated) graph.append(svg('line', { x1: x(previous), y1: y(previous), x2: x(point), y2: y(point), class: 'agent-usage-connection' }));
      if (reset) { resets++; graph.append(svg('line', { x1: x(point), x2: x(point), y1: top, y2: top + plotHeight, class: 'agent-usage-reset' })); }
      const description = `${time(point.at)}：剩余 ${amount(point.remaining)} ${series.unit || ''}${point.reset_at ? `；重置时间 ${time(point.reset_at)}` : ''}${reset ? '；重置 / 额度补充，曲线在此断开' : ''}`;
      const dot = svg('circle', { cx: x(point), cy: y(point), r: 3.5, tabindex: 0, class: 'agent-usage-dot', 'aria-label': description });
      const detail = el('p', description, 'hint agent-usage-point-detail'); detail.hidden = true;
      dot.onfocus = dot.onmouseenter = () => { detail.hidden = false; };
      dot.onblur = dot.onmouseleave = () => { detail.hidden = true; };
      dot.onclick = () => { detail.hidden = !detail.hidden; };
      dot.append(svg('title', {}, description)); graph.append(dot); root.append(detail);
      previous = point;
    }
    const wrap = el('div', undefined, 'agent-usage-chart-scroll'); wrap.append(graph); root.append(wrap);
    text(root, '虚线只连接观测点，不推测两次采样之间的实际消耗。失败 / 未知、额度重置 / 补充处断开；后台采样超过两倍间隔也留空。');
    if (range.truncated) text(root, '历史已截断 / 降采样，仅显示观测点，不跨缺失记录连线。', true);
    if (resets) text(root, `${resets} 处重置时间变化或额度回升已标注为重置 / 补充，不视为负消耗。`);
  }
  const details = el('details', undefined, 'agent-usage-data'); details.append(el('summary', `查看采样数据 · ${points.length} 条`));
  const scroll = el('div', undefined, 'agent-status-table-scroll'), table = el('table', undefined, 'agent-status-model-table');
  table.append(el('caption', `原始采样读数 · ${series.unit || '单位未知'} · UTC；未知不等于零`));
  const head = el('thead'), row = el('tr');
  for (const label of ['采样时间', '剩余', '总量', '已用', '状态', '重置时间']) { const th = el('th', label); th.setAttribute('scope', 'col'); row.append(th); }
  head.append(row); table.append(head); const body = el('tbody');
  for (const point of points) {
    const tr = el('tr');
    for (const value of [time(point.at), amount(point.status === 'available' ? point.remaining : null), amount(point.status === 'available' ? point.total : null),
      amount(point.status === 'available' ? point.used : null), pointStatus(point), point.reset_at ? time(point.reset_at) : '未知']) tr.append(el('td', value));
    body.append(tr);
  }
  table.append(body); scroll.append(table); details.append(scroll); root.append(details); return root;
}

/** Persistent sub-panel: status refreshes update history without replacing unsaved configuration. */
export function createAgentUsage({ ownsPage }) {
  const node = el('div', undefined, 'agent-usage-panel');
  const configHost = el('div'), configFeedback = el('p', '正在读取用量配置…', 'hint agent-usage-config-feedback'); configFeedback.setAttribute('role', 'status');
  const history = block('剩余量历史'), filters = el('div', undefined, 'agent-usage-filters');
  const days = selectControl(filters, '历史范围', [['1', '24 小时'], ['7', '7 天'], ['30', '30 天'], ['90', '90 天']], '7', 'agent-usage-days');
  const account = selectControl(filters, '账号', [['', '全部账号']], '', 'agent-usage-account-filter');
  const metric = selectControl(filters, '指标 / 单位 / 窗口', [], '', 'agent-usage-metric-filter');
  const feedback = el('p', undefined, 'hint agent-usage-history-feedback'); feedback.setAttribute('role', 'status');
  const content = el('div', undefined, 'agent-usage-history-content');
  let config = null, form = null, dirty = false, revision = 0, saving = null, configFlight = null, historyFlight = null, historyRequest = 0, data = null, accounts = [];
  const accountChoices = new Map();
  const current = () => ownsPage();
  const configMessage = (message, error = false) => {
    configFeedback.textContent = message; configFeedback.className = error ? 'agent-status-warning agent-usage-config-feedback' : 'hint agent-usage-config-feedback';
    configFeedback.setAttribute('role', error ? 'alert' : 'status');
  };
  const renderForm = value => {
    config = value;
    form = usageConfigForm(value, accounts, { changed() { dirty = true; revision++; configMessage('有未保存的修改；历史读取与状态刷新不会覆盖编辑。'); }, save });
    configHost.replaceChildren(form.node);
    configMessage(`${config.enabled ? `后台采样已启用，每 ${config.interval_minutes} 分钟查询，关闭页面仍运行` : '后台采样未启用，仅按需查询'}；历史保留 ${config.retention_days} 天。`);
  };
  async function save(value) {
    if (!current() || saving) return saving;
    const submittedRevision = revision; form.busy(true); configMessage('正在保存查询设置…');
    saving = (async () => {
      try {
        const result = await api('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'agent.usage.configure', params: { config: value } }) });
        if (!current()) return;
        if (result?.version !== 1) throw new Error('查询配置格式不兼容，请更新后台服务。');
        config = result;
        if (submittedRevision === revision) dirty = false;
        revision++; // Invalidate status requests started before this save completed.
        configMessage(`查询设置已保存；${config.enabled ? '后台采样已启用，关闭页面仍运行' : '后台采样未启用'}。${dirty ? '仍有新编辑尚未保存。' : '可点击页面顶部刷新状态执行查询；保存本身不调用上游。'}`);
        await loadHistory(true);
      } catch (error) { if (current()) configMessage(`保存失败：${error.message}；已保留编辑，可重试。`, true); }
      finally { saving = null; if (current()) form.busy(false); }
    })();
    return saving;
  }
  function paintSeries() {
    if (!data) return;
    const all = list(data.series), selectedAccount = account.value, previousMetric = metric.value;
    const choices = all.filter(series => !selectedAccount || `${series.provider}\n${series.account_key}` === selectedAccount);
    metric.replaceChildren();
    for (const series of choices) { const option = el('option', `${series.provider} · ${series.label} · ${series.unit || '单位未知'}${series.window_seconds ? ` · ${series.window_seconds} 秒` : ''} · ${String(series.account_key).slice(0, 12)}`); option.value = series.id; metric.append(option); }
    metric.value = choices.some(series => series.id === previousMetric) ? previousMetric : choices[0]?.id || '';
    metric.disabled = !choices.length;
    const selected = choices.find(series => series.id === metric.value);
    content.replaceChildren(selected ? renderUsageSeries(selected, data, config || {}) : el('p', '所选范围 / 账号暂无缓存样本。打开状态页、手动刷新或启用后台采样后才会产生历史。', 'hint'));
  }
  function paintHistory(value) {
    data = value; const previousAccount = account.value;
    account.replaceChildren(); const all = el('option', '全部账号'); all.value = ''; account.append(all);
    for (const item of [...accounts, ...list(value.series)]) {
      if (!item.account_key || !item.provider) continue;
      accountChoices.set(`${item.provider}\n${item.account_key}`, `${item.provider} · ${item.account_key}`);
    }
    for (const [key, label] of accountChoices) { const option = el('option', label); option.value = key; account.append(option); }
    account.value = accountChoices.has(previousAccount) ? previousAccount : '';
    paintSeries();
  }
  async function loadHistory(force = false) {
    if (!current()) return;
    const params = new URLSearchParams({ days: days.value });
    if (account.value) { const [provider, account_key] = account.value.split('\n'); params.set('provider', provider); params.set('account_key', account_key); }
    const key = params.toString();
    if (!force && historyFlight?.key === key) return historyFlight.promise;
    const request = ++historyRequest;
    feedback.textContent = '正在读取项目本地历史缓存…'; feedback.setAttribute('role', 'status');
    feedback.className = 'hint agent-usage-history-feedback';
    const promise = (async () => {
      try {
        const value = await api(`/api/agent/usage/history?${key}`);
        if (!current() || request !== historyRequest) return;
        if (value?.version !== 1 || !Array.isArray(value.series)) throw new Error('历史数据格式不兼容，请更新后台服务。');
        paintHistory(value);
        feedback.textContent = `已读取本地缓存；历史保留 ${value.retention_days} 天。${value.truncated ? '结果已截断 / 降采样，不能视为完整连续历史；可缩小时间范围。' : '切换范围和账号不访问服务商。'}`;
        feedback.className = value.truncated ? 'agent-status-warning agent-usage-history-feedback' : 'hint agent-usage-history-feedback';
      } catch (error) {
        if (!current() || request !== historyRequest) return;
        feedback.textContent = `历史读取失败：${error.message}${data ? '；以下保留上次范围的历史，并非本次结果。' : '；可重新读取缓存。'}`;
        feedback.className = 'agent-status-warning agent-usage-history-feedback'; feedback.setAttribute('role', 'alert');
      } finally { if (historyFlight?.request === request) historyFlight = null; }
    })();
    historyFlight = { key, request, promise }; return promise;
  }
  const help = '只重新读取项目本地用量历史，不访问服务商，也不启动 Agent 或模型。';
  const host = el('span', undefined, 'help-host'); host.setAttribute('data-help', help);
  host.append(button('刷新历史缓存', loadHistory, 'agent-usage-history-refresh', { help })); filters.append(host);
  days.onchange = () => loadHistory(); account.onchange = () => { paintSeries(); return loadHistory(); }; metric.onchange = () => {
    const series = list(data?.series).find(series => series.id === metric.value);
    if (series) content.replaceChildren(renderUsageSeries(series, data, config || {}));
  };
  history.append(el('p', '只展示每次查询的观测值，账号和指标分别成图。没有采样的时期无法还原；本页不会自动轮询，后台采样须显式启用。', 'hint'), filters, feedback, content);
  node.append(configHost, configFeedback, history);
  const retry = button('重试读取查询配置', () => update({ accounts }), 'agent-usage-config-retry'); retry.hidden = true; node.append(retry);
  async function update(status, expectedRevision = revision) {
    if (!current()) return;
    accounts = list(status.accounts);
    if (status.usage_config?.version === 1 && !dirty && !saving && expectedRevision === revision) { renderForm(status.usage_config); retry.hidden = true; }
    else if (!config && !configFlight) {
      configFlight = (async () => {
        try {
          const value = await api('/api/agent/usage/config');
          if (!current()) return;
          if (value?.version !== 1) throw new Error('查询配置格式不兼容，请更新后台服务。');
          if (!config && !dirty && !saving) renderForm(value);
          retry.hidden = true;
        } catch (error) { if (current() && !config) { configMessage(`用量配置读取失败：${error.message}；未使用默认值覆盖已有配置。`, true); retry.hidden = false; } }
        finally { configFlight = null; }
      })();
    }
    await Promise.all([configFlight, loadHistory()]);
  }
  return { node, update, loadHistory, configRevision: () => revision };
}
