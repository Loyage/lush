import { test, expect } from 'bun:test';
import { remoteCodeFixture } from '../workspaces/remote-code-fixture.js';
import { RPCServer } from '../../src/rpc/server.js';
import { RPCClient } from '../../src/rpc/client.js';
import { Dispatcher } from '../../src/rpc/protocol.js';
import { createSignal } from '../../src/signal.js';
import { startTestWeb, fetch } from './auth-fixture.js';
import { assertAllowed } from '../../src/rpc/registry.js';

test('authenticated HTTP/RPC code reads reach real Project and independent Runner, preserving envelope and stale/offline semantics', async () => {
  const f = await remoteCodeFixture(); let rpc, web;
  try {
    rpc = new RPCServer(f.config.socket, new Dispatcher(f.project, createSignal(), {})); await rpc.start();
    web = startTestWeb(f.config, 0);
    const url = `http://127.0.0.1:${web.port}/api/worker/${f.task.id}`, client = new RPCClient(f.config.socket);
    f.write('file.txt', 'HTTP remote\n');
    const state = await fetch(url + '/code-state');
    expect(state.status).toBe(200); expect(state.headers.get('cache-control')).toBe('no-store');
    const snapshot = await state.json();
    expect(snapshot).toMatchObject({ version: 1, task_id: f.task.id, availability: 'available', source: 'workspace' });
    const file = await fetch(url + '/code-file?path=file.txt&view=content&revision=' + snapshot.revision);
    expect(await file.json()).toMatchObject({ task_id: f.task.id, source: 'workspace', content: { text: 'HTTP remote\n' } });
    expect((await client.request('worker.code_tree', { id: f.task.id, limit: 1 })).has_more).toBe(true);
    f.write('file.txt', 'updated\n');
    const stale = await fetch(url + '/code-file?path=file.txt&revision=' + snapshot.revision);
    expect((await stale.json()).availability).toBe('stale');
    for (const method of ['worker.code_state', 'worker.code_tree', 'worker.code_file'])
      expect(() => assertAllowed(method, { id: f.task.id }, f.task.id)).toThrow('requires user approval');
    expect((await fetch(url + '/code-tree?cwd=/etc')).status).toBe(400);
    expect((await fetch(url + '/code-state', { headers: { Origin: 'https://foreign.invalid' } })).status).toBe(403);
    f.service.transport_factory = () => { throw new Error('NODE PRIVATE PATH /private'); };
    const offline = await (await fetch(url + '/code-state')).json();
    expect(offline).toMatchObject({ availability: 'unavailable', source: 'none', head_commit: null, summary: { changed_total: null } });
    expect(JSON.stringify(offline)).not.toContain('/private');
  } finally { web?.stop(true); await rpc?.close(); await f.close(); }
});
