import { button, el, pageModules } from './dom.js';
import { api } from './api.js';
import { projectRoute } from './route.js';
import { diagnosticsHash } from './diagnostics-route.js';
import { renderDiagnostics } from './diagnostics-render.js';

const PERIODS = { '1h': 3600000, '24h': 86400000, '7d': 7 * 86400000, '30d': 30 * 86400000 };
const option = (value, label) => { const node = el('option', label); node.value = value; return node; };
const field = (label, control) => { const node = el('label'); node.append(el('span', label), control); return node; };
const localTime = value => { const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, -1); };

/** One owned request generation; no refresh timer, background sampling or model calls. */
export function createDiagnosticsPage({ ownsPage, client, request = api }) {
  const node = el('section', undefined, 'runtime-diagnostics-page');
  const form = el('form', undefined, 'diagnostic-filters'); form.setAttribute('aria-label', '运行诊断筛选');
  const period = el('select'); period.dataset.diagnosticFilter = 'period';
  for (const [value, label] of [['1h', '近 1 小时'], ['24h', '近 24 小时'], ['7d', '近 7 天'], ['30d', '近 30 天'], ['custom', '自定义']]) period.append(option(value, label));
  period.value = '24h';
  const from = el('input'), to = el('input'); from.type = to.type = 'datetime-local'; from.step = to.step = '0.001';
  from.dataset.diagnosticFilter = 'from'; to.dataset.diagnosticFilter = 'to';
  from.value = localTime(Date.now() - PERIODS['24h']); to.value = localTime(Date.now());
  const fromField = field('起点（本地时间）', from), toField = field('终点（本地时间）', to);
  fromField.hidden = toField.hidden = true;
  const selects = {};
  for (const [key, label] of [['connection_id', '全部来源'], ['model', '全部具体模型'], ['project_id', '全部已登记项目']]) {
    const select = el('select'); select.dataset.diagnosticFilter = key; select.append(option('', label));
    if (key !== 'project_id') select.append(option('@unknown', '未知 @unknown'));
    selects[key] = select;
  }
  const project = projectRoute();
  const apply = button('应用筛选', () => load(), 'primary'); apply.dataset.diagnosticApply = '';
  const reload = button('重读', () => load(), 'ghost'); reload.dataset.diagnosticReload = '';
  form.append(field('时间范围', period), fromField, toField, field('来源（固定绑定）', selects.connection_id), field('具体模型（非登记名称）', selects.model));
  if (!project) form.append(field('项目', selects.project_id));
  form.append(apply, reload);
  const status = el('p', '默认分析近 24 小时，无需先选择对象。', 'diagnostic-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const catalogStatus = el('p', '', 'hint');
  const results = el('div', undefined, 'diagnostic-results');
  node.append(form, status, catalogStatus, results);
  let controller = null, revision = 0, disposed = true, snapshot = null, catalogLoaded = false;
  const names = new Map(), models = new Set(), projects = new Map();
  const current = stamp => !disposed && ownsPage() && stamp === revision;
  function cancel() { ++revision; controller?.abort(); controller = null; node.setAttribute('aria-busy', 'false'); }
  function dirty() {
    cancel();
    status.textContent = snapshot ? '筛选已更改，尚未应用；下方仍为上次结果，范围见覆盖说明。' : '筛选已更改，请应用。';
  }
  period.onchange = () => { fromField.hidden = toField.hidden = period.value !== 'custom'; dirty(); };
  from.oninput = to.oninput = dirty;
  for (const select of Object.values(selects)) select.onchange = dirty;
  form.onsubmit = event => { event.preventDefault(); if (!event.isComposing) return load(); };
  function remember(select, value, label = value) {
    if (!value) return;
    const existing = [...select.children].find(node => node.value === value);
    if (existing) existing.textContent = label;
    else select.append(option(value, label));
  }
  function populate() {
    for (const [id, label] of names) remember(selects.connection_id, id, label);
    for (const model of models) remember(selects.model, model);
    for (const [id, label] of projects) remember(selects.project_id, id, label);
  }
  function setFilters(filters) {
    if (!filters) return;
    cancel();
    period.value = filters.period || (filters.from || filters.to ? 'custom' : '24h');
    if (!Object.hasOwn(PERIODS, period.value) && period.value !== 'custom') period.value = '24h';
    for (const key of ['connection_id', 'model', 'project_id']) {
      remember(selects[key], filters[key], `${filters[key]}（深链／历史绑定）`); selects[key].value = filters[key] || '';
    }
    for (const [control, key] of [[from, 'from'], [to, 'to']]) if (filters[key]) control.value = Number.isFinite(Date.parse(filters[key])) ? localTime(filters[key]) : '';
    fromField.hidden = toField.hidden = period.value !== 'custom';
  }
  function query() {
    const now = Date.now(), end = period.value === 'custom' ? Date.parse(to.value) : now;
    const start = period.value === 'custom' ? Date.parse(from.value) : end - PERIODS[period.value];
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end > now || start < now - PERIODS['30d'] || end - start > PERIODS['30d']) throw Error('请选择最近 30 天内的有效起止时间，终点不可在未来。');
    const filters = { from: new Date(start).toISOString(), to: new Date(end).toISOString() };
    for (const [key, select] of Object.entries(selects)) if (select.value && (key !== 'project_id' || !project)) filters[key] = select.value;
    return filters;
  }
  async function load() {
    if (disposed || !ownsPage()) return;
    cancel(); const stamp = revision;
    let filters;
    try { filters = query(); } catch (error) { status.textContent = `${error.message}${snapshot ? ' 下方仍为上次结果，范围见覆盖说明。' : ''}`; return; }
    controller = new AbortController(); const signal = controller.signal;
    const hashFilters = { ...filters, period: period.value };
    if (period.value !== 'custom') { delete hashFilters.from; delete hashFilters.to; }
    globalThis.window?.history?.replaceState(null, '', diagnosticsHash(hashFilters));
    status.textContent = snapshot ? '正在重读；下方为上次结果，范围见覆盖说明。' : '正在读取已在线已登记项目，不启动离线后台…';
    node.setAttribute('aria-busy', 'true');
    const catalog = catalogLoaded ? Promise.resolve() : Promise.allSettled([
      client.read('/api/agent/connections', { signal }), client.read('/api/agent/registered-models', { signal }),
      project ? Promise.resolve({ projects: [] }) : request('/api/host/projects', { signal }),
    ]).then(values => {
      if (!current(stamp)) return;
      catalogLoaded = values.every(value => value.status === 'fulfilled');
      catalogStatus.textContent = catalogLoaded ? '筛选候选含本地登记与已读历史；仅本地读取，不联网刷新额度。' : '部分本地候选读取失败；历史／深链已选值保留，可重读重试。';
      for (const row of values[0].value?.connections || []) {
        names.set(row.id, row.label);
        for (const model of [...(row.models || []), row.default_model].filter(Boolean)) models.add(`${row.provider}/${model}`);
      }
      for (const row of values[1].value?.models || []) if (row.model) models.add(row.model);
      for (const row of values[2].value?.projects || []) projects.set(row.id, row.name || row.id);
      populate();
    });
    try {
      const value = await request(`${project ? '/api/diagnostics/query' : '/api/host/diagnostics/query'}?${new URLSearchParams(filters)}`, { signal });
      if (!current(stamp)) return;
      if (value?.version !== 1 || !value.range || !value.summary || !value.coverage || !Array.isArray(value.buckets) || !Array.isArray(value.groups) || !Array.isArray(value.quota?.series) || !Array.isArray(value.quota?.current)) throw Error('后台诊断协议不可用，请更新 Host 与项目后台');
      await catalog;
      if (!current(stamp)) return;
      for (const group of value.groups) { if (group.connection_id && !names.has(group.connection_id)) names.set(group.connection_id, `历史来源 ${group.connection_id}`); if (group.model) models.add(group.model); }
      populate(); renderDiagnostics(results, value, names); snapshot = value;
      status.textContent = '读取完成；未联网查询服务商。时间与覆盖以下方结果为准。';
    } catch (error) {
      if (!current(stamp) || signal.aborted) return;
      status.textContent = `读取失败：${error.message}。${snapshot ? '保留上次旧结果，其范围见下方覆盖说明；不是本次筛选结果。' : '没有可用结果，不等于没有消耗。'}`;
    } finally { if (current(stamp)) { node.setAttribute('aria-busy', 'false'); controller?.abort(); controller = null; } }
  }
  function dispose() { disposed = true; cancel(); globalThis.removeEventListener?.('pagehide', dispose); if (ownsPage()) pageModules(results, { scope: 'runtime-diagnostics', entries: [] }); }
  function resume() { disposed = false; catalogLoaded = false; globalThis.addEventListener?.('pagehide', dispose); }
  return { node, load, dispose, resume, setFilters };
}
