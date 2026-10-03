/** Newline-delimited JSON-RPC over a Unix domain socket. */
import fs from 'node:fs';
import { createLogger } from '../log.js';
import { LushError } from '../core/types.js';
import { MAX_FRAME, encode, errorResponse, parseRequest } from './protocol.js';
import { createWriter } from '../socket_io.js';

export const log = createLogger('lush.rpc.server');
const NL = 0x0a;

/**
 * Per-connection transfer budget. A frame is only parsed and queued while the
 * connection is below the in-flight cap; a client that never reads its replies
 * is closed after `outputStallMs` above the pending-output budget. These are
 * memory bounds, not a global concurrency limit: sibling connections are
 * independent and a legitimate large response still leaves in one frame.
 */
export const RPC_BUDGET = {
  /** Parsed-but-unfinished frames allowed per connection before pausing reads. */
  maxInFlight: 32,
  /** Resume reads once queued frames fall back to this level. */
  inFlightLowWater: 8,
  /** Bytes queued for a peer that is not reading before a stall timer starts. */
  maxPendingOutputBytes: 8 * 1024 * 1024,
  /** How long a peer may stay above the output budget before the connection closes. */
  outputStallMs: 30_000,
  /** Grace period for delivering "not executed" errors before forcing the socket shut. */
  closeGraceMs: 1_000,
  /** Error code for a request the server refused without executing; safe to retry. */
  notExecutedCode: -32022,
};

export class RPCServer {
  constructor(path, dispatcher, options = {}) {
    this.path = path;
    this.dispatcher = dispatcher;
    this.server = null;
    this.budget = { ...RPC_BUDGET, ...options };
    /** socket -> connection state */
    this.connections = new Map();
  }

  async start() {
    this.server = Bun.listen({
      unix: this.path,
      socket: {
        open: (socket) => this._open(socket),
        data: (socket, chunk) => this._data(socket, chunk),
        close: (socket) => this._onClose(socket),
        error: (socket, err) => {
          this.connections.get(socket)?.writer.fail();
          log.error(`socket error: ${err?.message ?? err}`);
        },
        drain: (socket) => {
          const conn = this.connections.get(socket);
          if (!conn) return;
          conn.writer.drain();
          this._notePending(socket, conn);
        },
      },
    });
    fs.chmodSync(this.path, 0o600);
  }

  _open(socket) {
    this.connections.set(socket, {
      buffer: Buffer.alloc(0),
      chain: Promise.resolve(),
      closed: false,
      inFlight: 0,
      pauseReasons: new Set(),
      paused: false,
      stallTimer: null,
      terminateTimer: null,
      writer: createWriter(socket),
    });
  }

  _onClose(socket) {
    const conn = this.connections.get(socket);
    if (conn) {
      this._clearTimers(conn);
      conn.writer.fail();
    }
    this.connections.delete(socket);
  }

  _clearTimers(conn) {
    if (conn.stallTimer) { clearTimeout(conn.stallTimer); conn.stallTimer = null; }
    if (conn.terminateTimer) { clearTimeout(conn.terminateTimer); conn.terminateTimer = null; }
  }

  _write(socket, conn, frame) {
    if (conn.closed) return;
    conn.writer.write(frame);
    this._notePending(socket, conn);
  }

  _close(socket, conn) {
    if (conn.closed) return;
    conn.closed = true;
    this._clearTimers(conn);
    conn.writer.end();
  }

  /** Pause/resume reading so queued work and pending replies stay bounded. */
  _updatePause(socket, conn) {
    if (conn.closed) return;
    const shouldPause = conn.pauseReasons.size > 0;
    if (shouldPause === conn.paused) return;
    conn.paused = shouldPause;
    try {
      if (shouldPause) socket.pause?.();
      else socket.resume?.();
    } catch { /* peer vanished; close/error handlers will clean up */ }
    if (!shouldPause) this._pump(socket, conn);
  }

  /**
   * Output budget: a peer that stops reading must not grow daemon memory without
   * limit. Above the budget we stop accepting new work; if it does not drain in
   * time the connection is closed. Replies already written are lost, so in-flight
   * requests have an unknown result, while frames still buffered were never
   * executed and get an explicit "not executed" error the client may retry.
   */
  _notePending(socket, conn) {
    if (conn.closed) return;
    const over = conn.writer.pendingBytes > this.budget.maxPendingOutputBytes;
    if (over) {
      conn.pauseReasons.add('output');
      if (!conn.stallTimer) {
        conn.stallTimer = setTimeout(() => this._stalled(socket, conn), this.budget.outputStallMs);
      }
    } else {
      conn.pauseReasons.delete('output');
      if (conn.stallTimer) { clearTimeout(conn.stallTimer); conn.stallTimer = null; }
    }
    this._updatePause(socket, conn);
  }

  _data(socket, chunk) {
    const conn = this.connections.get(socket);
    if (!conn || conn.closed) return;
    conn.buffer = Buffer.concat([conn.buffer, Buffer.from(chunk)]);
    this._pump(socket, conn);
  }

  /**
   * Parse and queue complete frames while below the in-flight cap. Frames left
   * in the buffer were never executed; reads resume when the queue drains.
   */
  _pump(socket, conn) {
    if (conn.closed || conn.pauseReasons.size) return;
    for (;;) {
      if (conn.inFlight >= this.budget.maxInFlight) {
        // Only pause when more work is actually pending; otherwise the queue
        // drains to the low-water mark and resumes normally.
        if (conn.buffer.includes(NL)) {
          conn.pauseReasons.add('input');
          this._updatePause(socket, conn);
        }
        return;
      }
      const index = conn.buffer.indexOf(NL);
      if (index === -1) {
        if (conn.buffer.length > MAX_FRAME) {
          this._write(socket, conn, encode(errorResponse(null, -32600, 'RPC frame too large')));
          this._close(socket, conn);
        }
        return;
      }
      const frame = Buffer.from(conn.buffer.subarray(0, index + 1));
      conn.buffer = Buffer.from(conn.buffer.subarray(index + 1));
      if (frame.length > MAX_FRAME) {
        this._write(socket, conn, encode(errorResponse(null, -32600, 'invalid RPC frame')));
        this._close(socket, conn);
        return;
      }
      conn.inFlight += 1;
      // One request at a time per connection; different connections run concurrently.
      // The catch keeps the chain alive if releasing the frame ever throws.
      conn.chain = conn.chain.then(() => this._handle(socket, conn, frame))
        .catch(error => log.exception('RPC frame handling failed', error));
    }
  }

  _release(socket, conn) {
    conn.inFlight = Math.max(0, conn.inFlight - 1);
    if (conn.inFlight <= this.budget.inFlightLowWater) conn.pauseReasons.delete('input');
    this._updatePause(socket, conn);
  }

  /** The peer has not read its replies for too long: refuse pending work, then close. */
  _stalled(socket, conn) {
    conn.stallTimer = null;
    if (conn.closed) return;
    // Complete frames still in the buffer were never parsed, so never executed:
    // answer them so the client can retry safely instead of assuming success.
    const refused = [];
    for (;;) {
      const index = conn.buffer.indexOf(NL);
      if (index === -1) break;
      refused.push(Buffer.from(conn.buffer.subarray(0, index + 1)));
      conn.buffer = Buffer.from(conn.buffer.subarray(index + 1));
    }
    conn.buffer = Buffer.alloc(0);
    for (const frame of refused) {
      let requestId = null;
      try {
        const request = parseRequest(frame);
        if (Object.hasOwn(request, 'id')) requestId = request.id ?? null;
      } catch { requestId = null; }
      if (requestId === null) continue;
      conn.writer.write(encode(errorResponse(requestId, this.budget.notExecutedCode,
        'connection queue full; request was not executed; safe to retry')));
    }
    this._close(socket, conn);
    // A peer that is not reading may never accept the errors; guarantee closure.
    conn.terminateTimer = setTimeout(() => {
      conn.terminateTimer = null;
      try { socket.terminate?.(); } catch { /* already closed */ }
    }, this.budget.closeGraceMs);
  }

  async _handle(socket, conn, frame) {
    try {
      if (conn.closed) return;
      let requestId = null;
      let notification = false;
      let response;
      try {
        const request = parseRequest(frame);
        requestId = request.id ?? null;
        notification = !Object.hasOwn(request, 'id');
        const result = await this.dispatcher.dispatch(request.method,
          request.params === undefined ? {} : request.params);
        response = { jsonrpc: '2.0', id: requestId, result };
      } catch (err) {
        if (err instanceof LushError) {
          response = errorResponse(requestId, err.code, err.message);
        } else {
          log.exception('RPC handler error', err);
          response = errorResponse(requestId, -32603, 'internal error; see daemon.log');
        }
      }
      if (!notification) {
        let out;
        try {
          out = encode(response);
        } catch (err) {
          out = encode(errorResponse(requestId, err.code ?? -32603, err.message));
        }
        this._write(socket, conn, out);
      }
      if (this.dispatcher.stopping.isRequested()) {
        this._close(socket, conn);
        // Only now may the daemon start tearing down: the reply is already queued.
        this.dispatcher.stopping.set();
      }
    } finally {
      this._release(socket, conn);
    }
  }

  async close() {
    if (this.server) {
      const server = this.server;
      this.server = null;
      // Keep existing connections: their queued bytes still have to reach the clients.
      server.stop(false);
    }
    for (const [socket, conn] of [...this.connections]) this._close(socket, conn);
    this.connections.clear();
  }
}
