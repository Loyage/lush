import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { startWeb } from '../../src/ui/web/server.js';
import { projectRouteId } from '../../src/host/registry.js';
import { env, temp } from '../helpers.js';
import { fetch as httpFetch } from './harness.js';
import { installDom, deepText } from '../dom-stub.js';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const drain = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test('临时 Host 的真实项目 API：核心优先、diff 按需、名称单飞隔离/失效/失败且 no-store', async () => {
  const a = temp(), b = temp(), shared = temp(), calls = [], core = deferred(), extras = deferred(), arrived = deferred(), diffArrived = deferred();
  let gateCore = true, gateExtras = true, label = '原名称', unavailable = false;
  const web = startWeb(null, 0, { env: env({ LUSH_GLOBAL_CONFIG: shared }), openProject: async project => ({
    config: { project, home: path.join(project, '.lush') },
    client: { async request(method, params = {}) {
      calls.push({ project, method });
      if (method === 'worker.inspect') {
        arrived.resolve(); if (gateCore) await core.promise;
        return { id: params.id, worker_number: 'W159-3', role: 'agent', task_kind: 'order', status: 'running', calls: 1,
          goal: '真实 HTTP 目标', result: '真实 HTTP 结果', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z' };
      }
      if (method === 'worker.diff') { diffArrived.resolve(); return { files: [{ path: 'http.js', added: 1, deleted: 0 }], files_total: 1, committed: true }; }
      if (method === 'worker.history_page' || method === 'worker.usage') {
        if (gateExtras) await extras.promise;
        return method === 'worker.usage' ? { files: [] } : { events: [] };
      }
      if (method === 'agent.connections.list') {
        if (unavailable) throw new Error('local read unavailable');
        return { connections: [{ id: 'source', label: `${path.basename(project)}:${label}`, credential: { status: 'configured' } }] };
      }
      if (method === 'agent.connections.save') { label = params.connection.label; return { saved: true }; }
      return {};
    } },
  }) });
  const origin = `http://127.0.0.1:${web.port}`;
  let dom, dispose;
  try {
    for (const project of [a, b]) await httpFetch(origin + '/api/host/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project }) });
    dom = installDom({ fetch: async (url, options) => {
      const response = await httpFetch(origin + url, options);
      expect(response.headers.get('cache-control')).toBe('no-store'); return response;
    } });
    const { ui, resetUiState } = await import('../../src/ui/web/assets/state.js'); resetUiState();
    const { loadDetail, disposeDetailRequests } = await import('../../src/ui/web/assets/detail.js'); dispose = disposeDetailRequests;
    const { loadConnectionNames, action } = await import('../../src/ui/web/assets/api.js');
    dom.location.pathname = `/p/${projectRouteId(a)}/`;
    const opening = loadDetail(7);
    await arrived.promise;
    expect(calls).toEqual([{ project: a, method: 'worker.inspect' }]);
    gateCore = false; core.resolve(); expect(await opening).toBe(true);
    expect(calls[0]).toEqual({ project: a, method: 'worker.inspect' });
    expect(calls.some(row => row.method === 'worker.diff')).toBe(false);
    expect(deepText(dom.node('detail'))).toContain('真实 HTTP 结果');
    const fold = dom.node('detail').querySelector('.detail-diff'); fold.open = true; fold.ontoggle();
    await diffArrived.promise;
    // History/usage stay gated; opening success and read-name completion do not depend on them.
    const names = await Promise.all([loadConnectionNames(), loadConnectionNames()]);
    expect(names[0]).toEqual([{ id: 'source', label: `${path.basename(a)}:原名称` }]);
    expect(calls.filter(row => row.method === 'agent.connections.list')).toHaveLength(1);
    await action('agent.connections.save', { connection: { label: '更新名称' } }, { refresh: false });
    expect((await loadConnectionNames())[0].label).toContain('更新名称');
    unavailable = true; await action('agent.connections.save', { connection: { label: '不可用后名称' } }, { refresh: false });
    await expect(loadConnectionNames()).rejects.toThrow('local read unavailable');
    await expect(loadConnectionNames()).rejects.toThrow('local read unavailable');
    unavailable = false; dom.location.pathname = `/p/${projectRouteId(b)}/`;
    expect((await loadConnectionNames())[0].label).toBe(`${path.basename(b)}:不可用后名称`);
    expect(calls.at(-1)).toEqual({ project: b, method: 'agent.connections.list' });
    ui.view = null; dispose(); gateExtras = false; extras.resolve(); await drain();
    expect(calls.filter(row => row.method === 'worker.diff')).toHaveLength(1);
  } finally {
    gateCore = false; gateExtras = false; core.resolve(); extras.resolve(); dispose?.(); dom?.restore(); web.stop(true);
    for (const dir of [a, b, shared]) fs.rmSync(dir, { recursive: true, force: true });
  }
});
