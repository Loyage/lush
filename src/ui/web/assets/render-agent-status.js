import { $, block, button, el, kv } from './dom.js';
import { api } from './api.js';
import { activateDetailView } from './sidebar-ui.js';
import { ui } from './state.js';
import { createAgentUsage } from './render-agent-usage.js';
import { usageWindow, usageErrorLabels } from './usage-window.js';

const REFRESH_HELP = '重新读取当前项目 Pi 的安装、模型、账号及可查询余额；可能访问服务商账户接口，并在已选官方 Codex 凭证过期时刷新登录，不启动 Agent 或模型调用。';
const list = value => Array.isArray(value) ? value : [];
const text = (value, fallback = '未知') => typeof value === 'string' && value ? value : fallback;
const amount = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 8 }) : '未知';
const authTypes = { oauth: 'OAuth 登录凭证', api_key: 'API Key', environment: '环境变量凭证', unknown: '未知' };
const accountStates = { configured: '已配置凭证（未联网验证）', expired: '凭证已过期', unconfigured: '未配置凭证', unknown: '凭证状态未知', invalid: '凭证无效' };
const balanceStates = { unsupported: '无法查询', unconfigured: '未配置查询凭证', error: '查询失败' };

function note(parent, value, warning = false) {
  if (value) parent.append(el('p', String(value), warning ? 'agent-status-warning' : 'hint'));
}

function runtimeSection(data) {
  const section = block('Pi 安装与运行配置');
  const runtime = data.runtime || {}, grid = el('div', undefined, 'grid');
  for (const [label, value] of [
    ['Pi 版本', runtime.version], ['Pi 命令', runtime.command], ['可执行文件', runtime.executable],
    ['实际文件地址', runtime.real_path], ['Pi 配置目录', runtime.config_dir],
    ['当前项目 Agent 后端', runtime.backend], ['当前项目 Agent 模型', runtime.model],
  ]) grid.append(kv(label, text(value, label.endsWith('模型') ? '未指定（由 Pi 选择）' : '未知')));
  section.append(grid);
  note(section, runtime.warning, true);
  return section;
}

function balanceSection(balance = {}) {
  const root = el('div', undefined, 'agent-status-balance');
  const title = balance.kind === 'quota' ? '订阅 / API 额度（非现金余额）' : balance.kind === 'balance' ? '账户余额' : '余额 / 额度';
  root.append(el('h3', title));
  // Do not reinterpret missing numbers, unknown statuses or quota as a cash balance.
  if (balance.status !== 'available') {
    note(root, usageErrorLabels[balance.error_code] || balanceStates[balance.status] || '查询状态未知', true);
  } else if (!['balance', 'quota'].includes(balance.kind) || !list(balance.items).length) {
    note(root, '未取得可展示的余额或额度数据；未知不等于零。', true);
  } else {
    for (const item of list(balance.items)) {
      const entry = el('div', undefined, 'agent-status-balance-item');
      entry.append(el('strong', text(item.label, balance.kind === 'quota' ? '额度' : '余额')));
      const unit = text(item.unit, '单位未知');
      entry.append(el('p', `剩余 ${amount(item.remaining)} ${unit}`, 'agent-status-amount'));
      if (item.total !== null && item.total !== undefined) note(entry, `总额 ${amount(item.total)} ${unit}`);
      if (item.used !== null && item.used !== undefined) note(entry, `已使用 ${amount(item.used)} ${unit}`);
      if (typeof item.used_percent === 'number' && Number.isFinite(item.used_percent)) note(entry, `已用百分比 ${amount(item.used_percent)} %`);
      note(entry, `额度窗口：${usageWindow(item.window_seconds)}`);
      if (item.unit === '%') note(entry, '这里的总量 100 % 表示百分比尺度，不是实际 token、请求总额度或金额。');
      if (item.reset_at) note(entry, `重置时间：${item.reset_at}`);
      root.append(entry);
    }
  }
  note(root, balance.reason);
  if (balance.checked_at) note(root, `查询时间：${balance.checked_at}`);
  return root;
}

function accountsSection(data) {
  const accounts = list(data.accounts), section = block('账号与余额 / 额度', accounts.length);
  note(section, '仅展示当前项目环境可读取的账号与凭证状态，不代表已向服务商验证登录。账号身份已脱敏；密钥和 token 不在页面中展示。');
  if (!accounts.length) note(section, '未发现账号信息；这不代表你没有账号或余额为零。');
  const cards = el('div', undefined, 'agent-status-accounts');
  for (const account of accounts) {
    const card = el('article', undefined, 'agent-status-account');
    card.append(el('h3', text(account.provider, '未知服务商')));
    const grid = el('div', undefined, 'grid');
    grid.append(kv('账号身份', text(account.identity, '未提供身份信息')),
      kv('认证方式', authTypes[account.auth_type] || text(account.auth_type)),
      kv('凭证状态', accountStates[account.status] || text(account.status)),
      kv('凭证来源', text(account.source)));
    if (account.expires_at) grid.append(kv('凭证到期时间', account.expires_at));
    card.append(grid, balanceSection(account.balance || {}));
    const previous = account.last_success;
    if (account.balance?.status !== 'available' && previous?.balance?.status === 'available') {
      const stale = el('div', undefined, 'agent-status-last-success');
      const checkedAt = previous.checked_at || previous.balance.checked_at;
      note(stale, `最后成功查询：${text(checkedAt, '时间未知')}。以下为缓存旧值，并非最新状态；本次查询失败 / 未取得新数值。`, true);
      stale.append(balanceSection({ ...previous.balance, checked_at: checkedAt || null })); card.append(stale);
    }
    cards.append(card);
  }
  section.append(cards);
  return section;
}

function resourcesSection(data) {
  const resources = data.resources || {}, section = block('安装包与发现的资源');
  note(section, '以下是安装 / 发现目录，不代表扩展已在某个运行中的 Worker 加载。实际加载还受 Pi 设置、项目信任及 Worker 配置影响。');
  note(section, resources.warning, true);
  for (const [key, label] of [['packages', '包配置 / 安装目录'], ['extensions', '扩展 / 插件'], ['skills', 'Skills']]) {
    const rows = list(resources[key]), details = el('details', undefined, 'agent-status-resources');
    details.append(el('summary', `${label} · ${rows.length}`));
    if (!rows.length) note(details, `未发现${label}${resources.warning ? '（目录读取可能不完整）' : ''}。`);
    const entries = el('ul', undefined, 'agent-status-resource-list');
    for (const row of rows) {
      const entry = el('li');
      entry.append(el('strong', text(row.label || row.source, '未命名资源')));
      if (row.description) note(entry, row.description);
      if (row.label && row.source) note(entry, `来源：${row.source}`);
      note(entry, row.root || row.id);
      if (key === 'packages' && !row.root) note(entry, '已配置此包，但未发现安装路径，不能确认已安装。', true);
      entries.append(entry);
    }
    details.append(entries); section.append(details);
  }
  return section;
}

function modelsSection(data) {
  const catalog = data.models || {}, models = list(catalog.models);
  const local = catalog.source === 'local', cli = catalog.source === 'cli';
  const section = block(local ? '本地模型目录（未联网验证）' : cli ? 'Pi CLI 模型目录（未联网验证）' : '模型目录（未确认可用）', models.length);
  note(section, local ? '本地目录与已配置凭证的匹配结果，未联网验证；模型目录读取不执行密钥命令或刷新登录凭证，不加载扩展动态模型。不保证凭证有效、账号额度充足或请求成功。'
    : cli ? '由当前项目环境的 Pi CLI 返回；目录模型未联网验证，不保证凭证有效、账号额度充足或请求成功。'
      : catalog.source === 'presets' ? '无法读取 Pi 实际目录，以下仅为内置预设，不代表当前账号可用。' : '模型目录来源未知，不能确认当前账号可用。', !local && !cli);
  note(section, catalog.warning, true);
  const controls = el('div', undefined, 'agent-status-model-filters');
  const searchLabel = el('label', '搜索模型'), search = el('input');
  search.type = 'search'; search.placeholder = '模型名称、ID 或服务商'; search.setAttribute('aria-label', '搜索模型');
  searchLabel.append(search);
  const providerLabel = el('label', '服务商'), provider = el('select'); provider.setAttribute('aria-label', '筛选模型服务商');
  const all = el('option', '全部服务商'); all.value = ''; provider.append(all);
  for (const value of [...new Set(models.map(model => model.provider).filter(value => typeof value === 'string' && value))].sort()) {
    const option = el('option', value); option.value = value; provider.append(option);
  }
  providerLabel.append(provider); controls.append(searchLabel, providerLabel);
  const count = el('p', undefined, 'hint'); count.setAttribute('role', 'status');
  const wrap = el('div', undefined, 'agent-status-table-scroll'), table = el('table', undefined, 'agent-status-model-table');
  table.append(el('caption', local ? '本地模型目录，未联网验证；不含扩展动态模型'
    : cli ? 'Pi CLI 模型目录，未联网验证' : '预设 / 未确认目录，非实际可用模型'));
  const head = el('thead'), tr = el('tr');
  for (const label of ['服务商 / 模型', '上下文', '最大输出', '思考 / 图像']) { const th = el('th', label); th.setAttribute('scope', 'col'); tr.append(th); }
  head.append(tr); table.append(head);
  const body = el('tbody'); table.append(body); wrap.append(table);
  const empty = el('p', '未找到匹配模型。', 'hint');
  const paint = () => {
    const query = search.value.trim().toLocaleLowerCase();
    const matches = models.filter(model => (!provider.value || model.provider === provider.value)
      && [model.id, model.label, model.provider].filter(Boolean).join(' ').toLocaleLowerCase().includes(query));
    body.replaceChildren();
    for (const model of matches) {
      const row = el('tr'), name = el('th'); name.setAttribute('scope', 'row');
      name.append(el('strong', text(model.id, text(model.label))));
      if (model.label && model.label !== model.id) name.append(el('small', model.label));
      const capability = value => value === true ? '支持' : value === false ? '不支持' : '未知';
      row.append(name, el('td', text(model.context)), el('td', text(model.max_output)),
        el('td', `${capability(model.thinking)} / ${capability(model.images)}`));
      body.append(row);
    }
    count.textContent = `显示 ${matches.length} / ${models.length} 个${local ? '本地目录模型' : cli ? 'CLI 目录模型' : '未确认模型'}`;
    empty.hidden = matches.length > 0;
  };
  search.oninput = paint; provider.onchange = paint; paint();
  section.append(controls, count, wrap, empty);
  return section;
}

/** Text-only rendering: configuration and catalog data never become HTML. */
export function renderAgentStatus(data) {
  const root = el('div', undefined, 'agent-status-results');
  note(root, `数据更新时间：${text(data.checked_at)}`);
  note(root, `查询项目：${text(data.scope?.project)} · 角色：${text(data.scope?.role, 'agent')}`);
  note(root, data.scope?.note || '来自项目 daemon 的 Pi 环境，不是浏览器本机，也不是某个运行中调用的快照。');
  for (const warning of list(data.warnings)) note(root, warning, true);
  root.append(runtimeSection(data), accountsSection(data), modelsSection(data), resourcesSection(data));
  return root;
}

/** Query only on entering the page and explicit refresh; overview polling owns no status data. */
export function openAgentStatus() {
  const view = activateDetailView({ view: 'agent-status' });
  if (ui.agentStatusPage?.view === view) return ui.agentStatusPage.pending || Promise.resolve();
  const page = el('div', undefined, 'agent-status-page');
  const header = el('header', undefined, 'agent-status-head'), copy = el('div');
  copy.append(el('h1', 'Agent 状态'), el('p', 'Pi 安装、模型、账号、余额与额度历史。进入页面和手动刷新时查询并缓存；页面不自动轮询，可在下方启用后台采样；已选官方 Codex 凭证过期时可自动刷新登录，不调用模型。', 'hint'));
  const feedback = el('p', undefined, 'hint agent-status-feedback'); feedback.setAttribute('role', 'status');
  const result = el('div');
  const state = { view, pending: null, data: null }; ui.agentStatusPage = state;
  const ownsPage = () => ui.view === view && ui.agentStatusPage === state;
  const usage = createAgentUsage({ ownsPage }); usage.node.hidden = true;
  const load = () => {
    if (!ownsPage()) return Promise.resolve();
    if (state.pending) return state.pending;
    const configRevision = usage.configRevision();
    refresh.disabled = true; refresh.textContent = '正在查询…'; feedback.textContent = '正在读取 Pi 状态…';
    feedback.className = 'hint agent-status-feedback'; feedback.setAttribute('role', 'status'); page.setAttribute('aria-busy', 'true');
    state.pending = (async () => {
      try {
        const data = await api('/api/agent/status');
        if (!ownsPage()) return;
        if (data?.version !== 1 || data.agent !== 'pi') throw new Error('Agent 状态数据格式不兼容，请更新项目后台与界面服务。');
        const content = renderAgentStatus(data);
        state.data = data; result.replaceChildren(content); feedback.textContent = '查询完成，结果已缓存；页面信息不会自动刷新。';
        usage.node.hidden = false;
        await usage.update(data, configRevision);
      } catch (error) {
        if (!ownsPage()) return;
        feedback.textContent = `查询失败：${error.message}${state.data ? '。以下保留上次查询结果，并非最新状态。' : ''}`;
        feedback.className = 'agent-status-warning agent-status-feedback'; feedback.setAttribute('role', 'alert');
        // Historical observations and query settings must remain accessible even if live discovery fails.
        usage.node.hidden = false;
        await usage.update(state.data || {}, configRevision);
      } finally {
        state.pending = null;
        if (ownsPage()) { refresh.disabled = false; refresh.textContent = state.data ? '刷新状态' : '重新查询'; page.setAttribute('aria-busy', 'false'); }
      }
    })();
    return state.pending;
  };
  const refreshHost = el('span', undefined, 'help-host'); refreshHost.setAttribute('data-help', REFRESH_HELP);
  const refresh = button('刷新状态', load, 'agent-status-refresh', { help: REFRESH_HELP });
  refreshHost.append(refresh); header.append(copy, refreshHost); page.append(header, feedback, result, usage.node); $('detail').replaceChildren(page);
  return load();
}
