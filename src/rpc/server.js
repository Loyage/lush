/** Newline-delimited JSON-RPC over a Unix domain socket. */
import fs from 'node:fs';
import { createLogger } from '../log.js';
import { LushError } from '../core/types.js';
import { MAX_FRAME, encode, errorResponse, parseRequest } from './protocol.js';
import { createWriter } from '../socket_io.js';

export const log = createLogger('lush.rpc.server');
const NL = 0x0a;

export class RPCServer {
  constructor(path, dispatcher) {
    this.path = path;
    this.dispatcher = dispatcher;
    this.server = null;
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
        drain: (socket) => this.connections.get(socket)?.writer.drain(),
      },
    });
    fs.chmodSync(this.path, 0o600);
  }

  _open(socket) {
    this.connections.set(socket, {
      buffer: Buffer.alloc(0),
      chain: Promise.resolve(),
      closed: false,
      writer: createWriter(socket),
    });
  }

  _onClose(socket) {
    const conn = this.connections.get(socket);
    if (conn) conn.writer.fail();
    this.connections.delete(socket);
  }

  _write(socket, conn, frame) {
    if (conn.closed) return;
    conn.writer.write(frame);
  }

  _close(socket, conn) {
    if (conn.closed) return;
    conn.closed = true;
    conn.writer.end();
  }

  _data(socket, chunk) {
    const conn = this.connections.get(socket);
    if (!conn || conn.closed) return;
    conn.buffer = Buffer.concat([conn.buffer, Buffer.from(chunk)]);
    for (;;) {
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
      // One request at a time per connection; different connections run concurrently.
      conn.chain = conn.chain.then(() => this._handle(socket, conn, frame));
    }
  }

  async _handle(socket, conn, frame) {
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
