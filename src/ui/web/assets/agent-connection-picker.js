import { api } from './api.js';
import { button, el } from './dom.js';

const option = (value, text) => { const node = el('option', text); node.value = value; return node; };
const MODEL_ERROR = '账号连接需要启用且匹配固定 provider/model 及模型范围；请先检查连接和模型。';

/** Local managed connections shared by project and Worker profile editors. Loading never selects a model. */
export function createAgentConnectionPicker({ backend, model, connectionId = '', ownsPage = () => true, onChange = () => {} }) {
  const node = el('div', undefined, 'agent-connection-binding');
  const connection = el('select'); connection.className = 'agent-select';
  const models = el('select'); models.className = 'model-catalog'; models.dataset.connectionModel = 'choice';
  models.setAttribute('aria-label', '连接内的模型');
  const note = el('span', undefined, 'settings-note');
  const entries = new Map(); let loading = null;
  const value = () => backend.value === 'pi' ? connection.value : '';
  const entry = () => entries.get(value());
  function paint(selected = connection.value || '') {
    connection.replaceChildren(option('', '原 CLI 认证（不绑定项目连接）'));
    for (const row of entries.values()) {
      connection.append(option(row.id, `${row.label} · ${row.provider}${row.enabled ? '' : '（停用）'}`));
    }
    if (selected && !entries.has(selected)) connection.append(option(selected, `已配置连接 ${selected}（未读取 / 不可用）`));
    connection.value = selected; sync();
  }
  function sync() {
    const pi = backend.value === 'pi', row = entry();
    connection.disabled = !pi; loadButton.disabled = !pi || !!loading;
    models.replaceChildren(option('', '选择此连接已保存的模型…'));
    for (const id of row?.models || []) models.append(option(`${row.provider}/${id}`, id));
    models.value = ''; models.hidden = !value() || !row?.models?.length;
    models.disabled = !pi || row?.enabled === false;
    note.textContent = !pi ? '托管连接仅支持 Pi；Codex CLI 沿用原认证，切回 Pi 后保留连接选择。'
      : !value() ? '未绑定连接时保持原 Agent / CLI 模型与认证方式；不自动切换账号。'
      : !row ? '请读取项目连接以查看模型范围；当前连接与未保存模型保持不变。'
      : `${row.label} · ${row.endpoint}。${row.models?.length ? '选择已保存模型或填写范围内的 provider/model。' : `填写 ${row.provider}/模型 ID（范围未限定）。`}此列表未联网验证模型；停用或凭证不可用时不能启动。${row.provider === 'openai-compatible' ? '自定义兼容 API 的余额尚不支持查询，不代表余额为零。' : ''}`;
    onChange();
  }
  const help = '只读取当前项目的连接配置和本地凭证状态，不查询上游、不调用 Agent；不会覆盖当前模型或未保存的连接选择。';
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
      } catch { if (ownsPage()) note.textContent = '连接列表读取失败；当前选择保留，请到账号连接页检查。'; }
      finally { loading = null; if (ownsPage()) loadButton.disabled = backend.value !== 'pi'; }
    })();
    loadButton.disabled = true; return loading;
  }
  connection.onchange = () => { if (ownsPage()) sync(); };
  models.onchange = () => { if (ownsPage() && value() && models.value) model.value = models.value; };
  node.append(connection, host, models, note);
  // Initial rendering must not invoke a caller callback before it has received the picker.
  connection.append(option('', '原 CLI 认证（不绑定项目连接）'));
  if (connectionId) connection.append(option(connectionId, `已配置连接 ${connectionId}（未读取 / 不可用）`));
  connection.value = connectionId;
  const validate = () => {
    const id = value(); if (!id) return null;
    const row = entry(), selected = model.value.trim();
    if (!/^[a-z][a-z0-9_-]*\/.+$/i.test(selected) || (row && (!row.enabled || row.credential?.status === 'unconfigured'
      || !selected.startsWith(`${row.provider}/`) || (row.models?.length && !row.models.includes(selected.slice(row.provider.length + 1)))))) {
      note.textContent = MODEL_ERROR; return MODEL_ERROR;
    }
    return null;
  };
  return { node, connection, models, value, entry, load, sync, validate,
    reset(id = '') { paint(id); } };
}
