import { block, button, el, kv } from './dom.js';
import { api } from './api.js';
import { confirmDialog } from './dialog.js';
import { renderUsageSeries } from './render-agent-usage.js';
import { usageErrorLabels, usageWindow } from './usage-window.js';

const PROVIDERS = [['deepseek', 'DeepSeek'], ['openrouter', 'OpenRouter'], ['zai', 'Z.AI'], ['kimi-coding', 'Kimi Coding'], ['openai-codex', 'Codex 订阅'], ['openai-compatible', '自定义 OpenAI 兼容 API']];
const SOURCES = { usage_api: '专用余额 / 额度接口', client_rpc: '原生客户端协议', response_headers: '正常模型响应（调用结束后采集）', none: '尚无观测来源' };
const CREDENTIALS = { configured: '已配置（不代表已联网验证）', unconfigured: '未配置', expired: '已过期', unknown: '未知' };
const STATUSES = { available: '观测成功', partial: '部分指标可用', unknown: '尚未取得当前数据', error: '查询失败（不代表资源耗尽）', unsupported: '此连接无法查询', unconfigured: '缺少查询凭证' };
const SCOPES = { account: '账号共享', key: 'API Key 预算', model: '模型专属' };
const array = value => Array.isArray(value) ? value : [];
const text = (value, fallback = '未知') => typeof value === 'string' && value ? value : fallback;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const amount = value => finite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 8 }) : '未知';
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : '时间未知';
const successful = value => ['available', 'partial'].includes(value?.status);
const DEVICE_FAILURE_REASONS = {
  network: '项目后台无法连接 OpenAI，请检查后台机器的网络或代理。',
  timeout: 'OpenAI 请求超过 8 秒未完成，请稍后重试或检查后台网络。',
  unsupported: 'OpenAI 未开放设备码接口，请显式使用备用回调登录。',
  unauthorized: 'OpenAI 拒绝了设备码请求，请检查账号是否允许 Codex 设备码登录，或使用备用方式。',
  rate_limited: 'OpenAI 限制了请求频率，请稍后重试。',
  invalid_response: '设备码响应格式不兼容或超过安全限制，请使用备用登录并报告此分类。',
  auth_changed: '连接配置或登录会话已更换，请重新发起登录。',
  auth_locked: '凭证正在被更新，请稍后重试。',
  login_expired: '本次登录已过期或被取消，请重新发起。',
  stopped: '项目后台已停止或本次请求被取消。',
  unsupported_platform: '后台平台无法安全托管凭证。',
  unknown: '后台未能确认失败类型；请检查连接配置和私有文件权限。',
};
function deviceFailureReason(error) {
  const match = /^Codex device login failed \(([a-z_]+)\)$/.exec(error?.message || '');
  if (match && Object.hasOwn(DEVICE_FAILURE_REASONS, match[1])) return `（${match[1]}）${DEVICE_FAILURE_REASONS[match[1]]}`;
  if (error?.message === 'device_login_clock') return '浏览器判断设备码已过期，请核对浏览器与后台机器的系统时间。';
  if (error?.message === 'device_login_invalid_response') return DEVICE_FAILURE_REASONS.invalid_response;
  if (error?.message === 'method not allowed from Web UI' || error?.message === 'unknown method: agent.connections.device.start')
    return '当前 Host 或项目后台不支持设备码接口，请更新并分别重启两者。';
  if (['Failed to fetch','NetworkError when attempting to fetch resource.'].includes(error?.message))
    return '浏览器无法连接 Lush 服务，请检查连接后重试。';
  return '未取得可识别的错误分类，请重试或使用备用回调登录。';
}
const post = (method, params) => api('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
const note = (parent, value, warning = false) => parent.append(el('p', value, warning ? 'agent-status-warning' : 'hint'));

function field(parent, label, key, type = 'text', value = '', help = '') {
  const wrap = el('label', label, 'agent-connection-field'), input = el('input');
  input.type = type; input.dataset.connectionField = key; input.setAttribute('aria-label', label);
  if (type === 'checkbox') input.checked = Boolean(value); else input.value = String(value ?? '');
  wrap.append(input); if (help) wrap.append(el('small', help, 'hint'));
  parent.append(wrap); return input;
}
function select(parent, label, key, options, value = '') {
  const wrap = el('label', label, 'agent-connection-field'), input = el('select');
  input.dataset.connectionField = key; input.setAttribute('aria-label', label);
  for (const [id, name] of options) { const option = el('option', name); option.value = id; input.append(option); }
  input.value = value; wrap.append(input); parent.append(wrap); return input;
}
function helped(label, fn, help, className = 'ghost') {
  const host = el('span', undefined, 'help-host'); host.setAttribute('data-help', help);
  host.append(button(label, fn, className, { help })); return host;
}
function positive(input, max, name) {
  const value = Number(input.value);
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${name}必须是 1–${max} 的整数。`);
  return value;
}

/** Render only structured public resources, never parse terminal output or infer quota from RPM headers. */
export function renderConnectionResources(observation = {}) {
  observation ||= {};
  const root = el('div', undefined, 'agent-connection-resources');
  note(root, STATUSES[observation.status] || '观测状态未知', !successful(observation));
  note(root, `来源：${SOURCES[observation.source] || '未知来源'} · 时间：${time(observation.checked_at)}`);
  if (observation.error_code) note(root, usageErrorLabels[observation.error_code] || '本次未取得完整资源数据；不能据此判断余额为零。', true);
  if (observation.reason) note(root, observation.reason);
  if (!successful(observation)) return root;
  if (!array(observation.resources).length) note(root, '暂无可展示指标，未知不等于零。', true);
  for (const resource of array(observation.resources)) {
    if (!['balance', 'quota'].includes(resource.kind)) continue;
    const entry = el('section', undefined, 'agent-connection-resource');
    entry.append(el('h4', text(resource.label, '未命名指标')));
    note(entry, `${resource.kind === 'balance' ? '现金余额' : resource.scope === 'key' ? 'API Key 消费额度（非账户余额）' : '套餐 / API 额度（非现金余额）'} · ${SCOPES[resource.scope] || '范围未知'}`);
    entry.append(el('p', `剩余 ${amount(resource.remaining)} ${text(resource.unit, '单位未知')}`, 'agent-status-amount'));
    if (finite(resource.total)) note(entry, `总量 ${amount(resource.total)} ${text(resource.unit, '单位未知')}`);
    if (finite(resource.used)) note(entry, `已用 ${amount(resource.used)} ${text(resource.unit, '单位未知')}`);
    if (finite(resource.used_percent)) note(entry, `已用比例 ${amount(resource.used_percent)} %`);
    if (resource.kind === 'quota') note(entry, usageWindow(resource.window_seconds));
    if (resource.reset_at) note(entry, `重置时间：${time(resource.reset_at)}`);
    if (resource.unit === '%') note(entry, '百分比不是实际 token、请求总量或金额。');
    if (array(resource.models).length) note(entry, `适用模型：${resource.models.join('、')}`);
    root.append(entry);
  }
  return root;
}

/** Local list reads and explicit remote queries; retain editor drafts and reject late page responses. */
export function createAgentConnections({ ownsPage, connectionId = '', setTimeout: setTimer = globalThis.setTimeout,
  clearTimeout: clearTimer = globalThis.clearTimeout, now = Date.now }) {
  const node = el('div', undefined, 'agent-connections-panel');
  const intro = block('项目模型来源');
  note(intro, '连接区分服务商、端点和账号。密钥由本项目 Lush 管理，存放在严格权限的私有文件中，不提供静态加密；系统当前用户仍可读取。');
  note(intro, '进入此页只读取本地配置和缓存。查询、登录和采样均不调用 Agent 或模型；不自动切换模型，也不自动转用付费资源。');
  note(intro, '托管来源目前可供 Pi 使用；Codex CLI 仍沿用自身认证。托管 Codex 订阅登录不代表 Codex CLI 已支持绑定。');
  const toolbar = el('div', undefined, 'agent-connection-actions');
  const feedback = el('p', '尚未读取本地连接。', 'hint agent-connections-feedback'); feedback.setAttribute('role', 'status');
  const layout = el('div', undefined, 'model-source-layout');
  const listPane = el('section', undefined, 'model-source-list'); listPane.setAttribute('aria-label', '模型来源列表');
  const filters = el('div', undefined, 'model-source-filters');
  const search = field(filters, '搜索来源', 'source-search', 'search', '', '按名称、服务商或模型端点搜索。');
  const providerFilter = select(filters, '服务商', 'source-provider', [['', '全部服务商'], ...PROVIDERS]);
  const enabledFilter = select(filters, '连接状态', 'source-enabled', [['', '全部状态'], ['enabled', '启用'], ['disabled', '停用']]);
  const listFeedback = el('p', undefined, 'hint'); listFeedback.setAttribute('role', 'status');
  const sourceRows = el('div', undefined, 'model-source-rows');
  listPane.append(filters, listFeedback, sourceRows);
  const detailPane = el('section', undefined, 'model-source-detail'); detailPane.setAttribute('aria-label', '模型来源详情');
  const back = button('返回来源列表', () => { closeEditor(); historySequence++; node.dataset.sourceView = 'list'; search.focus(); }, 'ghost model-source-back');
  const cards = el('div', undefined, 'agent-connection-cards');
  const selectionFeedback = el('p', undefined, 'hint model-source-selection-feedback'); selectionFeedback.setAttribute('role', 'status');
  const editor = block('添加连接'), editorHost = el('div'); editor.append(editorHost); editor.hidden = true;
  const samplingHost = block('后台采样'), samplingFeedback = el('p', undefined, 'hint'); samplingFeedback.setAttribute('role', 'status');
  const samplingForm = el('div', undefined, 'agent-connection-form');
  const samplingEnabled = field(samplingForm, '启用后台采样', 'sampling-enabled', 'checkbox', false);
  const interval = field(samplingForm, '采样间隔（分钟）', 'interval_minutes', 'number', 5); interval.min = '1'; interval.max = '1440'; interval.step = '1';
  const retention = field(samplingForm, '保留天数', 'retention_days', 'number', 90); retention.min = '1'; retention.max = '3650'; retention.step = '1';
  note(samplingHost, '默认关闭。开启后关闭页面仍采样，daemon 停止期间留空、不补查询；缩短保留天数会清理到期历史。');
  samplingHost.append(samplingForm, samplingFeedback);
  const historyHost = block('连接资源历史'), historyControls = el('div', undefined, 'agent-connection-history-controls');
  const historyConnection = select(historyControls, '历史连接', 'history-connection', [['', '请选择连接']], '');
  const historyId = field(historyControls, '已删除连接 ID（可选）', 'history-id', 'text', '', '连接删除不删除历史；可粘贴原连接 ID 查询。'); historyId.maxLength = 128;
  const days = select(historyControls, '历史范围', 'history-days', [['1', '24 小时'], ['7', '7 天'], ['30', '30 天'], ['90', '90 天']], '7');
  const historyFeedback = el('p', '选择连接后读取本地历史，不访问服务商。', 'hint agent-connection-history-feedback'); historyFeedback.setAttribute('role', 'status');
  const historyContent = el('div', undefined, 'agent-connection-history-content');
  historyHost.append(historyControls, historyFeedback, historyContent);
  samplingHost.hidden = historyHost.hidden = true;
  let selectedId = connectionId, explicitSelection = Boolean(connectionId), selectionRevision = 0;
  node.dataset.sourceView = connectionId ? 'detail' : 'list';
  let data = null, listFlight = null, version = 0, editorRevision = 0, saving = false, samplingDirty = false, samplingRevision = 0, samplingSaving = false;
  let historySequence = 0, historyFlight = null, historyKey = '', activeHistoryKey = '', editId = null, loginSequence = 0;
  const queries = new Map(), historyChoices = new Map();
  let deviceSession = null;
  const current = () => ownsPage();
  const loginVisible = () => {
    if (!current()) return false;
    for (let parent = node; parent; parent = parent.parentNode) if (parent.hidden) return false;
    return true;
  };
  const cancelDevice = login => post('agent.connections.device.cancel', { id: login.id, login_id: login.login_id }).catch(() => {});
  function stopDevice(cancel = true) {
    const session = deviceSession; if (!session) return;
    deviceSession = null; clearTimer(session.timer); session.observer?.disconnect();
    globalThis.removeEventListener?.('pagehide', session.leave);
    session.code.value = ''; session.login.user_code = '';
    session.copy.disabled = true;
    if (cancel) {
      session.feedback.textContent = '本次自动登录检查已停止；如需继续，请重新发起登录。';
      void cancelDevice(session.login);
    }
  }
  function invalidateLogin() { ++loginSequence; stopDevice(); }
  const message = (value, error = false) => {
    if (!current()) return;
    feedback.textContent = value; feedback.className = error ? 'agent-status-warning agent-connections-feedback' : 'hint agent-connections-feedback';
    feedback.setAttribute('role', error ? 'alert' : 'status');
  };
  const historicalId = () => historyId.value.trim() || historyConnection.value;
  function paintHistoryChoices() {
    for (const connection of array(data?.connections)) historyChoices.set(connection.id, connection.label);
    const selected = historyConnection.value, ids = new Set(array(data?.connections).map(connection => connection.id));
    historyConnection.replaceChildren(); const blank = el('option', '请选择连接'); blank.value = ''; historyConnection.append(blank);
    for (const [id, name] of historyChoices) { const option = el('option', `${ids.has(id) ? '' : '已删除 · '}${name} · ${id}`); option.value = id; historyConnection.append(option); }
    historyConnection.value = historyChoices.has(selected) ? selected : '';
  }
  function apply(value, stamp) {
    if (!current() || stamp !== version) return false;
    if (value?.version !== 1 || !Array.isArray(value.connections)) throw new Error('连接数据格式不兼容。');
    data = value;
    if (!explicitSelection && !array(data.connections).some(row => row.id === selectedId)) selectedId = data.connections[0]?.id || '';
    paintCards(); paintHistoryChoices(); paintRows(); paintSelection();
    if (!samplingDirty && !samplingSaving) {
      samplingEnabled.checked = Boolean(value.sampling?.enabled);
      interval.value = String(value.sampling?.interval_minutes ?? 5); retention.value = String(value.sampling?.retention_days ?? 90);
    }
    return true;
  }
  function load(force = false) {
    if (!current()) return Promise.resolve();
    if (!force && listFlight) return listFlight;
    const stamp = ++version;
    message('正在读取本地连接和缓存…'); node.setAttribute('aria-busy', 'true');
    const pending = (async () => {
      try { const value = await api('/api/agent/connections'); if (apply(value, stamp)) message('本地连接已读取；额度可显式刷新，旧配置和历史保持不迁移。'); }
      catch { if (stamp === version) message('读取连接失败；已有编辑和缓存保留，请重试。', true); }
      finally { if (listFlight === pending) listFlight = null; if (current() && stamp === version) node.setAttribute('aria-busy', 'false'); }
    })();
    listFlight = pending; return pending;
  }
  function query(id = null) {
    if (!current()) return Promise.resolve();
    const key = id || '*'; if (queries.has(key)) return queries.get(key);
    const stamp = ++version; message('正在查询资源；失败不会被解释为余额为零…');
    const pending = (async () => {
      try { const value = await post('agent.connections.query', id ? { id } : {}); if (apply(value, stamp)) message('资源查询完成；请以各连接的来源、时间和状态为准。'); }
      catch { if (stamp === version) message('资源查询失败；不能据此判断资源耗尽，旧值仅供参考。', true); }
      finally { queries.delete(key); if (current() && stamp === version) node.setAttribute('aria-busy', 'false'); }
    })();
    queries.set(key, pending); return pending;
  }
  function closeEditor() {
    invalidateLogin();
    // Clear secrets even in detached controls; never retain an abandoned login or key.
    for (const input of editorHost.querySelectorAll('input')) if (input.type === 'password') input.value = '';
    editor.hidden = true;
  }
  function paintSelection() {
    const found = array(data?.connections).some(row => row.id === selectedId);
    selectionFeedback.textContent = found ? '' : selectedId ? '所选来源不存在或已删除；请选择其他来源。' : '选择来源查看详情，或添加一个模型来源。';
    for (const card of cards.children) card.hidden = card.dataset.connectionId !== selectedId;
    for (const row of sourceRows.children) {
      const selected = row.dataset.sourceId === selectedId;
      row.classList.toggle('selected', selected); row.setAttribute('aria-current', selected ? 'true' : 'false');
    }
  }
  function selectConnection(id) {
    if (!current()) return false;
    if (id !== selectedId) {
      selectionRevision++; invalidateLogin();
      if (fieldInEditor('user_code') || fieldInEditor('redirect_url')) closeEditor();
      historyHost.hidden = true; historySequence++; historyContent.replaceChildren();
    }
    selectedId = id; explicitSelection = true; node.dataset.sourceView = 'detail'; paintSelection();
    // Narrow screens hide the source button: move keyboard focus into the visible detail.
    if (globalThis.matchMedia?.('(max-width:640px)')?.matches) {
      const card = [...cards.children].find(row => row.dataset.connectionId === id);
      const heading = card?.querySelector('h3');
      if (heading) { heading.tabIndex = -1; heading.focus(); }
    }
    return array(data?.connections).some(row => row.id === id);
  }
  const fieldInEditor = key => editorHost.querySelector(`[data-connection-field="${key}"]`);
  function paintRows() {
    const query = search.value.trim().toLocaleLowerCase();
    const rows = array(data?.connections).filter(row => (!providerFilter.value || row.provider === providerFilter.value)
      && (!enabledFilter.value || Boolean(row.enabled) === (enabledFilter.value === 'enabled'))
      && (!query || [row.label, row.provider, row.endpoint].join(' ').toLocaleLowerCase().includes(query)));
    sourceRows.replaceChildren(...rows.map(connection => {
      const row = button('', () => selectConnection(connection.id), 'model-source-row'); row.dataset.sourceId = connection.id;
      row.append(el('strong', text(connection.label, '未命名来源')),
        el('span', `${PROVIDERS.find(([id]) => id === connection.provider)?.[1] || connection.provider} · ${connection.auth_type === 'oauth' ? '订阅登录' : 'API Key'} · ${connection.enabled ? '启用' : '停用'}`, 'model-source-meta'),
        el('span', text(connection.endpoint), 'model-source-endpoint'),
        el('small', CREDENTIALS[connection.credential?.status] || '凭证状态未知'));
      return row;
    }));
    listFeedback.textContent = `显示 ${rows.length} / ${array(data?.connections).length} 个来源${rows.length ? '' : '；暂无匹配来源'}`;
    paintSelection();
  }
  search.oninput = paintRows; providerFilter.onchange = enabledFilter.onchange = paintRows;
  function paintCards() {
    const nodes = [];
    for (const connection of array(data?.connections)) {
      const card = el('article', undefined, 'agent-connection-card'); card.dataset.connectionId = connection.id;
      card.append(el('h3', text(connection.label, '未命名连接')));
      const connectionSection = block('连接与模型'), resourceSection = block('余额与额度'), consumerSection = block('使用情况');
      const grid = el('div', undefined, 'grid');
      grid.append(kv('服务商', text(connection.provider)), kv('模型端点', text(connection.endpoint)), kv('连接 ID', connection.id),
        kv('认证', connection.auth_type === 'oauth' ? 'OAuth 登录' : 'API Key'), kv('本地凭证', CREDENTIALS[connection.credential?.status] || '未知'),
        kv('连接状态', connection.enabled ? '启用' : '停用'));
      if (connection.credential?.identity) grid.append(kv('账号身份（脱敏）', connection.credential.identity));
      if (connection.credential?.expires_at) grid.append(kv('凭证到期', time(connection.credential.expires_at)));
      connectionSection.append(grid); note(connectionSection, `模型范围：${array(connection.models).length ? connection.models.join('、') : '未限定（不代表已验证模型可用）'}`);
      if (connection.provider === 'openai-compatible') note(connectionSection, '自定义 OpenAI Chat Completions 兼容 API；余额查询尚不支持，不代表余额为零。运行时仅供 Pi 显式绑定，不自动切换账号。当前适配按文本/工具调用配置；32K 上下文、4K 输出是本地运行预算，不是已验证的上游限额或价格。');
      note(resourceSection, '以下为缓存观测，不保证当前仍有额度；窗口到期或账号变化后需重新查询。');
      resourceSection.append(renderConnectionResources(connection.observation));
      const previous = connection.last_success;
      if (!successful(connection.observation) && previous) {
        const old = previous.observation || previous;
        if (successful(old)) {
          const stale = el('div', undefined, 'agent-connection-last-success');
          note(stale, `上次成功：${time(previous.checked_at || old.checked_at)}。以下为缓存旧值，不是当前资源状态。`, true);
          stale.append(renderConnectionResources(old)); resourceSection.append(stale);
        }
      }
      const consumers = el('div', undefined, 'agent-connection-consumers');
      note(consumers, '实际正在使用此连接的本项目 Worker：');
      for (const consumer of array(connection.consumers)) {
        if (!Number.isSafeInteger(consumer.task_id) || consumer.task_id <= 0) continue;
        const link = el('a', `Worker #${consumer.task_id}`); link.href = `#worker-${consumer.task_id}`;
        consumers.append(link, el('span', ` · ${text(consumer.model)} `));
      }
      if (!array(connection.consumers).length) note(consumers, '暂无运行中的显式绑定；不猜测其他客户端消耗。');
      consumerSection.append(consumers);
      const actions = el('div', undefined, 'agent-connection-actions');
      const refresh = helped('刷新此连接', () => query(connection.id), '访问此连接的专用资源接口，可能刷新本项目 OAuth 凭证；不会调用 Agent 或模型。');
      refresh.children[0].disabled = !connection.enabled; actions.append(refresh);
      actions.append(button('编辑', () => { if (current()) paintEditor(connection); }, 'ghost'),
        helped('查看历史', () => { selectConnection(connection.id); historyHost.hidden = false; historyConnection.value = connection.id; historyId.value = ''; return loadHistory(); }, '只读取此连接本地历史，不访问服务商；不同账号与指标分开显示。'));
      if (connection.auth_type === 'oauth') actions.append(
        helped('登录 / 重新登录', () => beginDeviceLogin(connection), '显示设备码和 OpenAI 官方授权链接，自动检查授权并保存本项目登录；不改外部客户端凭证，不调用 Agent 或模型。'),
        helped('备用：回调 URL 登录', () => beginLogin(connection), '设备码不可用时可显式使用浏览器回调登录，需要手动粘贴回调 URL；不自动切换，不调用 Agent 或模型。'));
      actions.append(helped('删除连接', async () => {
        if (!current()) return;
        const accepted = await confirmDialog({ title: '删除账号连接？', message: `将删除“${connection.label}”的项目配置和凭证。`,
          detail: '历史观测保留；外部客户端凭证不变。已有运行中的 invocation 不会热切换账号。', confirmLabel: '删除连接', danger: true,
          confirmHelp: '删除本项目的连接配置及凭证，保留历史观测与外部客户端登录。' });
        if (!accepted || !current()) return;
        ++version; if (deviceSession?.login.id === connection.id) invalidateLogin();
        try {
          await post('agent.connections.remove', { id: connection.id }); if (!current()) return;
          if (editId === connection.id) { paintEditor(); closeEditor(); }
          if (selectedId === connection.id) { selectedId = ''; explicitSelection = false; }
          await load(true); message('连接已删除，历史保留，可按原连接 ID 读取。');
        } catch { message('删除未完成；请重新读取本地连接确认状态。', true); }
      }, '删除本项目连接和凭证，需确认；不会删除观测历史或外部客户端凭证。', 'ghost danger'));
      card.append(connectionSection, resourceSection, consumerSection, actions); nodes.push(card);
    }
    if (!nodes.length) nodes.push(el('p', '暂无项目账号连接。添加连接不会自动迁移或替换原 CLI 登录。', 'hint'));
    cards.replaceChildren(...nodes);
  }
  function paintEditor(connection = null) {
    invalidateLogin();
    for (const input of editorHost.querySelectorAll('input')) if (input.type === 'password') input.value = '';
    editId = connection?.id || null; editorRevision++; editor.hidden = false; node.dataset.sourceView = 'detail';
    editor.querySelector('h2').textContent = connection ? `编辑连接 · ${connection.label}` : '添加连接';
    const form = el('div', undefined, 'agent-connection-form');
    const label = field(form, '连接名称', 'label', 'text', connection?.label || ''); label.maxLength = 120;
    const provider = select(form, '服务商', 'provider', PROVIDERS, connection?.provider || 'deepseek');
    const endpoint = field(form, '模型端点（HTTPS，可留空）', 'endpoint', 'url', connection?.endpoint || '', '留空采用该服务商官方模型端点；代理密钥不能发往官方余额接口。'); endpoint.maxLength = 2048;
    const models = field(form, '模型 ID 范围（逗号分隔，可留空）', 'models', 'text', array(connection?.models).join(', '), '填写物理模型 ID，不额外添加服务商前缀。这里只是限制，不进行付费可用性探测。'); models.maxLength = 8192;
    const enabled = field(form, '启用连接', 'enabled', 'checkbox', connection?.enabled ?? true);
    const credentialWrap = el('div', undefined, 'agent-connection-secret');
    const key = field(credentialWrap, 'API Key（仅写入，更换时才填写）', 'api_key', 'password', '', '留空保留已有密钥。提交后立即清空，不回显、不保存到浏览器。');
    key.autocomplete = 'new-password'; key.maxLength = 8192; key.setAttribute('spellcheck', 'false');
    const oauthNote = el('p', 'Codex 使用 OAuth：先保存连接，再点击卡片“登录 / 重新登录”。不接受手动录入 OAuth token。', 'hint');
    const compatibleNote = el('p', '自定义 API 必须填写 HTTPS 模型端点（通常含 /v1）和至少一个物理模型 ID；仅支持 OpenAI Chat Completions 协议，未联网验证可用性。当前按文本/工具调用配置，32K 上下文、4K 输出为本地运行预算，不代表上游实际限额。余额查询尚不支持，不代表余额为零。', 'hint');
    form.append(credentialWrap, oauthNote, compatibleNote);
    const localFeedback = el('p', undefined, 'hint agent-connection-editor-feedback'); localFeedback.setAttribute('role', 'status');
    const changed = () => { editorRevision++; invalidateLogin(); };
    for (const input of [label, endpoint, models, key]) input.oninput = changed;
    enabled.onchange = changed;
    const syncAuth = () => {
      const oauth = provider.value === 'openai-codex', compatible = provider.value === 'openai-compatible';
      credentialWrap.hidden = oauth; oauthNote.hidden = !oauth; compatibleNote.hidden = !compatible;
      endpoint.required = models.required = compatible; key.value = '';
    };
    provider.onchange = () => { endpoint.value = ''; changed(); syncAuth(); }; syncAuth();
    const actions = el('div', undefined, 'agent-connection-actions');
    actions.append(button('保存连接', async () => {
      if (!current() || saving) return;
      let params;
      try {
        const name = label.value.trim(); if (!name) throw new Error('请填写连接名称。');
        const url = endpoint.value.trim();
        if (provider.value === 'openai-compatible' && !url) throw new Error('自定义兼容 API 必须填写 HTTPS 模型端点。');
        if (url) { const parsed = new URL(url); if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('模型端点必须是无凭证、无查询参数、无片段的 HTTPS 地址。'); }
        const ids = models.value.split(/[,，\n]/).map(value => value.trim()).filter(Boolean);
        if (provider.value === 'openai-compatible' && !ids.length) throw new Error('自定义兼容 API 必须填写至少一个物理模型 ID。');
        if (ids.length > 50 || new Set(ids).size !== ids.length || ids.some(id => id.length > 256)) throw new Error('模型 ID 不可重复，最多 50 个，每个最长 256 字符。');
        const value = { ...(connection ? { id: connection.id } : {}), label: name, provider: provider.value, auth_type: provider.value === 'openai-codex' ? 'oauth' : 'api_key',
          enabled: enabled.checked, models: ids, ...(url ? { endpoint: url } : {}) };
        params = { connection: value, ...(value.auth_type === 'api_key' && key.value.trim() ? { credential: { api_key: key.value.trim() } } : {}) };
      } catch (error) { localFeedback.textContent = error instanceof TypeError ? '模型端点不是有效 HTTPS 地址。' : error.message; localFeedback.setAttribute('role', 'alert'); return; }
      // Only the request body briefly contains the secret. Clear the live input even when the write fails.
      key.value = ''; saving = true; ++version; const revision = editorRevision, selectionStamp = selectionRevision;
      localFeedback.textContent = '正在保存连接…';
      try {
        const saved = await post('agent.connections.save', params); if (!current()) return;
        if (revision === editorRevision) { paintEditor(); closeEditor(); if (saved?.id && selectionStamp === selectionRevision) { selectedId = saved.id; explicitSelection = true; } }
        await load(true); message('连接已保存；不会自动改变运行中的 Worker 或原 CLI 登录。');
      } catch { if (current()) { localFeedback.textContent = '保存连接失败；密钥输入已清空，请确认配置后重新提交。'; localFeedback.setAttribute('role', 'alert'); } }
      finally { saving = false; }
    }), button('取消编辑', () => { if (current()) { paintEditor(); closeEditor(); } }, 'ghost'));
    editorHost.replaceChildren(form, localFeedback, actions);
  }
  async function beginDeviceLogin(connection) {
    if (!loginVisible()) return;
    selectConnection(connection.id); invalidateLogin(); ++version;
    const revision = editorRevision, loginStamp = loginSequence;
    message('正在获取 Codex 设备码…');
    let login;
    try {
      login = await post('agent.connections.device.start', { id: connection.id });
      if (!loginVisible() || revision !== editorRevision || loginStamp !== loginSequence) { if (login?.id === connection.id && login.login_id) void cancelDevice(login); return; }
      if (login.id !== connection.id || typeof login.login_id !== 'string' || !login.login_id || login.login_id.length > 128
        || login.verification_uri !== 'https://auth.openai.com/codex/device'
        || typeof login.user_code !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(login.user_code)
        || !finite(login.interval_seconds) || login.interval_seconds < 1 || login.interval_seconds > 900
        || !Number.isFinite(Date.parse(login.expires_at))) throw new Error('device_login_invalid_response');
      if (Date.parse(login.expires_at) <= now()) throw new Error('device_login_clock');
    } catch (error) {
      if (login?.id === connection.id && login.login_id) void cancelDevice(login);
      if (loginVisible() && revision === editorRevision && loginStamp === loginSequence)
        message(`无法获取设备码：${deviceFailureReason(error)} 未改变已有凭证。`, true);
      return;
    }
    editor.hidden = false;
    editId = connection.id; editorRevision++;
    editor.querySelector('h2').textContent = 'Codex 设备码登录';
    const form = el('div', undefined, 'agent-connection-form'), link = el('a', '打开 OpenAI 设备码授权页面');
    link.href = login.verification_uri; link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.setAttribute('data-help', '在 OpenAI 官方页面输入下方设备码，完成本人发起的授权；Lush 会自动确认，不需要粘贴回调 URL。');
    note(form, `登录连接：${connection.label} · 设备码到期：${time(login.expires_at)}`); form.append(link);
    const code = field(form, '设备码（在官方页面输入）', 'user_code', 'text', login.user_code);
    code.readOnly = true; code.className = 'agent-device-code'; code.autocomplete = 'off'; code.setAttribute('spellcheck', 'false');
    note(form, '仅授权自己发起的设备码，不要分享。若服务商要求，请在 ChatGPT 安全设置中启用 Codex 设备码登录。');
    note(form, '无需回调端口或粘贴 URL；离开此页将停止检查，不在后台继续登录。外部 Pi 登录保持不变，不调用 Agent 或模型。');
    const loginFeedback = el('p', '等待你在官方页面授权，完成后将自动保存…', 'hint agent-device-feedback'); loginFeedback.setAttribute('role', 'status');
    const session = { login, code, feedback: loginFeedback, deadline: Math.min(Date.parse(login.expires_at), now() + 15 * 60000),
      copy: null, timer: null, observer: null, leave: () => stopDevice() }; deviceSession = session;
    const active = () => deviceSession === session && loginStamp === loginSequence && loginVisible();
    const end = value => {
      if (deviceSession !== session) return;
      const visible = active(); stopDevice();
      if (visible) { loginFeedback.textContent = value; loginFeedback.setAttribute('role', 'alert'); }
    };
    const schedule = seconds => {
      if (!active()) { stopDevice(); return; }
      const remaining = Math.min(Date.parse(login.expires_at), session.deadline) - now();
      if (remaining <= 0) { end('设备码已过期，请重新发起登录。'); return; }
      session.timer = setTimer(poll, Math.min(seconds * 1000, remaining));
    };
    async function poll() {
      if (!active()) { if (deviceSession === session) stopDevice(); return; }
      if (Math.min(Date.parse(login.expires_at), session.deadline) <= now()) { end('设备码已过期，请重新发起登录。'); return; }
      try {
        const result = await post('agent.connections.device.poll', { id: login.id, login_id: login.login_id });
        if (!active()) { if (deviceSession === session) stopDevice(); return; }
        if (result?.id !== login.id || result.login_id !== login.login_id) throw new Error('invalid device response');
        if (result.status === 'complete' && result.connection?.id === login.id) {
          stopDevice(false); paintEditor(); closeEditor(); const completedStamp = loginSequence;
          await load(true);
          if (current() && completedStamp === loginSequence) message('本项目设备码登录已保存，外部客户端登录未改动。');
          return;
        }
        if (result.status !== 'pending' || !finite(result.interval_seconds) || result.interval_seconds < 1 || result.interval_seconds > 900
          || !Number.isFinite(Date.parse(result.expires_at)) || Date.parse(result.expires_at) > Date.parse(login.expires_at)) throw new Error('invalid device response');
        login.expires_at = result.expires_at;
        loginFeedback.textContent = `等待授权；每 ${result.interval_seconds} 秒检查一次，服务限流时会延长间隔。`;
        schedule(result.interval_seconds);
      } catch (error) { end(`登录检查未完成：${deviceFailureReason(error)} 请重新登录或显式使用备用回调方式。已有凭证不变。`); }
    }
    const actions = el('div', undefined, 'agent-connection-actions');
    const copyHost = helped('复制设备码', async () => {
      if (!active()) return;
      try {
        if (!globalThis.navigator?.clipboard?.writeText) throw new Error('clipboard unavailable');
        await globalThis.navigator.clipboard.writeText(code.value);
        if (active()) loginFeedback.textContent = '设备码已复制；请在官方页面授权，Lush 将自动确认。';
      } catch { if (active()) { code.focus(); code.select?.(); loginFeedback.textContent = '无法自动复制；请手动选中上方设备码复制。'; } }
    }, '仅复制当前短期设备码到系统剪贴板，不保存到浏览器；请只在 OpenAI 官方页面输入，不分享。');
    session.copy = copyHost.children[0];
    actions.append(copyHost, helped('取消登录', () => { if (active()) { stopDevice(); paintEditor(); closeEditor(); message('设备码登录已取消；已有凭证不变。'); } }, '停止自动检查并取消本次设备码登录，不删除已有账号凭证。'));
    editorHost.replaceChildren(form, loginFeedback, actions);
    globalThis.addEventListener?.('pagehide', session.leave);
    if (typeof globalThis.MutationObserver === 'function') {
      session.observer = new globalThis.MutationObserver(() => { if (!loginVisible()) stopDevice(); });
      session.observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
    }
    message('设备码已获取；请在 OpenAI 官方页面输入短码，授权后自动完成。');
    schedule(login.interval_seconds);
  }
  async function beginLogin(connection) {
    if (!current()) return;
    selectConnection(connection.id); invalidateLogin(); ++version; const revision = editorRevision, loginStamp = loginSequence; message('正在创建独立 OAuth 登录请求…');
    let login;
    try {
      login = await post('agent.connections.login.start', { id: connection.id }); if (!current() || revision !== editorRevision || loginStamp !== loginSequence) return;
      const url = new URL(login.url), callback = new URL(login.redirect_uri);
      if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com' || url.pathname !== '/oauth/authorize' || url.username || url.password || url.hash || login.id !== connection.id
        || !['localhost', '127.0.0.1'].includes(callback.hostname) || callback.pathname !== '/auth/callback' || !['http:', 'https:'].includes(callback.protocol)
        || !login.login_id || !Number.isFinite(Date.parse(login.expires_at)) || Date.parse(login.expires_at) <= Date.now()) throw new Error('invalid OAuth response');
    } catch { if (revision === editorRevision && loginStamp === loginSequence) message('无法创建安全登录请求，请重试；未改变已有凭证。', true); return; }
    editor.hidden = false;
    editId = connection.id; editorRevision++;
    editor.querySelector('h2').textContent = 'Codex 独立账号登录';
    const form = el('div', undefined, 'agent-connection-form'), link = el('a', '打开 Codex 授权页面');
    link.href = login.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.setAttribute('data-help', '在 OpenAI 官方授权页登录；授权后复制浏览器地址栏的回调 URL，返回本页完成登录。不会调用 Agent。');
    note(form, `登录连接：${connection.label} · 请求到期：${time(login.expires_at)}`);
    note(form, '运行中的临时认证不携带 refresh token；长调用期间 access token 过期可能失败，下次 invocation 再由 Lush 协调刷新。');
    form.append(link); note(form, '授权后复制浏览器地址栏中的完整回调 URL。首版采用手动粘贴，回调页可能无法打开；远端 SSH 无需开放额外回调端口。');
    const callback = field(form, '授权回调 URL（仅提交，不回显）', 'redirect_url', 'password');
    callback.autocomplete = 'off'; callback.maxLength = 16384; callback.setAttribute('spellcheck', 'false');
    const loginFeedback = el('p', undefined, 'hint'); loginFeedback.setAttribute('role', 'status');
    const actions = el('div', undefined, 'agent-connection-actions'); let finishing = false;
    actions.append(helped('完成登录', async () => {
      if (!current() || finishing) return;
      const redirect_url = callback.value.trim(); callback.value = '';
      if (!redirect_url) { loginFeedback.textContent = '请粘贴完整授权回调 URL。'; return; }
      try { const value = new URL(redirect_url), expected = new URL(login.redirect_uri);
        if (value.origin !== expected.origin || value.pathname !== expected.pathname) throw new Error('wrong callback');
      } catch { loginFeedback.textContent = '回调地址不匹配；请复制本次授权后的完整地址，输入已清空。'; return; }
      finishing = true; ++version; const finishRevision = editorRevision; loginFeedback.textContent = '正在验证并保存本项目登录…';
      try {
        await post('agent.connections.login.finish', { id: connection.id, login_id: login.login_id, redirect_url });
        if (!current() || finishRevision !== editorRevision || loginStamp !== loginSequence) return;
        paintEditor(); closeEditor(); const completedStamp = loginSequence;
        await load(true); if (completedStamp === loginSequence) message('本项目登录已保存，外部客户端登录未改动。');
      } catch { if (current() && finishRevision === editorRevision && loginStamp === loginSequence) { loginFeedback.textContent = '登录未完成；回调输入已清空，请重新发起登录。不会回显授权码或上游错误。'; loginFeedback.setAttribute('role', 'alert'); } }
      finally { finishing = false; }
    }, '仅兑换本次授权码并保存本项目 OAuth 凭证；不会修改外部客户端登录，也不会调用模型。'),
    button('取消登录', () => { if (current()) { callback.value = ''; paintEditor(); closeEditor(); } }, 'ghost'));
    editorHost.replaceChildren(form, loginFeedback, actions); message('授权请求已创建；请打开官方授权页面并粘贴回调地址。');
  }
  function loadHistory() {
    if (!current()) return Promise.resolve();
    const id = historicalId(), key = `${id}\n${days.value}`;
    if (!id) { historySequence++; historyContent.replaceChildren(); historyFeedback.textContent = '请选择连接或填写原连接 ID。'; return Promise.resolve(); }
    if (historyFlight && historyKey === key) return historyFlight;
    const sequence = ++historySequence; historyKey = key;
    if (activeHistoryKey !== key) historyContent.replaceChildren();
    historyFeedback.textContent = '正在读取本地历史…'; historyFeedback.setAttribute('role', 'status');
    const pending = (async () => {
      try {
        const value = await api(`/api/agent/connections/history?id=${encodeURIComponent(id)}&days=${encodeURIComponent(days.value)}`);
        if (!current() || sequence !== historySequence || key !== `${historicalId()}\n${days.value}`) return;
        if (value?.version !== 1 || !Array.isArray(value.series)) throw new Error('invalid history');
        activeHistoryKey = key; historyContent.replaceChildren();
        for (const series of value.series) {
          const wrap = el('section', undefined, 'agent-connection-history-series');
          note(wrap, `${SCOPES[series.scope] || '范围未知'} · 来源：${SOURCES[series.source] || '历史来源'}${array(series.models).length ? ` · 模型：${series.models.join('、')}` : ''}`);
          wrap.append(renderUsageSeries(series, value, data?.sampling || {})); historyContent.append(wrap);
        }
        if (!value.series.length) note(historyContent, '暂无缓存样本；只有真实观测才会产生历史，未知不补零。');
        historyFeedback.textContent = value.truncated ? '历史已截断 / 降采样；不同账号、来源和单位分开显示，不跨缺失记录连线。' : '历史来自本地缓存，不访问服务商；账号和来源变化不会混为一条曲线。';
      } catch { if (current() && sequence === historySequence) { historyFeedback.textContent = '历史读取失败；已有图表仅为上次缓存，不代表当前资源状态。'; historyFeedback.setAttribute('role', 'alert'); } }
      finally { if (historyFlight === pending) historyFlight = null; }
    })();
    historyFlight = pending; return pending;
  }
  for (const input of [samplingEnabled, interval, retention]) {
    const changed = () => { samplingDirty = true; samplingRevision++; samplingFeedback.textContent = '有未保存的采样修改，刷新不会覆盖编辑。'; };
    input.type === 'checkbox' ? input.onchange = changed : input.oninput = changed;
  }
  samplingHost.append(button('保存采样设置', async () => {
    if (!current() || samplingSaving) return;
    let sampling;
    try { sampling = { enabled: samplingEnabled.checked, interval_minutes: positive(interval, 1440, '采样间隔'), retention_days: positive(retention, 3650, '保留天数') }; }
    catch (error) { samplingFeedback.textContent = error.message; samplingFeedback.setAttribute('role', 'alert'); return; }
    if (data?.sampling && sampling.retention_days < data.sampling.retention_days) {
      const accepted = await confirmDialog({ title: '缩短历史保留期限？', message: '到期的连接观测历史将被永久清理。', confirmLabel: '保存并清理', danger: true,
        confirmHelp: '保存较短的保留期限并清理过期历史；清理不可撤销。' });
      if (!accepted || !current()) return;
    }
    samplingSaving = true; const revision = samplingRevision; ++version;
    try {
      await post('agent.connections.sampling', { sampling }); if (!current()) return;
      if (revision === samplingRevision) samplingDirty = false;
      await load(true); if (current()) { samplingFeedback.textContent = '采样设置已保存；开启后关闭页面仍运行，daemon 停机期间留空。'; samplingFeedback.setAttribute('role', 'status'); }
    } catch { if (current()) { samplingFeedback.textContent = '采样设置保存失败；修改保留，请重试。'; samplingFeedback.setAttribute('role', 'alert'); } }
    finally { samplingSaving = false; }
  }));
  historyConnection.onchange = () => { historyId.value = ''; return loadHistory(); };
  days.onchange = loadHistory;
  historyControls.append(helped('读取历史', loadHistory, '只读取所选连接的项目 SQLite 历史，不联网查询服务商。'));
  toolbar.append(helped('重新读取本地连接', () => load(true), '重新读取项目连接配置和缓存，不访问服务商，不覆盖未保存编辑。'),
    helped('刷新全部资源', () => query(), '只查询启用连接的专用资源接口，可能刷新本项目 OAuth；不调用 Agent 或模型，不自动切换模型。'),
    button('添加连接', () => { if (current()) paintEditor(); }, 'ghost'),
    button('后台采样设置', () => { if (current()) { samplingHost.hidden = !samplingHost.hidden; node.dataset.sourceView = 'detail'; } }, 'ghost', { help: '展开本项目全部托管来源的采样设置；开启后关页仍采样，不是某个来源单独的开关。' }),
    button('历史与已删除来源', () => { if (current()) { historyHost.hidden = !historyHost.hidden; node.dataset.sourceView = 'detail'; } }, 'ghost', { help: '展开本地观测历史入口，可按原连接 ID 查看已删除来源的历史；不访问服务商。' }));
  intro.append(toolbar, feedback); detailPane.append(back, selectionFeedback, cards, editor, samplingHost, historyHost);
  layout.append(listPane, detailPane); node.append(intro, layout); paintEditor(); closeEditor(); node.dataset.sourceView = connectionId ? 'detail' : 'list';
  return { node, load, loadHistory, selectConnection, selectedConnection: () => selectedId, dispose: closeEditor };
}
