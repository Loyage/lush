import { test, expect } from 'bun:test';
import { runnerProject } from '../project/fixtures/runner-project.js';
import { until } from '../helpers.js';
import { RemoteBridgeClient } from '../../src/agent/remote-bridge.js';
import { runnerIdentity } from '../../src/core/runner-service.js';
import { RPCServer } from '../../src/rpc/server.js';
import { startTestWeb, fetch as httpFetch } from './auth-fixture.js';
import { installDom, deepText } from '../dom-stub.js';
import { resetUiState } from '../../src/ui/web/assets/state.js';
import { api } from '../../src/ui/web/assets/api.js';
import { renderDetail } from '../../src/ui/web/assets/render-detail.js';
import { registerNavigation } from '../../src/ui/web/assets/navigate.js';

test('explicit page -> authenticated HTTP/RPC -> original write receipt verification preserves dirty file without Agent restart', async () => {
  let dropped = false, writes = 0;
  const f = await runnerProject({ async run(ctx) {
    const bridge = new RemoteBridgeClient(ctx.remote_workspace, ctx.token), context = await bridge.call('context');
    await bridge.call('tool', { name: 'write', args: { path: 'preserved.txt', content: 'keep this work', context_ack: context.fingerprint } });
    return 'unreachable';
  } }, { async intercept(frame, request) {
    if (frame.method === 'file.write') writes++;
    const response = await request();
    if (!dropped && frame.method === 'file.write') { dropped = true; throw Object.assign(new Error('lost ACK'), { code: 'UNKNOWN' }); }
    return response;
  } });
  let dom, web;
  const rpc = new RPCServer(f.config.socket, f.dispatcher); await rpc.start();
  try {
    const sent = await f.dispatcher.dispatch('order.submit', { content: 'write then disconnect', start: false });
    const id = sent.task.id;
    await f.dispatcher.dispatch('worker.resume', { id });
    await until(() => !f.project.running.has(id) && f.store.task(id).calls === 1, 8000);
    web = startTestWeb(f.config); const origin = `http://127.0.0.1:${web.port}`, requests = [];
    dom = installDom({ fetch: (url, options) => {
      if (options?.method === 'POST') requests.push(JSON.parse(options.body));
      return httpFetch(origin + url, options);
    } }); resetUiState();
    let task = await api(`/api/worker/${id}`), section, reads = 0;
    const read = async () => { reads++; task = await api(`/api/worker/${id}`); };
    const expectedRevision = task.runner.revision;
    registerNavigation({ detail: read });
    renderDetail(task, null, null, null);
    section = dom.node('detail').querySelector('.worker-runner');
    expect(task.runner.state).toBe('unknown'); expect(requests).toHaveLength(0);
    const button = section.querySelectorAll('button').find(node => node.textContent === '核验远端现场');
    await button.onclick();
    expect(requests).toEqual([{ method: 'runner.worker.reconcile', params: { id, expected_revision: expectedRevision } }]);
    expect(deepText(section)).toContain('核验通过'); expect(reads).toBe(1);
    expect(task.runner).toMatchObject({ state: 'ready', barriers: { bindings: 0, runs: 0, receipts: 0 } });
    expect(f.store.task(id)).toMatchObject({ status: 'failed', calls: 1 }); expect(writes).toBe(1);
    const connection = await f.service.connect(runnerIdentity(f.store.runnerBinding(id), { operation_id: 'page-readback' }), { observation: true });
    try { expect((await connection.client.call('file.read', { path: 'preserved.txt' })).text).toBe('keep this work'); }
    finally { await connection.close(); }
    expect(requests.some(row => /retry|resume/.test(row.method))).toBe(false);
  } finally { resetUiState(); dom?.restore(); await web?.stop(true); await rpc.close(); await f.close(); }
});
