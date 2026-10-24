import { test, expect } from 'bun:test';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { temp, repo, env, until } from '../helpers.js';
import { RPCServer } from '../../src/rpc/server.js';
import { createSignal } from '../../src/signal.js';
import { Config } from '../../src/config.js';
import { UIClient } from '../../src/ui/client.js';
import { cli, idle, emittedTask } from './harness.js';

test('real daemon starts once, admits input and retains Worker state across restart', async () => {
  const root = temp(); await repo(root);
  try {
    const started = await cli(root, ['daemon', 'start']);
    const client = new UIClient(Config.fromEnv(env(), root));
    expect((await cli(root, ['daemon', 'start'])).already_running).toBe(true);
    expect((await cli(root, ['doctor'])).daemon_code_match).toBe(true);
    const main = (await client.request('worker.list')).find(task => task.task_kind === 'main');
    expect(main).toMatchObject({ task_kind: 'main', status: 'waiting', input_id: null });
    const receipt = await cli(root, ['order', 'original input']);
    expect(receipt).toMatchObject({ emitted: true });
    const task = await emittedTask(client, receipt);
    expect((await idle(client, task.id)).status).toBe('waiting');
    const before = await client.request('worker.inspect', { id: task.id });
    const restarted = await cli(root, ['daemon', 'restart']);
    expect(restarted.pid).not.toBe(started.pid);
    expect(await client.request('worker.inspect', { id: task.id })).toMatchObject({
      id: before.id, goal: before.goal, status: before.status, result: before.result, calls: before.calls,
    });
  } finally { await cli(root, ['daemon', 'stop']).catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); }
}, 30000);

// Existing daemon coverage has only small replies. Exercise the real socket
// writer's backpressure/drain path during shutdown, not a mocked write result.
test('RPC shutdown drains a queued large reply before closing the connection', async () => {
  const root = temp(), result = 'x'.repeat(900000);
  const server = new RPCServer(path.join(root, 'rpc.sock'), {
    stopping: createSignal(), async dispatch() { return result; },
  });
  let client, sockets = [];
  try {
    await server.start();
    client = net.createConnection(server.path);
    client.pause();
    await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('error', reject); });
    client.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'test.reply' }) + '\n');
    await until(() => [...server.connections.values()].some(conn => conn.writer.pendingBytes > 0));
    sockets = [...server.connections.keys()];
    await server.close();
    const chunks = []; let ended = false;
    client.on('data', chunk => chunks.push(chunk));
    client.on('end', () => { ended = true; });
    client.resume();
    await until(() => ended);
    expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual({ jsonrpc: '2.0', id: 1, result });
    await until(() => server.connections.size === 0);
  } finally {
    client?.destroy();
    for (const socket of sockets) socket.terminate();
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
