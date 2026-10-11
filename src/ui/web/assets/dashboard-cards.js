import { el } from './dom.js';
import { api } from './api.js';
import { settingsClient } from './settings-api.js';
import { usageWindow, usageErrorLabels } from './format.js';

const PROVIDERS = { deepseek: 'DeepSeek', openrouter: 'OpenRouter', zai: 'Z.AI', 'kimi-coding': 'Kimi Coding',
  'openai-codex': 'Codex 订阅', 'openai-compatible': '自定义 OpenAI 兼容 API' };
const STATUSES = { available: '观测成功', partial: '部分指标可用', error: '查询失败（不代表余额为零或资源耗尽）',
  unknown: '尚未取得当前数据；未知不等于零', unsupported: '此来源不支持查询', unconfigured: '缺少查询凭证' };
const SOURCES = { usage_api: '专用余额 / 额度接口', client_rpc: '原生客户端协议', response_headers: '正常模型响应（调用结束后采集）', none: '尚无观测来源' };
const SCOPES = { account: '账号共享', key: 'API Key 预算', model: '模型专属' };
const finite = value => typeof value === 'number' && Number.isFinite(value);
const text = (value, fallback = '未知') => typeof value === 'string' && value ? value : fallback;
const amount = value => finite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 8 }) : '未知';
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : '时间未知';
const successful = observation => ['available', 'partial'].includes(observation?.status);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const note = (parent, value, warning = false) => parent.append(el('p', value, warning ? 'dashboard-card-warning' : 'dashboard-card-note'));
const stalePage = () => new DOMException('账户卡片页面已离开', 'AbortError');
function validateConfig(value) {
  if (value?.version !== 1 || typeof value.revision !== 'string' || !value.revision || !Array.isArray(value.cards)
    || value.cards.some(card => card?.type !== 'account' || !uuid(card.connection_id))
    || new Set(value.cards.map(card => card.connection_id)).size !== value.cards.length) {
    throw new Error('卡片配置响应无效；未将其视为无卡片');
  }
  return { version: 1, revision: value.revision, cards: value.cards.map(({ connection_id }) => ({ type: 'account', connection_id })) };
}
async function readConfig() {
  try { return validateConfig(await api('/api/host/dashboard')); }
  catch (error) { throw new Error(`卡片配置读取失败：${error.message}`); }
}
async function readConnections() {
  try {
    const value = await settingsClient('device').read('/api/agent/connections');
    if (!Array.isArray(value?.connections) || value.connections.some(row => !uuid(row?.id))
      || new Set(value.connections.map(row => row.id)).size !== value.connections.length) throw new Error('设备来源列表响应无效');
    return value.connections;
  } catch (error) { throw new Error(`设备账户 / 余额缓存读取失败：${error.message}`); }
}

/** Reads only Host configuration and device cache; no provider query, model calls or browser persistence. */
export async function loadAccountCards({ ownsPage = () => true } = {}) {
  if (!ownsPage()) throw stalePage();
  const [config, connections] = await Promise.all([readConfig(), readConnections()]);
  if (!ownsPage()) throw stalePage();
  const byId = new Map(connections.map(connection => [connection.id, connection]));
  return config.cards.map(card => ({ id: `account:${card.connection_id}`, ...card, connection: byId.get(card.connection_id) || null }));
}

function renderMetric(resource) {
  const kind = resource.kind === 'balance' ? '现金余额' : resource.scope === 'key' ? 'Key 预算（非现金余额）'
    : resource.scope === 'account' ? '套餐 / 额度（非现金余额）' : '模型额度（非现金余额）';
  const root = el('section', undefined, 'dashboard-account-metric');
  root.dataset.metricId = text(resource.id, 'unknown');
  root.append(el('h4', text(resource.label, '未命名指标')));
  note(root, `${kind} · ${SCOPES[resource.scope] || '范围未知'}`);
  const unit = text(resource.unit, '单位未知');
  const remaining = el('p', undefined, 'dashboard-account-value');
  remaining.append(el('strong', `剩余 ${amount(resource.remaining)} ${unit}`)); root.append(remaining);
  let percent = finite(resource.used_percent) ? resource.used_percent : null;
  if (percent === null && finite(resource.total) && resource.total > 0) {
    if (finite(resource.used)) percent = resource.used / resource.total * 100;
    else if (finite(resource.remaining)) percent = (resource.total - resource.remaining) / resource.total * 100;
  }
  if (resource.kind === 'quota') {
    if (percent !== null) {
      const value = el('p', undefined, 'dashboard-account-value');
      value.append(el('strong', `已用 ${amount(percent)}%`)); root.append(value);
      // Native progress avoids inline styles under the existing CSP. Out-of-range raw values remain visible above.
      const bar = el('progress', undefined, 'dashboard-account-progress'); bar.max = 100; bar.value = Math.max(0, Math.min(100, percent));
      bar.setAttribute('aria-label', `${text(resource.label, '额度')}已用比例`); root.append(bar);
    } else note(root, '已用比例未知；不绘制进度条');
    note(root, usageWindow(resource.window_seconds));
    note(root, resource.reset_at ? `重置时间：${time(resource.reset_at)}（到期不代表额度已恢复）` : '重置时间未知');
  }
  const details = el('details', undefined, 'dashboard-account-metric-details'); details.append(el('summary', '指标口径与原始读数'));
  note(details, `单位：${unit} · 总量 ${amount(resource.total)} ${unit} · 已用 ${amount(resource.used)} ${unit}`);
  note(details, `原始已用比例：${amount(resource.used_percent)} %`);
  if (resource.kind === 'balance') {
    note(details, usageWindow(resource.window_seconds)); note(details, `重置时间：${time(resource.reset_at)}`);
  }
  if (unit === '%') note(details, '百分比不是实际 token、请求总量或金额。');
  if (Array.isArray(resource.models) && resource.models.length) note(details, `适用模型：${resource.models.join('、')}`);
  root.append(details); return root;
}
function renderObservation(observation) {
  observation ||= {};
  const root = el('div', undefined, 'dashboard-account-observation');
  note(root, STATUSES[observation.status] || '观测状态未知；未知不等于零', !successful(observation));
  // The list API may stamp an unobserved source:none row with its read time. Do not call that a real sample.
  note(root, `缓存观测时间：${observation.source === 'none' ? '时间未知（尚无观测）' : time(observation.checked_at)} · 来源：${SOURCES[observation.source] || '未知来源'}`);
  if (observation.error_code) note(root, usageErrorLabels[observation.error_code] || '本次未取得完整数据，不能据此判断余额为零。', true);
  if (observation.reason) note(root, observation.reason);
  if (successful(observation)) {
    const resources = Array.isArray(observation.resources) ? observation.resources.filter(resource => ['balance', 'quota'].includes(resource?.kind)) : [];
    if (!resources.length) note(root, '暂无可展示指标；未知不等于零', true);
    for (const resource of resources) root.append(renderMetric(resource));
  }
  return root;
}

/** Lightweight standalone renderer: do not import the account management console into the overview. */
export function renderAccountCard(row) {
  const root = el('li', undefined, 'project-item dashboard-account-card');
  root.dataset.cardId = row.id; root.dataset.cardType = 'account'; root.dataset.connectionId = row.connection_id;
  const connection = row.connection;
  const header = el('header', undefined, 'dashboard-account-header');
  header.append(el('span', '账户余额', 'dashboard-card-kicker'), el('h3', connection ? text(connection.label, '未命名账户') : '账户来源已删除或不可用'));
  root.append(header);
  if (!connection) {
    note(root, `所选来源：${row.connection_id}`); note(root, '无法读取该来源；保留卡片占位，可在卡片管理中移除。', true); return root;
  }
  note(header, `${PROVIDERS[connection.provider] || text(connection.provider, '服务商未知')}${connection.enabled === false ? ' · 来源已停用' : ''}`);
  note(root, `模型端点：${text(connection.endpoint, '端点未知')}`);
  note(root, '仅展示设备缓存，读取总览不联网查询；数值不保证当前仍有额度。');
  root.append(renderObservation(connection.observation));
  const previous = connection.last_success;
  if (!successful(connection.observation) && successful(previous?.observation)) {
    const old = el('details', undefined, 'dashboard-account-old');
    old.append(el('summary', '历史成功观测（非当前值）'));
    note(old, `历史成功时间：${time(previous.checked_at || previous.observation.checked_at)}；不能作为当前余额。`, true);
    old.append(renderObservation(previous.observation)); root.append(old);
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
      const [next, sources] = await Promise.all([readConfig(), readConnections()]);
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
        const sources = await readConnections();
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
