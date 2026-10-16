import { randomUUID } from 'node:crypto';
import { CAPABILITIES, LIMITS, PROTOCOL_VERSION, RunnerError, check, identifier, integer, validateRequest, hash, stable } from './protocol.js';

/** No retry loop: callers retain request IDs and explicitly reconcile unknown outcomes. */
export class RunnerClient {
  #auth;
  constructor({ transport, identity, auth, expected_runner_id, budgets = {} }) {
    check(transport && typeof transport.request === 'function', 'INVALID_REQUEST', 'Missing Runner transport');
    this.transport = transport; this.identity = Object.freeze({ ...identity }); this.#auth = { ...auth };
    check(!identity.runner_id || !expected_runner_id || identity.runner_id === expected_runner_id, 'STALE', 'Conflicting Runner installation identities');
    this.expected_runner_id = expected_runner_id ?? identity.runner_id ?? null;
    this.runner_id = null; this.capabilities = null; this.remote_limits = null;
    this.budgets = Object.freeze({
      max_commands: integer(budgets.max_commands ?? 1, 'max_commands', 1, 64),
      // Central configuration expresses ceilings, not a promise that every node supports them.
      // Preserve Runner hard limits, then further reduce to the negotiated node limits in call().
      timeout_ms: Math.min(integer(budgets.timeout_ms ?? LIMITS.command_ms, 'timeout_ms'), LIMITS.max_command_ms),
      output_bytes: Math.min(integer(budgets.output_bytes ?? LIMITS.output_bytes, 'output_bytes'), LIMITS.output_bytes),
    });
  }
  async handshake(options = {}) {
    const params = this.expected_runner_id ? { expected_runner_id: this.expected_runner_id } : {};
    const hello = await this.send('hello', params, options);
    check(hello && hello.protocol_version === PROTOCOL_VERSION && hello.node_id === this.identity.node_id,
      'VERSION_MISMATCH', 'Runner handshake identity/version mismatch');
    identifier(hello.runner_id, 'runner_id');
    check(!this.expected_runner_id || hello.runner_id === this.expected_runner_id, 'STALE', 'Runner installation changed');
    check(Array.isArray(hello.capabilities) && hello.capabilities.every(name => CAPABILITIES.includes(name))
      && new Set(hello.capabilities).size === hello.capabilities.length, 'VERSION_MISMATCH', 'Invalid Runner capabilities');
    check(hello.limits && Number.isSafeInteger(hello.limits.command_ms) && hello.limits.command_ms > 0
      && Number.isSafeInteger(hello.limits.output_bytes) && hello.limits.output_bytes > 0, 'VERSION_MISMATCH', 'Invalid Runner limits');
    this.runner_id = hello.runner_id;
    this.identity = Object.freeze({ ...this.identity, runner_id: hello.runner_id });
    this.expected_runner_id = hello.runner_id; // Pin this installation, including subsequent explicit handshakes.
    this.capabilities = Object.freeze([...hello.capabilities]); this.remote_limits = Object.freeze({ ...hello.limits });
    return hello;
  }
  async call(method, params = {}, options = {}) {
    if (method === 'hello') return this.handshake(options);
    check(this.runner_id && this.capabilities, 'UNAUTHORIZED', 'Runner handshake is required');
    check(this.capabilities.includes(method), 'UNSUPPORTED', 'Runner does not advertise this operation');
    if (method === 'command.start') params = { ...params,
      command_ms: Math.min(params.command_ms ?? this.budgets.timeout_ms, this.budgets.timeout_ms, this.remote_limits.command_ms),
      output_bytes: Math.min(params.output_bytes ?? this.budgets.output_bytes, this.budgets.output_bytes, this.remote_limits.output_bytes),
    };
    return this.send(method, params, options);
  }
  async send(method, params, { request_id = randomUUID(), signal, timeout_ms, before_send } = {}) {
    const frame = { version: PROTOCOL_VERSION, request_id, method, identity: this.identity,
      auth: this.#auth, params };
    validateRequest(frame);
    if (before_send) check(!before_send({ request_id, method, identity: this.identity, params,
      fingerprint: hash(stable({ method, identity: this.identity, params })) })?.then,
    'INVALID_REQUEST', 'Request persistence must finish synchronously before sending');
    const response = await this.transport.request(frame, { signal, ...(timeout_ms === undefined ? {} : { timeout_ms }) });
    check(response && response.version === PROTOCOL_VERSION && response.request_id === request_id,
      'UNKNOWN', 'Runner response did not match request');
    if (response.error) {
      const error = new RunnerError(response.error.code, response.error.message, response.error.details);
      error.runner_response = true; // Internal transport evidence, never a public recovery credential.
      throw error;
    }
    check(Object.hasOwn(response, 'result'), 'UNKNOWN', 'Runner response has no result');
    return response.result;
  }
  forRun({ run_id, run_token }) {
    const { operation_id, ...base } = this.identity;
    const client = new RunnerClient({ transport: this.transport, identity: { ...base, run_id },
      auth: { machine_token: this.#auth.machine_token, run_token }, expected_runner_id: this.expected_runner_id, budgets: this.budgets });
    client.runner_id = this.runner_id; client.capabilities = this.capabilities; client.remote_limits = this.remote_limits;
    return client;
  }
  close() { return this.transport.close(); }
}

/** In-process adapter for owned/local execution, explicit and never a transport fallback. */
export class LocalTransport {
  constructor(node) { this.node = node; this.session_id = node.openSession(); this.closed = false; }
  async request(frame, { signal } = {}) {
    check(!this.closed, 'UNAVAILABLE', 'Local Runner transport is closed');
    check(!signal?.aborted, 'CANCELLED', 'Request cancelled before admission');
    const abort = () => { this.closed = true; void this.node.disconnect(this.session_id); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const result = await this.node.dispatch(frame, this.session_id);
      if (signal?.aborted) throw new RunnerError('UNKNOWN', 'Cancelled request outcome requires reconciliation');
      return result;
    } finally { signal?.removeEventListener('abort', abort); }
  }
  async close() { if (!this.closed) { this.closed = true; await this.node.disconnect(this.session_id); } }
}
