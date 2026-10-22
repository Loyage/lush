import { api } from './api.js';
import { button, el } from './dom.js';
import { createModelChoice } from './model-choice.js';

const option = (value, text) => { const node = el('option', text); node.value = value; return node; };
export const registeredModelReason = row => ({ source_missing: '来源已删除', source_disabled: '来源已停用',
  credential_unconfigured: '请先配置凭证或登录', source_unsupported: '来源不支持', provider_mismatch: '服务商不匹配',
  model_out_of_scope: '模型不在来源范围内' })[row?.reason] || (row?.selectable === false ? '当前不可选' : '');
const sameBinding = (row, id, model) => row?.connection_id === id && row?.model === model;

/** One shared Pi registered-model selector. Profiles still store concrete connection_id + model.
 * Reads never resolve a selected name again: only a deliberate choice copies the displayed binding.
 * The hidden connection/model controls preserve the existing form collection API and legacy values.
 * Codex keeps its own editable CLI model and authentication; no directory/model probes here.
 */
export function createAgentConnectionPicker({ backend, model, connectionId = '', ownsPage = () => true,
  onChange = () => {}, read = api }) {
  const node = el('fieldset', undefined, 'agent-connection-binding');
  node.append(el('legend', '模型'));
  const connection = el('select'); connection.hidden = true;
  const models = el('select'); models.className = 'model-catalog'; models.dataset.registeredModel = 'choice';
  const registeredField = el('label', undefined, 'model-choice-field');
  registeredField.append(el('span', '已注册模型', 'model-choice-label'), models);
  const candidates = el('select'); candidates.className = 'model-catalog';
  const choice = createModelChoice({ model, candidates });
  const binding = el('div', undefined, 'registered-model-binding'); binding.dataset.registeredBinding = '';
  const modelExtras = el('div', undefined, 'model-choice-extras');
  const actions = el('div', undefined, 'model-source-actions');
  const note = el('span', undefined, 'settings-note'); note.setAttribute('role', 'status');
  const detailsLink = el('a', '管理模型和来源', 'nav-link agent-sources-link'); detailsLink.href = '/#model-sources';
  if (globalThis.location?.pathname?.startsWith('/p/')) { detailsLink.target = '_blank'; detailsLink.rel = 'noopener'; }
  let entries = new Map(), sources = new Map(), loading = null, loaded = false, selected = null, cliModels = [];
  let selectedConnection = connectionId;
  const value = () => backend.value === 'pi' ? selectedConnection : '';
  const entry = () => sources.get(value());
  const setConnection = id => { selectedConnection = id; connection.replaceChildren(option(id, id)); connection.value = id; };
  setConnection(connectionId);
  function paintModels() {
    const pi = backend.value === 'pi';
    registeredField.hidden = binding.hidden = !pi; choice.node.hidden = pi;
    model.readOnly = pi;
    const current = model.value.trim(), id = value();
    // Match by concrete value for an initial/legacy profile, never by name or provider alone.
    if (!selected) selected = [...entries.values()].find(row => sameBinding(row, id, current)) || null;
    const live = selected && entries.get(selected.id);
    const exact = live && sameBinding(live, id, current);
    models.replaceChildren(option('', id && current ? selected && !exact
      ? '当前固定配置（登记已变更或删除）' : '未注册当前配置' : '请选择已注册模型'));
    for (const row of entries.values()) {
      const reason = registeredModelReason(row);
      const item = option(row.id, `${row.name}${reason ? `（${reason}）` : ''}`); item.disabled = row.selectable !== true; models.append(item);
    }
    models.value = exact ? live.id : '';
    models.disabled = !entries.size;
    const source = entry();
    binding.replaceChildren(el('div', `来源：${source?.label || selected?.source?.label || id || '未选择'}`),
      el('div', `具体模型：${current || '未选择'}`));
    note.textContent = !pi ? 'Codex CLI 沿用自身认证，模型可手动填写；不使用模型登记。'
      : selected && !exact ? '当前具体绑定与登记不一致（已修改或删除）；仍保留当前配置，只有显式重新选择才采用新绑定。'
      : id && current && !exact ? '未注册当前配置：可原样保存，或到“模型和来源”显式注册；不会自动导入或选择第一项。'
      : exact && registeredModelReason(live) ? `${registeredModelReason(live)}；已有具体绑定保留，请到来源页处理。`
      : loaded && !entries.size ? '尚无已注册模型。请先添加来源并登录，再注册模型。'
      : '选择时固定来源与具体模型；登记后续修改或删除不会追改本配置。思考深度独立设置。';
    loadButton.disabled = !!loading;
  }
  function sync() { paintModels(); onChange(); }
  const loadButton = button('读取已注册模型', load, 'ghost', { help: '只读设备登记与本地来源；不联网、不调用模型、不替换当前具体绑定或未保存编辑。' });
  loadButton.type = 'button'; actions.append(loadButton, detailsLink);
  async function load() {
    if (!ownsPage()) return;
    if (loading) return loading;
    loading = (async () => {
      try {
        const [data, connections] = await Promise.all([read('/api/agent/registered-models'), read('/api/agent/connections')]);
        if (!ownsPage()) return;
        if (data?.version !== 1 || !Array.isArray(data.models) || !Array.isArray(connections?.connections)) throw new Error('模型登记数据格式不兼容');
        entries = new Map(data.models.map(row => [row.id, row])); sources = new Map(connections.connections.map(row => [row.id, row])); loaded = true;
        sync();
      } catch (error) { if (ownsPage()) note.textContent = `读取失败：${error.message}；当前具体绑定保留，可重试。`; }
      finally { loading = null; if (ownsPage()) loadButton.disabled = false; }
    })();
    loadButton.disabled = true; return loading;
  }
  models.onchange = () => {
    if (!ownsPage() || backend.value !== 'pi') return;
    const row = entries.get(models.value);
    if (!row || row.selectable !== true) { sync(); return; }
    selected = { ...row }; setConnection(row.connection_id); model.value = row.model; sync();
  };
  candidates.onchange = () => { if (ownsPage() && backend.value !== 'pi' && candidates.value) { model.value = candidates.value; choice.sync(); onChange(); } };
  model.addEventListener('input', () => { if (ownsPage()) { choice.sync(); sync(); } });
  node.append(connection, registeredField, binding, choice.node, modelExtras, actions, note);
  paintModels();
  return { node, connection, models, actions, modelExtras,
    setCliModels(items) {
      cliModels = items;
      candidates.replaceChildren(option('', cliModels.length ? '选择 CLI 模型或直接输入…' : '可直接输入，留空使用 CLI 默认'),
        ...cliModels.map(item => option(item.id, item.label || item.id)));
      candidates.disabled = !cliModels.length; choice.sync();
    },
    value, entry, catalog: () => null, thinkingLevels: () => null, load, sync,
    validate() {
      if (backend.value !== 'pi') return null;
      if (!value() || !model.value.trim()) return '请选择已注册模型；Pi 不会回退到用户认证或默认模型。';
      // Registration is an index, not a new runtime constraint. Preserve legacy/frozen bindings;
      // the existing configure/runtime boundary still validates the actual source and model.
      return null;
    },
    reset(id = '') { selected = null; setConnection(id); sync(); },
  };
}
