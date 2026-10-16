import { spawn } from 'node:child_process';
import { LIMITS, PROTOCOL_VERSION, RunnerError, check, integer } from './protocol.js';

/** Bounded NDJSON decoder. A malformed/oversized frame invalidates the connection. */
export class FrameDecoder {
  constructor(onFrame, max_bytes = LIMITS.frame_bytes) {
    this.onFrame = onFrame; this.max_bytes = max_bytes; this.buffer = Buffer.alloc(0);
  }
  push(chunk) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    for (let i = 0; i <= data.length; i++) {
      if (i < data.length && data[i] !== 10) continue;
      const part = data.subarray(start, i); start = i + 1;
      check(this.buffer.length + part.length <= this.max_bytes, 'LIMIT_EXCEEDED', 'Runner frame exceeds limit');
      if (part.length) this.buffer = Buffer.concat([this.buffer, part]);
      if (i === data.length) break;
      check(this.buffer.length > 0, 'INVALID_REQUEST', 'Empty Runner frame');
      let frame;
      try { frame = JSON.parse(this.buffer.toString('utf8')); }
      catch { throw new RunnerError('INVALID_REQUEST', 'Malformed Runner frame'); }
      this.buffer = Buffer.alloc(0); this.onFrame(frame);
    }
  }
  end() { check(this.buffer.length === 0, 'UNKNOWN', 'Runner frame was incomplete'); }
}

const safeEnvironment = () => Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'SSH_AUTH_SOCK']
  .filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));

/** Explicit subprocess adapter; never selected as a fallback for SSH failure. */
export class StdioTransport {
  constructor({ command, args = [], cwd, env = {}, request_ms = LIMITS.request_ms, max_pending = LIMITS.max_pending }) {
    check(typeof command === 'string' && command.length > 0 && Array.isArray(args) && args.every(arg => typeof arg === 'string'), 'INVALID_REQUEST', 'Invalid subprocess transport');
    this.request_ms = integer(request_ms, 'request_ms', 1, LIMITS.max_command_ms);
    this.max_pending = integer(max_pending, 'max_pending', 1, LIMITS.max_pending);
    this.pending = new Map(); this.state = 'connected'; this.sequence = Promise.resolve();
    this.child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    // Diagnostic bytes are deliberately not exposed: remote SSH/errors may contain private config.
    this.diagnostic_bytes = 0;
    this.child.stderr.on('data', chunk => { this.diagnostic_bytes = Math.min(this.diagnostic_bytes + chunk.length, 65536); });
    this.decoder = new FrameDecoder(frame => this.receive(frame));
    this.child.stdout.on('data', chunk => { try { this.decoder.push(chunk); } catch { this.unknown(); } });
    this.child.stdout.on('end', () => { try { this.decoder.end(); } catch { this.unknown(); } });
    this.child.stdin.on('error', () => this.unknown());
    this.child.on('error', () => this.unknown());
    this.exit = new Promise(resolve => this.child.once('close', (code, signal) => {
      if (this.state !== 'closed') this.unknown();
      resolve({ code, signal });
    }));
  }
  receive(frame) {
    check(frame && frame.version === PROTOCOL_VERSION && typeof frame.request_id === 'string'
      && ((Object.hasOwn(frame, 'result')) !== Object.hasOwn(frame, 'error')), 'INVALID_REQUEST', 'Invalid Runner response');
    const pending = this.pending.get(frame.request_id);
    // Duplicated or stale response is not a new result. No replay is triggered.
    if (!pending) return;
    this.pending.delete(frame.request_id); pending.cleanup(); pending.resolve(frame);
  }
  unknown() {
    if (this.state === 'closed') return;
    this.state = 'unknown';
    for (const pending of this.pending.values()) {
      pending.cleanup(); pending.reject(new RunnerError('UNKNOWN', 'Runner connection outcome is unknown; query the same request ID after reconciliation'));
    }
    this.pending.clear();
    this.child.stdin.destroy(); // EOF is a stop request, not proof that remote work stopped.
    this.child.kill('SIGTERM');
  }
  request(frame, { signal, timeout_ms = this.request_ms } = {}) {
    if (this.state !== 'connected') return Promise.reject(new RunnerError('UNKNOWN', 'Runner connection is not usable'));
    if (signal?.aborted) return Promise.reject(new RunnerError('CANCELLED', 'Request cancelled before sending'));
    try {
      check(this.pending.size < this.max_pending, 'BUSY', 'Too many pending Runner requests');
      check(!this.pending.has(frame.request_id), 'CONFLICT', 'Request ID already in flight');
      integer(timeout_ms, 'timeout_ms', 1, LIMITS.max_command_ms);
      const line = JSON.stringify(frame) + '\n';
      check(Buffer.byteLength(line) <= LIMITS.frame_bytes, 'LIMIT_EXCEEDED', 'Runner frame exceeds limit');
      return new Promise((resolve, reject) => {
        let sent = false;
        const abort = () => {
          if (sent) this.unknown();
          else { this.pending.delete(frame.request_id); cleanup(); reject(new RunnerError('CANCELLED', 'Request cancelled before sending')); }
        };
        const timer = setTimeout(() => this.unknown(), timeout_ms);
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
        this.pending.set(frame.request_id, { resolve, reject, cleanup });
        signal?.addEventListener('abort', abort, { once: true });
        this.sequence = this.sequence.then(() => new Promise(done => {
          if (this.state !== 'connected' || !this.pending.has(frame.request_id)) return done();
          sent = true;
          this.child.stdin.write(line, error => { if (error) this.unknown(); done(); });
        }));
        if (signal?.aborted) abort();
      });
    } catch (error) { return Promise.reject(error); }
  }
  async close() {
    if (this.state === 'closed') return this.exit;
    // Closing any in-flight request cannot convert its unknown effect into success.
    if (this.pending.size) this.unknown();
    else if (this.state === 'connected') { this.state = 'closed'; this.child.stdin.end(); }
    const timer = setTimeout(() => { this.child.kill('SIGKILL'); }, this.request_ms);
    try { return await this.exit; } finally { clearTimeout(timer); }
  }
}

export function sshArguments(ssh_alias) {
  // Alias is one config lookup token, not a destination/user/option/command expression.
  check(typeof ssh_alias === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(ssh_alias), 'INVALID_REQUEST', 'Invalid SSH alias');
  return ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ClearAllForwardings=yes',
    '-o', 'PermitLocalCommand=no', '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'ConnectTimeout=10',
    '--', ssh_alias, 'lush-runner serve'];
}
export class SshTransport extends StdioTransport {
  constructor({ ssh_alias, request_ms, max_pending }) {
    super({ command: 'ssh', args: sshArguments(ssh_alias), env: safeEnvironment(), request_ms, max_pending });
  }
}
