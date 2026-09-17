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
import { cleanup, contextPid, deferred, expectRejection, system, tmpdir } from './helpers.js';

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
    const preview = await client.request('process.call', { pid, prompt: 'who am I?', dry_run: true });
    expect(preview.dry_run).toBe(true);
    expect(preview.agent).toBe('mock');
    expect(preview.command).toBeNull();
    expect((await client.request('process.inspect', { pid })).context.message_count).toBe(0);
    await client.request('process.call', { pid, prompt: 'who am I?' });
    const info = await client.request('process.inspect', { pid });
    expect(info.context.message_count).toBe(2);
    const page = await client.request('process.history', { pid, limit: 1 });
    const page2 = await client.request('process.history', { pid, after: page.next_after });
    expect(page2.messages.length).toBe(1);
    await client.request('process.complete', { pid, result: 'done' });
    await client.request('process.reclaim', { pid });
    expect((await client.request('process.inspect', { pid })).status).toBe('reclaimed');
    expect(fs.statSync(server.path).mode & 0o777).toBe(0o600);
  });

  test('error codes and parameter validation', async () => {
    for (const [method, params, code] of [
      ['not.real', {}, -32601],
      ['process.inspect', {}, -32602],
      ['process.inspect', { pid: 0, extra: 1 }, -32602],
      ['process.inspect', { pid: true }, -32602],
      ['process.inspect', { pid: 999 }, -32004],
      ['process.spawn', { parent_pid: 0, template: [] }, -32602],
      ['process.call', { pid: 0, prompt: 'hi', dry_run: 'yes' }, -32602],
      ['process.call', { pid: 0, prompt: 'hi', extra: 1 }, -32602],
      ['process.kill', { pid: 0 }, -32009],
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
          jsonrpc: '2.0', id: 'detached', method: 'process.call', params: { pid, prompt: 'work' },
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
    expect(runtime.isBusy(pid)).toBe(true);
    release.resolve();
    await runtime.active.get(pid).promise;
    expect(manager.inspect(pid).recent_calls[0].status).toBe('succeeded');
    expect(LushError.name).toBe('LushError');
  });
});
