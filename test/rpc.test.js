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
import { cleanup, contextSid, deferred, expectRejection, permissiveRoot, system, tmpdir } from './helpers.js';

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
    const child = await client.request('service.construct', { parent_sid: 0, template: 'generic-task', name: 'demo' });
    const sid = child.sid;
    expect((await client.request('service.parent', { sid })).sid).toBe(0);
    // A person speaks once: `intent.submit` records it, SID 0 parses it, and the
    // work it arranges lands as a task on the named service.
    expect((await client.request('service.inspect', { sid })).context.message_count).toBe(0);
    const settled = await client.request('intent.submit', { content: 'delegate: who am I?', sid, wait: true });
    expect(settled).toMatchObject({ sid, status: 'settled', source: 'rpc', attempts: 1 });
    expect(settled.resolution.task_ids).toHaveLength(1);
    const task = await client.request('task.inspect', { task_id: settled.resolution.task_ids[0] });
    expect(task).toMatchObject({ sid, status: 'completed' });
    expect(task.parent_task_id).toBe(settled.parse_task_id);
    const info = await client.request('service.inspect', { sid });
    expect(info.context.message_count).toBe(2);
    const page = await client.request('task.history', { task_id: task.id, limit: 1 });
    const page2 = await client.request('task.history', { task_id: task.id, after: page.next_after });
    expect(page2.messages.length).toBe(1);
    expect((await client.request('task.inspect', { task_id: task.id })).service.sid).toBe(sid);
    expect((await client.request('task.tree', { task_id: task.id })).id).toBe(task.id);
    expect(await client.request('task.list', { sid })).toHaveLength(1);
    expect(await client.request('task.result', { task_id: task.id })).toMatchObject({ finished: true, status: 'completed' });
    // Without `wait` the submission returns immediately and the queue view shows
    // the row; `intent.wait` blocks until it is closed.
    const submitted = await client.request('intent.submit', { content: 'delegate again', sid });
    expect(['queued', 'parsing', 'settled']).toContain(submitted.status);
    expect((await client.request('intent.list', { sid })).map((row) => row.id)).toContain(submitted.id);
    const closed = await client.request('intent.wait', { intension_id: submitted.id });
    expect(closed.status).toBe('settled');
    expect(await client.request('task.list', { sid })).toHaveLength(2);
    // Variables travel over the wire with their declaration and regions.
    const project = await client.request('service.construct', {
      parent_sid: 0, template: 'project', name: 'wire', variables: { path: process.cwd() },
    });
    expect(project.variables).toMatchObject({ immutable: { path: process.cwd() }, mutable: { branch: 'main' } });
    expect(await client.request('service.update_vars', { sid: project.sid, patch: { branch: 'wire' } }))
      .toEqual({ branch: 'wire' });
    expect((await client.request('service.inspect', { sid: project.sid })).variables.mutable).toEqual({ branch: 'wire' });

    // delete: only a finished service goes, and its parent keeps the audit event.
    const doomed = await client.request('service.construct', { parent_sid: 0, template: 'generic-service', name: 'doomed' });
    await client.request('service.stop', { sid: doomed.sid });
    const removed = await client.request('service.delete', { sid: doomed.sid });
    expect(removed).toMatchObject({
      sid: doomed.sid,
      deleted: [doomed.sid],
      status: 'stopped',
      terminated: [],
    });
    expect(removed.rows.services).toBe(1);
    expect((await client.request('service.list')).map((row) => row.sid)).not.toContain(doomed.sid);
    expect((await expectRejection(client.request('service.inspect', { sid: doomed.sid }))).code).toBe(-32004);
    expect((await client.request('service.inspect', { sid: 0 })).recent_events[0]).toMatchObject({
      kind: 'child_deleted', data: { sid: doomed.sid, name: 'doomed', status: 'stopped' },
    });

    // purge: an idle node goes with its rows (`purge` cancelling a *running*
    // task is covered in core.test.js, where a task can be placed exactly).
    const live = await client.request('service.construct', { parent_sid: 0, template: 'generic-task', name: 'live' });
    const purged = await client.request('service.purge', { sid: live.sid });
    expect(purged.status).toBe('active');
    expect(purged.deleted).toEqual([live.sid]);
    expect(purged.cancelled).toEqual([]);
    expect(await client.request('task.list', { sid: live.sid })).toEqual([]);
    expect(await expectRejection(client.request('service.purge', { sid: live.sid }))).toBeDefined();    expect(fs.statSync(server.path).mode & 0o777).toBe(0o600);
  });

  test('error codes and parameter validation', async () => {
    for (const [method, params, code] of [
      ['not.real', {}, -32601],
      ['service.inspect', {}, -32602],
      ['service.inspect', { sid: 0, extra: 1 }, -32602],
      ['service.inspect', { sid: true }, -32602],
      ['service.inspect', { sid: 999 }, -32004],
      ['service.construct', { parent_sid: 0, template: [] }, -32602],
      ['intent.submit', {}, -32602],
      ['intent.submit', { content: '' }, -32602],
      ['intent.submit', { content: 'hi', extra: 1 }, -32602],
      ['intent.submit', { content: 'hi', sid: 99 }, -32004],
      ['intent.submit', { content: 'hi', wait: 'yes' }, -32602],
      ['intent.list', { status: 'nope' }, -32602],
      ['intent.list', { sid: true }, -32602],
      ['intent.inspect', {}, -32602],
      ['intent.inspect', { intension_id: 99 }, -32004],
      ['intent.context', {}, -32602],
      ['intent.settle', { status: 'nope' }, -32602],
      ['intent.defer', {}, -32602],
      ['intent.withdraw', { intension_id: 99 }, -32004],
      ['intent.wait', { intension_id: 99 }, -32004],
      ['service.tree', { agents: 'yes' }, -32602],
      ['service.tree', { extra: 1 }, -32602],
      ['task.list', { status: 'nope' }, -32602],
      ['task.construct', { sid: 0 }, -32602],
      ['task.inspect', {}, -32602],
      ['task.inspect', { task_id: 99 }, -32004],
      ['task.result', { task_id: 99 }, -32004],
      ['task.wait', { task_id: 99 }, -32004],
      ['task.cancel', { task_id: 99 }, -32004],
      ['task.complete', { task_id: 99 }, -32004],
      ['task.delete', { task_id: 99 }, -32004],
      ['task.session', { task_id: 99 }, -32004],
      ['task.agents_list', { all: 'yes' }, -32602],
      ['task.agents_list', { sid: 99 }, -32004],
      ['task.agents_show', {}, -32602],
      ['task.agents_show', { id: 5 }, -32602],
      ['task.agents_show', { id: '9.9' }, -32004],
      ['task.agents_kill', { id: 'nope' }, -32602],
      ['task.agents_kill', { id: '0.1' }, -32009],
      ['call.os_pid', { task_id: 0, call_id: 1, os_pid: 0 }, -32602],
      ['call.os_pid', { task_id: 0, call_id: 1, os_pid: 'x' }, -32602],
      ['call.end', { task_id: 0, call_id: 1, status: 'cancelled' }, -32602],
      ['service.update_vars', { sid: 0 }, -32602],
      ['service.update_vars', { sid: 0, patch: 'branch' }, -32602],
      ['service.update_vars', { sid: 0, patch: { path: '/tmp' } }, -32602],
      ['service.delete', { sid: 0 }, -32010],
      ['service.delete', { sid: 0, recursive: 'yes' }, -32602],
      ['service.purge', {}, -32602],
      ['service.purge', { sid: 0, extra: 1 }, -32602],
      ['service.purge', { sid: 0 }, -32010],
      ['service.delete', { sid: 99 }, -32004],
      ['service.orphans', { bogus: 1 }, -32602],
      ['service.orphans', { sweep: true }, -32602],
      ['service.orphan_sweep', { bogus: 1 }, -32602],
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
    const parent = await client.request('service.construct', { parent_sid: 0, template: 'generic-service', name: 'p' });
    await client.request('service.construct', { parent_sid: parent.sid, template: 'generic-task', name: 'kid' });
    await client.request('service.stop', { sid: parent.sid });
    expect((await client.request('system.status')).orphans_active).toBe(1);
  });

  test('service.orphans is a read model, service.orphan_sweep runs the policy now', async () => {
    const pool = await client.request('service.orphans');
    expect(pool.policy).toEqual({ adopt: 'adopt', limit: 0, ttl_seconds: 0, sweep_seconds: 30 });
    expect(pool).toMatchObject({ active_count: 0, busy_count: 0, over_limit: 0, orphans: [] });
    // Nothing to do under the default policy, and the pass still reports itself.
    expect(await client.request('service.orphan_sweep')).toEqual({
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
      const parent = await client2.request('service.construct', { parent_sid: 0, template: 'generic-service', name: 'p' });
      const kid = await client2.request('service.construct', { parent_sid: parent.sid, template: 'generic-task', name: 'kid' });
      // Only a terminal parent turns its surviving children into SID 0's orphans.
      await client2.request('service.stop', { sid: parent.sid });

      const pool = await client2.request('service.orphans');
      expect(pool.policy.ttl_seconds).toBe(1);
      expect(pool.active_count).toBe(1);
      expect(pool.orphans[0]).toMatchObject({ sid: kid.sid, name: 'kid', busy: false, status: 'active' });
      expect(typeof pool.orphans[0].last_activity_at).toBe('string');

      // Jump the supervisor clock instead of waiting for a real TTL.
      second.manager.orphanSupervisor.clock = () => Date.now() + 3600_000;
      const report = await client2.request('service.orphan_sweep');
      expect(report.trigger).toBe('manual');
      expect(report.evicted).toHaveLength(1);
      expect(report.evicted[0]).toMatchObject({ sid: kid.sid, from: 'active', to: 'stopped', reason: 'orphan_ttl' });
      expect(report).toMatchObject({ active_before: 1, active_after: 0, deferred: [] });
      expect((await client2.request('service.inspect', { sid: kid.sid })).status).toBe('stopped');
      expect((await client2.request('service.inspect', { sid: kid.sid })).recent_events[0]).toMatchObject({
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
    const plain = await client.request('service.tree', { agents: false });
    expect(plain.length).toBe(1);
    expect(plain[0].agent).toBeUndefined();
    const rows = await client.request('service.tree');
    expect(rows[0].agent).toEqual({ provider: 'mock', running: 0, agents: [] });
    // Same rows either way: only the activity field differs, so list and tree stay one read model.
    expect(rows.map((row) => row.sid)).toEqual(plain.map((row) => row.sid));
    // The agent space is runtime data: nothing persisted, nothing to list yet.
    expect(await client.request('task.agents_list')).toEqual([]);
    expect(await client.request('task.agents_list', { all: true })).toEqual([]);
  });

  test('notifications and multiple requests on one connection', async () => {
    const frames = Buffer.concat([
      encode({ jsonrpc: '2.0', method: 'service.construct', params: { parent_sid: 0, template: 'generic-task' } }),
      encode({ jsonrpc: '2.0', id: 'next', method: 'service.list' }),
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
        contextSid(messages);
        gate.resolve();
        await release.promise;
        return new AgentResponse('survived');
      },
    };
    // A submission is what a caller abandons here: the parse task it starts on
    // SID 0 keeps running, and the intension still records the outcome.
    const socket = await Bun.connect({
      unix: server.path,
      socket: {
        open: (handle) => handle.write(encode({
          jsonrpc: '2.0', id: 'detached', method: 'intent.submit', params: { content: 'work' },
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
    const row = manager.intensionList(null, undefined, true)[0];
    const task = manager.repository.getTask(row.parse_task_id);
    expect(task.sid).toBe(0);
    expect(runtime.isBusy(0)).toBe(true);
    release.resolve();
    await runtime.active.get(task.id).promise;
    expect(manager.repository.taskCalls(task.id)[0].status).toBe('succeeded');
    expect(manager.intensionInspect(row.id)).toMatchObject({ status: 'settled', response: 'survived' });
    expect(LushError.name).toBe('LushError');
  });
});
