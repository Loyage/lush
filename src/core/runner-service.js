import { randomUUID, createHash } from 'node:crypto';
import { RunnerSettings } from './runner-settings.js';
import { RunnerCredentials } from './runner-credentials.js';
import { RunnerClient, SshTransport } from '../runner/index.js';
import { check } from './types.js';
import { RunnerSsh } from './runner-ssh.js';
import { DeploymentStore } from './runner-deployment-store.js';
import { DeploymentOperations } from './runner-deployment-operations.js';
import { publicDeployments } from './runner-deployment-view.js';
import { DeploymentController } from './runner-deployment-controller.js';

export const RUNNER_BINDING_KEYS = Object.freeze(['project_id', 'node_id', 'runner_id', 'worker_id', 'workspace_id', 'generation']);
export function runnerIdentity(binding, context = {}) {
  return { ...Object.fromEntries(RUNNER_BINDING_KEYS.map(key => [key, binding[key]])), ...context };
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stopped = value => value?.stopped === true && value.unknown !== true;
const connectionVersion = (node, auth) => digest({ id: node.id, ssh_alias: node.ssh_alias,
  expected_runner_id: node.expected_runner_id, enabled: node.enabled, budgets: node.budgets, auth });

/** Central connection/configuration boundary, also usable by Host without a Project Store.
 * No model invocation or connection on reads. transport_factory is an internal test seam,
 * never a JSON setting. Runtime owns write safety, fixed Git receipts and invocation release.
 */
export class RunnerService {
  #connections = new Set(); #watches = new Map(); #stops = new Map(); #timer; #checking = null; #closed = false; #deployments = null;
  constructor(config, store = null, { transport_factory = null, ssh = {}, deployment = {} } = {}) {
    this.config = config; this.store = store;
    this.settings = new RunnerSettings(config); this.credentials = new RunnerCredentials(config);
    this.deployment_options = deployment; this.pending = 0; this.ssh = new RunnerSsh(ssh);
    this.transport_factory = transport_factory ?? ((node, options) => {
      const deployment = this.#deployment().managedNode(node, options);
      return deployment ? this.#deployment().transport_factory(deployment) : new SshTransport({ ssh_alias: node.ssh_alias });
    });
  }
  #deployment() {
    return this.#deployments ??= new DeploymentController(this.config, this.deployment_options);
  }
  async #deploymentCall(method, request) {
    check(!this.#closed, 'Runner service is closed'); this.pending++;
    try { return await this.#deployment()[method](request); } finally { this.pending--; }
  }
  planDeployment(request) { return this.#deploymentCall('plan', request); }
  applyDeployment(request) { return this.#deploymentCall('apply', request); }
  confirmDeployment(request) { return this.#deploymentCall('confirm', request); }
  reconcileDeployment(request) { return this.#deploymentCall('reconcile', request); }
  planDeploymentRecovery(request) { return this.#deploymentCall('planRecovery', request); }
  applyDeploymentRecovery(request) { return this.#deploymentCall('applyRecovery', request); }
  reconcileDeploymentRecovery(request) { return this.#deploymentCall('reconcileRecovery', request); }
  discoverSsh() { return this.ssh.discover(); }
  async testSsh(ssh_alias) {
    check(!this.#closed, 'Runner service is closed');
    this.pending++;
    try { return await this.ssh.test(ssh_alias); } finally { this.pending--; }
  }
  readDeployments() {
    // Inert receipt history: no directory creation, artifact preparation, SSH, reconciliation or replay.
    const store = new DeploymentStore(this.config), operations = new DeploymentOperations(store), value = store.list();
    const unresolved = r => ['running', 'unknown'].includes(r.status) || Boolean(r.private_data?.recovery?.gate)
      || r.private_data?.recovery?.items?.some(item => ['running', 'unknown'].includes(item.status));
    value.items.sort((a, b) => Number(Boolean(unresolved(b))) - Number(Boolean(unresolved(a)))
      || b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
    return publicDeployments({ ...value, items: value.items.slice(0, 64).map(record => operations.view(record)), truncated: value.items.length > 64 });
  }
  readNodes() { return this.settings.read(); }
  readCredentials() { return this.credentials.read(); }
  readPolicy() { check(this.store, 'Runner project policy requires its project'); return this.store.runnerProject(); }
  node(node_id, { observation = false, unpinned = false } = {}) {
    check(node_id !== 'local', 'Local execution does not use a remote Runner');
    const node = this.readNodes().nodes.find(node => node.id === node_id);
    check(node, 'Runner node is not registered');
    check(observation || node.enabled, 'Runner node is disabled');
    check(unpinned || node.expected_runner_id, 'Runner installation must be checked and explicitly pinned first');
    return node;
  }
  selectNode(node_id, parent_id = null) {
    if (node_id === undefined || node_id === null) node_id = parent_id === null
      ? this.readPolicy().default_node_id : this.store.runnerBinding(parent_id)?.node_id ?? 'local';
    if (node_id === 'local') return null;
    const node = this.node(node_id);
    check(this.readPolicy().allowed_node_ids.includes(node.id), 'Runner node is not authorized for this project');
    this.credentials.snapshot(node.id, this.readPolicy().project_id); // fail before creating a Worker/ref
    this.#deployment().managedNode(node); // durable recovery gate applies across processes, before Worker/ref creation
    return node;
  }
  assertBinding(identity, { observation = false } = {}) {
    check(this.store, 'Runner workspace requires a project');
    const binding = this.store.runnerBinding(identity.worker_id), policy = this.readPolicy();
    check(binding && RUNNER_BINDING_KEYS.every(key => binding[key] === identity[key])
      && policy.project_id === identity.project_id, 'Runner workspace identity changed');
    const node = this.node(identity.node_id, { observation });
    check(node.expected_runner_id === identity.runner_id, 'Runner installation identity changed');
    check(observation || policy.allowed_node_ids.includes(identity.node_id), 'Runner project authorization revoked');
    check(observation || binding.state === 'ready' || binding.state === 'preparing', 'Runner workspace is blocked');
    check(binding.state !== 'removed', 'Runner workspace was removed');
    if (identity.run_id !== undefined && !observation) {
      const run = this.store.runnerRun(identity.run_id);
      check(run, 'Runner Run has no authorization');
      this.store.assertRunnerAuthorization(runnerIdentity(identity, { run_id: identity.run_id }), run.authorization_version);
      check(!this.#watches.get(identity.run_id)?.invalid, 'Runner Run was revoked');
    }
    return { node, binding, policy };
  }
  async #open(node, identity, { unpinned = false, observation = false } = {}) {
    check(!this.#closed, 'Runner service is closed');
    const auth = this.credentials.snapshot(node.id, identity.project_id);
    const version = connectionVersion(node, auth);
    let generation;
    const assertCurrent = () => {
      const current = this.node(node.id, { observation: true, unpinned });
      check(connectionVersion(current, this.credentials.snapshot(node.id, identity.project_id)) === version,
        'Runner connection configuration changed; new authorization is required');
      check((this.#deployment().managedNode(current, { observation })?.managed.runtime_generation?.sha256 ?? null) === generation,
        'Runner runtime generation changed; new authorization is required');
    };
    let client; this.pending++;
    try {
      generation = this.#deployment().managedNode(node, { observation })?.managed.runtime_generation?.sha256 ?? null;
      assertCurrent();
      const transport = this.transport_factory(node, { observation });
      client = new RunnerClient({ transport, identity, auth, budgets: node.budgets,
        ...(unpinned ? {} : { expected_runner_id: node.expected_runner_id }) });
      const hello = await client.handshake();
      assertCurrent();
      this.#connections.add(client);
      let closed = false;
      const service = this;
      return { client, hello, assertCurrent, async close() {
        if (closed) return;
        closed = true;
        try { await client.close(); } finally { service.#connections.delete(client); }
      } };
    } catch {
      try { await client?.close(); } catch { /* A failed connect never proves the node stopped. */ }
      throw new Error('Runner connection or identity check failed; no local fallback');
    } finally { this.pending--; }
  }
  async connect(identity, { observation = false } = {}) {
    const { node } = this.assertBinding(identity, { observation });
    const connection = await this.#open(node, identity, { observation });
    try { this.assertBinding(identity, { observation }); return connection; }
    catch (error) { await connection.close(); throw error; }
  }
  /** Explicit authenticated diagnostic. Never saves a newly observed installation identity. */
  async checkNode(node_id, project_id = this.readPolicy().project_id) {
    const node = this.node(node_id, { observation: true, unpinned: true });
    check(typeof project_id === 'string' && project_id, 'Initialize project Runner policy before checking its node');
    const connection = await this.#open(node, { project_id, node_id, worker_id: 1,
      workspace_id: 'diagnostic', generation: 1, operation_id: randomUUID(),
      ...(node.expected_runner_id ? { runner_id: node.expected_runner_id } : {}) }, { unpinned: !node.expected_runner_id, observation: true });
    try {
      const latest = this.node(node_id, { observation: true, unpinned: true });
      check(latest.ssh_alias === node.ssh_alias && latest.expected_runner_id === node.expected_runner_id, 'Runner node changed during diagnostic');
      return { node_id, runner_id: connection.hello.runner_id, checked_at: new Date().toISOString(),
        protocol_version: connection.hello.protocol_version, implementation_version: connection.hello.implementation_version,
        platform: connection.hello.platform, arch: connection.hello.arch, capabilities: connection.hello.capabilities,
        limits: connection.hello.limits, max_commands: connection.hello.max_commands,
        memory_reserve_bytes: connection.hello.memory_reserve_bytes, pinned: Boolean(node.expected_runner_id) };
    } finally { await connection.close(); }
  }
  async saveNodes(value, revision) {
    const view = this.settings.save(value, revision);
    await this.checkWatches();
    return view;
  }
  async saveCredentials(value, revision) {
    const view = this.credentials.save(value, revision);
    await this.checkWatches();
    return view;
  }
  async removeCredentials(value, revision) {
    const view = this.credentials.remove(value, revision);
    await this.checkWatches();
    return view;
  }
  async savePolicy(value, revision) {
    const nodes = this.readNodes().nodes;
    check(Array.isArray(value.allowed_node_ids) && value.allowed_node_ids.every(id => nodes.some(node => node.id === id)),
      'Project Runner authorization references an unknown node');
    check(value.default_node_id === this.readPolicy().default_node_id || value.default_node_id === 'local'
      || value.allowed_node_ids.includes(value.default_node_id), 'New default Runner must be explicitly authorized');
    const result = this.store.saveRunnerProject(value, revision);
    await this.checkWatches();
    return result;
  }
  #securityVersion(identity) {
    const { node } = this.assertBinding(identity);
    const generation = this.#deployment().managedNode(node)?.managed.runtime_generation?.sha256;
    return digest({ node_id: node.id, ssh_alias: node.ssh_alias, runner_id: node.expected_runner_id,
      ...(generation ? { runtime_generation: generation } : {}), budgets: node.budgets, auth: this.credentials.snapshot(node.id, identity.project_id) });
  }
  /** Independent current-policy monitor for an already granted Run. Stop callback uses retained
   * fixed authority, NOT a new general development permission check. It must return real stop proof.
   * Unwatching is not a release receipt; Store.runnerRun remains authoritative across restart.
   */
  watchRun(identity, stop) {
    check(typeof stop === 'function' && identity.run_id && !this.#watches.has(identity.run_id), 'Invalid or duplicate Runner Run watch');
    const entry = { identity: Object.freeze({ ...identity }), stop, version: this.#securityVersion(identity), invalid: false, stopping: null };
    this.#watches.set(identity.run_id, entry);
    if (!this.#timer) {
      this.#timer = setInterval(() => { void this.checkWatches().catch(() => {}); }, 250);
      this.#timer.unref();
    }
    return () => {
      this.#watches.delete(identity.run_id);
      if (!this.#watches.size) { clearInterval(this.#timer); this.#timer = null; }
    };
  }
  async #invalidate(entry) {
    if (entry.stopping) return entry.stopping;
    entry.invalid = true;
    // Preserve project grants when a device node is disabled; never resurrect this Run on re-enable.
    this.store.run("UPDATE runner_runs SET state='revoked',revision=revision+1 WHERE run_id=? AND state='active'", entry.identity.run_id);
    entry.stopping = (async () => {
      let result;
      try { result = await entry.stop(); } catch { result = { stopped: false, unknown: true }; }
      if (!stopped(result)) {
        const binding = this.store.runnerBinding(entry.identity.worker_id);
        if (binding && !['removed', 'unknown'].includes(binding.state))
          this.store.markRunnerWorkspaceUnknown(runnerIdentity(binding), binding.revision);
      }
      return result;
    })();
    return entry.stopping;
  }
  checkWatches() {
    if (this.#checking) return this.#checking;
    this.#checking = (async () => {
      const stops = [];
      for (const entry of this.#watches.values()) {
        let valid = false;
        try { valid = !entry.invalid && this.#securityVersion(entry.identity) === entry.version; } catch { /* fail closed */ }
        if (!valid) stops.push(this.#invalidate(entry));
      }
      return Promise.all(stops);
    })().finally(() => { this.#checking = null; });
    return this.#checking;
  }
  /** Explicit stop is allowed after revocation. A registered callback must revoke/release its
   * fixed lease as well as drain tools; neither aborting a model nor closing SSH is stop proof.
   * A later explicit call may reconcile a failed stop, but never replays code/tool requests.
   */
  stopRun(runId) {
    if (this.#stops.has(runId)) return this.#stops.get(runId);
    const run = this.store.runnerRun(runId);
    check(run, 'Runner Run was not registered');
    if (run.state === 'released') return Promise.resolve({ stopped: true, unknown: false });
    const entry = this.#watches.get(runId);
    this.store.revokeRunnerRun(runId);
    this.pending++;
    const operation = (async () => {
      let result;
      try {
        result = entry ? await this.#invalidate(entry) : await this.#reconcileRunStop(run);
        if (stopped(result)) {
          const current = this.store.runnerRun(runId);
          const receipts = this.store.runnerBarriers(run.worker_id).receipts.filter(receipt => receipt.run_id === runId);
          // A global empty process group does not prove an unknown file edit or object transfer.
          if (receipts.length) return { stopped: true, unknown: true, reason: 'unresolved_runner_receipts' };
          if (current.state !== 'released') this.store.releaseRunnerRun(runnerIdentity(run, { run_id: runId }), current.revision, { stopped: true });
          return { stopped: true, unknown: false };
        }
      } catch { /* Transport/raw protocol diagnostics may contain sensitive data; use a fixed code. */ }
      const binding = this.store.runnerBinding(run.worker_id);
      if (binding && binding.state !== 'unknown' && binding.state !== 'removed')
        this.store.markRunnerWorkspaceUnknown(runnerIdentity(binding), binding.revision);
      return { stopped: false, unknown: true, reason: 'runner_stop_unconfirmed' };
    })().finally(() => { this.pending--; this.#stops.delete(runId); });
    this.#stops.set(runId, operation);
    return operation;
  }
  async #reconcileRunStop(run) {
    const identity = runnerIdentity(run, { operation_id: `stop-run-${run.run_id}` });
    const connection = await this.connect(identity, { observation: true });
    try {
      const observed = await connection.client.call('workspace.inspect');
      check(observed.last_run_id <= run.run_id, 'Runner has a newer Run; do not revoke its lease');
      this.assertBinding(identity, { observation: true });
      const result = await connection.client.call('lease.revoke');
      const barrier = await connection.client.call('workspace.barrier');
      return { stopped: result.stopped === true && barrier.stopped === true && barrier.total === 0
        && !barrier.busy && !barrier.truncated, unknown: false };
    } finally { await connection.close(); }
  }
  async stopWorker(workerId) {
    const runs = this.store.runnerBarriers(workerId).runs;
    const results = await Promise.all(runs.map(run => this.stopRun(run.run_id)));
    const barriers = this.store.runnerBarriers(workerId);
    return { stopped: results.every(result => result.stopped) && barriers.runs.length === 0,
      unknown: results.some(result => result.unknown) || barriers.bindings.length > 0 || barriers.receipts.length > 0 };
  }
  async close() {
    this.#closed = true;
    const deploymentsClosing = this.#deployments?.close();
    await Promise.allSettled([...this.#stops.values()]);
    this.#closed = true; clearInterval(this.#timer); this.#timer = null;
    await Promise.allSettled([...this.#watches.values()].map(entry => this.#invalidate(entry)));
    this.#watches.clear();
    await Promise.allSettled([...this.#connections].map(client => client.close()));
    this.#connections.clear();
    await deploymentsClosing;
  }
}
