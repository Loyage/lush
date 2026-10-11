import { el } from './dom.js';
import { api } from './api.js';
import { settingsClient } from './settings-api.js';
import { usageWindow, usageErrorLabels, relative } from './format.js';

const PROVIDERS = { deepseek: 'DeepSeek', openrouter: 'OpenRouter', zai: 'Z.AI', 'kimi-coding': 'Kimi Coding',
  'openai-codex': 'Codex 订阅', 'openai-compatible': '自定义 OpenAI 兼容 API' };
const STATUSES = { partial: '部分指标可用', error: '查询失败',
  unknown: '当前数据未知；未知不等于零', unsupported: '不支持查询', unconfigured: '缺少查询凭证' };
const DEFAULT_SECTIONS = ['quota', 'balance', 'reset', 'observed'];
const ACCOUNT_SECTIONS = new Set([...DEFAULT_SECTIONS, 'details', 'history', 'provenance']);
const PROJECT_SECTIONS = new Set(['metrics', 'distribution', 'delivery', 'recent', 'messages', 'shortcuts']);
const SOURCES = { usage_api: '专用余额 / 额度接口', client_rpc: '原生客户端协议', response_headers: '正常模型响应（调用结束后采集）', none: '尚无观测来源' };
const SCOPES = { account: '账号共享', key: 'API Key 预算', model: '模型专属' };
const finite = value => typeof value === 'number' && Number.isFinite(value);
const text = (value, fallback = '未知') => typeof value === 'string' && value ? value : fallback;
const amount = value => finite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 8 }) : '未知';
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : '时间未知';
const successful = observation => ['available', 'partial'].includes(observation?.status);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const projectId = value => typeof value === 'string' && /^[a-f0-9]{16}$/.test(value);
const cardId = value => projectId(value) || (typeof value === 'string' && value.startsWith('account:') && uuid(value.slice(8)));
const fields = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
const uniqueIds = rows => new Set(rows.map(row => row?.id)).size === rows.length;
const note = (parent, value, warning = false) => parent.append(el('p', value, warning ? 'dashboard-card-warning' : 'dashboard-card-note'));
const stalePage = () => new DOMException('账户卡片页面已离开', 'AbortError');
function validateConfig(value) {
  if (![1, 2].includes(value?.version) || typeof value.revision !== 'string' || !value.revision || !Array.isArray(value.cards) || value.cards.length > 100
    || value.cards.some(card => !fields(card, ['type', 'connection_id']) || card.type !== 'account' || !uuid(card.connection_id))
    || new Set(value.cards.map(card => card.connection_id)).size !== value.cards.length) {
    throw new Error('卡片配置响应无效；未将其视为无卡片');
  }
  const { hidden_projects = [], layout = [], content = [] } = value;
  if ((value.version === 2 && !['hidden_projects', 'layout', 'content'].every(key => Array.isArray(value[key])))
    || ![hidden_projects, layout, content].every(Array.isArray)
    || [hidden_projects, layout, content].some(items => items.length > 300)
    || hidden_projects.some(id => !projectId(id))
    || !uniqueIds(layout) || !uniqueIds(content)
    || layout.some(item => !fields(item, ['id', 'x', 'y', 'w', 'h']) || !cardId(item.id)
      || !['x', 'y', 'w', 'h'].every(key => Number.isInteger(item[key]))
      || item.x < 0 || item.x > 11 || item.y < 0 || item.y > 4095 || item.w < 1 || item.w > 12
      || item.x + item.w > 12 || item.h < 6 || item.h > 80)
    || content.some(item => !fields(item, ['id', 'sections']) || !cardId(item.id) || !Array.isArray(item.sections)
      || item.sections.some(section => !(item.id.startsWith('account:') ? ACCOUNT_SECTIONS : PROJECT_SECTIONS).has(section)))) {
    throw new Error('卡片配置响应无效；未将其视为无卡片');
  }
  return { version: value.version, revision: value.revision,
    cards: value.cards.map(({ connection_id }) => ({ type: 'account', connection_id })),
    hidden_projects: [...hidden_projects], layout: layout.map(item => ({ ...item })),
    content: content.map(item => ({ ...item, sections: [...item.sections] })) };
}
/** Validate a supplied save ACK locally; only a call without value reads Host configuration. */
export async function readDashboardConfig(options = {}) {
  try { return validateConfig(Object.hasOwn(options, 'value') ? options.value : await api('/api/host/dashboard')); }
  catch (error) { throw new Error(`卡片配置读取失败：${error.message}`); }
}
export async function loadDashboardConnections() {
  try {
    const value = await settingsClient('device').read('/api/agent/connections');
    if (!Array.isArray(value?.connections) || value.connections.some(row => !uuid(row?.id))
      || new Set(value.connections.map(row => row.id)).size !== value.connections.length) throw new Error('设备来源列表响应无效');
    return value.connections;
  } catch (error) { throw new Error(`设备账户 / 余额缓存读取失败：${error.message}`); }
}

/** Reads only Host configuration and device cache; no provider query, model calls or browser persistence. */
export async function loadAccountCards({ ownsPage = () => true, config, connections } = {}) {
  if (!ownsPage()) throw stalePage();
  const [snapshot, sources] = await Promise.all([
    config === undefined ? readDashboardConfig() : validateConfig(config),
    connections === undefined ? loadDashboardConnections() : connections,
  ]);
  if (!ownsPage()) throw stalePage();
  const byId = new Map(sources.map(connection => [connection.id, connection]));
  return snapshot.cards.map(card => ({ id: `account:${card.connection_id}`, ...card, connection: byId.get(card.connection_id) || null }));
}

/** Query only explicitly placed accounts. Never apply the full list snapshots returned by parallel actions. */
export async function refreshAccountCards(ids, { ownsPage = () => true } = {}) {
  if (!ownsPage()) throw stalePage();
  if (!Array.isArray(ids) || ids.some(id => !uuid(id))) throw new Error('刷新账户必须指定有效来源 ID');
  const selected = [...new Set(ids)], errors = new Map(), client = settingsClient('device');
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(3, selected.length) }, async () => {
    while (ownsPage() && cursor < selected.length) {
      const id = selected[cursor++];
      try {
        const result = await client.action('agent.connections.query', { id });
        const source = result?.connections?.find(connection => connection.id === id);
        if (!source) errors.set(id, '查询响应中未找到该来源');
        else if (source.observation?.status !== 'available') errors.set(id, STATUSES[source.observation?.status] || '观测状态未知');
      } catch (error) { errors.set(id, typeof error?.message === 'string' && error.message ? error.message : '账户查询失败'); }
    }
  }));
  if (!ownsPage()) throw stalePage();
  const connections = await loadDashboardConnections();
  if (!ownsPage()) throw stalePage();
  // The reread is authoritative, including a concurrent disable/removal or a normalized observation failure.
  const byId = new Map(connections.map(connection => [connection.id, connection]));
  for (const id of selected) {
    const source = byId.get(id);
    if (!source) errors.set(id, '来源已删除或不可用');
    else if (source.enabled === false) errors.set(id, '来源已停用');
    else if (source.observation?.status !== 'available' && !errors.has(id)) errors.set(id, STATUSES[source.observation?.status] || '观测状态未知');
  }
  return { connections, errors: selected.filter(id => errors.has(id)).map(id => ({ id, error: errors.get(id) })) };
}

function renderMetric(resource, sections) {
  const kind = resource.kind === 'balance' ? '现金余额' : resource.scope === 'key' ? 'Key 预算'
    : resource.scope === 'account' ? '套餐额度' : '模型额度';
  const root = el('section', undefined, 'dashboard-account-metric');
  root.dataset.metricId = text(resource.id, 'unknown');
  root.append(el('h4', `${kind} · ${text(resource.label, '未命名指标')}`));
  const unit = text(resource.unit, '单位未知');
  const showValue = sections.has(resource.kind === 'quota' ? 'quota' : 'balance');
  if (showValue) {
    const remaining = el('p', undefined, 'dashboard-account-value');
    remaining.append(el('strong', `剩余 ${amount(resource.remaining)} ${unit}`)); root.append(remaining);
    if (resource.kind === 'quota') {
      let percent = finite(resource.used_percent) ? resource.used_percent : null;
      if (percent === null && finite(resource.total) && resource.total > 0) {
        if (finite(resource.used)) percent = resource.used / resource.total * 100;
        else if (finite(resource.remaining)) percent = (resource.total - resource.remaining) / resource.total * 100;
      }
      if (percent !== null) {
        const value = el('p', undefined, 'dashboard-account-value');
        value.append(el('strong', `已用 ${amount(percent)}%`)); root.append(value);
        // Native progress avoids inline styles under the existing CSP; raw out-of-range percentages remain visible.
        const bar = el('progress', undefined, 'dashboard-account-progress'); bar.max = 100; bar.value = Math.max(0, Math.min(100, percent));
        bar.setAttribute('aria-label', `${text(resource.label, '额度')}已用比例`); root.append(bar);
      } else note(root, '已用比例未知');
      note(root, usageWindow(resource.window_seconds));
    }
  }
  if (sections.has('reset') && resource.kind === 'quota') {
    const resetAt = Date.parse(resource.reset_at);
    note(root, Number.isFinite(resetAt) ? `重置：${time(resource.reset_at)}${resetAt <= Date.now() ? ' · 到期待刷新' : ''}` : '重置时间未知');
  }
  if (sections.has('details')) {
    const details = el('details', undefined, 'dashboard-account-metric-details'); details.append(el('summary', '指标详情'));
    note(details, `范围：${SCOPES[resource.scope] || '范围未知'} · 单位：${unit}`);
    note(details, `总量 ${amount(resource.total)} ${unit} · 已用 ${amount(resource.used)} ${unit}`);
    note(details, `原始已用比例：${amount(resource.used_percent)} %`);
    if (resource.kind === 'balance') { note(details, usageWindow(resource.window_seconds)); note(details, `重置时间：${time(resource.reset_at)}`); }
    if (unit === '%') note(details, '百分比不是实际 token、请求总量或金额。');
    if (Array.isArray(resource.models) && resource.models.length) note(details, `适用模型：${resource.models.join('、')}`);
    root.append(details);
  }
  return root;
}
function renderObservation(observation, sections) {
  observation ||= {};
  const root = el('div', undefined, 'dashboard-account-observation');
  if (observation.status !== 'available') note(root, STATUSES[observation.status] || '观测状态未知；未知不等于零', true);
  if (sections.has('observed')) {
    // source:none may carry a list read timestamp; it is not a sample.
    note(root, `上次观测：${observation.source === 'none' ? '时间未知（尚无观测）'
      : Number.isFinite(Date.parse(observation.checked_at)) ? relative(observation.checked_at) : '时间未知'}`);
  }
  if (sections.has('provenance')) {
    note(root, `观测来源：${SOURCES[observation.source] || '未知来源'}`);
    if (observation.source !== 'none') note(root, `观测时间：${time(observation.checked_at)}`);
    if (observation.error_code) note(root, usageErrorLabels[observation.error_code] || '未取得完整数据', true);
    if (observation.reason) note(root, observation.reason);
  }
  if (successful(observation)) {
    const resources = Array.isArray(observation.resources) ? observation.resources.filter(resource => ['balance', 'quota'].includes(resource?.kind)) : [];
    if (!resources.length) note(root, '暂无可展示指标；未知不等于零', true);
    for (const resource of resources) {
      if (sections.has(resource.kind) || sections.has('details') || (resource.kind === 'quota' && sections.has('reset'))) root.append(renderMetric(resource, sections));
    }
  }
  return root;
}

/** Lightweight renderer. Parent owns refresh/repaint so this node never applies late list snapshots. */
export function renderAccountCard(row, { sections = DEFAULT_SECTIONS, refresh, ownsPage = () => true } = {}) {
  const selected = new Set(Array.isArray(sections) ? sections.filter(section => ACCOUNT_SECTIONS.has(section)) : DEFAULT_SECTIONS);
  const root = el('li', undefined, 'project-item dashboard-account-card');
  root.dataset.cardId = row.id; root.dataset.cardType = 'account'; root.dataset.connectionId = row.connection_id;
  const connection = row.connection;
  const header = el('header', undefined, 'dashboard-account-header');
  header.append(el('h3', connection ? text(connection.label, '未命名账户') : '账户来源已删除或不可用'));
  const refreshHost = el('span', undefined, 'help-host'), refreshButton = el('button', '刷新', 'dashboard-account-refresh');
  refreshButton.type = 'button'; refreshHost.append(refreshButton); header.append(refreshHost); root.append(header);
  let busy = false;
  const blocker = !connection ? '来源已删除或不可用，无法查询。' : connection.enabled === false ? '来源已停用，请先在模型来源中启用。'
    : typeof refresh !== 'function' ? '当前页面未提供账户刷新操作。' : null;
  function syncRefresh() {
    refreshButton.disabled = !!blocker || busy;
    if (refreshButton.disabled) { refreshHost.dataset.help = blocker || '账户刷新尚未完成，请勿重复请求。'; refreshHost.setAttribute('tabindex', '0'); }
    else { delete refreshHost.dataset.help; refreshHost.removeAttribute('tabindex'); }
  }
  refreshButton.onclick = async () => {
    if (blocker || busy || !ownsPage()) return;
    busy = true; syncRefresh();
    try { await refresh(row.connection_id); }
    catch (error) { if (ownsPage()) note(root, error.message || '账户刷新失败', true); }
    finally { busy = false; if (ownsPage()) syncRefresh(); }
  };
  syncRefresh();
  if (!connection) {
    if (selected.has('provenance')) note(root, `所选来源：${row.connection_id}`);
    return root;
  }
  if (connection.enabled === false) note(root, '来源已停用', true);
  if (selected.has('provenance')) {
    note(root, PROVIDERS[connection.provider] || text(connection.provider, '服务商未知'));
    note(root, `模型端点：${text(connection.endpoint, '端点未知')}`);
  }
  root.append(renderObservation(connection.observation, selected));
  const previous = connection.last_success;
  if (!successful(connection.observation) && successful(previous?.observation)) {
    if (selected.has('history')) {
      const old = el('details', undefined, 'dashboard-account-old'); old.append(el('summary', '历史成功观测（非当前值）'));
      note(old, `历史成功时间：${time(previous.checked_at || previous.observation.checked_at)}；不能作为当前余额。`, true);
      old.append(renderObservation(previous.observation, new Set([...DEFAULT_SECTIONS, ...selected]))); root.append(old);
    } else note(root, '有历史成功观测（非当前值）', true);
  }
  return root;
}

/** Explicit device-wide card selection. Reads never initialize or write defaults. */
export function createDashboardCardSettings({ ownsPage = () => true } = {}) {
  const root = el('section', undefined, 'dashboard-card-settings');
  root.append(el('h2', '总览卡片'), el('p', '可选类型：账户余额。每个选中账户独立一张卡片；选择保存于 Host 设备，同设备的浏览器共享。这里只读取配置和余额缓存，不查询服务商、不调用模型。', 'dashboard-card-note'));
  const choices = el('fieldset', undefined, 'dashboard-card-choices'); choices.append(el('legend', '设备托管账户'));
  const rows = el('div', undefined, 'dashboard-card-choice-list'); choices.append(rows);
  const status = el('p', '正在读取卡片配置与设备账户…', 'dashboard-card-settings-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const actions = el('div', undefined, 'dashboard-card-settings-actions');
  const save = el('button', '保存卡片选择'), reload = el('button', '重新读取'); save.type = reload.type = 'button';
  const saveHost = el('span', undefined, 'help-host'), reloadHost = el('span', undefined, 'help-host');
  reload.dataset.help = '重新读取设备共享配置，并替换此页未保存的选择；不会联网查询余额。';
  saveHost.append(save); reloadHost.append(reload); actions.append(saveHost, reloadHost); root.append(choices, actions, status);
  let config = null, connections = [], selected = new Set(), busy = false, conflict = false, disposed = false;
  const active = () => !disposed && ownsPage();
  function setStatus(value, warning = false) {
    status.textContent = value; status.classList.toggle('dashboard-card-warning', warning);
  }
  function sync() {
    save.disabled = busy || !config || conflict; reload.disabled = busy; choices.disabled = busy || !config;
    if (save.disabled) {
      saveHost.dataset.help = busy ? '请求尚未完成，请勿重复提交。' : conflict ? '配置已被其他页面修改；保留此页选择，请先重新读取再编辑。' : '尚未确认设备配置，不能保存。';
      saveHost.setAttribute('tabindex', '0');
    } else { delete saveHost.dataset.help; saveHost.removeAttribute('tabindex'); }
    if (reload.disabled) { reloadHost.dataset.help = '请求尚未完成，请等待响应。'; reloadHost.setAttribute('tabindex', '0'); }
    else { delete reloadHost.dataset.help; reloadHost.removeAttribute('tabindex'); }
    for (const input of rows.querySelectorAll('input')) input.disabled = choices.disabled;
  }
  function paintChoices() {
    const byId = new Map(connections.map(connection => [connection.id, connection]));
    const ids = [...byId.keys(), ...[...selected].filter(id => !byId.has(id))];
    rows.replaceChildren();
    if (!ids.length) note(rows, '尚无设备托管账户；请在「模型来源」中添加。');
    for (const id of ids) {
      const connection = byId.get(id), label = el('label', undefined, 'dashboard-card-choice');
      const input = el('input'); input.type = 'checkbox'; input.value = id; input.checked = selected.has(id); input.dataset.connectionId = id;
      const identity = el('span'); identity.append(el('strong', connection ? text(connection.label, '未命名账户') : '来源已删除或不可用'));
      identity.append(el('small', connection ? `${PROVIDERS[connection.provider] || text(connection.provider)} · ${connection.enabled === false ? '已停用' : '已启用'} · ${id}` : `${id} · 取消勾选后保存可移除该卡片`));
      input.onchange = () => {
        if (!active() || busy || !config) return;
        if (input.checked) selected.add(id); else selected.delete(id);
        if (!conflict) setStatus('选择尚未保存。');
      };
      label.append(input, identity); rows.append(label);
    }
  }
  async function reread() {
    if (!active() || busy) return;
    busy = true; sync(); setStatus('正在重新读取设备配置与账户缓存…');
    try {
      const [next, sources] = await Promise.all([readDashboardConfig(), loadDashboardConnections()]);
      if (!active()) return;
      config = next; connections = sources; selected = new Set(next.cards.map(card => card.connection_id)); conflict = false;
      paintChoices(); setStatus('已读取设备共享配置；未写入任何更改。');
    } catch (error) {
      if (active()) setStatus(`${error.message}；保留已有选择，未修改设备配置。`, true);
    } finally { busy = false; if (active()) sync(); }
  }
  async function submit() {
    if (!active() || busy || !config || conflict) return;
    busy = true; sync(); setStatus('正在保存卡片选择…');
    const cards = [...selected].map(connection_id => ({ type: 'account', connection_id }));
    let acknowledged = false;
    try {
      const next = validateConfig(await api('/api/host/dashboard', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cards, expected_revision: config.revision }) }));
      acknowledged = true;
      if (!active()) return;
      config = next; selected = new Set(next.cards.map(card => card.connection_id));
      setStatus('卡片选择已保存到设备。');
      // The ACK is authoritative. A failed cache reread must never invite resubmitting this successful write.
      try {
        const sources = await loadDashboardConnections();
        if (!active()) return;
        connections = sources; paintChoices(); setStatus('卡片选择已保存到设备；账户缓存已重新读取。');
      } catch (error) { if (active()) { paintChoices(); setStatus(`卡片选择已保存到设备；后续${error.message}，现有账户展示可能过期。请重新读取，不必再次保存。`, true); } }
    } catch (error) {
      if (!active()) return;
      conflict = /revision|conflict|冲突|已(?:被|由).*修改|版本/i.test(error.message);
      setStatus(conflict ? '设备卡片配置已被其他页面修改；本页选择已保留，请重新读取后再编辑保存。'
        : `${acknowledged ? '保存已确认' : '保存未获确认'}：${error.message}；选择已保留，请先重新读取核对设备状态，不自动重试。`, true);
    } finally { busy = false; if (active()) sync(); }
  }
  save.onclick = submit; reload.onclick = reread; sync();
  return { root, ready: reread(), reload: reread, dispose: () => { disposed = true; } };
}
