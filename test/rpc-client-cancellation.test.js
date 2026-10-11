import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RPCClient } from '../src/rpc/client.js';
import { UIClient } from '../src/ui/client.js';
import { encode } from '../src/rpc/protocol.js';

async function withServer(action, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-rpc-cancel-'));
  const socket = path.join(dir, 'rpc.sock'), requests = [], closed = Promise.withResolvers();
  const server = Bun.listen({ unix: socket, socket: {
    data(handle, bytes) { const request = JSON.parse(bytes.toString()); requests.push(request); action(handle, request); },
    close() { closed.resolve(); }, error() {},
  } });
  try { await run(socket, requests, closed.promise); }
  finally { server.stop(true); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('a pre-aborted client request does not connect or encode/send any request', async () => {
  const controller = new AbortController(); controller.abort();
  const client = new RPCClient('/no-such-socket');
  let error;
  try { await client.request('worker.transcript_page', { cyclic: null }, { signal: controller.signal }); }
  catch (value) { error = value; }
  expect(error.name).toBe('AbortError');
  expect(error.message).toContain('inspect before retrying');
});

test('abort immediately closes an in-flight connection and does not retry or cancel the daemon operation', async () => {
  const controller = new AbortController(); let processed = false;
  await withServer(() => { processed = true; controller.abort(); }, async (socket, requests, closed) => {
    const client = new RPCClient(socket, 30), started = performance.now();
    await expect(client.request('worker.transcript_page', { id: 7, seq: 1, offset: 0 }, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    await closed;
    expect(performance.now() - started).toBeLessThan(1000);
    expect(processed).toBe(true);
    expect(requests).toEqual([{ jsonrpc: '2.0', id: 1, method: 'worker.transcript_page', params: { id: 7, seq: 1, offset: 0 } }]);
  });
});

test('normal response removes the abort listener; later abort does not change a completed result', async () => {
  const controller = new AbortController(); let added = 0, removed = 0;
  const signal = controller.signal, add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (...args) => { added++; return add(...args); };
  signal.removeEventListener = (...args) => { removed++; return remove(...args); };
  await withServer((handle, request) => handle.write(encode({ jsonrpc: '2.0', id: request.id, result: 'ok' })), async (socket, requests) => {
    expect(await new RPCClient(socket).request('echo', {}, { signal })).toBe('ok');
    controller.abort();
    expect({ added, removed }).toEqual({ added: 1, removed: 1 });
    expect(requests).toHaveLength(1);
  });
});

test('UIClient forwards the local cancellation option without serializing it into params', async () => {
  const controller = new AbortController();
  await withServer(() => controller.abort(), async (socket, requests, closed) => {
    const client = new UIClient({ socket });
    await expect(client.request('worker.transcript_page', { id: 7, seq: 1, offset: 0 }, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    await closed;
    expect(requests[0].params).toEqual({ id: 7, seq: 1, offset: 0 });
  });
});

test('signal-free and successful signalled calls retain the existing response/error protocol', async () => {
  await withServer((handle, request) => handle.write(encode({ jsonrpc: '2.0', id: request.id,
    ...(request.method === 'fail' ? { error: { code: -32100, message: 'fixture error' } } : { result: request.params }) })), async socket => {
    const client = new RPCClient(socket), signal = new AbortController().signal;
    expect(await client.request('echo', { value: 7 })).toEqual({ value: 7 });
    await expect(client.request('fail', {}, { signal })).rejects.toMatchObject({ code: -32100, message: 'fixture error' });
  });
});

test('timeout still rejects rather than silently retrying a potentially dispatched request', async () => {
  await withServer(() => {}, async (socket, requests) => {
    await expect(new RPCClient(socket, 0.02).request('echo')).rejects.toMatchObject({ code: -32021 });
    expect(requests).toHaveLength(1);
  });
});
