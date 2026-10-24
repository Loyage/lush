import { block, button, el } from './dom.js';
import { searchField } from './search-field.js';
import { listSurface } from './list-surface.js';
import { api } from './api.js';
import { confirmDialog } from './dialog.js';
import { scopeLabel, scopeImpact } from './settings-scope.js';
import { PROVIDERS, array, select, note, helped, canQuery, publicConfig, successful } from './connection-view-common.js';
import { createConnectionReminders } from './connection-reminders.js';
import { createConnectionArchive } from './connection-archive.js';
import { createConnectionEditor } from './connection-editor.js';
import { renderConnectionRow, renderConnectionCard } from './connection-directory.js';

// Preserve the existing public entry points for callers outside the connection page.
export { relativeTime, resetRemaining, renderConnectionResources } from './connection-resources.js';

const legacyPost = (method, params) => api('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });

/** Local list reads and explicit remote queries; retain editor drafts and reject late page responses. */
export function createAgentConnections({ ownsPage, connectionId = '', setTimeout: setTimer = globalThis.setTimeout,
  clearTimeout: clearTimer = globalThis.clearTimeout, now = Date.now,
  resetSetTimeout = globalThis.setTimeout, resetClearTimeout = globalThis.clearTimeout, client = null }) {
  const read = client ? url => url.startsWith('/api/agent/connections/history')
    ? Promise.reject(new Error('设备来源页不读取项目历史；请到来源项目查看')) : client.read(url) : api;
  const storageScopeFor = id => {
    const row = array(data?.connections).find(entry => entry.id === id);
    return row?.storage_scope || (typeof row?.scope === 'string' ? row.scope : null);
  };
  const post = (method, params) => {
    if (!client) return legacyPost(method, params);
    if (!data?.configuration_scope) return Promise.reject(new Error('来源范围未确认，请先重新读取本地连接并更新后台'));
    const id = params?.id || params?.connection?.id;
    if (id && storageScopeFor(id) === 'project') return Promise.reject(new Error('旧项目来源不属于设备配置，请先显式迁移'));
    return client.action(method, params);
  };
  const projectHistory = client?.project !== false;
  const sharedSampling = client?.scope === 'device';
  const node = el('div', undefined, 'agent-connections-panel');
  const intro = block('来源管理'); intro.classList.add('model-source-intro');
  const explanation = el('details', undefined, 'model-source-explanation'); explanation.append(el('summary', '读取、刷新与存储范围'));
  if (client) note(explanation, `${scopeImpact()} 不自动导入旧项目凭证。`);
  note(explanation, '进入页面只读本地配置与缓存，不访问服务商；显式刷新额度会联网，不调用模型。详情包含完整配置、额度与适用的项目使用情况。');
  const toolbar = el('div', undefined, 'agent-connection-actions');
  const feedback = el('p', '尚未读取本地连接。', 'hint agent-connections-feedback'); feedback.setAttribute('role', 'status');
  const layout = el('div', undefined, 'model-source-layout');
  const listPane = el('section', undefined, 'model-source-list'); listPane.setAttribute('aria-label', '模型来源列表');
  const filters = el('div', undefined, 'model-source-filters');
  const searchControl = searchField({ label: '搜索来源', placeholder: '名称、端点、服务商或模型', scope: '范围：当前目录全部模型来源（本地配置与缓存）', onSubmit: () => paintRows() });
  const search = searchControl.input; search.dataset.connectionField = 'source-search'; filters.append(searchControl.root);
  const providerFilter = select(filters, '服务商', 'source-provider', [['', '全部服务商'], ...PROVIDERS]);
  const enabledFilter = select(filters, '连接状态', 'source-enabled', [['', '全部状态'], ['enabled', '启用'], ['disabled', '停用']]);
  const stateFilter = select(filters, '认证 / 观测', 'source-state', [['', '全部认证与观测'], ['attention', '需处理'], ['configured', '凭证已配置（未验证）'], ['unconfigured', '凭证未配置'], ['expired', '凭证已过期'], ['error', '查询失败'], ['unknown', '观测未知'], ['available', '观测成功'], ['partial', '部分可用'], ['unsupported', '不支持查询']]);
  const statistics = el('p', undefined, 'model-source-statistics');
  const batchToolbar = el('div', undefined, 'agent-connection-actions');
  const batchFeedback = el('div', undefined, 'model-source-batch-feedback'); batchFeedback.setAttribute('role', 'status');
  const selectionCount = el('strong', '已选 0 个连接');
  const listFeedback = el('p', undefined, 'hint'); listFeedback.setAttribute('role', 'status');
  const sourceRows = el('div', undefined, 'model-source-rows');
  const listHeading = el('div', undefined, 'section-title'); listHeading.append(el('h2', '模型来源目录'));
  listPane.append(listHeading, sourceRows, statistics, listFeedback, filters, batchToolbar, batchFeedback);
  listSurface({ root: node, tools: filters, card: listPane, heading: listHeading, body: sourceRows });
  const detailPane = el('aside', undefined, 'model-source-detail'); detailPane.setAttribute('aria-label', '模型来源操作面板'); detailPane.hidden = !connectionId;
  // Non-modal: the overview stays operable; do not claim aria-modal or trap focus.
  let panelTrigger = null, triggerSource = '', triggerLabel = '', panelKind = connectionId ? 'detail' : '';
  const back = button('返回来源列表', () => { closeEditor(); detailPane.hidden = true; panelKind = ''; archive.invalidateHistory(); node.dataset.sourceView = 'list'; paintSelection(); returnFocus(); }, 'ghost model-source-back');
  function returnFocus() {
    let target = panelTrigger, within = false;
    for (let parent = target; parent; parent = parent.parentNode) if (parent === node) within = true;
    if (!within) target = null;
    if (!within && triggerSource) {
      const row = [...sourceRows.children].find(row => row.dataset.sourceId === triggerSource);
      target = [...(row?.querySelectorAll('button') || [])].find(control => control.textContent === triggerLabel);
    }
    (within ? panelTrigger : target || search)?.focus();
  }
  function openPanel(kind, trigger = document.activeElement) {
    let inside = false;
    for (let parent = trigger; parent; parent = parent.parentNode) if (parent === detailPane) inside = true;
    if (!inside || detailPane.hidden) {
      panelTrigger = trigger; triggerSource = ''; triggerLabel = trigger?.textContent || '';
      for (let parent = trigger; parent; parent = parent.parentNode) if (parent.dataset?.sourceId) triggerSource = parent.dataset.sourceId;
    }
    panelKind = kind; detailPane.hidden = false;
    editor.hidden = kind !== 'editor'; cards.hidden = selectionFeedback.hidden = kind !== 'detail';
    samplingHost.hidden = kind !== 'sampling'; historyHost.hidden = kind !== 'history';
    node.dataset.sourceView = 'detail'; paintSelection();
  }
  detailPane.onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); back.onclick(); } };
  const cards = el('div', undefined, 'agent-connection-cards');
  const selectionFeedback = el('p', undefined, 'hint model-source-selection-feedback'); selectionFeedback.setAttribute('role', 'status');
  let selectedId = connectionId, explicitSelection = Boolean(connectionId), selectionRevision = 0, initialDetail = Boolean(connectionId);
  node.dataset.sourceView = connectionId ? 'detail' : 'list';
  let data = null, listFlight = null, version = 0;
  const queries = new Map(), selected = new Set(), operationState = new Map(), configBusy = new Set();
  let batchBusy = false, filtered = [], sessionRevision = 0;
  const queryVersions = new Map();
  const attention = connection => ['expired', 'unconfigured', 'unknown'].includes(connection.credential?.status || 'unknown') || ['error', 'unconfigured', 'unknown'].includes(connection.observation?.status || 'unknown');
  const current = () => ownsPage();
  const message = (value, error = false) => {
    if (!current()) return;
    feedback.textContent = value; feedback.className = error ? 'agent-status-warning agent-connections-feedback' : 'hint agent-connections-feedback';
    feedback.setAttribute('role', error ? 'alert' : 'status');
  };
  const reminders = createConnectionReminders({ node, current, getData: () => data, now, resetSetTimeout, resetClearTimeout });
  const updateResets = reminders.update;
  const archive = createConnectionArchive({ read, post, current, getData: () => data, load,
    invalidateList: () => ++version, projectHistory, sharedSampling });
  const { samplingHost, historyHost, loadHistory } = archive;
  const editorView = createConnectionEditor({ node, panel: { open: openPanel, back: () => back.onclick(), kind: () => panelKind },
    operations: { current, post, load, autoRefresh, message, invalidateList: () => ++version, generation: () => sessionRevision,
      isBusy: id => configBusy.has(id), beginSave(id) { if (id) { configBusy.add(id); queryVersions.set(id, (queryVersions.get(id) || 0) + 1); operationState.delete(id); } },
      endSave: id => configBusy.delete(id) },
    selection: { revision: () => selectionRevision, saved(id, revision) { if (revision === selectionRevision) { selectedId = id; explicitSelection = true; } } },
    selectConnection, now, setTimer, clearTimer });
  const editor = editorView.node, closeEditor = editorView.close, paintEditor = editorView.paint;
  function apply(value, stamp) {
    if (!current() || stamp !== version) return false;
    if (value?.version !== 1 || !Array.isArray(value.connections)) throw new Error('连接数据格式不兼容。');
    data = value;
    // 首次应用先标记已到期项，确保随后绘制触发的 updateResets 不会补发旧提醒。
    reminders.seed();
    if (!explicitSelection && !array(data.connections).some(row => row.id === selectedId)) selectedId = data.connections[0]?.id || '';
    for (const id of selected) if (!data.connections.some(row => row.id === id)) selected.delete(id);
    paintCards(); archive.apply(value); paintRows(); paintSelection(); updateResets();
    if (initialDetail) { initialDetail = false; if (panelKind === 'detail') selectConnection(selectedId); }
    return true;
  }
  function load(force = false) {
    if (!current()) return Promise.resolve();
    if (!force && listFlight) return listFlight;
    const stamp = ++version;
    message('正在读取本地连接和缓存…'); node.setAttribute('aria-busy', 'true');
    const pending = (async () => {
      try {
        const value = await read('/api/agent/connections');
        if (!apply(value, stamp)) return false;
        message(`已读取 ${data.connections.length} 个来源 · 本地配置与额度缓存，未查询服务商。`); return true;
      }
      catch { if (stamp === version) message('读取连接失败；已有编辑和缓存保留，请重试。', true); return false; }
      finally { if (listFlight === pending) listFlight = null; if (current() && stamp === version) node.setAttribute('aria-busy', 'false'); }
    })();
    listFlight = pending; return pending;
  }
  async function query(id = null) {
    if (!current()) return false;
    if (!id) return runBatch('refresh', array(data?.connections).filter(canQuery).map(row => row.id), false);
    if (queries.has(id)) return queries.get(id);
    const connection = array(data?.connections).find(row => row.id === id);
    if (!canQuery(connection)) { message('此连接未启用、无可用本地凭证或不支持资源查询；未访问服务商。'); return false; }
    const generation = sessionRevision, queryRevision = queryVersions.get(id) || 0;
    operationState.set(id, '刷新中…'); paintRows(); paintCards();
    const pending = (async () => {
      let ok = false;
      try {
        // query returns a whole list. Never apply these independent snapshots: concurrent
        // responses can omit siblings' newer results. Re-read the local authority at the end.
        const value = await post('agent.connections.query', { id });
        if (generation !== sessionRevision || queryRevision !== (queryVersions.get(id) || 0)) return false;
        ok = successful(value?.connections?.find(row => row.id === id)?.observation);
        operationState.set(id, ok ? '刷新完成' : '查询未取得完整数据（非零余额）');
      } catch { if (generation === sessionRevision && queryRevision === (queryVersions.get(id) || 0)) operationState.set(id, '查询失败；旧值仅供参考（非零余额）'); }
      finally {
        queries.delete(id);
        if (current() && generation === sessionRevision) { await load(true); message(ok ? '资源查询完成；数值只代表观测时刻。' : '资源查询失败或未知；旧值仅供参考，不代表耗尽。', !ok); }
        else if (current()) { operationState.delete(id); paintRows(); paintCards(); paintSelection(); }
      }
      return ok;
    })();
    queries.set(id, pending); paintRows(); paintCards(); return pending;
  }
  async function runBatch(kind, ids = [...selected], confirm = true) {
    if (!current() || batchBusy || !ids.length) return;
    const generation = sessionRevision;
    const targets = ids.map(id => array(data?.connections).find(row => row.id === id)).filter(Boolean);
    if (confirm && !await confirmDialog({ title: kind === 'refresh' ? '批量刷新资源？' : kind === 'enable' ? '批量启用连接？' : '批量停用连接？',
      message: `仅处理以下 ${targets.length} 个连接：`, detail: targets.map(row => `${row.label} · ${row.provider} · ${row.endpoint} · ${row.id}`).join('\n')
        + (kind === 'enable' ? '\n启用保存后，有凭证且支持查询的连接会自动联网刷新资源；不调用模型，查询失败不撤销启用成功。' : ''),
      confirmLabel: '确认执行', confirmHelp: '逐项执行并显示成功或失败；保留全部其他公开设置，不批量更换凭证或删除连接。' })) return;
    if (!current() || generation !== sessionRevision || batchBusy) return;
    if (kind !== 'refresh' && targets.some(row => configBusy.has(row.id))) { message('所选连接正在保存配置，请待保存结束后重试；未批量写入。', true); return; }
    batchBusy = true;
    if (kind !== 'refresh') for (const row of targets) configBusy.add(row.id);
    paintRows(); let index = 0;
    async function work() {
      while (index < targets.length && current() && generation === sessionRevision) {
        const row = targets[index++];
        if (kind === 'refresh') {
          if (canQuery(row)) await query(row.id);
          else operationState.set(row.id, '跳过：未启用 / 无凭证 / 不支持查询');
        } else {
          queryVersions.set(row.id, (queryVersions.get(row.id) || 0) + 1);
          operationState.set(row.id, '配置保存中…'); paintRows();
          try {
            // Always send the complete public config; do not reset defaults, models or auth.
            await post('agent.connections.save', { connection: { ...publicConfig(row), enabled: kind === 'enable' } });
            operationState.set(row.id, kind === 'enable' ? '启用成功' : '停用成功');
            if (kind === 'enable' && current() && generation === sessionRevision) {
              await load(true); const refreshed = await autoRefresh(row.id);
              operationState.set(row.id, refreshed === false ? '启用成功；自动查询失败或未知（非零余额）' : refreshed === true ? '启用成功，资源已刷新' : '启用成功；无自动查询');
            }
          } catch { operationState.set(row.id, '配置保存失败；请核对本地状态'); }
        }
        if (current() && generation === sessionRevision) paintRows();
      }
    }
    try { await Promise.all(Array.from({ length: Math.min(3, targets.length) }, work)); }
    finally {
      for (const row of targets) configBusy.delete(row.id);
      batchBusy = false;
      if (current() && generation === sessionRevision) {
        const read = await load(true); paintRows();
        message(read ? '批量操作结束；逐项结果见各行，本地状态已重新读取。' : '批量操作结束，但本地重读失败；显示的配置 / 观测可能是旧值，请重新读取。', !read);
      } else if (current()) paintRows(); // Release busy controls, without applying an old page snapshot.
    }
  }
  function paintSelection() {
    const found = array(data?.connections).some(row => row.id === selectedId);
    selectionFeedback.textContent = found ? '' : selectedId ? '所选来源不存在或已删除；请选择其他来源。' : '选择来源查看详情，或添加一个模型来源。';
    for (const card of cards.children) card.hidden = card.dataset.connectionId !== selectedId;
    node.dataset.sourcePanel = panelKind;
    for (const row of sourceRows.children) {
      if (!row.dataset.sourceId) continue;
      const active = panelKind === 'detail' && row.dataset.sourceId === selectedId;
      row.classList.toggle('selected', active); row.setAttribute('aria-current', active ? 'true' : 'false');
      row.querySelector('.model-source-details-toggle')?.setAttribute('aria-expanded', active ? 'true' : 'false');
    }
    if (panelKind === 'detail') {
      const rows = [...sourceRows.children], index = rows.findIndex(row => row.dataset.sourceId === selectedId);
      const next = index >= 0 ? rows[index + 1] || null : null;
      if (next !== detailPane && !(next === null && rows.at(-1) === detailPane)) sourceRows.insertBefore(detailPane, next);
    } else if (detailPane.parentNode !== layout) layout.insertBefore(detailPane, null);
  }
  function selectConnection(id) {
    if (!current()) return false;
    closeEditor();
    if (id !== selectedId) {
      selectionRevision++;
      archive.invalidateHistory(true);
    }
    selectedId = id; explicitSelection = true; openPanel('detail'); paintSelection();
    // Read-only detail expands immediately below the selected source on all screen widths.
    {
      const card = [...cards.children].find(row => row.dataset.connectionId === id);
      const heading = card?.querySelector('h3');
      const target = heading || selectionFeedback;
      target.tabIndex = -1; target.focus();
    }
    return array(data?.connections).some(row => row.id === id);
  }
  function paintRows() {
    const focused = document.activeElement;
    let focusId = '';
    for (let parent = focused; parent; parent = parent.parentNode) {
      if (parent.parentNode === sourceRows) focusId = parent.dataset.sourceId;
    }
    const focusLabel = focused?.textContent, focusField = focused?.dataset?.connectionField;
    const term = searchControl.applied.toLocaleLowerCase();
    const all = array(data?.connections);
    filtered = all.filter(row => (!providerFilter.value || row.provider === providerFilter.value)
      && (!enabledFilter.value || Boolean(row.enabled) === (enabledFilter.value === 'enabled'))
      && (!stateFilter.value || (stateFilter.value === 'attention' ? attention(row) : row.credential?.status === stateFilter.value || row.observation?.status === stateFilter.value))
      && (!term || [row.label, row.provider, PROVIDERS.find(([id]) => id === row.provider)?.[1], row.endpoint, ...array(row.models), row.default_model].join(' ').toLocaleLowerCase().includes(term)));
    sourceRows.replaceChildren(...filtered.map(connection => renderConnectionRow(connection, {
      selected: selected.has(connection.id), refreshing: queries.has(connection.id), operation: operationState.get(connection.id), now,
      onSelect(checked) { checked ? selected.add(connection.id) : selected.delete(connection.id); updateBatchControls(); },
      onQuery: () => query(connection.id), onDetail() {
        if (panelKind === 'detail' && selectedId === connection.id && !detailPane.hidden) back.onclick();
        else selectConnection(connection.id);
      } })));
    statistics.textContent = `总数 ${all.length} · 启用 ${all.filter(row => row.enabled).length} · 需处理 ${all.filter(attention).length}${projectHistory ? ` · 本项目使用中 ${all.filter(row => array(row.consumers).length).length}` : ''}`;
    listFeedback.textContent = `显示 ${filtered.length} / ${all.length} 个来源${filtered.length ? '' : '；暂无匹配来源'}`;
    batchFeedback.replaceChildren(...all.filter(row => selected.has(row.id) && operationState.has(row.id)).map(row => el('p', `${row.label}：${operationState.get(row.id)}`, 'hint')));
    updateBatchControls(); paintSelection(); updateResets();
    if (focusId) {
      const row = [...sourceRows.children].find(row => row.dataset.sourceId === focusId);
      const control = focusField ? row?.querySelector(`[data-connection-field="${focusField}"]`)
        : [...(row?.querySelectorAll('button') || [])].find(control => control.textContent === focusLabel);
      if (control && !control.disabled) control.focus();
      else if (row) { row.tabIndex = -1; row.focus(); }
    }
  }
  function updateBatchControls() {
    selectionCount.textContent = `已选 ${selected.size} 个连接`;
    for (const control of batchToolbar.querySelectorAll('button')) if (control.dataset.batchAction) control.disabled = batchBusy || !selected.size;
  }
  batchToolbar.append(selectionCount, button('选择当前筛选结果', () => { for (const row of filtered) selected.add(row.id); paintRows(); }, 'ghost'),
    button('清空选择', () => { selected.clear(); paintRows(); }, 'ghost'));
  for (const [kind, label] of [['refresh', '批量刷新'], ['enable', '批量启用'], ['disable', '批量停用']]) {
    const control = helped(label, () => runBatch(kind), kind === 'refresh' ? null : '先确认连接范围，再逐项保存启用状态；不更换秘密、不删除，保留端点、模型和默认设定。');
    control.children[0].dataset.batchAction = kind; batchToolbar.append(control);
  }
  providerFilter.onchange = enabledFilter.onchange = stateFilter.onchange = paintRows;
  function paintCards() {
    const nodes = [];
    for (const connection of array(data?.connections)) {
      const actions = el('div', undefined, 'agent-connection-actions');
      const refresh = helped('刷新此连接', () => query(connection.id),
        !canQuery(connection) ? '此来源未启用、缺少本地凭证或不支持额度查询；请检查连接配置。' : null);
      refresh.children[0].disabled = !canQuery(connection) || queries.has(connection.id); actions.append(refresh);
      note(actions, operationState.get(connection.id) || '');
      actions.append(button('编辑', () => { if (current()) paintEditor(connection); }, 'ghost'));
      if (projectHistory) actions.append(button('查看历史', () => { selectConnection(connection.id); openPanel('history'); return archive.showHistory(connection.id); }, 'ghost'));
      if (connection.auth_type === 'oauth') actions.append(
        helped('登录 / 重新登录', () => editorView.beginDeviceLogin(connection), '显示设备码和 OpenAI 官方授权链接，自动检查授权并保存设备登录；不改外部客户端凭证，不调用 Agent 或模型。'),
        helped('备用：回调 URL 登录', () => editorView.beginLogin(connection), '设备码不可用时可显式使用浏览器回调登录，需要手动粘贴回调 URL；不自动切换，不调用 Agent 或模型。'));
      actions.append(helped('删除连接', async () => {
        if (!current()) return;
        const accepted = await confirmDialog({ title: '删除账号连接？', message: `将删除“${connection.label}”在${client ? (storageScopeFor(connection.id) ? scopeLabel(storageScopeFor(connection.id)) : '未报告范围（需后台核验）的存储位置') : '本项目'}中的配置和凭证。设备来源删除会影响所有使用此来源的项目。`,
          detail: '历史观测保留；外部客户端凭证不变。已有运行中的 invocation 不会热切换账号。', confirmLabel: '删除连接', danger: true,
          confirmHelp: '删除所选作用域的连接配置及凭证；设备来源删除会影响使用它的所有项目。保留项目历史观测与外部客户端登录。' });
        if (!accepted || !current()) return;
        ++version; if (editorView.activeLoginId() === connection.id) editorView.invalidateLogin();
        try {
          await post('agent.connections.remove', { id: connection.id }); if (!current()) return;
          if (editorView.editedId() === connection.id) { paintEditor(); closeEditor(); }
          if (selectedId === connection.id) { selectedId = ''; explicitSelection = false; }
          await load(true); message('连接已删除，历史保留，可按原连接 ID 读取。');
        } catch { message('删除未完成；请重新读取本地连接确认状态。', true); }
      }, '删除设备连接和凭证，需确认；不会删除观测历史或外部客户端凭证。', 'ghost danger'));
      nodes.push(renderConnectionCard(connection, { now, projectHistory, actions }));
    }
    if (!nodes.length) nodes.push(el('p', '暂无项目账号连接。添加连接不会自动迁移或替换原 CLI 登录。', 'hint'));
    cards.replaceChildren(...nodes);
  }
  async function autoRefresh(id) {
    if (queries.has(id)) await queries.get(id);
    const connection = array(data?.connections).find(row => row.id === id);
    return current() && canQuery(connection) ? query(id) : null;
  }
  const addConnection = button('添加连接', () => { if (current()) paintEditor(null, addConnection); }, 'primary');
  toolbar.append(addConnection,
    button('刷新全部资源', () => query(), 'ghost', { busyLabel: '刷新中…' }),
    button('重新读取本地连接', () => load(true), 'ghost', { busyLabel: '读取中…' }),
    button('后台采样设置', () => { if (current()) { closeEditor(); openPanel('sampling'); archive.focusSampling(); } }, 'ghost', { help: sharedSampling ? '编辑设备采样配置，所有项目统一使用；各项目独立执行和保存历史，Host 不运行采样。' : '展开本项目全部托管来源的采样设置；开启后关页仍采样，不是某个来源单独的开关。' }),
    button('历史与已删除来源', () => { if (current()) { closeEditor(); openPanel('history'); archive.focusHistory(); } }, 'ghost', { help: '展开本地观测历史入口，可按原连接 ID 查看已删除来源的历史；不访问服务商。' }));
  if (!projectHistory) {
    for (const control of [...toolbar.querySelectorAll('button')]) if (['后台采样设置', '历史与已删除来源'].includes(control.textContent)) control.parentNode?.classList.contains('help-host') ? control.parentNode.remove() : control.remove();
  }
  intro.append(toolbar, explanation); detailPane.append(back, selectionFeedback, cards, editor, samplingHost, historyHost);
  layout.append(listPane, detailPane); node.append(feedback, layout, intro);
  // Construct the initial empty form for old callers, but keep it out of the visual/focus flow.
  const initialFocus = document.activeElement;
  paintEditor(null, null); closeEditor(); initialFocus?.focus(); detailPane.hidden = !connectionId; panelKind = connectionId ? 'detail' : '';
  cards.hidden = selectionFeedback.hidden = !connectionId;
  node.dataset.sourceView = connectionId ? 'detail' : 'list';
  let observer = null;
  function dispose() {
    sessionRevision++; version++; archive.invalidateHistory();
    editorView.invalidate(); reminders.dispose();
    observer?.disconnect(); observer = null;
    globalThis.removeEventListener?.('pagehide', dispose);
  }
  function resume() {
    reminders.resume();
    globalThis.addEventListener?.('pagehide', dispose);
    if (!observer && typeof globalThis.MutationObserver === 'function') {
      observer = new globalThis.MutationObserver(() => { if (!current()) dispose(); });
      observer.observe(document.body, { childList: true, subtree: true });
    }
    updateResets();
  }
  resume();
  return { node, load, loadHistory, selectConnection, selectedConnection: () => selectedId, dispose, resume };
}
