import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runnerProject } from './fixtures/runner-project.js';
import { until } from '../helpers.js';
import { RemoteBridgeClient } from '../../src/agent/remote-bridge.js';
import { runnerIdentity } from '../../src/core/runner-service.js';
import { hash } from '../../src/runner/protocol.js';

for (const foreign of [false, 'extra', 'deleted']) test(`edit ACK loss verifies Unicode history without losing files: ${foreign || 'preserved'}`, async () => {
  let dropped;
  const f = await runnerProject({ async run(ctx) {
    const bridge = new RemoteBridgeClient(ctx.remote_workspace, ctx.token), context = await bridge.call('context');
    await bridge.call('tool', { name: 'write', args: { path: '恢复.txt', content: 'before confidential body', context_ack: context.fingerprint } });
    await bridge.call('tool', { name: 'edit', args: { path: '恢复.txt', edits: [{ oldText: 'before', newText: 'after' }], context_ack: context.fingerprint } });
    return 'unreachable';
  } }, { async intercept(frame, request) {
    const result = await request();
    if (!dropped && frame.method === 'file.edit') { dropped = frame.request_id; throw Object.assign(new Error('fixture lost edit ACK'), { code: 'UNKNOWN' }); }
    return result;
  } });
  let connection;
  try {
    const sent = await f.dispatcher.dispatch('order.submit', { content: 'edit loss', start: false }), id = sent.task.id;
    await f.dispatcher.dispatch('worker.resume', { id });
    await until(() => !f.project.running.has(id) && f.store.task(id).calls === 1, 8000);
    const receipt = f.store.runnerReceipt(dropped);
    expect(receipt).toMatchObject({ kind: 'tool', state: 'unknown', data: { method: 'file.edit', path_hash: hash('恢复.txt') } });
    const persisted = JSON.stringify(f.store.all('SELECT data,evidence,params_hash FROM runner_receipts WHERE worker_id=?', id));
    expect(persisted).not.toContain('confidential body'); expect(persisted).not.toContain('恢复.txt');
    connection = await f.service.connect(runnerIdentity(f.store.runnerBinding(id), { operation_id: 'observe-edit' }), { observation: true });
    if (foreign === 'deleted') fs.unlinkSync(path.join((await connection.client.call('workspace.inspect')).directory, '恢复.txt'));
    if (foreign === 'extra') {
      const context = await connection.client.call('file.context', { path: 'not-owned.txt' });
      await connection.client.call('file.write', { path: 'not-owned.txt', content: 'outside the journal', expected_sha256: null, context_ack: context.fingerprint });
    }
    const result = await f.dispatcher.dispatch('runner.worker.reconcile', { id, expected_revision: f.store.runnerBinding(id).revision });
    expect(result).toMatchObject({ reconciled: !foreign, state: foreign ? 'unknown' : 'ready' });
    if (foreign !== 'deleted') expect((await connection.client.call('file.read', { path: '恢复.txt' })).text).toBe('after confidential body');
    expect(f.store.task(id)).toMatchObject({ status: 'failed', calls: 1 });
    expect(f.store.runnerReceipt(dropped).terminal).toBe(foreign ? 0 : 1);
  } finally { await connection?.close(); await f.close(); }
});

test('definitive no-effect edit rejection is distinct from unknown and does not poison later journaled work', async () => {
  const f = await runnerProject({ async run(ctx) {
    const bridge = new RemoteBridgeClient(ctx.remote_workspace, ctx.token), context = await bridge.call('context');
    await bridge.call('tool', { name: 'write', args: { path: 'known.txt', content: 'original', context_ack: context.fingerprint } });
    await expect(bridge.call('tool', { name: 'edit', args: { path: 'known.txt', edits: [{ oldText: 'does not exist', newText: 'must not apply' }], context_ack: context.fingerprint } })).rejects.toThrow();
    await bridge.call('tool', { name: 'bash', args: { command: 'git add known.txt && git -c user.name=Fixture -c user.email=fixture@invalid commit -m known', context_ack: context.fingerprint } });
    return 'completed';
  } });
  try {
    const sent = await f.dispatcher.dispatch('order.submit', { content: 'definitive rejection', start: false }), id = sent.task.id;
    await f.dispatcher.dispatch('worker.resume', { id });
    await until(() => !f.project.running.has(id) && f.store.task(id).calls === 1, 8000);
    expect(f.store.task(id)).toMatchObject({ status: 'waiting', error: null });
    expect(f.store.all("SELECT state,terminal FROM runner_receipts WHERE worker_id=? AND kind='tool' ORDER BY rowid", id))
      .toEqual([{ state: 'completed', terminal: 1 }, { state: 'rejected', terminal: 1 }, { state: 'stopped', terminal: 1 }]);
    expect(f.store.runnerBarriers(id)).toEqual({ bindings: [], runs: [], receipts: [] });
  } finally { await f.close(); }
});
