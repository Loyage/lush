import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { RunnerClient } from '../runner/client.js';
import { LIMITS, RunnerError, OPERATIONS, definitiveRunnerRejection } from '../runner/protocol.js';
import { REMOTE_BRIDGE_VERSION, REMOTE_TOOL_NAMES, REMOTE_RUNNER_METHODS, sameRemoteIdentity } from './remote-contract.js';
import { RemoteControlResources, remoteCooperate } from './remote-cooperation.js';

const MAX_FRAME = 4 * 1024 * 1024;
const MAX_TEXT = 50 * 1024;
const result = (value, extra = []) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }, ...extra], details: undefined });
function fail(code, message, details) { throw new RunnerError(code, message, details); }
function check(ok, code, message) { if (!ok) fail(code, message); }
function equalToken(a, b) {
  return typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function codePath(value, root) {
  check(typeof value === 'string' && value.length > 0 && !value.includes('\0'), 'INVALID_REQUEST', 'Expected a code path');
  if (value.startsWith('/')) {
    check(value.startsWith(root.replace(/\/$/, '') + '/'), 'UNAUTHORIZED', 'Path is outside the remote workspace');
    value = value.slice(root.replace(/\/$/, '').length + 1);
  }
  check(!value.split('/').some(p => p === '..') && !value.includes('\\'), 'UNAUTHORIZED', 'Invalid code path');
  return value.replace(/^\.\//, '');
}
/** Central-only service. client MUST be an already-handshaken RunnerClient.forRun with a granted lease.
 * identity is its exact immutable Run identity. token is ONLY the current Lush Agent token.
 * authorize({identity,token}) is synchronous and MUST recheck Project.actor, Store.assertRunnerAuthorization,
 * and latest node/project settings; throw or return false to deny. No cached authorization is sufficient.
 * cooperate({method,params,identity,token}) invokes the restricted real Dispatcher, never user authority.
 * control={directory,resources:{logicalId:absoluteReviewedTextFile}}; path is the remote logical code root.
 * Owner calls close() after SDK exit/abort and keeps unknown barriers durable. Lease renewal/revoke/release,
 * client transport ownership and Project scheduling are deliberately NOT managed here.
 */
export class RunnerToolBridge {
  #client; #token; #authorize; #cooperate; #control; #active = new Set(); #closing = false; #unknown = false;
  #server; #sockets = new Set(); #closePromise; #journal;
  constructor({ client, identity, token, authorize, cooperate, control, journal, path: root }) {
    check(client instanceof RunnerClient && sameRemoteIdentity(client.identity, identity) && client.runner_id
      && REMOTE_RUNNER_METHODS.every(method => client.capabilities?.includes(method)), 'UNAUTHORIZED', 'Bridge requires a compatible granted Run client');
    check(typeof token === 'string' && token.length >= 16 && typeof authorize === 'function' && typeof cooperate === 'function', 'UNAUTHORIZED', 'Bridge requires current Agent authorization and collaboration');
    check(typeof root === 'string' && root.startsWith('/'), 'INVALID_REQUEST', 'Remote code root is required');
    this.identity = Object.freeze({ ...identity }); this.path = root; this.#journal = journal;
    this.#client = client; this.#token = token; this.#authorize = authorize; this.#cooperate = cooperate;
    this.#control = new RemoteControlResources(control, identity.worker_id);
    this.authorize();
  }
  authorize() {
    check(sameRemoteIdentity(this.#client.identity, this.identity), 'UNAUTHORIZED', 'Run identity changed');
    let allowed;
    try { allowed = this.#authorize({ identity: this.identity, token: this.#token }); }
    catch { fail('UNAUTHORIZED', 'Current invocation is no longer authorized'); }
    check(allowed !== false && !allowed?.then, 'UNAUTHORIZED', 'Current invocation authorization failed');
  }
  async #call(method, params = {}, { cleanup = false, signal } = {}) {
    check(REMOTE_RUNNER_METHODS.includes(method), 'UNAUTHORIZED', 'Runner operation is not allowlisted');
    check(sameRemoteIdentity(this.#client.identity, this.identity), 'UNAUTHORIZED', 'Run identity changed');
    if (!cleanup) {
      this.authorize();
      check(!this.#closing && !signal?.aborted, 'CANCELLED', 'Remote invocation is stopping');
    }
    const effect = OPERATIONS[method]?.mutation;
    check(!effect || cleanup || !this.#unknown, 'UNKNOWN', 'An earlier operation is unknown; new writes are blocked');
    let receipt, sent = false, acknowledged = false;
    // Persist the exact normalized wire request before transport admission. Never abort/replay
    // a side effect to manufacture an acknowledgement, including after local persistence errors.
    try {
      const value = await this.#client.call(method, params, effect ? { before_send: request => {
        receipt = this.#journal?.prepare(request); sent = true;
      } } : {});
      acknowledged = true;
      if (effect) this.#journal?.acknowledge(receipt, value);
      return value;
    } catch (error) {
      let rejected = false;
      if (effect && sent && !acknowledged && definitiveRunnerRejection(error)) {
        try { this.#journal?.reject(receipt); rejected = true; } catch { /* Persisted prepared remains a barrier. */ }
      }
      if (effect && !rejected || ['UNKNOWN', 'UNAVAILABLE'].includes(error.code)) {
        this.#unknown = true;
        try { this.#journal?.uncertain(receipt); } catch { /* Prepared row still blocks recovery. */ }
      }
      throw error;
    }
  }
  async #context(signal) {
    const context = await this.#call('file.context', { scope: 'workspace' }, { signal });
    check(context.complete === true, 'CONTEXT_REQUIRED', 'Incomplete project rules');
    return context;
  }
  async #mutationContext(args, target, signal) {
    const context = await this.#context(signal);
    if (args.context_ack !== context.fingerprint) fail('CONTEXT_REQUIRED', 'Read current rules and pass context_ack before mutating', context);
    if (target === null) return context.fingerprint;
    const scoped = await this.#call('file.context', { path: target }, { signal });
    if (!scoped.complete || scoped.files.some(file => !context.files.some(known => known.path === file.path && known.sha256 === file.sha256)))
      fail('CONTEXT_REQUIRED', 'Project rules changed before mutation; read workspace_context again');
    return scoped.fingerprint;
  }
  async #file(target, expected, signal) {
    let page = await this.#call('file.read', { path: target, ...(expected ? { expected_sha256: expected } : {}) }, { signal });
    if (page.encoding !== 'utf8') return page;
    let text = page.text;
    while (page.truncated) {
      page = await this.#call('file.read', { path: target, format: 'text', offset: page.next_offset,
        expected_sha256: page.sha256, limit: LIMITS.output_chunk_bytes }, { signal });
      text += page.text;
      check(Buffer.byteLength(text) <= LIMITS.file_bytes, 'LIMIT_EXCEEDED', 'Remote text exceeds file limit');
    }
    return { ...page, text };
  }
  async #bash(args, signal) {
    const context_ack = await this.#mutationContext(args, null, signal);
    check(typeof args.command === 'string' && (!Object.hasOwn(args, 'timeout') || Number.isFinite(args.timeout) && args.timeout > 0), 'INVALID_REQUEST', 'Invalid shell arguments');
    const start = await this.#call('command.start', { script: args.command, context_ack, queue_ms: 30000,
      ...(args.timeout ? { command_ms: Math.max(1, Math.ceil(args.timeout * 1000)) } : {}) }, { signal });
    const execution_id = start.execution_id;
    let status, after = 0, text = '', gap = false, truncated = false, outputComplete = false, outputError = null;
    const deadline = Date.now() + Math.min(args.timeout ? args.timeout * 1000 : this.#client.budgets.timeout_ms,
      this.#client.budgets.timeout_ms) + 35000; // includes bounded Runner queue and stop time, not model waiting
    let stopping = false;
    try {
      for (;;) {
        if (signal?.aborted || this.#closing || Date.now() >= deadline) stopping = true;
        try { this.authorize(); } catch { stopping = true; }
        status = await this.#call(stopping ? 'command.cancel' : 'command.status', { execution_id }, { cleanup: stopping, signal });
        const page = await this.#call('command.output', { execution_id, after, limit: 8 }, { cleanup: stopping, signal });
        after = page.next_cursor; gap ||= Boolean(page.gap); truncated ||= Boolean(page.truncated);
        outputComplete = page.complete; outputError ||= page.output_error;
        for (const chunk of page.chunks) text += Buffer.from(chunk.data, 'base64').toString('utf8');
        if (Buffer.byteLength(text) > MAX_TEXT) { text = Buffer.from(text).subarray(-MAX_TEXT).toString('utf8'); truncated = true; }
        check(status.state !== 'unknown', 'UNKNOWN', 'Remote command stop is unknown');
        if (status.stop_confirmed && !page.has_more) break;
        check(Date.now() < deadline + 10000, 'UNKNOWN', 'Remote command did not confirm stop');
        await delay(20);
      }
    } catch (error) {
      if (error.code === 'UNKNOWN') this.#unknown = true;
      // Revocation/read failure after start must still request stop using the retained Run receipt.
      try {
        const stopped = await this.#call('command.cancel', { execution_id }, { cleanup: true });
        if (!stopped.stop_confirmed) this.#unknown = true;
      } catch { this.#unknown = true; }
      throw error;
    }
    check(status.stop_confirmed === true, 'UNKNOWN', 'Remote command stop is unknown');
    try { this.#journal?.stopped(execution_id, status); }
    catch (error) { this.#unknown = true; try { this.#journal?.uncertain(); } catch {} throw error; }
    return { ...result(text + '\n' + JSON.stringify({ execution_id, state: status.state, reason: status.reason,
      exit_code: status.exit_code, stop_confirmed: status.stop_confirmed, output_complete: outputComplete,
      gap, truncated, output_error: outputError })),
      isError: stopping || status.exit_code !== 0 || status.reason === 'timeout' || !outputComplete || gap || Boolean(outputError) };
  }
  async #tool(name, args, signal) {
    check(REMOTE_TOOL_NAMES.includes(name), 'UNAUTHORIZED', 'Tool is not registered');
    if (name === 'workspace_context') return result(await this.#context(signal));
    if (name === 'control') return result(this.#control.access(args));
    if (name === 'lushc') check(!this.#unknown, 'UNKNOWN', 'Unknown remote effects block new collaboration writes');
    if (name === 'lushc') return result(await remoteCooperate(args.argv, { identity: this.identity, token: this.#token,
      authorize: () => { this.authorize(); check(!this.#closing && !signal.aborted, 'CANCELLED', 'Invocation stopping'); },
      cooperate: this.#cooperate, control: this.#control }));
    if (name === 'bash') return this.#bash(args, signal);
    const target = codePath(args.path, this.path);
    if (name === 'read') {
      const file = await this.#file(target, args.expected_sha256, signal);
      if (file.encoding === 'base64') {
        check(file.complete && file.mime_type.startsWith('image/'), 'UNSUPPORTED', 'Only complete images or UTF-8 text are supported');
        return result({ path: target, sha256: file.sha256, size: file.size }, [{ type: 'image', data: file.data, mimeType: file.mime_type }]);
      }
      const offset = args.offset ?? 1, limit = Math.min(args.limit ?? 2000, 2000);
      check(Number.isSafeInteger(offset) && offset >= 1 && Number.isSafeInteger(limit) && limit >= 1, 'INVALID_REQUEST', 'Invalid line page');
      const lines = file.text.split('\n'), selected = lines.slice(offset - 1, offset - 1 + limit);
      let text = '', count = 0;
      for (const line of selected) {
        const next = (count ? '\n' : '') + line;
        if (Buffer.byteLength(text + next) > MAX_TEXT) break;
        text += next; count++;
      }
      // A single very long line cannot silently look like an empty successful page.
      if (!count && selected.length) fail('LIMIT_EXCEEDED', 'A single line exceeds 50 KiB; use remote bash for a bounded view');
      const truncated = offset - 1 + count < lines.length;
      return result(text + '\n' + JSON.stringify({ path: target, sha256: file.sha256, next_offset: offset + count, truncated }));
    }
    const context_ack = await this.#mutationContext(args, target, signal);
    let expected_sha256;
    try { expected_sha256 = (await this.#call('file.read', { path: target, limit: 1 }, { signal })).sha256; }
    catch (error) { if (name === 'write' && error.code === 'NOT_FOUND') expected_sha256 = null; else throw error; }
    return result(await this.#call(`file.${name}`, { path: target, expected_sha256, context_ack,
      ...(name === 'edit' ? { edits: args.edits } : { content: args.content }) }, { signal }));
  }
  async #dispatch(frame, signal) {
    check(frame?.version === REMOTE_BRIDGE_VERSION && sameRemoteIdentity(frame.identity, this.identity)
      && equalToken(frame.token, this.#token), 'UNAUTHORIZED', 'Invalid Bridge invocation');
    if (frame.method === 'barrier') return this.drain(); // stop-only channel survives permission revocation
    if (frame.method === 'idle') {
      const barrier = await this.#call('workspace.barrier', {}, { cleanup: true });
      return { ...barrier, stopped: barrier.stopped === true && !this.#unknown, unknown: this.#unknown };
    }
    this.authorize();
    check(!this.#closing && !signal.aborted, 'CANCELLED', 'Remote invocation is stopping');
    if (frame.method === 'hello') return { version: REMOTE_BRIDGE_VERSION, identity: this.identity, path: this.path,
      tools: REMOTE_TOOL_NAMES, control_resources: [...this.#control.resources.keys(), 'questionnaire'] };
    if (frame.method === 'context') {
      const context = await this.#context(signal), project_supplements = [];
      for (const role of ['common', 'agent']) {
        try {
          const file = await this.#file(`.lush-agent/${role}.md`, undefined, signal);
          check(file.encoding === 'utf8' && Buffer.byteLength(file.text) <= 65536, 'LIMIT_EXCEEDED', 'Remote project supplement must be bounded UTF-8');
          if (file.text.trim()) project_supplements.push({ name: `project.${role}`, title: `项目共享补充：${role}`,
            source: path.posix.join(this.path, `.lush-agent/${role}.md`), content: file.text.trim() });
        } catch (error) { if (error.code !== 'NOT_FOUND') throw error; }
      }
      return { ...context, project_supplements };
    }
    check(frame.method === 'tool', 'UNAUTHORIZED', 'Bridge method is not allowlisted');
    return this.#tool(frame.name, frame.args ?? {}, signal);
  }
  async listen(socket) {
    const dir = path.dirname(socket), st = fs.lstatSync(dir);
    check(st.isDirectory() && !st.isSymbolicLink() && st.uid === process.getuid() && !(st.mode & 0o077)
      && fs.realpathSync(dir) === path.resolve(dir) && !fs.existsSync(socket), 'UNAUTHORIZED', 'Bridge requires an unused socket in a private directory');
    this.socket = socket;
    this.#server = net.createServer(connection => {
      if (this.#sockets.size >= 32) { connection.destroy(); return; }
      this.#sockets.add(connection);
      const abort = new AbortController(); let received = false, buffer = Buffer.alloc(0);
      connection.on('error', () => {});
      connection.on('close', () => { this.#sockets.delete(connection); abort.abort(); });
      connection.setTimeout(5000, () => { if (!received) connection.destroy(); });
      connection.on('data', chunk => {
        if (received) { connection.destroy(); return; }
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > MAX_FRAME) { connection.destroy(); return; }
        const at = buffer.indexOf(10); if (at === -1) return;
        received = true; connection.setTimeout(0);
        let frame;
        try { check(at === buffer.length - 1, 'INVALID_REQUEST', 'One Bridge request per connection'); frame = JSON.parse(buffer.subarray(0, at)); }
        catch { connection.end(JSON.stringify({ error: { code: 'INVALID_REQUEST', message: 'Invalid Bridge frame' } }) + '\n'); return; }
        const operation = { abort, promise: null };
        // Barrier is outside the active set, otherwise it would wait on itself.
        operation.promise = Promise.resolve().then(() => this.#dispatch(frame, abort.signal)).then(value => {
          const response = JSON.stringify({ result: value }).replaceAll(this.#token, '[redacted]');
          check(Buffer.byteLength(response) <= MAX_FRAME, 'LIMIT_EXCEEDED', 'Bridge result exceeds limit');
          connection.end(response + '\n');
        }).catch(error => {
          // Never serialize arbitrary host callback errors, tokens, paths or private responses.
          const safe = error instanceof RunnerError ? { code: error.code, message: error.message,
            ...(error.code === 'CONTEXT_REQUIRED' ? { details: error.details } : {}) }
            : { code: 'REJECTED', message: 'Restricted operation rejected; check arguments or current authorization' };
          const wire = JSON.stringify({ error: safe }).replaceAll(this.#token, '[redacted]');
          connection.end(wire + '\n');
        }).finally(() => this.#active.delete(operation));
        if (frame.method !== 'barrier') this.#active.add(operation);
      });
    });
    await new Promise((resolve, reject) => { this.#server.once('error', reject); this.#server.listen(socket, resolve); });
    fs.chmodSync(socket, 0o600);
    return this;
  }
  async drain() {
    this.#closing = true;
    for (const operation of this.#active) operation.abort.abort();
    await Promise.allSettled([...this.#active].map(operation => operation.promise));
    try {
      const barrier = await this.#call('workspace.barrier', {}, { cleanup: true });
      return { ...barrier, stopped: barrier.stopped === true && !this.#unknown, unknown: this.#unknown };
    } catch { this.#unknown = true; return { stopped: false, unknown: true }; }
  }
  close() {
    return this.#closePromise ??= (async () => {
      const barrier = await this.drain();
      for (const socket of this.#sockets) socket.destroy();
      if (this.#server) await new Promise(resolve => this.#server.close(resolve));
      if (this.socket) fs.rmSync(this.socket, { force: true });
      return barrier;
    })();
  }
}

/** Agent-side client contains no RunnerClient or machine/control/Run token. */
export class RemoteBridgeClient {
  constructor(descriptor, token) { this.descriptor = descriptor; this.token = token; }
  call(method, params = {}, { signal, timeout_ms = method === 'barrier' ? 45000 : LIMITS.max_command_ms + 60000 } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('Remote tool cancelled')); return; }
      const socket = net.createConnection(this.descriptor.socket); let buffer = Buffer.alloc(0), settled = false, cancelling = false;
      const finish = (error, value) => {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        socket.destroy(); error ? reject(error) : resolve(value);
      };
      const abort = () => {
        if (settled || cancelling) return;
        cancelling = true; socket.destroy();
        // Do not let Pi reach turn_end while cancellation is only a signal. The central owner
        // also drains after guard exit, including SIGKILL where this callback cannot run.
        this.call('barrier').then(barrier => finish(new Error(barrier.stopped
          ? 'Remote tool cancelled; stop confirmed' : 'Remote tool cancelled; stop unknown')),
        () => finish(new Error('Remote tool cancelled; stop unknown')));
      };
      const timer = setTimeout(() => finish(new Error('Remote Bridge outcome unknown')), timeout_ms);
      signal?.addEventListener('abort', abort, { once: true });
      socket.once('connect', () => {
        const frame = JSON.stringify({ ...params, version: REMOTE_BRIDGE_VERSION, identity: this.descriptor.identity, token: this.token, method });
        if (Buffer.byteLength(frame) > MAX_FRAME) return finish(new Error('Bridge request exceeds limit'));
        socket.write(frame + '\n');
      });
      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > MAX_FRAME) return finish(new Error('Bridge response exceeds limit'));
        const at = buffer.indexOf(10); if (at === -1) return;
        try {
          const response = JSON.parse(buffer.subarray(0, at));
          if (response.error) finish(new RunnerError(response.error.code, response.error.message, response.error.details));
          else finish(null, response.result);
        } catch (error) { finish(error); }
      });
      socket.once('error', () => { if (!cancelling) finish(new Error('Restricted Bridge unavailable; outcome unknown')); });
      socket.once('close', () => { if (!settled && !cancelling) finish(new Error('Restricted Bridge disconnected; outcome unknown')); });
    });
  }
}
