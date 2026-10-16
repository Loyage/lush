import { test, expect } from 'bun:test';
import { installDom, deepText, dialogText } from '../dom-stub.js';
import { renderRunnerSettings } from '../../src/ui/web/assets/runner-settings.js';
import { renderRunnerProjectSettings, runnerProjectClient } from '../../src/ui/web/assets/runner-project-settings.js';
import { settingsClient } from '../../src/ui/web/assets/settings-api.js';
import { openSettings } from '../../src/ui/web/assets/render-settings.js';
import { openProjectManager } from '../../src/ui/web/assets/project-picker.js';
import { activateDetailView } from '../../src/ui/web/assets/sidebar-ui.js';
import { ui } from '../../src/ui/web/assets/state.js';
import { makeWorld } from './dom-world.js';
const ID = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222', SOURCE = 'aaaaaaaaaaaaaaaa';
const button = (root, label) => root.querySelectorAll('button').find(node => node.textContent === label);
const field = (root, key) => root.querySelector(`[data-runner-field="${key}"]`);
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) }; };
function fixture({ withCredentials = false, initialNodes = true } = {}) {
  const world = makeWorld(), calls = [], writes = [], node = { id: ID, name: '远端节点', ssh_alias: 'fixture', enabled: true, expected_runner_id: null, budgets: { max_commands: 1, timeout_ms: 1000, output_bytes: 4096 } };
  let revision = 1, intercept;
  const state = { nodes: { version: 1, revision: '1'.repeat(64), nodes: initialNodes ? [node] : [] }, credentials: { version: 1, revision: 'absent', nodes: withCredentials ? [{ node_id: ID, machine_configured: true, projects: [{ project_id: 'paired', control_configured: true }] }] : [] }, policy: { version: 1, revision: 0, project_id: null, allowed_node_ids: [], default_node_id: 'local' } };
  const response = (value, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(value) });
  const dom = installDom({ fetch: async (url, options = {}) => {
    const path = String(url), body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path, body }); if (body) writes.push(body);
    const custom = intercept?.(path, body); if (custom) return custom;
    if (path === '/api/host/projects') return response({ projects: [{ id: SOURCE, name: '来源 A', running: true }] });
    if (path.includes('/runner/nodes')) return response(state.nodes);
    if (path.includes('/runner/credentials')) return response(state.credentials);
    if (path.includes('/runner/project')) return response(state.policy);
    if (body?.method.startsWith('runner.')) {
      const { method, params: p } = body;
      if (method === 'runner.nodes.set') {
        if (p.expected_revision !== state.nodes.revision) return response({ error: 'revision conflict' }, 400);
        state.nodes = { ...state.nodes, revision: String(++revision).repeat(64), nodes: p.nodes.map(row => ({ ...row, id: row.id || OTHER, expected_runner_id: row.expected_runner_id || null })) }; return response(state.nodes);
      }
      if (method === 'runner.credentials.set') { state.credentials = { version: 1, revision: OTHER, nodes: [{ node_id: p.node_id, machine_configured: Boolean(p.machine_token), projects: p.project_id ? [{ project_id: p.project_id, control_configured: true }] : [] }] }; return response(state.credentials); }
      if (method === 'runner.credentials.remove') { state.credentials = { ...state.credentials, revision: ID, nodes: [] }; return response(state.credentials); }
      if (method === 'runner.nodes.check') return response({ node_id: ID, runner_id: 'installation', checked_at: '2026-10-15T17:00:00Z', pinned: false, limits: { output_bytes: 4096 }, capabilities: [] });
      if (method === 'runner.project.set') {
        if (p.expected_revision !== state.policy.revision) return response({ error: 'revision conflict' }, 400);
        state.policy = { ...state.policy, ...p, project_id: 'paired', revision: state.policy.revision + 1 }; delete state.policy.expected_revision;
        return response({ policy: state.policy, stop_bindings: [] });
      }
    }
    return world.fetchImpl(path, options);
  } });
  const editor = renderRunnerSettings(); dom.node('detail').append(editor.root);
  return { dom, editor, state, calls, writes, response, intercept(fn) { intercept = fn; }, async close() { editor.dispose(); ui.clearSettingsSecrets?.(); dom.restore(); } };
}

test('device node CRUD sends complete snapshots/revisions, centrally allocates IDs, preserves fixed alias/pin, confirms removal risk', async () => {
  const f = fixture(); const { dom, editor } = f;
  try {
    await editor.ready;
    expect(f.writes).toHaveLength(0);
    const edit = button(editor.root, '编辑节点').onclick();
    expect(field(dom.node('modal'), 'ssh_alias').readOnly).toBe(true);
    expect(field(dom.node('modal'), 'expected_runner_id')).toBeNull();
    field(dom.node('modal'), 'enabled').checked = false;
    expect(dialogText(dom)).toContain('不代表进程已停止');
    await button(dom.node('modal'), '保存节点').onclick(); await edit;
    expect(f.writes[0].params.expected_revision).toBe('1'.repeat(64)); expect(f.state.nodes.nodes[0].enabled).toBe(false);
    const add = button(editor.root, '新增执行节点').onclick();
    field(dom.node('modal'), 'name').value = '新节点'; field(dom.node('modal'), 'ssh_alias').value = 'new-node';
    await button(dom.node('modal'), '保存节点').onclick(); await add;
    expect(f.writes[1].params.nodes).toHaveLength(2); expect(f.writes[1].params.nodes[1].id).toBeUndefined();
    expect(f.writes[1].params.nodes[0].id).toBe(ID);
    const removing = button(editor.root, '删除节点').onclick(); expect(dialogText(dom)).toContain('不会迁移');
    await button(dom.node('modal'), '取消').onclick(); await removing; expect(f.writes).toHaveLength(2);
    const confirmed = button(editor.root, '删除节点').onclick(); await button(dom.node('modal'), '确认').onclick(); await confirmed;
    expect(f.state.nodes.nodes.map(row => row.id)).toEqual([OTHER]);
    expect(f.calls.filter(row => row.body).every(row => row.path === '/api/host/settings/action')).toBe(true);
  } finally { await f.close(); }
});

test('check requires paired credentials/project, is non-model explicit action, shows cached identity/time/limits and never pins implicitly', async () => {
  const f = fixture({ withCredentials: true }); const { dom, editor } = f;
  try {
    await editor.ready; const check = button(editor.root, '检查连接');
    expect(check.classList.contains('agent-call')).toBe(false); expect(check.dataset.help).toContain('不调用模型');
    const checking = check.onclick(); field(dom.node('modal'), 'check_project_id').value = 'wrong';
    await button(dom.node('modal'), '检查连接').onclick(); expect(f.writes).toHaveLength(0);
    field(dom.node('modal'), 'check_project_id').value = 'paired'; await button(dom.node('modal'), '检查连接').onclick(); await checking;
    expect(f.writes.map(row => row.method)).toEqual(['runner.nodes.check']); expect(f.state.nodes.nodes[0].expected_runner_id).toBeNull();
    expect(deepText(editor.root)).toContain('installation'); expect(deepText(editor.root)).toContain('2026-10-15T17:00:00Z'); expect(deepText(editor.root)).toContain('output_bytes');
    const pin = button(editor.root, '保存安装身份 pin').onclick(); expect(dialogText(dom)).toContain('不可修改');
    await button(dom.node('modal'), '确认').onclick(); await pin;
    expect(f.state.nodes.nodes[0].expected_runner_id).toBe('installation'); expect(button(editor.root, '保存安装身份 pin')).toBeUndefined();
  } finally { await f.close(); }
});

test('credential submission secrets never enter public state/URL and clear on cancel, navigation, ACK and unknown failure; no blind replay', async () => {
  const f = fixture(); const { dom, editor } = f; const secret = 'sensitive-fixture-value';
  try {
    await editor.ready;
    let pending = button(editor.root, '配置凭据').onclick(), input = field(dom.node('modal'), 'machine_token');
    expect(input.type).toBe('password'); input.value = secret;
    await button(dom.node('modal'), '取消').onclick(); await pending; expect(input.value).toBe(''); expect(f.writes).toHaveLength(0);
    pending = button(editor.root, '配置凭据').onclick(); input = field(dom.node('modal'), 'machine_token'); input.value = secret;
    const wait = deferred(); f.intercept((path, body) => body?.method === 'runner.credentials.set' ? wait.promise : null);
    const send = button(dom.node('modal'), '提交凭据').onclick(); expect(input.value).toBe('');
    await button(dom.node('modal'), '提交凭据').onclick(); expect(f.writes).toHaveLength(1);
    wait.resolve(f.response({ error: secret }, 400)); await send;
    expect(dialogText(dom)).not.toContain(secret); expect(dialogText(dom)).toContain('密码框已清空');
    expect(button(dom.node('modal'), '提交凭据').disabled).toBe(true);
    expect(deepText(editor.root)).not.toContain(secret); expect(JSON.stringify(ui)).not.toContain(secret);
    expect(f.calls.every(call => !call.path.includes(secret))).toBe(true);
    await button(dom.node('modal'), '取消').onclick(); await pending;
    expect(button(editor.root, '新增执行节点').disabled).toBe(true);
    expect(button(editor.root, '新增执行节点').parentNode.className).toBe('help-host');
    f.intercept(null); await editor.reload();
    pending = button(editor.root, '配置凭据').onclick(); input = field(dom.node('modal'), 'machine_token'); input.value = secret;
    editor.dispose(); await pending; expect(input.value).toBe(''); expect(dom.node('modal').hidden).toBe(true);
  } finally { await f.close(); }
});

test('credential deletion requires risk confirmation and sends credential revision, never ordinary node revision', async () => {
  const f = fixture({ withCredentials: true });
  try {
    await f.editor.ready;
    const deleting = button(f.editor.root, '删除项目凭据').onclick(); expect(dialogText(f.dom)).toContain('未知状态');
    await button(f.dom.node('modal'), '确认').onclick(); await deleting;
    expect(f.writes[0]).toEqual({ method: 'runner.credentials.remove', params: { node_id: ID, project_id: 'paired', expected_revision: 'absent' } });
  } finally { await f.close(); }
});

test('ACK is independent of refresh; revision conflict blocks writes until explicit reread and never retries', async () => {
  const f = fixture();
  try {
    await f.editor.ready; const readCount = f.calls.length;
    let editing = button(f.editor.root, '编辑节点').onclick(); field(f.dom.node('modal'), 'name').value = 'ACK name';
    await button(f.dom.node('modal'), '保存节点').onclick(); await editing;
    expect(f.calls.length).toBe(readCount + 1); expect(deepText(f.editor.root)).toContain('ACK');
    f.state.nodes.revision = '9'.repeat(64);
    editing = button(f.editor.root, '编辑节点').onclick(); field(f.dom.node('modal'), 'name').value = 'conflicting';
    await button(f.dom.node('modal'), '保存节点').onclick(); expect(dialogText(f.dom)).toContain('先重新读取');
    await button(f.dom.node('modal'), '取消').onclick(); await editing;
    expect(f.writes).toHaveLength(2); expect(f.state.nodes.nodes[0].name).toBe('ACK name');
    await button(f.editor.root, '新增执行节点').onclick(); expect(f.writes).toHaveLength(2);
    f.intercept((path, body) => !body && path.includes('/runner/') ? f.response({ error: 'offline' }, 503) : null);
    await f.editor.reload(); expect(deepText(f.editor.root)).toContain('ACK name'); expect(deepText(f.editor.root)).toContain('读取失败'); expect(f.writes).toHaveLength(2);
    f.intercept(null); await f.editor.reload(); expect(button(f.editor.root, '新增执行节点').disabled).toBe(false);
  } finally { await f.close(); }
});

test('disposed reads and delayed mutation ACK cannot repaint replacement page or clear replacement credentials', async () => {
  const f = fixture(); let replacement;
  try {
    await f.editor.ready;
    const wait = deferred(); f.intercept((path, body) => body?.method === 'runner.credentials.set' ? wait.promise : null);
    const editing = button(f.editor.root, '配置凭据').onclick(); field(f.dom.node('modal'), 'machine_token').value = 'old-secret';
    const posting = button(f.dom.node('modal'), '提交凭据').onclick(); f.editor.dispose(); await editing;
    replacement = renderRunnerSettings(); f.dom.node('detail').replaceChildren(replacement.root); await replacement.ready;
    const newEditing = button(replacement.root, '配置凭据').onclick(); const next = field(f.dom.node('modal'), 'machine_token'); next.value = 'new-secret';
    wait.resolve(f.response({ revision: OTHER, nodes: [] })); await posting;
    f.editor.dispose(); // Repeated old cleanup must not dismiss a replacement dialog.
    expect(next.value).toBe('new-secret'); expect(f.dom.node('modal').hidden).toBe(false);
    await button(f.dom.node('modal'), '取消').onclick(); await newEditing;
    const read = deferred(); f.intercept((path, body) => !body && path.includes('/runner/') ? read.promise : null);
    const loading = replacement.reload(); replacement.dispose(); f.dom.node('detail').replaceChildren();
    read.resolve(f.response(f.state.nodes)); await loading; expect(f.dom.node('detail').children).toHaveLength(0);
  } finally { replacement?.dispose(); await f.close(); }
});

test('project policy stays bound to source, validates new defaults, allows revoked old default, confirms risk and separates ACK/read', async () => {
  const f = fixture(); let editor;
  try {
    await f.editor.ready; editor = renderRunnerProjectSettings(SOURCE); f.dom.node('detail').append(editor.root); await editor.ready;
    f.dom.location.pathname = '/p/bbbbbbbbbbbbbbbb/';
    editor.root.querySelector('select').value = ID; await button(editor.root, '保存项目授权').onclick(); expect(f.writes).toHaveLength(0); expect(deepText(editor.root)).toContain('必须已勾选授权');
    editor.root.querySelector('input').checked = true;
    await button(editor.root, '保存项目授权').onclick(); expect(f.state.policy.default_node_id).toBe(ID);
    const callCount = f.calls.length;
    editor.root.querySelector('input').checked = false;
    const revoking = button(editor.root, '保存项目授权').onclick(); expect(dialogText(f.dom)).toContain('不代表进程已停止');
    await button(f.dom.node('modal'), '确认撤权并保存').onclick(); await revoking;
    expect(f.state.policy.default_node_id).toBe(ID); expect(f.state.policy.allowed_node_ids).toEqual([]);
    expect(f.calls.length).toBe(callCount + 1); expect(deepText(editor.root)).toContain('不会自动回退本机');
    expect(f.writes.every(row => row.method === 'runner.project.set')).toBe(true);
    expect(f.calls.filter(row => row.body).every(row => row.path === `/p/${SOURCE}/api/action`)).toBe(true);
    expect(() => runnerProjectClient('../')).toThrow();
  } finally { editor?.dispose(); await f.close(); }
});

test('device transport rejects scope/Agent token and project methods; page entries are lazy and navigation clears password fields', async () => {
  const f = fixture();
  try {
    await f.editor.ready; f.dom.location.pathname = '/';
    await expect(settingsClient().action('runner.project.set', {})).rejects.toThrow();
    await expect(settingsClient().action('runner.nodes.set', { _token: 'x' })).rejects.toThrow();
    await expect(settingsClient().action('runner.nodes.set', { scope: 'project' })).rejects.toThrow();
    const before = f.calls.filter(r => r.path.includes('/runner/')).length;
    await openSettings({ preferenceActions: {} });
    expect(f.calls.filter(r => r.path.includes('/runner/')).length).toBe(before);
    await f.dom.node('detail').querySelector('[data-settings-tab="runners"]').onclick();
    expect(deepText(f.dom.node('detail'))).toContain('执行节点');
    const credentials = button(f.dom.node('detail'), '配置凭据').onclick(); const secret = field(f.dom.node('modal'), 'machine_token'); secret.value = 'page-secret';
    activateDetailView({ view: 'overview' }); await credentials; expect(secret.value).toBe('');
    await openProjectManager(); const reads = f.calls.filter(row => row.path.includes('/runner/project')).length;
    await button(f.dom.node('detail'), '执行节点').onclick();
    expect(f.calls.filter(row => row.path.includes('/runner/project')).length).toBe(reads + 1);
    expect(deepText(f.dom.node('detail'))).toContain(`来源项目：${SOURCE}`);
    expect(f.writes).toHaveLength(0);
  } finally { await f.close(); }
});

test('project policy conflicts/late ACK preserve source and block blind replay; refresh is separate', async () => {
  const f = fixture(); let editor;
  try {
    await f.editor.ready; editor = renderRunnerProjectSettings(SOURCE); f.dom.node('detail').append(editor.root); await editor.ready;
    f.state.policy.revision = 8;
    await button(editor.root, '保存项目授权').onclick();
    expect(button(editor.root, '保存项目授权').disabled).toBe(true); expect(deepText(editor.root)).toContain('结果未确认');
    await button(editor.root, '保存项目授权').onclick(); expect(f.writes).toHaveLength(1);
    await editor.reload();
    const wait = deferred(); f.intercept((path, body) => body?.method === 'runner.project.set' ? wait.promise : null);
    const saving = button(editor.root, '保存项目授权').onclick();
    expect(editor.root.querySelector('select').disabled).toBe(true);
    expect(editor.root.querySelector('select').parentNode.dataset.help).toContain('请求处理中');
    editor.dispose(); f.dom.node('detail').replaceChildren();
    wait.resolve(f.response({ policy: { ...f.state.policy, revision: 9 }, stop_bindings: [] })); await saving;
    expect(f.dom.node('detail').children).toHaveLength(0); expect(f.writes).toHaveLength(2);
  } finally { editor?.dispose(); await f.close(); }
});

test('failed explicit check keeps visible anomaly, sanitizes transport diagnostics, never pins/retries or hides it in details', async () => {
  const f = fixture({ withCredentials: true });
  try {
    await f.editor.ready;
    f.intercept((path, body) => body?.method === 'runner.nodes.check' ? f.response({ error: 'raw-sensitive-transport' }, 500) : null);
    const checking = button(f.editor.root, '检查连接').onclick(); field(f.dom.node('modal'), 'check_project_id').value = 'paired';
    await button(f.dom.node('modal'), '检查连接').onclick(); await checking;
    const warning = f.editor.root.querySelector('.runner-warning');
    expect(warning.parentNode.tagName).toBe('ARTICLE'); expect(warning.textContent).toContain('最近一次显式检查失败');
    expect(deepText(f.editor.root)).not.toContain('raw-sensitive-transport');
    expect(f.writes.map(row => row.method)).toEqual(['runner.nodes.check']); expect(f.state.nodes.nodes[0].expected_runner_id).toBeNull();
  } finally { await f.close(); }
});
