import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp, until } from './helpers.js';
import { RPCServer, RPC_BUDGET } from '../src/rpc/server.js';
import { NOT_EXECUTED_CODE } from '../src/rpc/client.js';
import { createWriter } from '../src/socket_io.js';
import { encode, errorResponse } from '../src/rpc/protocol.js';

function dispatcher(handler) {
  return { stopping: { isRequested: () => false, set() {} }, dispatch: handler };
}

function request(id, n) { return encode({ jsonrpc: '2.0', id, method: 'echo', params: { n } }); }

async function startServer(dispatch, options = {}) {
  const dir = temp();
  const socketPath = path.join(dir, 'rpc.sock');
  const server = new RPCServer(socketPath, dispatcher(dispatch), options);
  await server.start();
  return { server, socketPath, dir, async close() {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  } };
}

/** Raw client that decodes newline-delimited replies without retrying anything. */
async function rawClient(socketPath, { open } = {}) {
  let buffer = Buffer.alloc(0);
  const lines = [];
  const waiters = [];
  const push = line => { const waiter = waiters.shift(); if (waiter) waiter(line); else lines.push(line); };
  const socket = await Bun.connect({
    unix: socketPath,
    socket: {
      open: handle => open?.(handle),
      data: (_handle, chunk) => {
        buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
        for (;;) {
          const index = buffer.indexOf(0x0a);
          if (index === -1) break;
          push(buffer.subarray(0, index).toString('utf8'));
          buffer = buffer.subarray(index + 1);
        }
      },
      drain() {},
      error() {},
      close: () => { for (const waiter of waiters.splice(0)) waiter(null); },
    },
  });
  return {
    socket,
    write: value => socket.write(value),
    async next(timeout = 4000) {
      if (lines.length) return JSON.parse(lines.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no reply before timeout')), timeout);
        waiters.push(line => { clearTimeout(timer); resolve(line === null ? null : JSON.parse(line)); });
      });
    },
    end: () => { try { socket.end(); } catch { /* already closed */ } },
  };
}

test('writer reports queued bytes across partial writes and drains to zero', () => {
  let accepted = 0;
  let limit = 10;
  const socket = {
    write(chunk) { const take = Math.max(0, Math.min(chunk.length, limit - accepted)); accepted += take; return take; },
    end() { socket.ended = true; },
  };
  const writer = createWriter(socket);
  expect(writer.pendingBytes).toBe(0);
  writer.write(Buffer.from('abcdefghijklmnop'));
  expect(writer.pendingBytes).toBe(6);
  expect(writer.pending).toBe(1);
  limit = 100; // the peer starts reading again
  writer.drain();
  expect(writer.pendingBytes).toBe(0);
  expect(writer.pending).toBe(0);
  writer.fail();
  expect(writer.pendingBytes).toBe(0);
});

test('a connection pauses at the in-flight cap and resumes without losing or reordering frames', async () => {
  const executed = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await startServer(async (method, params) => { executed.push(params.n); await gate; return { n: params.n }; },
    { maxInFlight: 8, inFlightLowWater: 2, outputStallMs: 60000 });
  try {
    const client = await rawClient(f.socketPath);
    client.write(Buffer.concat(Array.from({ length: 12 }, (_value, index) => request(index + 1, index + 1))));
    await until(() => [...f.server.connections.values()].some(conn => conn.inFlight >= 8));
    const conn = [...f.server.connections.values()][0];
    // Only the cap fits into the parse queue; the rest stays unread in the buffer.
    expect(conn.inFlight).toBe(8);
    expect(conn.pauseReasons.has('input')).toBe(true);
    expect(conn.paused).toBe(true);
    expect(Buffer.from(conn.buffer).toString().split('\n').filter(Boolean).length).toBeLessThanOrEqual(4);
    expect(executed.length).toBe(1); // the chain is gated, so queued frames never started

    release();
    const replies = [];
    for (let index = 0; index < 12; index++) replies.push(await client.next());
    expect(replies.map(reply => reply.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(executed).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    await until(() => conn.paused === false && conn.inFlight === 0);
    client.end();
  } finally { await f.close(); }
});

test('output backpressure refuses never-executed frames with a retry-safe error', async () => {
  const executed = [];
  const f = await startServer(async (method, params) => { executed.push(params.n); return { n: params.n }; },
    { maxPendingOutputBytes: 20, outputStallMs: 25, closeGraceMs: 30 });
  try {
    const written = [];
    let blocked = true;
    const fake = {
      pause() {}, resume() {},
      write(chunk) { written.push(Buffer.from(chunk)); return blocked ? 0 : chunk.length; },
      end() {},
      terminate() { fake.terminated = true; },
    };
    f.server._open(fake);
    const conn = f.server.connections.get(fake);
    f.server._data(fake, Buffer.concat([request(1, 1), request(2, 2)]));
    await until(() => conn.pauseReasons.has('output'));
    // These arrive while replies are stuck: they are never parsed or executed.
    f.server._data(fake, Buffer.concat([request(3, 3), request(4, 4)]));
    await until(() => conn.closed);
    await until(() => fake.terminated === true);
    // The peer starts reading again during the grace window: the queue (and the
    // refusals written just before closing) finally reaches it.
    blocked = false;
    conn.writer.drain();

    const responses = [...new Set(written.map(chunk => chunk.toString('utf8')))].map(line => JSON.parse(line));
    expect(executed).toEqual([1, 2]); // frames 3 and 4 were never executed
    expect(responses.filter(reply => reply.id === 1 && reply.result)).toHaveLength(1);
    expect(responses.filter(reply => reply.id === 2 && reply.result)).toHaveLength(1);
    for (const id of [3, 4]) {
      const refusal = responses.find(reply => reply.id === id && reply.error);
      expect(refusal.error.code).toBe(RPC_BUDGET.notExecutedCode);
      expect(refusal.error.message).toContain('not executed');
      expect(refusal.error.message).toContain('safe to retry');
      expect(refusal.result).toBeUndefined();
    }
    // Dispatched replies were already queued to an unreading peer: their result is
    // unknown, so the server must not claim they were not executed.
    expect(responses.some(reply => reply.error && [1, 2].includes(reply.id))).toBe(false);
    expect(executed).toEqual([1, 2]);
    expect(conn.closed).toBe(true);
  } finally { await f.close(); }
});

test('a legal large response is delivered in full and does not trip the output budget', async () => {
  const payload = 'x'.repeat(200 * 1024);
  const f = await startServer(async () => ({ payload }), { maxPendingOutputBytes: 64 * 1024, outputStallMs: 2000 });
  try {
    const client = await rawClient(f.socketPath);
    client.write(request(1, 1));
    const reply = await client.next();
    expect(reply.error).toBeUndefined();
    expect(reply.result.payload.length).toBe(payload.length);
    // The connection stays open for the next bounded request.
    client.write(request(2, 2));
    expect((await client.next()).id).toBe(2);
    expect(f.server.connections.size).toBe(1);
    client.end();
  } finally { await f.close(); }
});

test('one stalled connection does not block or close a healthy sibling', async () => {
  const payload = 'y'.repeat(128 * 1024);
  const f = await startServer(async (_method, params) => ({ n: params.n, payload }),
    { maxPendingOutputBytes: 64 * 1024, outputStallMs: 300, closeGraceMs: 60 });
  try {
    // A never reads: pausing its socket lets the daemon's reply queue exceed budget.
    const stalled = await rawClient(f.socketPath, { open: handle => handle.pause() });
    for (let index = 1; index <= 16; index++) stalled.write(request(index, index));
    await until(() => [...f.server.connections.values()].some(conn => conn.pauseReasons.has('output')));

    const healthy = await rawClient(f.socketPath);
    healthy.write(request(1, 1));
    const reply = await healthy.next();
    expect(reply.result).toMatchObject({ n: 1 });
    expect(reply.result.payload.length).toBe(payload.length);

    await until(() => f.server.connections.size === 1, 5000);
    healthy.write(request(2, 2));
    expect((await healthy.next()).id).toBe(2);
    healthy.end();
    stalled.end();
  } finally { await f.close(); }
});

test('the not-executed code is retry-safe while a disconnect is not', async () => {
  expect(NOT_EXECUTED_CODE).toBe(RPC_BUDGET.notExecutedCode);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let releaseDispatch;
  const dispatched = new Promise(resolve => { releaseDispatch = resolve; });
  const f = await startServer(async (_method, params) => {
    if (params.n === 8) { releaseDispatch(); await gate; }
    return { n: params.n };
  }, { outputStallMs: 60000 });
  try {
    const { RPCClient } = await import('../src/rpc/client.js');
    const client = new RPCClient(f.socketPath, 10);
    expect(await client.request('echo', { n: 7 })).toEqual({ n: 7 });
    const pending = client.request('echo', { n: 8 });
    await dispatched;
    await f.server.close();
    // A closed socket cannot prove the request never ran, so it is not retry-safe.
    await expect(pending).rejects.toThrow('inspect before retrying');
    release();
  } finally { await f.close(); }
});

test('refusal frames keep a request id and never carry a result', () => {
  const refusal = errorResponse(3, RPC_BUDGET.notExecutedCode, 'connection queue full; request was not executed; safe to retry');
  expect(refusal.id).toBe(3);
  expect(refusal.result).toBeUndefined();
  expect(refusal.error.code).toBe(-32022);
});
