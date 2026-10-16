import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { check } from '../types.js';
import { runnerIdentity } from '../runner-service.js';
import { RunnerToolBridge } from '../../agent/remote-bridge.js';
import { REMOTE_BRIDGE_VERSION, REMOTE_PI_VERSION } from '../../agent/remote-contract.js';
import { assertRemoteRuntime } from '../../agent/remote-provider.js';
import { AGENT_CAPABILITIES } from '../../agent/capabilities.js';
import { forkCheckpoint } from '../../agent/fork.js';
import { Dispatcher } from '../../rpc/dispatcher.js';
import { PROTOCOL_VERSION, LIMITS, hash } from '../../runner/protocol.js';
import { runnerToolJournal } from '../runner-tool-journal.js';
import { runnerDirtyManifest } from '../runner-tool-evidence.js';

const confirmed = result => result?.stopped === true && !result.unknown && !result.busy && !result.truncated;
function markUnknown(project, run, workerId) {
  run.remoteStopUnknown = true;
  const binding = project.store.runnerBinding(workerId);
  if (binding && !['unknown', 'removed'].includes(binding.state))
    project.store.markRunnerWorkspaceUnknown(runnerIdentity(binding), binding.revision);
}
function checkpoint(project, task, run, commit) {
  const file = path.join(project.config.home, 'sessions', `task-${task.id}-context.json`);
  if (!fs.existsSync(file)) return;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    check(stat.isFile() && stat.size < 16384 && stat.uid === process.getuid(), 'Invalid central context marker');
    const buffer = Buffer.alloc(16384), count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    check(count < buffer.length, 'Central context marker grew');
    const pointer = JSON.parse(buffer.subarray(0, count).toString());
    check(pointer.task_id === task.id && pointer.run_id === run.recordId, 'Context belongs to another invocation');
    forkCheckpoint(project.config.home, { session: pointer.session, entry: pointer.entry, commit });
    project.store.run('INSERT OR IGNORE INTO commit_contexts(commit_hash,task_id,session_path,entry_id) VALUES (?,?,?,?)',
      commit, task.id, pointer.session, pointer.entry);
  } catch {
    // Invalid/missing local context never grants remote database access or invalidates verified code.
    project.store.event(task.id, 'runner.context_unavailable', { run_id: run.recordId, commit });
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Called before startRun: preparation has no Run authority and never allocates a local checkout. */
export async function prepareRunnerInvocation(project, task, run, agent) {
  const initial = project.store.runnerBinding(task.id);
  if (!initial) return null;
  assertRemoteRuntime(project.config, agent);
  check(['order', 'child'].includes(task.task_kind) && task.role === 'agent' && task.workspace === null,
    'Remote invocation requires its original ref-only Worker');
  const barriers = project.store.runnerBarriers(task.id);
  check(!barriers.runs.length && !barriers.receipts.length && !project.store.pendingRunnerTaskSyncs(task.id).length
    && ['preparing', 'ready'].includes(initial.state),
    'Remote invocation is blocked by unconfirmed operations');
  const identity = runnerIdentity(initial, { operation_id: `prepare:${initial.workspace_id}:${initial.generation}` });
  const connection = await project.runners.connect(identity);
  let controlDirectory;
  try {
    const options = { identity, client: connection.client, request_id: identity.operation_id,
      authorization_version: project.store.runnerProject().authorization_version,
      guard() {
        connection.assertCurrent();
        project.runners.assertBinding(identity);
        check(!run.controller.signal.aborted && !project.stopping, 'Remote invocation admission closed');
      } };
    if (initial.state === 'preparing') await project.workspaces.prepareRemoteWorkspace(options);
    const observed = await project.workspaces.inspectRemoteWorkspace({ ...options, request_id: randomUUID(), require_no_lease: true });
    check(observed.head_commit === project.store.runnerBinding(task.id).head_commit, 'Remote HEAD differs from its received central commit');
    const workspace = await connection.client.call('workspace.inspect');
    options.guard();
    check(typeof workspace.directory === 'string' && path.posix.isAbsolute(workspace.directory), 'Runner code path is unavailable');
    // The control cwd contains no checkout, credentials or model configuration. It is central-only
    // and uses a short private path so Unix socket length does not depend on the repository path.
    const baseline = await runnerDirtyManifest(connection.client, task.branch, observed.head_commit, options.guard);
    controlDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-remote-control-'));
    fs.chmodSync(controlDirectory, 0o700);
    return new RunnerInvocation(project, task, run, connection, identity, workspace.directory, controlDirectory, baseline);
  } catch (error) {
    markUnknown(project, run, task.id);
    await connection.close();
    if (controlDirectory) fs.rmSync(controlDirectory, { recursive: true, force: true });
    throw error;
  }
}

class RunnerInvocation {
  constructor(project, task, run, connection, controlIdentity, codePath, directory, baseline) {
    this.project = project; this.task = task; this.run = run; this.connection = connection;
    this.controlIdentity = controlIdentity; this.codePath = codePath; this.directory = directory; this.baseline = baseline;
    this.bridge = null; this.renewal = null; this.renewing = null; this.unwatch = null;
    this.stopPromise = null; this.finalizePromise = null; this.capturePromise = null;
    this.unknown = false; this.head = null; this.clean = false;
  }
  authorize() {
    this.connection.assertCurrent();
    check(this.project.actor(this.run.token) === this.task.id && !this.run.invocationEnded, 'Remote Agent invocation has ended');
    this.project.runners.assertBinding(this.identity);
  }
  controlOptions() {
    return { client: this.connection.client, identity: this.controlIdentity, request_id: randomUUID(),
      authorization_version: this.project.store.runnerProject().authorization_version,
      guard: () => { this.connection.assertCurrent(); this.project.runners.assertBinding(this.controlIdentity); } };
  }
  async activate() {
    const { project, run, task } = this;
    this.identity = runnerIdentity(this.controlIdentity, { run_id: run.recordId });
    this.connection.assertCurrent();
    this.authorization = project.store.authorizeRunnerRun(this.identity, project.store.runnerProject().authorization_version);
    project.store.startRunnerToolJournal(this.identity, { version: 1,
      head_commit: project.store.runnerBinding(task.id).head_commit,
      baseline: this.baseline === null ? null : Object.fromEntries(Object.entries(this.baseline).map(([path, digest]) => [hash(path), digest])) });
    const runToken = randomBytes(32).toString('base64url');
    await this.connection.client.call('lease.grant', { run_id: run.recordId, run_token: runToken, ttl_ms: LIMITS.lease_ms });
    this.runClient = this.connection.client.forRun({ run_id: run.recordId, run_token: runToken });
    this.authorize();
    const dispatcher = project.rpcDispatcher ?? new Dispatcher(project, { isRequested: () => project.stopping });
    const resources = { startup: path.join(project.config.home, 'sessions', `task-${task.id}-input.md`) };
    for (const capability of AGENT_CAPABILITIES) resources[`skill:${capability.id}`] = capability.skill;
    this.bridge = new RunnerToolBridge({ client: this.runClient, identity: this.identity, token: run.token, path: this.codePath,
      journal: runnerToolJournal(project, this.identity, this.authorization.authorization_version),
      authorize: () => this.authorize(),
      cooperate: ({ method, params, token }) => dispatcher.dispatch(method, { ...params, _token: token }),
      control: { directory: this.directory, resources } });
    await this.bridge.listen(path.join(this.directory, 'bridge.sock'));
    this.descriptor = { version: REMOTE_BRIDGE_VERSION, runner_protocol: PROTOCOL_VERSION, pi_version: REMOTE_PI_VERSION,
      socket: this.bridge.socket, identity: this.identity, path: this.codePath };
    this.unwatch = project.runners.watchRun(this.identity, () => this.stop());
    this.abortListener = () => { void this.stop().catch(() => {}); };
    run.controller.signal.addEventListener('abort', this.abortListener, { once: true });
    this.renewal = setInterval(() => {
      if (this.renewing || this.stopPromise || this.finalizePromise) return;
      this.renewing = (async () => {
        // Questions/preemption end developer authority, not the fixed stop capability.
        this.authorize();
        await this.runClient.call('lease.renew', { ttl_ms: LIMITS.lease_ms });
      })().catch(async () => { await this.stop(); }).finally(() => { this.renewing = null; });
    }, Math.floor(LIMITS.lease_ms / 3));
    this.renewal.unref();
    if (run.controller.signal.aborted) await this.stop();
    return this.directory;
  }
  stop() {
    if (this.stopPromise) return this.stopPromise;
    // Set the latch before abort dispatch (AbortController invokes listeners synchronously).
    this.stopPromise = Promise.resolve().then(async () => {
      clearInterval(this.renewal);
      if (!this.run.controller.signal.aborted) this.run.controller.abort(new Error('Remote invocation authorization revoked or stopped'));
      let drained, barrier;
      try {
        drained = this.bridge ? await this.bridge.close() : { stopped: true };
        barrier = await this.connection.client.call('lease.revoke');
      } catch { barrier = { stopped: false, unknown: true }; }
      const result = confirmed(drained) && confirmed(barrier) ? barrier : { stopped: false, unknown: true };
      if (!confirmed(result)) { this.unknown = true; markUnknown(this.project, this.run, this.task.id); }
      return result;
    });
    return this.stopPromise;
  }
  /** A current Run may export committed objects while its lease still exists, for child creation. */
  capture() {
    check(!this.capturePromise, 'Another remote baseline capture is in progress');
    this.capturePromise = (async () => {
      this.authorize();
      const binding = this.project.store.runnerBinding(this.task.id);
      const options = { ...this.controlOptions(), identity: this.identity,
        authorization_version: this.authorization.authorization_version, guard: () => this.authorize() };
      const observed = await this.project.workspaces.inspectRemoteWorkspace(options);
      if (observed.head_commit !== binding.head_commit) {
        await this.project.workspaces.receiveRemoteCommit({ ...options, commit: observed.head_commit,
          old_commit: binding.head_commit, original_commit: binding.base_commit });
        checkpoint(this.project, this.task, this.run, observed.head_commit);
      }
      this.authorize();
      return observed;
    })().finally(() => { this.capturePromise = null; });
    return this.capturePromise;
  }
  /** SDK exit -> drain -> real lease stop -> durable release -> control-scope object receipt.
   * Run-scoped export requires a live lease, so it MUST NOT be reused after lease.release.
   * Control capture does not restore ordinary tools after a questionnaire/cancellation.
   */
  finalize() {
    return this.finalizePromise ??= (async () => {
      clearInterval(this.renewal);
      try {
        let captureError;
        if (this.capturePromise) await this.capturePromise.catch(error => { captureError = error; });
        await this.renewing;
        let barrier;
        if (this.stopPromise) barrier = await this.stopPromise;
        else {
          const drained = this.bridge ? await this.bridge.close() : { stopped: true };
          const released = await this.connection.client.call('lease.release');
          barrier = confirmed(drained) && confirmed(released) ? released : { stopped: false, unknown: true };
        }
        check(confirmed(barrier), 'Remote stop is unknown; preserve workspace and block delivery');
        if (captureError) throw captureError;
        this.unwatch?.(); this.unwatch = null;
        const row = this.run.recordId ? this.project.store.runnerRun(this.run.recordId) : null;
        if (row && row.state !== 'released') this.project.store.releaseRunnerRun(this.identity, row.revision, { stopped: true });
        // Existing stop authority remains usable after revocation. New object acceptance does not.
        const options = this.controlOptions(), binding = this.project.store.runnerBinding(this.task.id);
        const observed = await this.project.workspaces.inspectRemoteWorkspace({ ...options, require_no_lease: true });
        if (observed.head_commit !== binding.head_commit) {
          await this.project.workspaces.receiveRemoteCommit({ ...options, commit: observed.head_commit,
            old_commit: binding.head_commit, original_commit: binding.base_commit,
            final_delivery: observed.clean, agent_exited: true });
          checkpoint(this.project, this.task, this.run, observed.head_commit);
        }
        this.head = observed.head_commit; this.clean = observed.clean;
      } catch (error) {
        this.unknown = true; markUnknown(this.project, this.run, this.task.id);
        throw error;
      }
    })();
  }
  finish() {
    check(!this.unknown && this.head && this.clean, 'Remote working tree is dirty or unconfirmed; preserve the workspace');
    const binding = this.project.store.runnerBinding(this.task.id);
    check(binding.state === 'ready' && binding.head_commit === this.head, 'Remote received HEAD changed before settlement');
    this.project.store.update(this.task.id, { head_commit: this.head, integration: this.head === this.task.base_commit ? 'none' : 'pending' });
  }
  async dispose() {
    clearInterval(this.renewal); this.unwatch?.();
    if (this.abortListener) this.run.controller.signal.removeEventListener('abort', this.abortListener);
    await this.renewing?.catch(() => {});
    await this.connection.close();
    fs.rmSync(this.directory, { recursive: true, force: true });
  }
}
