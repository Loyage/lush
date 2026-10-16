import { $, el } from './dom.js';
import { api } from './api.js';
import { ui } from './state.js';
import { activateDetailView } from './sidebar-ui.js';
import { projectRoute } from './route.js';
import { confirmDialog } from './dialog.js';
import { loadCliCatalog } from './cli-catalog.js';

const permissionsEndpoint = '/api/host/management/permissions';
const labels = { read: '只读', automatic: '自动执行', confirmation: '逐次确认', unavailable: '禁止' };
const accessLabel = (item, access) => access === 'unavailable' && item.base_access === 'unavailable' ? '固有不可用' : labels[access];
function validatePermissions(value, catalog) {
  if (value?.version !== 1 || value.scope !== 'device' || typeof value.configured !== 'boolean' || typeof value.revision !== 'string' || !value.revision
    || !Array.isArray(value.groups) || !Array.isArray(value.methods) || !value.permissions
    || new Set(value.methods.map(item => item.method)).size !== value.methods.length
    || Object.keys(value.permissions).length !== value.methods.length
    || value.methods.some(item => !value.groups.some(group => group.id === item.group)
      || !Array.isArray(item.allowed_access) || !item.allowed_access.includes(item.access)
      || value.permissions[item.method] !== item.access || item.allowed_access.some(access => !labels[access]))) {
    throw Error('权限目录不完整或不兼容，请重新读取。');
  }
  // A cached learning ceiling must match the running Host policy version,
  // including the ACK if the Host changed between read and save.
  if (catalog.commands.some(command => command.rpc.some(rpc => {
    const actual = value.methods.find(item => item.method === rpc.method);
    return !actual || actual.base_access !== rpc.base_access || JSON.stringify(actual.allowed_access) !== JSON.stringify(rpc.allowed_access);
  }))) throw Error('CLI 目录与 Host 权限版本不一致；请在安全空闲时更新 Host 并刷新页面后重新读取。');
  return value;
}

// Historical filename/state slot retained; the independent settings page is replaced.
export async function openCliInterfaces({ registerPageLeaveGuard }) {
  const view = activateDetailView({ view: 'cli-interfaces' });
  const owner = globalThis.document, identity = globalThis.location?.pathname;
  const existing = ui.valetSettingsPage;
  if (existing?.view === view && existing.owner === owner && existing.pathname === identity) return existing.ready;
  ui.disposeValetSettings?.();
  const state = { view, owner, pathname: identity, disposed: false, generation: 0, catalogGeneration: 0, catalog: null, data: null,
    draft: null, busy: false, catalogLoading: false, permissionsStale: false, uncertain: false, selected: null, query: '', composing: false, expanded: new Set() };
  ui.valetSettingsPage = state;
  const owns = () => !state.disposed && globalThis.document === owner && ui.view === view
    && ui.valetSettingsPage === state && globalThis.location?.pathname === identity && !projectRoute();
  const dirty = () => state.data && state.data.methods.some(item => state.draft[item.method] !== state.data.permissions[item.method]);
  const root = el('div', undefined, 'cli-interfaces-page');
  const searchBox = el('section', undefined, 'cli-search');
  const searchLabel = el('label', '搜索命令'); searchLabel.htmlFor = 'cli-command-search';
  const search = el('input'); search.id = 'cli-command-search'; search.type = 'search'; search.placeholder = '搜索 CLI 命令、名称或介绍'; search.setAttribute('aria-label', '搜索 CLI 命令、名称或介绍'); search.setAttribute('aria-describedby', 'cli-search-hint');
  const clear = el('button', '清空', 'ghost'); clear.type = 'button'; clear.onclick = () => { if (!owns()) return; search.value = ''; state.query = ''; state.selected = null; paint(); search.focus(); };
  const searchField = el('span', undefined, 'cli-search-field');
  const searchIcon = el('span', '⌕', 'cli-search-icon'); searchIcon.setAttribute('aria-hidden', 'true');
  searchField.append(searchIcon, search, clear);
  const searchHint = el('p', '支持 lush / lushc 完整命令及关键词 · 实时匹配读写接口 · 空关键词显示顶层目录', 'hint'); searchHint.id = 'cli-search-hint';
  searchBox.append(searchLabel, searchField, searchHint);
  const updateSearch = () => { if (!owns() || state.composing) return; state.query = search.value.trim(); state.selected = null; paint(); };
  search.oninput = event => { if (!event?.isComposing) updateSearch(); };
  search.addEventListener('compositionstart', () => { state.composing = true; });
  search.addEventListener('compositionend', () => { state.composing = false; updateSearch(); });
  const hero = el('header', undefined, 'resource-hero');
  hero.append(el('h1', 'CLI 接口'), el('p', '说明随版本缓存，查阅不依赖项目后台。全局权限按需读取；浏览不执行 CLI、不调用 Agent。保存不新建管家操作，不能提升审核上限。'));
  const unconfigured = el('section', undefined, 'cli-permissions-unconfigured resource-card'); unconfigured.hidden = true; unconfigured.setAttribute('role', 'status');
  const configurationHeading = el('h2', '尚未统一生效 · 审核默认草稿');
  unconfigured.append(configurationHeading, el('p', '上次成功读取时，尚未配置设备全局管家权限。下方仅为审核默认草稿，不代表任何项目的实际授权；首次显式保存后，才统一作用于此设备用户所有项目的新旧管家。旧项目权限仅保留历史，不自动导入。'));
  const catalogStatus = el('p', '正在加载静态目录…', 'cli-catalog-status'); catalogStatus.setAttribute('role', 'status');
  const catalogRetry = el('button', '重试读取目录', 'ghost'); catalogRetry.type = 'button'; catalogRetry.hidden = true; catalogRetry.onclick = () => loadCatalog(true);
  const catalogNotice = el('section', undefined, 'cli-catalog-notice'); catalogNotice.append(catalogStatus, catalogRetry);
  const results = el('section', undefined, 'cli-results'); results.setAttribute('aria-label', 'CLI 搜索结果');
  const detail = el('section', undefined, 'cli-command-detail');
  const footer = el('section', undefined, 'cli-permissions-save resource-card');
  const status = el('p', '全局权限尚未读取；查看命令不需要读取权限。', 'cli-settings-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const save = el('button', '保存全局管家权限', 'primary'); save.type = 'button'; save.onclick = saveDraft;
  const reload = el('button', '读取全局权限', 'ghost'); reload.type = 'button'; reload.onclick = () => loadPermissions(true);
  footer.append(el('h2', '全局权限 · 按需读取与统一保存'), el('p', '保存后，此设备用户所有项目的新旧管家统一使用最新权限；排队或待确认但尚未开始的操作，执行前重新检查。已开始的操作不强行中断，已执行的不撤销；失败不自动重放。危险操作仍须逐次确认，权限改变不新建操作；已有未开始的请求可能继续或受阻。无需选择项目，所有项目后台离线也可配置。', 'hint'), status, save, reload);
  root.append(hero, unconfigured, catalogNotice, searchBox, results, detail, footer); $('detail').replaceChildren(root);
  const selects = new Map(), diagnostics = new Map(), summaries = new Map();
  function setStatus(text, error = false) { status.textContent = text; status.classList.toggle('error', error); }
  function sync() {
    save.disabled = !state.data || state.busy || state.uncertain || state.permissionsStale || (state.data.configured && !dirty()); reload.disabled = !state.catalog || state.busy;
    reload.textContent = state.data || state.uncertain ? '重新读取全局权限' : '读取全局权限';
    unconfigured.hidden = !state.data || state.data.configured;
    configurationHeading.textContent = state.uncertain || state.permissionsStale ? '上次读取尚未统一生效 · 请重新核对' : '尚未统一生效 · 审核默认草稿';
    catalogRetry.disabled = state.catalogLoading;
    for (const [method, select] of selects) {
      const item = state.data?.methods.find(item => item.method === method);
      select.value = state.draft?.[method] ?? '';
      select.disabled = !item || state.busy || state.permissionsStale || item.allowed_access.length < 2;
    }
    for (const [node, item] of summaries) {
      if (item.directory) { node.textContent = '分类 · 查看子命令'; continue; }
      if (!item.rpc.length) { node.textContent = '本地 · 不可授权'; continue; }
      if (!state.data) { node.textContent = '全局权限未读取'; continue; }
      const policies = item.rpc.map(rpc => {
        const policy = state.data?.methods.find(row => row.method === rpc.method) ?? rpc;
        const access = state.draft?.[rpc.method] ?? policy.base_access;
        return `${rpc.method}：${accessLabel(policy, access)}`;
      });
      const changed = state.data && item.rpc.some(rpc => state.draft[rpc.method] !== state.data.permissions[rpc.method]);
      const rpc = item.rpc[0], policy = state.data?.methods.find(row => row.method === rpc.method) ?? rpc;
      node.textContent = (state.uncertain ? '保存待核对 · ' : state.permissionsStale ? '旧读取 · ' : '') + (!state.data.configured ? '审核默认草稿 · 未生效 · ' : '') + (item.rpc.length > 1 ? `多项权限（${item.rpc.length}）` : accessLabel(policy, state.draft?.[rpc.method] ?? policy.base_access))
        + (changed ? ' · 草稿' : '');
      node.setAttribute('data-help', `${policies.join('；')}。点击命令查看详情与审核上限；${!state.data.configured ? '这是审核默认草稿，不代表任何项目实际授权。' : ''}保存后对此设备用户所有项目新旧管家生效，不新建操作；已有未开始的请求按最新权限重新检查。`);
    }
    for (const [method, node] of diagnostics) {
      const item = state.data?.methods.find(item => item.method === method);
      const forbidden = item && state.draft[method] === 'unavailable' && item.base_access !== 'unavailable';
      node.hidden = !forbidden;
      node.textContent = forbidden ? !state.data.configured ? '审核默认草稿禁止此能力，尚未统一生效；不代表任何项目实际授权。' : state.data.permissions[method] === 'unavailable'
        ? '当前全局权限禁止此能力。' : '当前草稿禁止此能力；保存后对此设备用户所有项目新旧管家生效。' : '';
    }
  }
  function commandList(container, commands) {
    const headings = el('div', undefined, 'cli-command-columns'); headings.setAttribute('aria-hidden', 'true');
    headings.append(el('span', '命令'), el('span', '简介', 'cli-command-description'), el('span', '读写'), el('span', '管家权限')); container.append(headings);
    const wordCount = item => item.command_path.trim().split(/\s+/).length;
    for (const item of [...commands].sort((a, b) => wordCount(a) - wordCount(b))) {
      const node = el('button', undefined, 'cli-command-link'); node.type = 'button'; node.dataset.command = item.path;
      const summary = el('span', undefined, 'cli-command-access'); summaries.set(summary, item);
      const operation = el('span', item.operations.length > 1 ? '读／写' : item.operations.includes('write') ? '写' : '读', 'cli-command-operation');
      operation.dataset.operation = item.operations.length > 1 ? 'mixed' : item.operations[0];
      node.append(el('strong', item.path), el('span', item.description, 'cli-command-description'), operation, summary);
      node.onclick = () => { if (!owns()) return; state.selected = item.path; paint(); detail.scrollIntoView?.({ block: 'start' }); };
      container.append(node);
    }
  }
  function permissions(item) {
    const section = el('section', undefined, 'cli-command-permissions');
    section.append(el('h3', '设备全局管家权限'));
    if (!item.rpc.length) { section.append(el('p', '本地／终端能力，没有可授予管家的项目 RPC；可学习但不可提权。', 'hint')); return section; }
    section.append(el('p', item.rpc.length > 1
      ? '此命令关联多个 RPC（按参数或读取／写入阶段调用），逐项设置；授权某项不等于开放整条 CLI 命令。Valet 使用受控工具而非 Shell。'
      : '此命令关联以下 RPC；Valet 经受控工具执行，不运行 CLI 或 Shell。', 'hint'));
    for (const rpc of item.rpc) {
      const policy = state.data?.methods.find(row => row.method === rpc.method) ?? rpc;
      const row = el('div', undefined, 'cli-permission-method'); row.dataset.method = rpc.method;
      const copy = el('div'); copy.append(el('code', rpc.method), el('p', `审核上限：${accessLabel(policy, policy.base_access)}`, 'hint'));
      // The CLI projection carries the reviewed ceiling reason, not authorization.
      if (rpc.reason) copy.append(el('p', rpc.reason, 'hint'));
      const diagnostic = el('p', undefined, 'cli-permission-diagnostic hint'); diagnostics.set(rpc.method, diagnostic); copy.append(diagnostic);
      const label = el('label', !state.data ? '全局权限尚未读取' : state.permissionsStale ? '旧读取／草稿 · 待核对' : !state.data.configured ? '审核默认草稿 · 未生效' : '全局权限选择');
      const select = el('select'); select.setAttribute('aria-label', `${rpc.method} 管家权限`);
      if (!state.data) { const unknown = el('option', '未读取全局权限'); unknown.value = ''; select.append(unknown); }
      for (const access of policy.allowed_access) { const option = el('option', accessLabel(policy, access)); option.value = access; select.append(option); }
      select.onchange = () => {
        const actual = state.data?.methods.find(row => row.method === rpc.method);
        if (!owns() || state.busy || state.permissionsStale || !actual?.allowed_access.includes(select.value)) { sync(); return; }
        state.draft[rpc.method] = select.value; setStatus('草稿已修改，尚未保存。'); sync();
      };
      selects.set(rpc.method, select); label.append(select);
      const host = el('span', undefined, 'help-host');
      if (!state.data || state.permissionsStale || policy.allowed_access.length === 1) host.setAttribute('data-help', !state.data ? '全局管家权限未读取成功，不能编辑。' : state.permissionsStale ? '这是旧读取或保留草稿，重新读取全局权限成功后才能编辑。' : rpc.reason || '后台固定审核能力，不可通过设置提权。');
      host.append(label); row.append(copy, host); section.append(row);
    }
    return section;
  }
  function paint() {
    const previous = detail.querySelector('details');
    if (previous) { if (previous.open) state.expanded.add(previous.dataset.command); else state.expanded.delete(previous.dataset.command); }
    results.replaceChildren(); detail.replaceChildren(); selects.clear(); diagnostics.clear(); summaries.clear();
    if (!state.catalog) { sync(); return; }
    const commands = state.catalog.commands, query = state.query.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
    const matches = commands.filter(item => !query ? !item.parent : ['lush', 'lushc'].includes(query)
      ? item.executable === query : `${item.path} ${item.name} ${item.description}`.toLocaleLowerCase().includes(query));
    results.hidden = Boolean(state.selected); detail.hidden = !state.selected;
    results.append(el('h2', query ? `匹配结果（${matches.length}）` : '顶层命令目录'));
    if (!matches.length) results.append(el('p', '没有匹配的 CLI 命令，请调整关键词。', 'hint'));
    commandList(results, matches);
    if (state.selected) {
      const item = commands.find(item => item.path === state.selected);
      const nav = el('nav', undefined, 'cli-detail-nav');
      const back = el('button', query ? '返回搜索结果' : '返回顶层目录', 'ghost'); back.type = 'button';
      back.onclick = () => { if (!owns()) return; state.selected = null; paint(); search.focus(); }; nav.append(back);
      if (item.parent) {
        const parent = el('button', `上级：${item.parent}`, 'ghost'); parent.type = 'button';
        parent.onclick = () => { if (!owns()) return; state.selected = item.parent; paint(); }; nav.append(parent);
      }
      detail.append(nav, el('h2', item.path), el('p', item.description), el('h3', '调用格式'), el('code', item.format, 'cli-command-code'));
      if (item.example) detail.append(el('h3', '示例（仅说明，不执行）'), el('code', item.example, 'cli-command-code'));
      detail.append(el('h3', '风险与边界'), el('p', item.risk));
      const children = commands.filter(child => child.parent === item.path);
      if (children.length) { detail.append(el('h3', '子命令')); commandList(detail, children); }
      if (!item.directory) detail.append(permissions(item));
      const advanced = el('details', undefined, 'cli-advanced'); advanced.dataset.command = item.path; advanced.open = state.expanded.has(item.path); advanced.append(el('summary', '高级参数、关联 RPC 与兼容限制'));
      advanced.append(el('code', item.usage, 'cli-command-code'));
      advanced.append(el('p', '通用选项：--project PATH 明确项目；--json 输出结构化结果（终端 watch 不支持）；--help / -h 只打印帮助，不执行命令。', 'hint'));
      if (item.advanced) advanced.append(el('p', item.advanced, 'hint'));
      for (const rpc of item.rpc) advanced.append(el('p', `${rpc.method} · RPC 参数：${rpc.parameters.join(', ') || '无'} · ${rpc.audience === 'user' ? '用户专属入口' : rpc.audience === 'agent' ? '专用 Agent 入口' : '用户／开发 Agent（仍受身份门禁）'}`, 'hint'));
      detail.append(advanced);
    }
    sync();
  }
  async function loadCatalog(retry = false) {
    if (!owns() || state.catalogLoading) return;
    const generation = ++state.catalogGeneration; state.catalogLoading = true; sync();
    catalogNotice.hidden = false; catalogStatus.textContent = '正在加载静态目录…'; catalogStatus.classList.remove('error'); catalogRetry.hidden = true;
    try {
      const catalog = await loadCliCatalog({ retry });
      if (!owns() || generation !== state.catalogGeneration) return;
      state.catalog = catalog; paint(); catalogNotice.hidden = true;
    } catch (error) {
      if (!owns() || generation !== state.catalogGeneration) return;
      catalogStatus.textContent = `目录加载失败：${error.message}`; catalogStatus.classList.add('error'); catalogRetry.hidden = false;
    } finally { if (owns() && generation === state.catalogGeneration) { state.catalogLoading = false; sync(); } }
  }
  async function loadPermissions(discard = false) {
    if (!owns() || !state.catalog || state.busy) return;
    if (discard && (dirty() || state.uncertain)) {
      const accepted = await confirmDialog({ title: '放弃草稿并重新读取？', message: '将用设备全局权威设置替换本地草稿。若上次保存结果未知，只读取核对，不自动重放。', confirmLabel: '放弃并读取', danger: true });
      if (!accepted || !owns() || state.busy) return;
    }
    const generation = ++state.generation; state.busy = true; sync(); setStatus('正在读取全局权限…');
    try {
      const value = validatePermissions(await api(permissionsEndpoint), state.catalog);
      if (!owns() || generation !== state.generation) return;
      state.data = value; state.draft = { ...value.permissions }; state.uncertain = false; state.permissionsStale = false;
      paint(); setStatus(value.configured ? '已读取设备全局管家权限；适用于此设备用户所有项目的新旧管家。' : '尚未统一生效：已读取审核默认草稿，不代表任何项目实际授权。可直接首次保存，无需修改默认映射。');
    } catch (error) {
      if (owns() && generation === state.generation) {
        state.permissionsStale = Boolean(state.data); paint();
        setStatus(`权限读取失败：${error.message}。${state.data ? '显示旧读取与保留草稿，不代表当前权限；重新读取成功前不能编辑或保存。' : '全局权限未知。'}不自动重放写入。`, true);
      }
    } finally { if (owns() && generation === state.generation) { state.busy = false; sync(); } }
  }
  async function saveDraft() {
    if (!owns() || !state.data || state.busy || state.uncertain || state.permissionsStale || (state.data.configured && !dirty())) return;
    state.busy = true; sync(); const generation = ++state.generation;
    try {
      if (!state.data.configured) {
        const accepted = await confirmDialog({ title: '首次启用设备全局管家权限？', message: '将以当前审核默认草稿（含你的修改）统一此设备用户所有项目的新旧管家权限，替代各项目旧权限；旧值仅保留历史。未开始的操作执行前重新检查，已开始的不强行中断、已执行的不撤销，失败不重放。保存不新建操作；已有未开始的请求可能继续或受阻。', confirmLabel: '确认全局生效' });
        if (!accepted || !owns() || generation !== state.generation) return;
      }
      setStatus('正在保存…');
      const value = validatePermissions(await api(permissionsEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        permissions: { ...state.draft }, expected_revision: state.data.revision,
      }) }), state.catalog);
      if (!value.configured) throw Error('Host 未确认全局权限已配置，请重新读取核对');
      if (!owns() || generation !== state.generation) return;
      state.data = value; state.draft = { ...value.permissions }; state.uncertain = false;
      paint(); setStatus('已保存设备全局管家权限，此设备用户所有项目的新旧管家均生效；未开始的操作执行前重新检查，已开始的不强行中断、已执行的不撤销，失败不重放。权限改变不新建操作；已有未开始的请求可能继续或受阻。');
    } catch (error) {
      if (owns() && generation === state.generation) {
        state.uncertain = true;
        setStatus(/revision|修订|conflict/i.test(error.message)
          ? `多标签或并发修改冲突：${error.message}。草稿保留，请重新读取后编辑，不自动覆盖。`
          : `保存未确认：${error.message}。草稿保留；结果可能未知，请重新读取核对，不自动重放。`, true);
      }
    } finally { if (owns() && generation === state.generation) { state.busy = false; sync(); } }
  }
  const unregister = registerPageLeaveGuard(target => {
    if (!owns() || ['#cli-interfaces', '#valet-settings'].includes(target)) return true;
    if (state.busy) { setStatus('请求尚未结束，请等待后离开。'); return false; }
    if (!dirty() && !state.uncertain) return true;
    return confirmDialog({ title: '离开并丢弃未保存更改？', message: '离开将丢弃本地权限草稿；未确认的保存建议先重新读取核对。', confirmLabel: '丢弃并离开', danger: true }).then(accepted => accepted && owns());
  }, { stay: () => { if (owns()) window.history.replaceState(null, '', '#cli-interfaces'); return false; } });
  const beforeUnload = event => { if (owns() && (dirty() || state.busy || state.uncertain)) { event.preventDefault?.(); event.returnValue = ''; } };
  globalThis.addEventListener?.('beforeunload', beforeUnload);
  ui.disposeValetSettings = () => { state.disposed = true; ++state.generation; unregister(); globalThis.removeEventListener?.('beforeunload', beforeUnload); if (ui.valetSettingsPage === state) ui.valetSettingsPage = null; };
  state.ready = loadCatalog(); return state.ready;
}
