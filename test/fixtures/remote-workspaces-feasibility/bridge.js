import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { authorize } from './registry.js';

// The parent owns this binding; it is never included in a model tool schema/result.
export class RunnerBridge extends EventEmitter {
  constructor({ entry, root, home, binding }) {
    super();
    this.binding = binding;
    this.pending = new Map();
    this.state = 'connected';
    this.audit = [];
    this.stderr = '';
    this.child = spawn(process.execPath, [fileURLToPath(new URL('./runner.js', import.meta.url)), entry, root], {
      cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
      // Deliberately do not inherit LUSH_*, provider credentials or host PI_*.
      env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: home, PI_CODING_AGENT_DIR: home },
    });
    this.child.stderr.on('data', data => { this.stderr += data; });
    this.child.stdin.on('error', () => this.disconnected());
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let frame;
      try { frame = JSON.parse(line); } catch { this.disconnected(); return; }
      if (frame.event) {
        this.audit.push(frame);
        this.emit(frame.event, frame);
        return;
      }
      const request = this.pending.get(frame.id);
      if (!request) return;
      if (frame.update) { request.onUpdate?.(frame.update); return; }
      this.pending.delete(frame.id);
      request.cleanup();
      if (frame.error) request.reject(new Error(frame.error));
      else request.resolve(frame.result);
    });
    this.exit = new Promise(resolve => this.child.once('close', (code, signal) => {
      this.disconnected(); this.lines.close(); resolve({ code, signal });
    }));
    this.child.on('error', error => { this.stderr += error.message; this.disconnected(); });
    this.child.stdin.write(JSON.stringify({ method: 'bind', binding }) + '\n');
  }
  disconnected() {
    if (this.state === 'connected') this.state = 'unknown';
    for (const request of this.pending.values()) {
      request.cleanup(); request.reject(new Error('Runner state unknown; not replayed'));
    }
    this.pending.clear();
  }
  call(method, payload = {}, options = {}) {
    const frame = { ...this.binding, ...payload, method, id: randomUUID() };
    try {
      authorize(frame, this.binding);
      if (this.state !== 'connected') throw new Error('Runner state unknown; new operations blocked');
      if (options.signal?.aborted) throw new Error('aborted before admission');
    } catch (error) { return Promise.reject(error); }
    return this.send(frame, options);
  }
  // Tests send invalid bindings through the actual transport to exercise Runner authorization too.
  send(frame, { signal, onUpdate } = {}) {
    return new Promise((resolve, reject) => {
      const abort = () => this.child.stdin.write(JSON.stringify({ ...this.binding, method: 'cancel', target: frame.id }) + '\n');
      this.pending.set(frame.id, { resolve, reject, onUpdate,
        cleanup: () => signal?.removeEventListener('abort', abort) });
      signal?.addEventListener('abort', abort, { once: true });
      this.child.stdin.write(JSON.stringify(frame) + '\n');
      // Cancellation waits for the Runner response, not just local AbortSignal delivery.
      if (signal?.aborted) abort();
    });
  }
  async close() {
    if (this.state === 'connected') {
      await this.call('shutdown');
      this.state = 'closed';
      this.child.stdin.end();
    } else this.child.stdin.destroy();
    return this.exit;
  }
}
