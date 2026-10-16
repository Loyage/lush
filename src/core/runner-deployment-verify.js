import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { RunnerClient } from '../runner/client.js';
import { OPERATIONS, hash } from '../runner/protocol.js';
import { check } from './types.js';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const REQUIRED = Object.freeze(['workspace.register', 'file.context', 'command.start', 'command.status', 'command.output', 'command.cancel', 'workspace.barrier']);
const SHORT_MARKER = 'lush-deployment-runtime-ffi-ok\n', LIVE_MARKER = 'lush-deployment-stop-live\n';
const script = (version, marker, live) => `if(typeof Bun==="undefined"||Bun.version!==${JSON.stringify(version)})process.exit(2);const {dlopen,FFIType}=await import("bun:ffi");const lib=dlopen("libc.so.6",{getpid:{args:[],returns:FFIType.i32}});if(lib.symbols.getpid()<=0)process.exit(3);lib.close();process.stdout.write(${JSON.stringify(marker)});${live ? 'setInterval(()=>{},1000);' : ''}`;

/** Internal only: a fresh installation's isolated diagnostic workspace, not a Worker/Run.
 * Factory/checkpoint/guard are trusted service callbacks; there is no JSON command/path API.
 * Production factories must select the verified managed SSH startup, never this test transport.
 */
export async function verifyDeploymentRunner({ deployment_id, node_id, project_id, operation_id = randomUUID(), runtime_path,
  runtime_version, implementation_version, platform = 'linux', arch, auth, expected_runner_id = null, transport_factory, checkpoint, guard, on_client = null,
  signal, timeout_ms = 10_000, output_bytes = 4096 }) {
  check(uuid(deployment_id) && uuid(node_id) && uuid(operation_id) && typeof project_id === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(project_id), 'Invalid deployment verification identity');
  check(typeof runtime_path === 'string' && path.isAbsolute(runtime_path) && path.resolve(runtime_path) === runtime_path
    && /^[A-Za-z0-9_./-]+$/.test(runtime_path), 'Invalid internal deployment runtime path');
  check(typeof runtime_version === 'string' && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(runtime_version)
    && typeof implementation_version === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,79}$/.test(implementation_version) && platform === 'linux' && ['x64', 'arm64'].includes(arch), 'Invalid deployment runtime identity');
  check(expected_runner_id === null || uuid(expected_runner_id), 'Invalid expected deployment installation identity');
  check(Number.isSafeInteger(output_bytes) && output_bytes >= 64 && output_bytes <= 4096, 'Invalid deployment verification output budget');
  check(typeof transport_factory === 'function' && typeof checkpoint === 'function' && typeof guard === 'function'
    && (on_client === null || typeof on_client === 'function') && Number.isSafeInteger(timeout_ms) && timeout_ms >= 100 && timeout_ms <= 15_000, 'Invalid internal deployment verification callbacks or budget');
  const identity = { project_id, node_id, worker_id: 1, workspace_id: 'deployment-' + deployment_id, generation: 1, operation_id };
  const deadline = Date.now() + timeout_ms;
  const current = () => { guard(); check(!signal?.aborted && Date.now() < deadline, 'Deployment verification deadline or authorization expired'); };
  const persist = value => { current(); check(!checkpoint(value)?.then, 'Deployment verification receipt must be synchronous'); };
  const options = () => ({ signal, timeout_ms: Math.max(1, deadline - Date.now()), before_send(frame) {
    current();
    if (frame.method === 'hello' || OPERATIONS[frame.method]?.mutation) persist({ phase: 'intent', request_id: frame.request_id,
      method: frame.method, identity: frame.identity, fingerprint: frame.fingerprint });
  } });
  let transport, client, untrack;
  try {
    // Includes Runner SQLite/config startup, not just the first authenticated protocol mutation.
    persist({ phase: 'connection', identity, ...(expected_runner_id ? { expected_runner_id } : {}) });
    transport = await transport_factory(); current();
    // Recovery must authenticate the ORIGINAL installation before workspace/command mutations.
    // A matching ID checked only in the final proof would already have executed on a replacement.
    client = new RunnerClient({ transport, identity, auth, expected_runner_id, budgets: { max_commands: 1, timeout_ms, output_bytes } });
    untrack = on_client?.(client);
    check(untrack === undefined || typeof untrack === 'function', 'Invalid deployment verification cleanup callback');
    const hello = await client.handshake(options());
    check(uuid(hello.runner_id) && hello.implementation_version === implementation_version && hello.platform === platform && hello.arch === arch
      && REQUIRED.every(method => hello.capabilities.includes(method)), 'Runner installation lacks required production capabilities or identity');
    persist({ phase: 'hello', runner_id: hello.runner_id, implementation_version, platform, arch });
    const call = async (method, params = {}, request_id) => { current(); const result = await client.call(method, params,
      { ...options(), ...(request_id ? { request_id } : {}) }); current(); return result; };
    const workspace = await call('workspace.register');
    check(workspace.workspace_id === identity.workspace_id && workspace.worker_id === 1 && workspace.generation === 1 && !workspace.busy,
      'Deployment verification workspace identity changed');
    const context = await call('file.context', { scope: 'workspace' });
    check(context.complete === true && typeof context.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(context.fingerprint), 'Deployment verification context is incomplete');
    const wait = async () => { current(); await delay(Math.min(20, Math.max(1, deadline - Date.now())), undefined, { signal }); current(); };
    const start = async (kind, marker, live) => {
      const request_id = randomUUID();
      const execution = await call('command.start', { argv: [runtime_path, '-e', script(runtime_version, marker, live)],
        context_ack: context.fingerprint, command_ms: timeout_ms, queue_ms: 1000, output_bytes }, request_id);
      check(execution.execution_id === 'cmd-' + hash(`${project_id}:${request_id}`), 'Deployment verification command identity is invalid');
      persist({ phase: 'execution', kind, request_id, execution_id: execution.execution_id });
      return { execution_id: execution.execution_id, request_id };
    };
    const output = async (execution_id, expected, live) => {
      let cursor = 0, text = '';
      for (;;) {
        const result = await call('command.output', { execution_id, after: cursor, limit: 1 });
        check(result.execution_id === execution_id && result.gap === false && result.truncated === false && !result.output_error
          && Number.isSafeInteger(result.next_cursor) && result.next_cursor >= cursor && Array.isArray(result.chunks) && result.chunks.length <= 1,
        'Deployment verification output proof is incomplete');
        for (const chunk of result.chunks) {
          check(chunk.stream === 'stdout' && chunk.encoding === 'base64' && typeof chunk.data === 'string' && chunk.data.length <= 8192
            && chunk.seq === cursor + 1 && Buffer.from(chunk.data, 'base64').toString('base64') === chunk.data, 'Deployment verification output is invalid');
          text += Buffer.from(chunk.data, 'base64').toString('utf8'); cursor = chunk.seq;
          check(text.length <= expected.length && expected.startsWith(text), 'Deployment verification output did not match');
        }
        check(result.next_cursor === cursor, 'Deployment verification output cursor changed');
        if (text === expected && (live || result.complete === true && result.has_more === false)) return;
        check(live || result.complete !== true, 'Deployment verification output was not confirmed');
        await wait();
      }
    };
    const { execution_id: short_id, request_id: short_request_id } = await start('runtime_ffi', SHORT_MARKER, false);
    let short;
    do { short = await call('command.status', { execution_id: short_id }); if (!short.stop_confirmed) { check(short.state !== 'unknown', 'Deployment command outcome is unknown'); await wait(); } } while (!short.stop_confirmed);
    check(short.execution_id === short_id && short.state === 'exited' && short.reason === 'exit' && short.exit_code === 0
      && short.output_complete === true && short.truncated === false && !short.output_error, 'Deployment runtime/FFI command failed');
    await output(short_id, SHORT_MARKER, false);
    persist({ phase: 'runtime_verified', execution_id: short_id, stop_confirmed: true, exit_code: 0 });
    const { execution_id: live_id, request_id: live_request_id } = await start('stop', LIVE_MARKER, true);
    await output(live_id, LIVE_MARKER, true); // Proves the payload actually ran, not merely queued/not_started.
    const live = await call('command.status', { execution_id: live_id });
    check(live.execution_id === live_id && live.state === 'running' && live.stop_confirmed === false, 'Deployment stop command was not live');
    const cancel_request_id = randomUUID();
    const cancelled = await call('command.cancel', { execution_id: live_id }, cancel_request_id);
    check(cancelled.execution_id === live_id && cancelled.state === 'exited' && cancelled.reason === 'cancelled' && cancelled.stop_confirmed === true,
      'Deployment command stop is unconfirmed');
    const stopped = await call('command.status', { execution_id: live_id });
    check(stopped.execution_id === live_id && stopped.state === 'exited' && stopped.reason === 'cancelled' && stopped.stop_confirmed === true
      && stopped.output_complete === true && stopped.truncated === false && !stopped.output_error, 'Deployment stopped command proof changed');
    await output(live_id, LIVE_MARKER, false);
    const barrier = await call('workspace.barrier');
    check(barrier.stopped === true && barrier.busy === false && barrier.truncated === false && barrier.total === 0
      && Array.isArray(barrier.executions) && barrier.executions.length === 0, 'Deployment workspace stop barrier is incomplete');
    const proof = { runner_id: hello.runner_id, ...(expected_runner_id ? { expected_runner_id } : {}), node_id, project_id, operation_id, workspace_id: identity.workspace_id,
      implementation_version, platform, arch, runtime_version, command_request_id: short_request_id, command_execution_id: short_id,
      stop_request_id: live_request_id, stop_execution_id: live_id, cancel_request_id,
      runtime_verified: true, ffi_verified: true, stop_confirmed: true, barrier_confirmed: true, checked_at: new Date().toISOString() };
    persist({ phase: 'verified', proof });
    return proof;
  } catch {
    throw new Error('Runner installation verification was not confirmed; inspect the original deployment, do not retry');
  } finally {
    try { await (client ? client.close() : transport?.close()); untrack?.(); }
    catch { throw new Error('Runner verification connection close was not confirmed; inspect the original deployment'); }
  }
}
