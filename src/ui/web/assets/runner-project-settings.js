import { api } from './api.js';
import { el } from './dom.js';
import { formDialog } from './dialog.js';
import { runnerButton, runnerLifetime, closeRunnerDialog, REVOCATION, UNKNOWN_WRITE } from './runner-settings-controls.js';

/** Fixed source identity, never inferred from the currently active browser project. */
export function runnerProjectClient(projectId) {
  if (typeof projectId !== 'string' || !/^[a-f0-9]{16}$/.test(projectId)) throw new Error('需要已登记的来源项目 ID');
  const base = `/p/${projectId}/api/`;
  return { read: kind => {
    if (!['nodes', 'project'].includes(kind)) throw new Error('不支持此 Runner 读请求');
    return api(`${base}runner/${kind}`);
  }, save: params => api(`${base}action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'runner.project.set', params }) }) };
}
export function renderRunnerProjectSettings(projectId, { ownsPage = () => true, client = runnerProjectClient(projectId) } = {}) {
  const life = runnerLifetime(ownsPage), root = el('section', undefined, 'runner-project-settings runner-settings');
  const message = el('p', '', 'runner-feedback'); message.setAttribute('role', 'status');
  const body = el('div'), tools = el('div', undefined, 'runner-actions');
  let policy = null, nodes = [], busy = false, blocked = false, epoch = 0, allowed = new Map(), select, confirmation = null;
  const current = life.current;
  const reload = runnerButton('重新读取项目授权', load), save = runnerButton('保存项目授权', submit, '只修改此来源项目的授权和未来 Worker 默认节点，不迁移已有 Worker。撤权不代表已停止或回收。');
  tools.append(reload.host, save.host);
  function sync() {
    reload.disable(busy); save.disable(busy || blocked || !policy, blocked ? '结果未知或版本冲突；请先重新读取项目授权。' : '请等待读取或保存完成。');
    for (const input of [...allowed.values(), select].filter(Boolean)) {
      input.disabled = busy;
      if (busy) { input.parentNode.dataset.help = '请求处理中，请等待；不会重复提交。'; input.parentNode.setAttribute('tabindex', '0'); }
      else { delete input.parentNode.dataset.help; input.parentNode.removeAttribute('tabindex'); }
    }
  }
  function status(text, error = false) { if (current()) { message.textContent = text; message.className = `runner-feedback${error ? ' error' : ''}`; } }
  async function load() {
    if (!current() || busy) return;
    const request = ++epoch; busy = true; sync();
    try {
      const [model, list] = await Promise.all([client.read('project'), client.read('nodes')]);
      if (!current() || request !== epoch) return;
      policy = model; nodes = list.nodes; blocked = false; paint(); status('已读取此来源项目的授权；设备启用不等于授权。');
    } catch { if (current() && request === epoch) { blocked = true; status('项目授权读取失败；不会启动项目后台，请显式刷新。', true); } }
    finally { if (request === epoch) { busy = false; sync(); } }
  }
  async function submit() {
    if (!current() || busy || blocked || !policy) return;
    const params = { allowed_node_ids: [...allowed].filter(([, input]) => input.checked).map(([id]) => id), default_node_id: select.value, expected_revision: policy.revision };
    if (params.default_node_id !== 'local' && params.default_node_id !== policy.default_node_id && !params.allowed_node_ids.includes(params.default_node_id)) { status('新默认节点必须已勾选授权。', true); return; }
    busy = true; sync();
    try {
      if (policy.allowed_node_ids.some(id => !params.allowed_node_ids.includes(id))) {
        confirmation = el('p', REVOCATION, 'modal-message');
        const accepted = await formDialog({ title: '撤销项目节点授权？', content: confirmation, cardClass: 'runner-dialog', confirmLabel: '确认撤权并保存', danger: true, confirmHelp: REVOCATION });
        confirmation = null;
        if (!accepted || !current()) return;
      }
      const result = await client.save(params);
      if (!current()) return;
      policy = result.policy; paint();
      status(`项目授权已保存（ACK）；${result.stop_bindings?.length || 0} 个受影响绑定摘要，不代表已停止或回收。重新读取是独立操作。`);
    } catch { if (current()) { blocked = true; status(UNKNOWN_WRITE, true); } }
    finally { busy = false; if (current()) sync(); }
  }
  function paint() {
    body.replaceChildren(); allowed = new Map();
    body.append(el('p', `项目 ID：${policy.project_id || '尚未初始化；显式保存后分配，供凭据配对使用'}`, 'runner-project-id'));
    const choices = el('fieldset', undefined, 'runner-authorizations'); choices.append(el('legend', '授权执行节点'));
    // Removed nodes remain visible so revoked defaults are not silently rewritten.
    const entries = new Map(nodes.map(node => [node.id, node]));
    for (const id of [...policy.allowed_node_ids, policy.default_node_id]) if (id !== 'local' && !entries.has(id)) entries.set(id, { id, name: id, missing: true });
    for (const node of entries.values()) {
      const label = el('label', undefined, 'runner-choice'), input = el('input'); input.type = 'checkbox'; input.checked = policy.allowed_node_ids.includes(node.id); input.dataset.runnerNode = node.id;
      const host = el('span', undefined, 'help-host'); host.append(input);
      label.append(host, el('span', `${node.name}${node.missing ? ' · 已移除登记' : node.enabled ? '' : ' · 设备禁用'}`)); choices.append(label); allowed.set(node.id, input);
    }
    const label = el('label', undefined, 'runner-field'); select = el('select'); select.setAttribute('aria-label', '项目默认执行节点'); select.dataset.runnerDefault = '';
    for (const node of [{ id: 'local', name: '本机' }, ...entries.values()]) { const option = el('option', node.name); option.value = node.id; select.append(option); }
    select.value = policy.default_node_id;
    const selectHost = el('span', undefined, 'help-host'); selectHost.append(select);
    label.append(el('span', '未来 Worker 的默认节点'), selectHost);
    body.append(choices, label, el('p', '新默认必须已授权；撤权允许保留旧默认，后续默认创建会明确失败，不会静默改投本机。已有 Worker 不迁移。', 'hint'));
    const defaultNode = entries.get(policy.default_node_id);
    if (policy.default_node_id !== 'local' && (!policy.allowed_node_ids.includes(policy.default_node_id) || !defaultNode?.enabled || defaultNode?.missing)) body.append(el('p', '当前默认节点未授权、已禁用或已移除；后续默认创建可能被阻止，不会自动回退本机。', 'error runner-warning'));
  }
  root.append(el('h3', '项目执行节点'), el('p', `来源项目：${projectId}`, 'hint'), message, body, tools);
  const ready = load();
  return { root, ready, reload: load, dispose() { life.dispose(); ++epoch; closeRunnerDialog(confirmation); } };
}
