import { api } from './api.js';
import { button, el } from './dom.js';

const option = (value, text) => { const node = el('option', text); node.value = value; return node; };
const MODEL_ERROR = '账号连接需要启用且匹配固定 provider/model 及模型范围；请先检查连接和模型。';
const CATALOG_STATES = { fresh: '缓存目录已更新', cached: '缓存目录（可能不是最新）', unknown: '无缓存目录', error: '目录读取失败', unsupported: '该来源不支持目录同步' };

/**
 * 项目 Profile 与单 Worker 编辑器共用的后端→来源→匹配模型选择。
 *
 * 模型选项来自 Lush 缓存的连接模型目录（GET /api/agent/connections/models?id=…，只读本地、不联网刷新、不调用模型）；
 * 目录缺失或读取失败时退回已保存的模型范围，并明确说明可以手填，不默默替换用户已选来源或模型。
 * 思考等级只按目录里确有证据的元数据返回；未知一律返回 null，由调用方保留原选项。
 */
export function createAgentConnectionPicker({ backend, model, connectionId = '', ownsPage = () => true, onChange = () => {} }) {
  const node = el('div', undefined, 'agent-connection-binding');
  const connection = el('select'); connection.className = 'agent-select';
  const models = el('select'); models.className = 'model-catalog'; models.dataset.connectionModel = 'choice';
  models.setAttribute('aria-label', '连接内的模型');
  const note = el('span', undefined, 'settings-note');
  const detailsLink = el('a', '管理模型来源', 'agent-sources-link'); detailsLink.href = '#model-sources';
  const entries = new Map();
  // 只保存已读取的目录缓存；不从连接列表里推断，也不在打开表单时联网刷新。
  const catalogs = new Map();
  const catalogPending = new Map();
  let loading = null;
  const value = () => backend.value === 'pi' ? connection.value : '';
  const entry = () => entries.get(value());
  const catalog = () => catalogs.get(value()) || null;
  function catalogModels(row) {
    const cached = catalogs.get(row?.id);
    if (cached?.status === 'fresh' || cached?.status === 'cached') return Array.isArray(cached.models) ? cached.models : [];
    return null;
  }
  function paint(selected = connection.value || '') {
    connection.replaceChildren(option('', '请选择 Lush 模型来源'));
    for (const row of entries.values()) {
      connection.append(option(row.id, `${row.label} · ${row.provider}${row.enabled ? '' : '（停用）'}`));
    }
    if (selected && !entries.has(selected)) connection.append(option(selected, `已配置连接 ${selected}（未读取 / 不可用）`));
    connection.value = selected; sync();
  }
  function paintModels(row) {
    const seen = new Set();
    const list = catalogModels(row);
    models.replaceChildren(option('', list ? '选择此来源缓存目录内的模型…' : '选择此连接已保存的模型…'));
    let count = 0;
    if (list) {
      // The manual `connection.models` range is the user's explicit restriction: only offer the
      // intersection, so a catalog entry outside the range can never become an invalid choice.
      const allowed = new Set(row?.models || []);
      const provider = row?.provider || '';
      for (const item of list) {
        const id = String(item?.id || '').trim(); if (!id || seen.has(id)) continue;
        if (allowed.size && provider && id.startsWith(`${provider}/`) && !allowed.has(id.slice(provider.length + 1))) continue;
        seen.add(id); count++;
        const name = String(item?.name || '').trim();
        const levels = Array.isArray(item?.thinking_levels) && item.thinking_levels.length ? ` · 思考 ${item.thinking_levels.join('/')}` : '';
        models.append(option(id, name && name !== id ? `${name} · ${id}${levels}` : `${id}${levels}`));
      }
    }
    // No usable catalog (or nothing inside the range): fall back to the saved range itself.
    if (!count) for (const id of row?.models || []) { if (seen.has(id)) continue; seen.add(id); count++; models.append(option(`${row.provider}/${id}`, id)); }
    models.value = '';
    models.hidden = !value() || count === 0;
    models.disabled = !backend.value || row?.enabled === false;
  }
  function catalogNote(row) {
    const cached = catalogs.get(row?.id);
    if (!cached) return '';
    const state = CATALOG_STATES[cached.status] || '目录状态未知';
    const at = cached.checked_at ? `，更新于 ${cached.checked_at}` : '';
    const warning = cached.warning ? ` ${cached.warning}` : '';
    const unknown = cached.status === 'fresh' || cached.status === 'cached' ? '' : '；可手填来源范围内的 provider/model。';
    return `模型目录：${state}${at}，共 ${Array.isArray(cached.models) ? cached.models.length : 0} 项${unknown}${warning}`;
  }
  function sync() {
    const pi = backend.value === 'pi', row = entry();
    connection.disabled = !pi; loadButton.disabled = !pi || !!loading;
    connection.children[0].textContent = pi ? '请选择 Lush 模型来源' : 'Codex CLI 自身认证';
    paintModels(row);
    detailsLink.href = value() ? `#model-source-${encodeURIComponent(value())}` : '#model-sources';
    detailsLink.textContent = value() ? '查看来源详情' : '管理模型来源';
    const details = catalogNote(row);
    note.textContent = !pi ? '托管连接仅支持 Pi；Codex CLI 沿用原认证，切回 Pi 后保留连接选择。'
      : !value() ? 'Pi 必须选择 Lush 模型来源与明确模型才能启动；不会回退到用户 Pi 认证或默认模型。'
      : !row ? '请读取项目连接以查看模型范围；当前连接与未保存模型保持不变。'
      : `${row.label} · ${row.endpoint}。${details || (row.models?.length ? '选择已保存模型或填写范围内的 provider/model。' : `填写 ${row.provider}/模型 ID（范围未限定）。`)}${details ? '' : '此列表未联网验证模型；'}停用或凭证不可用时不能启动。${row.provider === 'openai-compatible' ? '自定义兼容 API 的余额尚不支持查询，不代表余额为零。' : ''}`;
    if (row && model.value.trim() && (!model.value.trim().startsWith(`${row.provider}/`)
      || (row.models?.length && !row.models.includes(model.value.trim().slice(row.provider.length + 1))))) {
      note.textContent += ' 当前模型与此来源不匹配，请显式选择或填写匹配模型；不会自动替换。';
    }
    onChange();
  }
  // 目录读取只发生在用户显式选择来源时（本地缓存 GET），失败保留已保存范围；迟到结果不覆盖已换来源的页面。
  function loadCatalog(row) {
    if (!row) return undefined;
    if (catalogs.has(row.id) || catalogPending.has(row.id)) return catalogPending.get(row.id);
    const pending = (async () => {
      try {
        const data = await api(`/api/agent/connections/models?id=${encodeURIComponent(row.id)}`);
        if (data?.version === 1 && Array.isArray(data.models)) {
          catalogs.set(row.id, { status: data.status || 'cached', checked_at: data.checked_at || null, source: data.source || null,
            models: data.models, warning: data.warning || null });
        } else {
          catalogs.set(row.id, { status: 'error', checked_at: null, source: null, models: [], warning: '模型目录数据格式不兼容。' });
        }
      } catch (error) {
        catalogs.set(row.id, { status: 'error', checked_at: null, source: null, models: [],
          warning: `模型目录读取失败：${error.message}` });
      } finally { catalogPending.delete(row.id); }
      if (ownsPage()) { paintModels(entry()); sync(); }
    })();
    catalogPending.set(row.id, pending);
    return pending;
  }
  const help = '只读取当前项目的连接配置和本地模型目录缓存，不查询上游、不调用 Agent；不会覆盖当前模型或未保存的连接选择。';
  const host = el('span', undefined, 'help-host'); host.setAttribute('data-help', help);
  const loadButton = button('读取项目连接', load, 'ghost', { help }); loadButton.type = 'button'; host.append(loadButton);
  async function load() {
    if (!ownsPage()) return;
    if (loading) return loading;
    loading = (async () => {
      try {
        const data = await api('/api/agent/connections');
        if (!ownsPage()) return;
        if (data?.version !== 1 || !Array.isArray(data.connections)) throw new Error('invalid connections');
        entries.clear(); for (const row of data.connections) entries.set(row.id, row);
        paint();
        if (value()) void loadCatalog(entry());
      } catch { if (ownsPage()) note.textContent = '连接列表读取失败；当前选择保留，请到模型来源页检查。'; }
      finally { loading = null; if (ownsPage()) loadButton.disabled = backend.value !== 'pi'; }
    })();
    loadButton.disabled = true; return loading;
  }
  connection.onchange = () => { if (ownsPage()) { sync(); void loadCatalog(entry()); } };
  models.onchange = () => { if (ownsPage() && value() && models.value) { model.value = models.value; sync(); } };
  node.append(connection, host, models, detailsLink, note);
  // Initial rendering must not invoke a caller callback before it has received the picker.
  connection.append(option('', '请选择 Lush 模型来源'));
  if (connectionId) connection.append(option(connectionId, `已配置连接 ${connectionId}（未读取 / 不可用）`));
  connection.value = connectionId;
  const validate = () => {
    if (backend.value !== 'pi') return null;
    const fail = message => { note.textContent = message; return message; };
    const id = value();
    if (!id) return fail('请选择 Lush 模型来源；Pi 未选择来源时无法启动，不会回退用户 Pi 认证。');
    const row = entry(), selected = model.value.trim();
    if (!selected) return fail('请选择来源内模型；Pi 不能使用 CLI 默认模型。');
    if (!row) return fail('请先读取项目连接，确认所选来源存在且凭证可用；当前草稿保留。');
    // Expired managed Codex OAuth can be refreshed by the trusted runtime; unknown/missing keys cannot.
    const credentialReady = row.credential?.status === 'configured'
      || (row.provider === 'openai-codex' && row.auth_type === 'oauth' && row.credential?.status === 'expired');
    if (!credentialReady) return fail('所选来源凭证不可用或状态未知，请在模型来源页配置密钥或登录。');
    if (!/^[a-z][a-z0-9_-]*\/.+$/i.test(selected) || !row.enabled
      || !selected.startsWith(`${row.provider}/`) || (row.models?.length && !row.models.includes(selected.slice(row.provider.length + 1)))) {
      return fail(MODEL_ERROR);
    }
    return null;
  };
  /** 所选模型在缓存目录里声明的思考等级；没有确证元数据时返回 null（调用方保留原选项，不伪造支持）。 */
  const thinkingLevels = () => {
    const row = catalog(); if (!row) return null;
    const selected = model.value.trim();
    const item = (row.models || []).find(entry => entry?.id === selected);
    const levels = item?.thinking_levels;
    return Array.isArray(levels) && levels.length ? [...levels] : null;
  };
  return { node, connection, models, value, entry, catalog, thinkingLevels, load, sync, validate, reset(id = '') { paint(id); void loadCatalog(entries.get(id)); } };
}
