import { LushError, isPlainObject, jsonLoad } from '../core/types.js';
import { createWriter } from '../socket_io.js';
import { encode, MAX_FRAME } from './protocol.js';

export class RPCClient {
  constructor(path, timeout = 130) {
    this.path = path;
    this.timeout = timeout;
  }

  async request(method, params = {}) {
    const frame = encode({ jsonrpc: '2.0', id: 1, method, params });
    let writer = null;
    let buffer = Buffer.alloc(0);
    let settled = false;
    let timer = null;
    let resolveLine = () => {};
    let rejectLine = () => {};
    const line = new Promise((resolve, reject) => {
      resolveLine = resolve;
      rejectLine = reject;
    });
    line.catch(() => {}); // handled below via await

    const finish = (action) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      action();
    };

    timer = setTimeout(() => {
      finish(() => {
        writer?.end();
        rejectLine(new LushError('RPC timed out; the daemon invocation may still be running; inspect before retrying', -32021));
      });
    }, this.timeout * 1000);
    timer.unref?.();

    try {
      await Bun.connect({
        unix: this.path,
        socket: {
          open: (handle) => {
            writer = createWriter(handle);
            try {
              writer.write(frame);
            } catch (err) {
              finish(() => rejectLine(err));
            }
          },
          data: (handle, chunk) => {
            buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
            if (buffer.length > MAX_FRAME) {
              finish(() => { writer.end(); rejectLine(new LushError('daemon response too large')); });
              return;
            }
            const index = buffer.indexOf(0x0a);
            if (index === -1) return;
            const payload = buffer.subarray(0, index).toString('utf8');
            finish(() => {
              writer.end();
              resolveLine(payload);
            });
          },
          close: () => finish(() => rejectLine(new LushError('daemon disconnected', -32021))),
          error: (_handle, err) => finish(() => rejectLine(err)),
          drain: () => writer?.drain(),
        },
      });
    } catch (err) {
      finish(() => rejectLine(new LushError(
        `cannot connect to lushd at ${this.path}; run 'lush daemon start' (${err.message})`, -32004)));
    }

    const raw = await line;
    let response;
    try {
      response = jsonLoad(raw);
    } catch {
      throw new LushError('invalid daemon response', -32600);
    }
    if (!isPlainObject(response) || response.jsonrpc !== '2.0' || response.id !== 1) {
      throw new LushError('invalid daemon response', -32600);
    }
    if (Object.hasOwn(response, 'error')) {
      const error = response.error;
      if (!isPlainObject(error) || typeof error.message !== 'string') {
        throw new LushError('invalid daemon response', -32600);
      }
      throw new LushError(error.message, Number.isInteger(error.code) ? error.code : -32009);
    }
    return response.result;
  }
}
