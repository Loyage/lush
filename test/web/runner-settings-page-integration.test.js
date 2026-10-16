import { test, expect } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { startTestWeb, fetch } from './auth-fixture.js';
import { DeviceSettingsService } from '../../src/host/device-settings.js';
import { managementFixture } from '../runner-management-fixture.js';
import { sshFixture } from '../runner-ssh-fixture.js';
import { openRunners } from '../../src/ui/web/assets/render-runners.js';
import { ui } from '../../src/ui/web/assets/state.js';

const button = (root, text) => root.querySelectorAll('button').find(node => node.textContent === text);
const field = (root, name) => root.querySelector(`[data-runner-field="${name}"]`);

test('real Host and fixed-project HTTP → page actions → RPC → persisted Runner settings; explicit independent-process check', async () => {
  const f = await managementFixture(), ssh = sshFixture(f.root); let opened = 0, discovery;
  ssh.config('Host lab\n HostName private-fixture.example\n');
  f.runnerOptions.ssh = ssh.options;
  const device = new DeviceSettingsService(f.config.env, { runner: f.runnerOptions });
  const host = startTestWeb(null, 0, { env: f.config.env, deviceSettingsService: device, openProject: async () => { opened++; throw new Error('must not start'); } });
  const projectWeb = startTestWeb(f.config), requests = [];
  const hostUrl = `http://127.0.0.1:${host.port}`, projectUrl = `http://127.0.0.1:${projectWeb.port}`;
  let dom, editor, projectEditor;
  try {
    const { projects } = await (await fetch(`${projectUrl}/api/host/projects`)).json(), id = projects[0].id;
    dom = installDom({ fetch: (url, options) => {
      requests.push({ url: String(url), method: options?.method || 'GET' });
      const pending = fetch((String(url).startsWith('/p/') || url === '/api/host/projects' ? projectUrl : hostUrl) + url, options);
      if (String(url).includes('/ssh/aliases')) discovery = pending;
      return pending;
    } });
    // Exercise the independent global page, using the existing real HTTP editors unchanged.
    await openRunners(); editor = { root: dom.node('detail').querySelector('.runner-settings') };
    expect(f.connections()).toBe(0); expect(opened).toBe(0);
    const adding = button(editor.root, '新增执行节点').onclick();
    await discovery; for (let i = 0; i < 8; i++) await Promise.resolve();
    const aliases = field(dom.node('modal'), 'ssh_discovered');
    expect(aliases.querySelectorAll('option').map(row => row.value)).toEqual(['', 'lab']);
    expect(ssh.calls()).toBe(0);
    aliases.value = 'lab'; aliases.onchange();
    field(dom.node('modal'), 'name').value = 'Lab node';
    // Re-read before execution: stale discovery must not silently drop newly added routing semantics.
    ssh.config('Host lab\n ProxyJump private-bastion\n');
    await button(dom.node('modal'), '测试 SSH').onclick();
    expect(ssh.calls()).toBe(0); expect(deepText(dom.node('modal'))).toContain('未发起 SSH 连接');
    expect(field(dom.node('modal'), 'name').value).toBe('Lab node');
    ssh.config('Host lab\n HostName private-fixture.example\n');
    await button(dom.node('modal'), '测试 SSH').onclick();
    expect(ssh.calls()).toBe(1); expect(f.connections()).toBe(0);
    expect(deepText(dom.node('modal'))).toContain('SSH 成功 ≠ Runner 可用');
    expect((await device.request('runner.nodes.get')).nodes).toEqual([]);
    expect((await device.request('runner.credentials.get')).nodes).toEqual([]);
    await button(dom.node('modal'), '保存节点').onclick(); await adding;
    let model = await device.request('runner.nodes.get'); const node = model.nodes[0];
    expect(node.name).toBe('Lab node'); expect(node.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(node.expected_runner_id).toBeNull();
    await openRunners({ projectId: id });
    projectEditor = { root: dom.node('detail').querySelector('.runner-project-settings'), reload: () => button(projectEditor.root, '重新读取项目授权').onclick() };
    expect(dom.node('detail').querySelectorAll('.runner-settings')).toHaveLength(2);
    expect(deepText(dom.node('detail'))).toContain(`Host ID：${id}`);
    expect(f.store.runnerProject().project_id).toBeNull();
    await button(projectEditor.root, '保存项目授权').onclick();
    const project_id = f.store.runnerProject().project_id; expect(project_id).toBeTruthy();
    const credentials = button(editor.root, '配置凭据').onclick();
    const machine = field(dom.node('modal'), 'machine_token'), token = field(dom.node('modal'), 'control_token');
    machine.value = f.machine; token.value = f.secret; field(dom.node('modal'), 'project_id').value = project_id;
    const posting = button(dom.node('modal'), '提交凭据').onclick();
    expect(machine.value).toBe(''); expect(token.value).toBe(''); await posting; await credentials;
    expect(deepText(editor.root)).not.toContain(f.secret); expect(deepText(editor.root)).not.toContain(f.machine);
    expect(f.connections()).toBe(0); f.provision(node.id, project_id);
    const checking = button(editor.root, '检查连接').onclick(); field(dom.node('modal'), 'check_project_id').value = project_id;
    await button(dom.node('modal'), '检查连接').onclick(); await checking;
    expect(f.connections()).toBe(1); expect(deepText(editor.root)).toContain('不代表当前在线');
    expect((await device.request('runner.nodes.get')).nodes[0].expected_runner_id).toBeNull();
    const pinning = button(editor.root, '保存安装身份 pin').onclick();
    await button(dom.node('modal'), '确认').onclick(); await pinning;
    model = await device.request('runner.nodes.get'); expect(model.nodes[0].expected_runner_id).toBeTruthy();
    // Refresh policy independently, then authorize and explicitly choose the node.
    await projectEditor.reload();
    projectEditor.root.querySelector('input').checked = true; projectEditor.root.querySelector('select').value = node.id;
    await button(projectEditor.root, '保存项目授权').onclick();
    expect(f.store.runnerProject().allowed_node_ids).toEqual([node.id]); expect(f.store.runnerProject().default_node_id).toBe(node.id);
    expect(requests.filter(r => r.url.includes('/runner/project')).every(r => r.url.startsWith(`/p/${id}/`))).toBe(true);
    expect(requests.filter(r => r.method === 'POST').every(r => r.url === '/api/host/settings/action' || r.url === `/p/${id}/api/action`)).toBe(true);
    expect(f.connections()).toBe(1); expect(opened).toBe(0);
    expect(deepText(projectEditor.root)).toContain('ACK');
  } finally { ui.disposeRunnersPage?.(); dom?.restore(); await host.stop(true); await projectWeb.stop(true); await f.close(); }
});
