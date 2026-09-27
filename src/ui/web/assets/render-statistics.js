import { $, block, button, el, kv } from './dom.js';
import { api } from './api.js';
import { activateDetailView } from './sidebar-ui.js';
import { ui } from './state.js';
import { statisticsDefaults, statisticsDates, statisticsQuery, statisticsToday } from './statistics-range.js';

const number = value => Number(value).toLocaleString();
const money = value => `$${Number(value).toFixed(6)}`;
const expense = row => row.requests && row.unknown_cost === row.requests ? '未知' : `${money(row.cost)}${row.unknown_cost ? ' + 未知' : ''}`;
const intervalNames = { hour: '小时', day: '天', month: '月' };
let requestId = 0;

function svg(tag, attributes = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}
function label(at, interval) {
  return interval === 'month' ? at.slice(0, 7) : interval === 'day' ? at.slice(0, 10) : `${at.slice(5, 10)} ${at.slice(11, 13)}:00`;
}
function chart(data) {
  const section = block(`预计花费 · 按${intervalNames[data.interval]}`);
  section.append(el('p', 'USD · UTC 分段；只绘制已知预计花费。悬停或聚焦柱子查看明细，空白时段补零。', 'hint'));
  if (!data.buckets.length) { section.append(el('p', '暂无可绘制的带时间用量记录。', 'hint')); return section; }
  const wrap = el('div', undefined, 'usage-chart-scroll');
  const width = Math.max(720, data.buckets.length * 28 + 80), height = 270;
  const graph = svg('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'group', 'aria-label': '各时间段预计花费柱状图，单位美元，时间为 UTC', class: 'usage-chart' });
  const max = Math.max(...data.buckets.map(b => b.cost), 0);
  const plotHeight = 185, baseline = 218, left = 75, step = (width - left - 15) / data.buckets.length;
  for (let i = 0; i <= 4; i++) {
    const y = baseline - plotHeight * i / 4;
    graph.append(svg('line', { x1: left, x2: width - 10, y1: y, y2: y, class: 'usage-grid' }));
    const tick = svg('text', { x: left - 8, y: y + 4, 'text-anchor': 'end', class: 'usage-axis' });
    tick.textContent = money(max * i / 4); graph.append(tick);
  }
  // SVG attributes keep positioning compatible with the strict page CSP (no inline styles).
  const tooltipWidth = 300, tooltipHeight = 100;
  const tooltip = svg('g', { class: 'usage-tooltip', visibility: 'hidden', 'aria-hidden': 'true' });
  tooltip.append(svg('rect', { width: tooltipWidth, height: tooltipHeight, rx: 8, class: 'usage-tooltip-bg' }));
  const tooltipLines = [22, 47, 69, 88].map((y, i) => svg('text', { x: 12, y, class: i === 1 ? 'usage-tooltip-value' : 'usage-tooltip-text' }));
  tooltip.append(...tooltipLines);
  const hideTooltip = () => tooltip.setAttribute('visibility', 'hidden');
  const showTooltip = (bucket, center, top, event) => {
    const matrix = graph.getScreenCTM?.();
    const bounds = wrap.getBoundingClientRect?.();
    // Constrain the popup to the visible scroll viewport, not just the entire (possibly wide) SVG.
    const visibleLeft = matrix && bounds ? Math.max(0, (bounds.left - matrix.e) / matrix.a) : 0;
    const visibleRight = matrix && bounds ? Math.min(width, (bounds.right - matrix.e) / matrix.a) : width;
    const px = matrix && Number.isFinite(event?.clientX) ? (event.clientX - matrix.e) / matrix.a : center;
    const py = matrix && Number.isFinite(event?.clientY) ? (event.clientY - matrix.f) / matrix.d : top;
    const scale = Math.min(1, Math.max(0.1, (visibleRight - visibleLeft - 8) / tooltipWidth));
    const x = Math.max(visibleLeft + 4, Math.min(px + 12, visibleRight - tooltipWidth * scale - 4));
    const y = Math.max(4, Math.min(py - tooltipHeight * scale - 12, height - tooltipHeight * scale - 4));
    tooltip.setAttribute('transform', `translate(${x} ${y}) scale(${scale})`);
    tooltipLines[0].textContent = `${label(bucket.start, data.interval)} — ${label(bucket.end, data.interval)} UTC`;
    tooltipLines[1].textContent = `预计花费 ${expense(bucket)} USD`;
    tooltipLines[2].textContent = `${number(bucket.tokens)} tokens · ${number(bucket.requests)} 条记录`;
    tooltipLines[3].textContent = bucket.unknown_cost ? `${bucket.unknown_cost} 条费用未知，未计入已知花费` : '费用为预计值，非实际账单';
    tooltip.setAttribute('visibility', 'visible');
  };
  wrap.addEventListener('scroll', hideTooltip);
  const every = Math.max(1, Math.ceil(100 / step));
  data.buckets.forEach((b, i) => {
    const barHeight = max > 0 ? b.cost / max * plotHeight : 0;
    const x = left + i * step + step * 0.18;
    const text = `${b.start} — ${b.end}：预计 ${expense(b)} USD，${number(b.tokens)} tokens，${b.requests} 条用量记录${b.unknown_cost ? `，${b.unknown_cost} 条费用未知` : ''}`;
    const bar = svg('rect', { x, y: baseline - Math.max(barHeight, 1), width: step * 0.64, height: Math.max(barHeight, 1),
      class: `usage-bar${b.unknown_cost ? ' usage-bar-partial' : ''}`, tabindex: 0, 'aria-label': text });
    const group = svg('g', { class: 'usage-column' });
    // Full-height hit area also makes zero / tiny values easy to inspect.
    const hit = svg('rect', { x: left + i * step, y: baseline - plotHeight, width: step, height: plotHeight,
      class: 'usage-hit', 'aria-hidden': 'true' });
    group.append(bar, hit);
    const show = event => showTooltip(b, x + step * 0.32, baseline - barHeight, event);
    group.onmouseenter = show; group.onmousemove = show; group.onmouseleave = hideTooltip;
    bar.onfocus = () => show(); bar.onblur = hideTooltip;
    bar.onkeydown = event => { if (event.key === 'Escape') hideTooltip(); };
    graph.append(group);
    if (i % every === 0) {
      const tick = svg('text', { x: x + step * 0.32, y: baseline + 24, 'text-anchor': 'middle', class: 'usage-axis' });
      tick.textContent = label(b.start, data.interval); graph.append(tick);
    }
  });
  graph.append(tooltip);
  wrap.append(graph); section.append(wrap);
  return section;
}

export function renderStatistics(data) {
  const root = el('div', undefined, 'usage-results');
  const cards = el('div', undefined, 'usage-cards');
  cards.append(kv('累计 token', number(data.totals.tokens)), kv('预计花费（USD）', expense(data.totals)), kv('用量记录', number(data.totals.requests)));
  root.append(cards);
  root.append(el('p', `输入 ${number(data.totals.input)} · 输出 ${number(data.totals.output)} · 缓存读取 ${number(data.totals.cache_read)} · 缓存写入 ${number(data.totals.cache_write)}`, 'hint'));
  root.append(el('p', `统计范围：${data.range.start ?? '历史起点'} ≤ 时间 < ${data.range.end}；更新于 ${data.generated_at}`, 'hint'));
  const notes = [];
  if (data.totals.unknown_cost) notes.push(`${data.totals.unknown_cost} 条记录未提供价格；费用仅为已知部分，未知不等于免费。`);
  if (data.totals.unknown_tokens) notes.push(`${data.totals.unknown_tokens} 条记录未提供 token，用量合计不完整。`);
  const c = data.coverage;
  if (c.undated_requests) notes.push(`${c.undated_requests} 条记录缺少时间：仅在无时间筛选的总量／模型汇总中计入，不进入柱状图。`);
  if (c.unreadable_files || c.malformed_lines) notes.push(`跳过 ${c.unreadable_files} 个不可读文件、${c.malformed_lines} 条损坏或过长记录，统计可能不完整。`);
  if (c.incomplete_files) notes.push(`${c.incomplete_files} 个会话的末行尚未写完；可稍后刷新。`);
  if (c.codex_threads) notes.push('Codex 仅统计启用用量记录后的调用；此前的历史用量无法恢复。Codex 未提供价格时显示未知。');
  for (const note of notes) root.append(el('p', note, 'usage-warning'));
  if (!data.totals.requests) root.append(el('p', '所选范围内暂无用量记录。', 'empty'));
  root.append(chart(data));
  const section = block('按模型统计预计花费');
  const scroll = el('div', undefined, 'usage-table-scroll');
  const table = el('table', undefined, 'usage-table');
  table.append(el('caption', '同名模型按 provider 区分；费用均为预计 USD，不代表实际账单。', 'hint'));
  const head = el('thead'), row = el('tr');
  for (const title of ['Provider / 模型', '记录数', '累计 token', '预计花费（USD）', '缺失数据']) {
    const th = el('th', title); th.setAttribute('scope', 'col'); row.append(th);
  }
  head.append(row); table.append(head);
  const body = el('tbody');
  for (const model of data.models) {
    const tr = el('tr');
    const name = el('th', `${model.provider} / ${model.model}`); name.setAttribute('scope', 'row');
    tr.append(name, el('td', number(model.requests)), el('td', number(model.tokens)), el('td', expense(model)),
      el('td', [model.unknown_cost ? `${model.unknown_cost} 条缺价` : '', model.unknown_tokens ? `${model.unknown_tokens} 条缺用量` : ''].filter(Boolean).join('；') || '—'));
    body.append(tr);
  }
  table.append(body); scroll.append(table); section.append(scroll); root.append(section);
  for (const [key, title] of [['roles', '按角色归因'], ['tasks', '按任务归因'], ['invocations', '按 invocation 归因']]) {
    if (!data[key]) continue;
    const group = block(title), wrap = el('div', undefined, 'usage-table-scroll'), table = el('table', undefined, 'usage-table');
    const head = el('tr');
    for (const label of ['对象 / 状态', '响应记录', '非缓存输入', '缓存读取', '缓存写入', '输出', '预计 USD']) head.append(el('th', label));
    const thead = el('thead'); thead.append(head); table.append(thead);
    const body = el('tbody');
    for (const entry of data[key]) {
      const name = key === 'roles' ? entry.role : `#${entry.task_id} · ${entry.role}${key === 'invocations' ? ` · run ${entry.run_id ?? '未知'}` : ''}`;
      const row = el('tr');
      const status = [entry.status, entry.integration, entry.unknown_tokens ? `${entry.unknown_tokens} 条用量未知` : null].filter(Boolean).join(' / ');
      row.append(el('th', `${name}${status ? ` / ${status}` : ''}`), el('td', number(entry.requests)),
        el('td', number(entry.input)), el('td', number(entry.cache_read)), el('td', number(entry.cache_write)), el('td', number(entry.output)), el('td', expense(entry)));
      if (entry.goal) row.title = entry.goal;
      body.append(row);
    }
    table.append(body); wrap.append(table); group.append(wrap);
    if (data.attribution?.[`${key}_truncated`]) group.append(el('p', `仅显示预计费用最高的 ${data.attribution.limit} 组；总量仍包含全部记录。`, 'hint'));
    root.append(group);
  }
  if (data.attribution?.unknown_role_requests || data.attribution?.unknown_run_requests) {
    root.append(el('p', `历史归因不完整：${data.attribution.unknown_role_requests} 条角色未知，${data.attribution.unknown_run_requests} 条 invocation 未知。未知记录仍计入总量，不按相邻任务猜测。`, 'usage-warning'));
  }
  return root;
}

export async function openStatistics() {
  const view = activateDetailView({ view: 'statistics' });
  const page = el('div', undefined, 'statistics-page');
  page.append(el('h1', '用量统计'), el('p', '当前项目所有保留会话（含已归档／已删除任务）。不设置时间即统计迄今为止的全部记录；费用来自调用时的估价，不是实际账单。', 'hint'));
  const filters = ui.statisticsFilters ??= statisticsDefaults();
  const modes = el('div', undefined, 'usage-modes'); modes.setAttribute('role', 'group'); modes.setAttribute('aria-label', '统计视图');
  const form = el('form', undefined, 'usage-filters');
  const controls = el('div', undefined, 'usage-range-controls');
  const modeButtons = new Map();
  let syncFilters = () => {};
  const markSelection = () => {
    for (const [key, node] of modeButtons) {
      node.classList.toggle('selected', key === filters.mode); node.setAttribute('aria-pressed', String(key === filters.mode));
    }
    for (const node of controls.querySelectorAll('.usage-preset')) {
      const selected = node.dataset.preset === filters[filters.mode].preset;
      node.classList.toggle('selected', selected); node.setAttribute('aria-pressed', String(selected));
    }
  };
  const paintControls = () => {
    const dates = statisticsDates(filters);
    const presets = el('div', undefined, 'usage-presets');
    const entries = filters.mode === 'daily'
      ? [['7d', '最近 7 天'], ['30d', '最近 30 天'], ['month', '本月'], ['all', '全部历史'], ['custom', '自定义日期']]
      : [['today', '今天'], ['yesterday', '昨天'], ['custom', '选择日期']];
    for (const [key, title] of entries) {
      const node = button(title, async () => {
        syncFilters();
        const current = filters[filters.mode]; current.preset = key;
        if (key === 'custom') {
          if (filters.mode === 'daily') { current.start ||= statisticsToday(); current.end ||= statisticsToday(); }
          else current.date ||= statisticsToday();
        }
        paintControls(); await load();
      }, 'ghost usage-preset');
      node.dataset.preset = key; presets.append(node);
    }
    const fields = el('div', undefined, 'usage-date-fields');
    const inputs = {};
    const dateInput = (key, title, value) => {
      const label = el('label', title), input = el('input');
      input.type = 'date'; input.value = value; input.dataset.filter = key;
      input.onchange = () => { syncFilters(); markSelection(); };
      label.append(input); fields.append(label); inputs[key] = input;
    };
    if (filters.mode === 'daily') {
      dateInput('start', '开始日期', dates.start); dateInput('end', '结束日期（含当天）', dates.end);
      syncFilters = () => {
        const start = inputs.start.value, end = inputs.end.value;
        if (start !== dates.start || end !== dates.end) filters.daily.preset = 'custom';
        Object.assign(filters.daily, { start, end });
      };
    } else {
      dateInput('date', '统计日期', dates.date);
      const hours = {};
      for (const [key, title, begin, end] of [['startHour', '开始小时', 0, 23], ['endHour', '结束小时', 1, 24]]) {
        const label = el('label', title), select = el('select'); select.dataset.filter = key;
        for (let hour = begin; hour <= end; hour++) {
          const option = el('option', `${String(hour).padStart(2, '0')}:00${hour === 24 ? '（次日零点）' : ''}`); option.value = String(hour); select.append(option);
        }
        select.value = String(filters.intraday[key]); select.onchange = () => syncFilters();
        label.append(select); fields.append(label); hours[key] = select;
      }
      fields.append(button('全天', () => {
        syncFilters(); filters.intraday.startHour = 0; filters.intraday.endHour = 24; paintControls(); return load();
      }, 'ghost'));
      syncFilters = () => {
        if (inputs.date.value !== dates.date) filters.intraday.preset = 'custom';
        Object.assign(filters.intraday, { date: inputs.date.value, startHour: Number(hours.startHour.value), endHour: Number(hours.endHour.value) });
      };
    }
    controls.replaceChildren(presets, fields); markSelection();
  };
  for (const [key, title] of [['daily', '日间 · 按天'], ['intraday', '日内 · 按小时']]) {
    const node = button(title, () => { syncFilters(); filters.mode = key; paintControls(); return load(); }, 'ghost usage-mode');
    node.dataset.mode = key; modeButtons.set(key, node); modes.append(node);
  }
  const submit = el('button', '查询／刷新'); submit.type = 'submit';
  const error = el('p', '', 'usage-warning'); error.setAttribute('role', 'alert');
  const results = el('div'); results.setAttribute('aria-live', 'polite');
  const load = async () => {
    const id = ++requestId;
    error.textContent = ''; submit.disabled = true;
    results.replaceChildren(el('p', '正在读取项目会话用量…', 'hint'));
    try {
      syncFilters(); markSelection();
      const params = statisticsQuery(filters);
      const data = await api(`/api/usage?${params}`);
      if (id !== requestId || ui.view !== view) return;
      results.replaceChildren(renderStatistics(data));
    } catch (cause) {
      if (id !== requestId || ui.view !== view) return;
      results.replaceChildren(); error.textContent = `统计失败：${cause.message}`;
    } finally { if (id === requestId) submit.disabled = false; }
  };
  form.onsubmit = event => { event.preventDefault(); return load(); };
  paintControls();
  const actions = el('div', undefined, 'usage-range-actions');
  actions.append(el('span', 'UTC 时区 · 日间日期包含首尾两天；日内结束小时不含。自定义后点击查询。', 'hint'), submit);
  form.append(controls, actions);
  page.append(modes, form, error, results); $('detail').dataset.view = 'statistics'; $('detail').replaceChildren(page);
  await load();
}
