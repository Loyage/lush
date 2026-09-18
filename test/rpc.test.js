import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AgentResponse } from '../src/agent/provider.js';
import { LushError } from '../src/core/types.js';
import { Dispatcher, MAX_FRAME } from '../src/rpc/protocol.js';
import { encode } from '../src/rpc/protocol.js';
import { RPCClient } from '../src/rpc/client.js';
import { RPCServer, log as serverLog } from '../src/rpc/server.js';
import { createSignal } from '../src/signal.js';
import { createWriter } from '../src/socket_io.js';
import { cleanup, contextPid, deferred, expectRejection, permissiveRoot, system, tmpdir } from './helpers.js';

const NL = 0x0a;

describe('rpc', () => {
  let dir;
  let db;
  let manager;
  let runtime;
  let stopping;
  let server;
  let client;

  beforeEach(async () => {
    dir = tmpdir('lush-rpc-');
    ({ database: db, manager, runtime } = system(dir));
    permissiveRoot(manager);
    stopping = createSignal();
    server = new RPCServer(path.join(dir, 'lush.sock'), new Dispatcher(manager, stopping));
    await server.start();
    client = new RPCClient(server.path, 2);
  });

  afterEach(async () => {
    await server.close();
    await runtime.shutdown();
    db.close();
    cleanup(dir);
  });

  /** Send raw bytes on a fresh connection and read one response line. */
  async function raw(content, { count = 1 } = {}) {
    let buffer = Buffer.alloc(0);
    const responses = [];
    const done = deferred();
    await Bun.connect({
      unix: server.path,
      socket: {
        open: (socket) => {
          const writer = createWriter(socket);
          socket.writer = writer;
          writer.write(content);
        },
        data: (socket, chunk) => {
          buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
          for (;;) {
            const index = buffer.indexOf(NL);
            if (index === -1) break;
            responses.push(JSON.parse(buffer.subarray(0, index).toString('utf8')));
            buffer = Buffer.from(buffer.subarray(index + 1));
            if (responses.length >= count) {
              socket.writer.end();
              done.resolve();
              return;
            }
          }
        },
        close: () => done.resolve(),
        error: (_socket, err) => done.reject(err),
        drain: (socket) => socket.writer?.drain(),
      },
    });
    const timeout = Bun.sleep(3000).then(() => {
      throw new Error('no RPC response');
    });
    await Promise.race([done.promise, timeout]);
    return count === 1 ? responses[0] : responses;
  }

  test('full round trip', async () => {
    expect((await client.request('system.status')).provider).toBe('mock');
    const child = await client.request('process.spawn', { parent_pid: 0, template: 'generic-task', name: 'demo' });
    const pid = child.pid;
    expect((await client.request('process.parent', { pid })).pid).toBe(0);
    // Work travels as a task: `call` opens a root task and waits for it.
    const preview = await client.request('call.describe', { pid, prompt: 'who am I?' });
    expect(preview.dry_run).toBe(true);
    expect(preview.agent).toBe('mock');
    expect(preview.command).toBeNull();
    expect((await client.request('process.inspect', { pid })).context.message_count).toBe(0);
    const task = await client.request('call', { pid, goal: 'who am I?' });
    expect(task).toMatchObject({ pid, status: 'completed', parent_task_id: null, root_task_id: task.id });
    const info = await client.request('process.inspect', { pid });
    expect(info.context.message_count).toBe(2);
    const page = await client.request('task.history', { task_id: task.id, limit: 1 });
    const page2 = await client.request('task.history', { task_id: task.id, after: page.next_after });
    expect(page2.messages.length).toBe(1);
    expect((await client.request('task.inspect', { task_id: task.id })).process.pid).toBe(pid);
    expect((await client.request('task.tree', { task_id: task.id })).id).toBe(task.id);
    expect(await client.request('task.list', { pid })).toHaveLength(1);
    expect(await client.request('task.result', { task_id: task.id })).toMatchObject({ finished: true, status: 'completed' });
    // A detached call returns the task while it runs; `task.wait` settles it.
    const detached = await client.request('call', { pid, goal: 'again', detach: true });
    expect(detached.pid).toBe(pid);
    await client.request('task.wait', { task_id: detached.id });
    expect(await client.request('task.list', { pid })).toHaveLength(2);
    // Variables travel over the wire with their declaration and regions.
    const project = await client.request('process.spawn', {
      parent_pid: 0, template: 'project', name: 'wire', variables: { path: process.cwd() },
    });
    expect(project.variables).toMatchObject({ immutable: { path: process.cwd() }, mutable: { branch: 'main' } });
    expect(await client.request('process.update_vars', { pid: project.pid, patch: { branch: 'wire' } }))
      .toEqual({ branch: 'wire' });
    expect((await client.request('process.inspect', { pid: project.pid })).variables.mutable).toEqual({ branch: 'wire' });

    // delete: only a finished process goes, and its parent keeps the audit event.
    const doomed = await client.request('process.spawn', { parent_pid: 0, template: 'generic-service', name: 'doomed' });
    await client.request('process.stop', { pid: doomed.pid });
    const removed = await client.request('process.delete', { pid: doomed.pid });
    expect(removed).toMatchObject({
      pid: doomed.pid,
      deleted: [doomed.pid],
      status: 'stopped',
      terminated: [],
    });
    expect(removed.rows.processes).toBe(1);
    expect((await client.request('process.list')).map((row) => row.pid)).not.toContain(doomed.pid);
    expect((await expectRejection(client.request('process.inspect', { pid: doomed.pid }))).code).toBe(-32004);
    expect((await client.request('process.inspect', { pid: 0 })).recent_events[0]).toMatchObject({
      kind: 'child_deleted', data: { pid: doomed.pid, name: 'doomed', status: 'stopped' },
    });

    // purge: cancel its work first, then delete the node.
    const live = await client.request('process.spawn', { parent_pid: 0, template: 'generic-task', name: 'live' });
    const liveTask = await client.request('task.spawn', { pid: live.pid, goal: 'work' });
    expect(liveTask.pid).toBe(live.pid);
    const purged = await client.request('process.purge', { pid: live.pid });
    expect(purged.status).toBe('active');
    expect(purged.deleted).toEqual([live.pid]);
    expect(purged.cancelled.length).toBeLessThanOrEqual(1);
    expect(await client.request('task.list', { pid: live.pid })).toEqual([]);
    expect(await expectRejection(client.request('process.purge', { pid: live.pid }))).toBeDefined();    expect(fs.statSync(server.path).mode & 0o777).toBe(0o600);
  });

  test('error codes and parameter validation', async () => {
    for (const [method, params, code] of [
      ['not.real', {}, -32601],
      ['process.inspect', {}, -32602],
      ['process.inspect', { pid: 0, extra: 1 }, -32602],
      ['process.inspect', { pid: true }, -32602],
      ['process.inspect', { pid: 999 }, -32004],
      ['process.spawn', { parent_pid: 0, template: [] }, -32602],
      ['call', { pid: 0, goal: 'hi', detach: 'yes' }, -32602],
      ['call', { pid: 0, goal: 'hi', extra: 1 }, -32602],
      ['call', { pid: 99, goal: 'hi' }, -32004],
      ['call.describe', { pid: 0, prompt: '' }, -32602],
      ['process.tree', { agents: 'yes' }, -32602],
      ['process.tree', { extra: 1 }, -32602],
      ['task.list', { status: 'nope' }, -32602],
      ['task.spawn', { pid: 0 }, -32602],
      ['task.inspect', {}, -32602],
      ['task.inspect', { task_id: 99 }, -32004],
      ['task.result', { task_id: 99 }, -32004],
      ['task.wait', { task_id: 99 }, -32004],
      ['task.cancel', { task_id: 99 }, -32004],
      ['task.complete', { task_id: 99 }, -32004],
      ['task.delete', { task_id: 99 }, -32004],
      ['task.session', { task_id: 99 }, -32004],
      ['task.agents_list', { all: 'yes' }, -32602],
      ['task.agents_list', { pid: 99 }, -32004],
      ['task.agents_show', {}, -32602],
      ['task.agents_show', { id: 5 }, -32602],
      ['task.agents_show', { id: '9.9' }, -32004],
      ['task.agents_kill', { id: 'nope' }, -32602],
      ['task.agents_kill', { id: '0.1' }, -32009],
      ['call.os_pid', { task_id: 0, call_id: 1, os_pid: 0 }, -32602],
      ['call.os_pid', { task_id: 0, call_id: 1, os_pid: 'x' }, -32602],
      ['call.end', { task_id: 0, call_id: 1, status: 'cancelled' }, -32602],
      ['process.update_vars', { pid: 0 }, -32602],
      ['process.update_vars', { pid: 0, patch: 'branch' }, -32602],
      ['process.update_vars', { pid: 0, patch: { path: '/tmp' } }, -32602],
      ['process.delete', { pid: 0 }, -32010],
      ['process.delete', { pid: 0, recursive: 'yes' }, -32602],
      ['process.purge', {}, -32602],
      ['process.purge', { pid: 0, extra: 1 }, -32602],
      ['process.purge', { pid: 0 }, -32010],
      ['process.delete', { pid: 99 }, -32004],
      ['process.orphans', { bogus: 1 }, -32602],
      ['process.orphans', { sweep: true }, -32602],
      ['process.orphan_sweep', { bogus: 1 }, -32602],
    ]) {
      const error = await expectRejection(client.request(method, params));
      expect(error.code).toBe(code);
    }
    for (const [frame, code] of [
      [Buffer.from('not-json\n'), -32700],
      [Buffer.from('[]\n'), -32600],
      [Buffer.from('{"jsonrpc":"2.0","id":true,"method":"system.status"}\n'), -32600],
      [Buffer.from('{"jsonrpc":"2.0","id":1,"method":"system.status","params":[]}\n'), -32602],
      [Buffer.from('{"value":NaN}\n'), -32700],
    ]) {
      expect((await raw(frame)).error.code).toBe(code);
    }
  });

  test('system.status reports the orphan policy and the active orphan count', async () => {
    const status = await client.request('system.status');
    expect(status.orphan_policy).toEqual({ adopt: 'adopt', limit: 0, ttl_seconds: 0, sweep_seconds: 30 });
    expect(status.orphans_active).toBe(0);
    // An adopted child shows up in the scalar without changing the policy.
    const parent = await client.request('process.spawn', { parent_pid: 0, template: 'generic-service', name: 'p' });
    await client.request('process.spawn', { parent_pid: parent.pid, template: 'generic-task', name: 'kid' });
    await client.request('process.stop', { pid: parent.pid });
    expect((await client.request('system.status')).orphans_active).toBe(1);
  });

  test('process.orphans is a read model, process.orphan_sweep runs the policy now', async () => {
    const pool = await client.request('process.orphans');
    expect(pool.policy).toEqual({ adopt: 'adopt', limit: 0, ttl_seconds: 0, sweep_seconds: 30 });
    expect(pool).toMatchObject({ active_count: 0, busy_count: 0, over_limit: 0, orphans: [] });
    // Nothing to do under the default policy, and the pass still reports itself.
    expect(await client.request('process.orphan_sweep')).toEqual({
      trigger: 'manual', skipped: false, checked: 0, active_before: 0, active_after: 0,
      evicted: [], deferred: [], limit: 0, ttl_seconds: 0,
    });
  });

  test('a ttl sweep freezes an idle orphan over the wire', async () => {
    // A daemon of its own: supervision is configured at startup.
    const dir2 = tmpdir('lush-rpc-orphan-');
    const second = system(dir2, null, {}, { ttlSeconds: 1 });
    permissiveRoot(second.manager);
    const stop2 = createSignal();
    const server2 = new RPCServer(path.join(dir2, 'lush.sock'), new Dispatcher(second.manager, stop2));
    await server2.start();
    const client2 = new RPCClient(server2.path, 2);
    try {
      const parent = await client2.request('process.spawn', { parent_pid: 0, template: 'generic-service', name: 'p' });
      const kid = await client2.request('process.spawn', { parent_pid: parent.pid, template: 'generic-task', name: 'kid' });
      // Only a terminal parent turns its surviving children into PID 0's orphans.
      await client2.request('process.stop', { pid: parent.pid });

      const pool = await client2.request('process.orphans');
      expect(pool.policy.ttl_seconds).toBe(1);
      expect(pool.active_count).toBe(1);
      expect(pool.orphans[0]).toMatchObject({ pid: kid.pid, name: 'kid', busy: false, status: 'active' });
      expect(typeof pool.orphans[0].last_activity_at).toBe('string');

      // Jump the supervisor clock instead of waiting for a real TTL.
      second.manager.orphanSupervisor.clock = () => Date.now() + 3600_000;
      const report = await client2.request('process.orphan_sweep');
      expect(report.trigger).toBe('manual');
      expect(report.evicted).toHaveLength(1);
      expect(report.evicted[0]).toMatchObject({ pid: kid.pid, from: 'active', to: 'stopped', reason: 'orphan_ttl' });
      expect(report).toMatchObject({ active_before: 1, active_after: 0, deferred: [] });
      expect((await client2.request('process.inspect', { pid: kid.pid })).status).toBe('stopped');
      expect((await client2.request('process.inspect', { pid: kid.pid })).recent_events[0]).toMatchObject({
        kind: 'transition', data: { from: 'active', to: 'stopped', cause: 'orphan_ttl' },
      });
    } finally {
      await server2.close();
      await second.runtime.shutdown();
      second.database.close();
      cleanup(dir2);
    }
  });

  test('tree carries live-agent activity, agents_list is its own view', async () => {
    const plain = await client.request('process.tree', { agents: false });
    expect(plain.length).toBe(1);
    expect(plain[0].agent).toBeUndefined();
    const rows = await client.request('process.tree');
    expect(rows[0].agent).toEqual({ provider: 'mock', running: 0, agents: [] });
    // Same rows either way: only the activity field differs, so list and tree stay one read model.
    expect(rows.map((row) => row.pid)).toEqual(plain.map((row) => row.pid));
    // The agent space is runtime data: nothing persisted, nothing to list yet.
    expect(await client.request('task.agents_list')).toEqual([]);
    expect(await client.request('task.agents_list', { all: true })).toEqual([]);
  });

  test('notifications and multiple requests on one connection', async () => {
    const frames = Buffer.concat([
      encode({ jsonrpc: '2.0', method: 'process.spawn', params: { parent_pid: 0, template: 'generic-task' } }),
      encode({ jsonrpc: '2.0', id: 'next', method: 'process.list' }),
    ]);
    const response = await raw(frames);
    expect(response.id).toBe('next');
    expect(response.result.length).toBe(2);
  });

  test('oversized frame and internal errors', async () => {
    const oversized = Buffer.concat([Buffer.alloc(MAX_FRAME + 1, 0x78), Buffer.from('\n')]);
    expect((await raw(oversized)).error.code).toBe(-32600);

    let logged = 0;
    const original = serverLog.exception;
    serverLog.exception = () => {
      logged += 1;
    };
    server.dispatcher.methods['test.broken'] = {
      params: { required: [] },
      fn: () => {
        throw new Error('private detail');
      },
    };
    const error = await expectRejection(client.request('test.broken'));
    serverLog.exception = original;
    expect(error.code).toBe(-32603);
    expect(error.message).not.toContain('private detail');
    expect(logged).toBe(1);
  });

  test('shutdown reply', async () => {
    expect(await client.request('system.shutdown')).toEqual({ stopping: true });
    expect(stopping.isSet()).toBe(true);
  });

  test('a dropped connection keeps the invocation running', async () => {
    const gate = deferred();
    const release = deferred();
    runtime.provider = {
      name: 'blocking',
      async call(messages) {
        contextPid(messages);
        gate.resolve();
        await release.promise;
        return new AgentResponse('survived');
      },
    };
    const child = await client.request('process.spawn', { parent_pid: 0, template: 'generic-task' });
    const pid = child.pid;
    const socket = await Bun.connect({
      unix: server.path,
      socket: {
        open: (handle) => handle.write(encode({
          jsonrpc: '2.0', id: 'detached', method: 'call', params: { pid, goal: 'work' },
        })),
        data: () => {},
        close: () => {},
        error: () => {},
        drain: () => {},
      },
    });
    await gate.promise;
    socket.end();
    await Bun.sleep(50);
    const task = manager.taskList(pid)[0];
    expect(runtime.isBusy(pid)).toBe(true);
    release.resolve();
    await runtime.active.get(task.id).promise;
    expect(manager.repository.taskCalls(task.id)[0].status).toBe('succeeded');
    expect(LushError.name).toBe('LushError');
  });
});
