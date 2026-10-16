import { test, expect } from 'bun:test';
import { startTestWeb, fetch as httpFetch } from './auth-fixture.js';
import { managementFixture, nodeDefinition } from '../runner-management-fixture.js';
import { installDom, deepText } from '../dom-stub.js';
import { api, action } from '../../src/ui/web/assets/api.js';
import { renderDetail } from '../../src/ui/web/assets/render-detail.js';
import { resetUiState } from '../../src/ui/web/assets/state.js';

const identity = row => Object.fromEntries(['project_id', 'worker_id', 'node_id', 'runner_id', 'workspace_id', 'generation'].map(key => [key, row[key]]));

test('real Web/RPC/Store inspect renders fixed remote identity, visible unknown/revocation and local history without connecting a Runner', async () => {
  const f = await managementFixture(), web = startTestWeb(f.config, 0), origin = `http://127.0.0.1:${web.port}`;
  const requests = [];
  const dom = installDom({ fetch: async (url, options) => {
    requests.push(String(url));
    const response = await httpFetch(origin + url, options);
    expect(response.headers.get('cache-control')).toBe('no-store');
    return response;
  } });
  resetUiState();
  try {
    const empty = await api('/api/runner/nodes');
    const { nodes: [node] } = await action('runner.nodes.set', { nodes: [nodeDefinition()], expected_revision: empty.revision }, { refresh: false });
    const { policy } = await action('runner.project.set', { allowed_node_ids: [node.id], default_node_id: node.id, expected_revision: 0 }, { refresh: false });
    const task = f.store.create({ input_id: null, role: 'agent', task_kind: 'order', goal: '远端只读位置' });
    const bound = f.store.bindRunnerWorkspace({ project_id: policy.project_id, worker_id: task.id, node_id: node.id,
      runner_id: 'fixture-installation', workspace_id: `workspace-${task.id}`, generation: 1, base_commit: 'a'.repeat(40) });
    const ready = f.store.confirmRunnerWorkspace(identity(bound), bound.head_commit, bound.revision);
    const read = async () => {
      const value = await api(`/api/worker/${task.id}`);
      renderDetail(value, null, null, null);
      return dom.node('detail').querySelector('.worker-runner');
    };
    let section = await read();
    expect(deepText(section)).toContain(node.id);
    expect(deepText(section)).toContain('代次 1');
    expect(deepText(section)).toContain('中央已接收 HEAD');
    expect(deepText(section)).toContain('屏障为 0 不证明在线');
    expect(section.querySelector('.worker-runner-warning')).toBeNull();
    f.store.markRunnerWorkspaceUnknown(identity(ready), ready.revision);
    await action('runner.project.set', { allowed_node_ids: [], default_node_id: node.id, expected_revision: policy.revision }, { refresh: false });
    section = await read();
    const warnings = section.querySelectorAll('.worker-runner-warning');
    expect(warnings.length).toBeGreaterThan(1);
    expect(warnings.every(node => node.parentNode === section)).toBe(true);
    expect(deepText(section)).toContain('远端现场未知');
    expect(deepText(section)).toContain('项目未授权此节点');
    expect(deepText(section)).toContain('工作区／同步 1');
    expect(section.querySelector('.worker-runner-details').open).toBe(false);
    const local = f.store.create({ input_id: null, role: 'agent', task_kind: 'order', goal: '旧本地 Worker' });
    const value = await api(`/api/worker/${local.id}`);
    expect(value.runner).toBeUndefined();
    renderDetail(value, null, null, null);
    expect(deepText(dom.node('detail').querySelector('.worker-runner'))).toBe('执行环境：本地');
    expect(requests.some(url => /credentials|check/.test(url))).toBe(false);
    expect(f.connections()).toBe(0);
  } finally { resetUiState(); dom.restore(); await web.stop(true); await f.close(); }
});
