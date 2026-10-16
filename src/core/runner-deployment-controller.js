import { DeploymentPlans } from './runner-deployment-plans.js';
import { DeploymentLocal } from './runner-deployment-local.js';
import { DeploymentRejection } from './runner-deployment-operations.js';
import { validateDeploymentRequest, validateDeploymentApproval, publicDeployment, deploymentObservationFacts } from './runner-deployment-view.js';
import { verifyDeploymentRunner } from './runner-deployment-verify.js';
import { DeploymentRecovery, recoveryManaged } from './runner-deployment-recovery.js';
import { deploymentTransport, deploymentRecoveryTransport } from './runner-deployment-transport.js';
import { assertDeploymentBinding } from './runner-deployment-binding.js';
import { RunnerClient } from '../runner/client.js';
import { hash, stable } from '../runner/protocol.js';
import { check } from './types.js';

/** Private orchestration only. No JSON may select factories, commands, artifacts or verification.
 * Acknowledged verification produces ready, NOT pinning/enabling/project authorization. Original
 * requests are never resumed/replayed after uncertain results, including central publication loss.
 */
export class DeploymentController {
  constructor(config, { plans = new DeploymentPlans(config), local = new DeploymentLocal(config), transport_factory = deploymentTransport, recovery_transport_factory = deploymentRecoveryTransport, verification_timeout_ms = 10000 } = {}) {
    this.plans = plans; this.local = local; this.transport_factory = transport_factory; this.verification_timeout_ms = verification_timeout_ms;
    this.recovery = new DeploymentRecovery({ plans, local, transport_factory: recovery_transport_factory, timeout_ms: verification_timeout_ms });
  }
  get pending() { return this.plans.pending + this.recovery.pending; }
  async planRecovery(request) { return publicDeployment(await this.recovery.plan(request)); }
  async applyRecovery(request) { return publicDeployment(await this.recovery.apply(request)); }
  async reconcileRecovery(request) { return publicDeployment(await this.recovery.reconcile(request)); }
  plan(request) { return this.plans.plan(request); }
  async apply(request) {
    validateDeploymentRequest('runner.deployments.apply', request);
    const { id, expected_revision, approved_actions } = request, record = this.plans.store.read(id);
    check(record.revision === expected_revision && record.status === 'planned', 'Deployment revision changed or operation cannot be replayed');
    validateDeploymentApproval(record.plan, approved_actions);
    check(record.private_data.plan_sha256 === hash(stable(record.plan)), 'Deployment frozen plan changed');
    check(this.plans.currentSnapshot() === record.private_data.ssh_configuration, 'Deployment SSH configuration changed; no action was sent');
    const bundle = this.plans.artifacts(record); // Full local readback BEFORE any remote/central mutation.
    const privileged = record.plan.actions.filter(action => action.privileged).map(action => action.id);
    const stages = ['recheck', 'prepare_remote', 'node_register', 'credentials_pair', 'install_runtime', 'install_runner', ...privileged, 'configure_runner', 'verify_runner', 'seal_runner'];
    let final_guard;
    try {
      const result = await this.plans.operations.run(id, expected_revision, { stages, publish: () => final_guard() }, async context => {
        context.checkpoint(row => { row.private_data.approval = { confirm: true, operation_id: row.private_data.operation_id,
          plan_sha256: row.private_data.plan_sha256, approved_actions: [...approved_actions] }; });
        const remote = this.plans.remote_factory({ ssh_alias: record.ssh_alias, ssh_configuration: record.private_data.ssh_configuration });
        context.onClose(() => remote.close());
        const base = { id, plan: record.plan, plan_sha256: record.private_data.plan_sha256 };
        const guard = () => {
          context.guard();
          check(this.plans.currentSnapshot() === record.private_data.ssh_configuration, 'Deployment SSH configuration changed');
          const current = context.read();
          if (current.private_data.local?.registration?.status === 'complete') {
            if (current.private_data.active_stage) this.local.assert(context, { paired: current.private_data.local.pairing?.status === 'complete' });
            else {
              const observed = this.local.observe(current);
              check(observed.registration === 'matching' && observed.pairing === 'matching', 'Deployment central configuration changed before readiness');
            }
          }
        };
        final_guard = guard;
        await context.stage('recheck', async () => {
          const current = await remote.probe({ id, abi: record.plan.abi }); guard();
          if (hash(stable(current)) !== record.private_data.plan_proof) throw new DeploymentRejection();
          // New alias/node registrations during inspection also invalidate admission before prepare.
          if (this.local.settings.read().nodes.some(node => node.id === id || node.ssh_alias === record.ssh_alias)) throw new DeploymentRejection();
        });
        await context.stage('prepare_remote', async intent => { guard(); return await remote.prepare({ ...base, request_id: intent.request_id }); }, (row, proof) => { row.private_data.preparation = proof; });
        await context.stage('node_register', () => { guard(); return this.local.register(context); });
        const pairing = await context.stage('credentials_pair', () => { guard(); return this.local.pair(context); });
        for (const kind of ['runtime', 'runner']) await context.stage(`install_${kind}`, async intent => {
          guard(); return await remote.upload({ ...base, request_id: intent.request_id, kind, artifact: { ...bundle[kind], ...(kind === 'runner' ? { files: bundle.files } : {}) } });
        });
        for (const action of privileged) await context.stage(action, async intent => { guard(); return await remote.system({ ...base, request_id: intent.request_id, action }); },
          (row, proof) => { row.private_data.system_results ??= {}; row.private_data.system_results[action] = proof; });
        const cgroup = context.read().private_data.system_results?.cgroup_setup?.cgroup ?? record.plan.cgroup;
        check(cgroup?.path && cgroup.evidence, 'Deployment cgroup evidence is incomplete');
        await context.stage('configure_runner', async intent => {
          guard();
          return await remote.configure({ ...base, request_id: intent.request_id, node_config: { version: 1, node_id: pairing.node_id,
            root: `${record.plan.install_root}/workspaces`, cgroup_root: cgroup.path, machine_token_hash: pairing.machine_token_hash,
            projects: { [record.project_id]: { control_token_hash: pairing.control_token_hash } },
            budgets: record.plan.node_budgets, max_commands: record.plan.node_budgets.max_commands } });
        }, (row, result) => { row.private_data.managed = result.managed; });
        const managed = context.read().private_data.managed;
        check(managed?.node_id === pairing.node_id && managed.deployment_id === id && managed.plan_sha256 === base.plan_sha256
          && managed.cgroup_root === cgroup.path && stable(managed.cgroup_evidence) === stable(cgroup.evidence), 'Deployment managed configuration acknowledgement changed');
        const proof = await context.stage('verify_runner', async () => {
          guard();
          return await verifyDeploymentRunner({ deployment_id: id, node_id: pairing.node_id, project_id: record.project_id,
            operation_id: context.read().private_data.operation_id, runtime_path: `${record.plan.install_root}/bun`, runtime_version: record.plan.runtime.version,
            implementation_version: record.plan.runner.version, arch: record.plan.target.arch, auth: this.local.auth(context),
            transport_factory: () => { guard(); return this.transport_factory({ managed, configuration: record.private_data.ssh_configuration }); },
            checkpoint: event => context.checkpoint(row => { row.private_data.verification ??= []; check(row.private_data.verification.length < 64, 'Deployment verification journal limit'); row.private_data.verification.push(event); }),
            guard, signal: context.signal, timeout_ms: this.verification_timeout_ms, on_client: client => context.onClose(() => client.close()) });
        }, (row, proof) => { row.runner_id = proof.runner_id; row.private_data.proof = proof; });
        await context.stage('seal_runner', async intent => {
          guard();
          return await remote.seal({ ...base, request_id: intent.request_id, proof: { node_id: pairing.node_id, runner_id: proof.runner_id,
            execution_id: proof.stop_execution_id, stopped: true, verified_at: proof.checked_at } });
        }, (row, seal) => { check(seal?.runner_id === row.runner_id, 'Deployment seal identity changed'); row.private_data.seal = seal; });
        guard();
      });
      return publicDeployment(this.plans.operations.view(result));
    } finally { this.plans.release(id); }
  }
  async confirm(request) {
    validateDeploymentRequest('runner.deployments.confirm', request);
    const record = this.plans.store.read(request.id);
    check(record.revision === request.expected_revision && record.status === 'ready' && record.runner_id === request.runner_id, 'Deployment confirmation identity/revision changed or cannot be replayed');
    assertDeploymentBinding(record, this.local);
    check(this.plans.currentSnapshot() === record.private_data.ssh_configuration, 'Deployment SSH configuration changed');
    let final_guard;
    const result = await this.plans.operations.run(record.id, record.revision, { purpose: 'confirm', stages: ['confirm_remote', 'confirm_binding'], finish: 'confirmed', publish: () => final_guard() }, async context => {
      const guard = (confirmed = false) => {
        context.guard();
        check(this.plans.currentSnapshot() === record.private_data.ssh_configuration, 'Deployment SSH configuration changed');
        return assertDeploymentBinding(context.read(), this.local, { confirmed });
      };
      const remote = this.plans.remote_factory({ ssh_alias: record.ssh_alias, ssh_configuration: record.private_data.ssh_configuration });
      context.onClose(() => remote.close());
      await context.stage('confirm_remote', async intent => {
        guard();
        const observed = await remote.inspect({ id: record.id, plan: record.plan, plan_sha256: record.private_data.plan_sha256, request_id: intent.request_id });
        guard();
        check(observed.integrity === 'verified' && observed.sealed === true && stable(observed.managed) === stable(record.private_data.managed), 'Original sealed installation integrity changed');
        // Authenticate actual persistent runner_id again, not merely a file/SSH success or old proof.
        const identity = { project_id: record.project_id, node_id: record.node_id, worker_id: 1, workspace_id: `deployment-${record.id}`, generation: 1, operation_id: context.read().private_data.operation_id };
        context.checkpoint(row => { row.private_data.confirmation.connection = { identity, status: 'intent' }; });
        guard();
        const transport = await this.transport_factory({ managed: record.private_data.managed, configuration: record.private_data.ssh_configuration });
        let client, untrack;
        try {
          guard();
          client = new RunnerClient({ transport, identity, auth: record.private_data.local.pairing.auth, expected_runner_id: record.runner_id, budgets: record.plan.node_budgets });
          untrack = context.onClose(() => client.close());
          const hello = await client.handshake({ signal: context.signal, timeout_ms: this.verification_timeout_ms, before_send: frame => {
            guard(); context.checkpoint(row => { row.private_data.confirmation.hello_intent = { request_id: frame.request_id, identity: frame.identity, fingerprint: frame.fingerprint }; });
          } });
          guard();
          check(hello.runner_id === record.runner_id && hello.platform === record.plan.target.os && hello.arch === record.plan.target.arch
            && hello.implementation_version === record.plan.runner.version, 'Deployment installation identity changed during confirmation');
          return { runner_id: hello.runner_id, integrity: 'verified', checked_at: new Date().toISOString() };
        } finally { await (client ? client.close() : transport.close()); untrack?.(); }
      }, (row, observed) => { row.private_data.confirmation.remote = observed; });
      await context.stage('confirm_binding', () => {
        guard(); const before = this.local.settings.read();
        const saved = this.local.settings.pinDeployment({ node_id: record.node_id, runner_id: record.runner_id, expected_node: record.private_data.local.registration.node }, before.revision, () => guard());
        return saved.nodes.find(node => node.id === record.node_id);
      }, (row, node) => { row.private_data.confirmation.node = node; });
      final_guard = () => guard(true);
      final_guard();
    });
    return publicDeployment(this.plans.operations.view(result));
  }
  async reconcile(request) {
    validateDeploymentRequest('runner.deployments.reconcile', request);
    const result = await this.plans.operations.observe(request.id, request.expected_revision, async (context, intent) => {
      const record = context.read(), data = record.private_data;
      let remoteFacts = { integrity: 'not_started', binding: 'unrecorded' };
      // Only an original dispatched installation intent may be inspected. Never prepare/upload,
      // authenticate a new Runner, replay a stage, recover a lease or promote ready/confirmed here.
      if (data.intents?.prepare_remote) {
        check(data.plan_sha256 === hash(stable(record.plan)), 'Original frozen deployment plan changed');
        const guard = () => { context.guard(); check(this.plans.currentSnapshot() === data.ssh_configuration, 'Original deployment SSH configuration changed'); };
        guard();
        const remote = this.plans.remote_factory({ ssh_alias: record.ssh_alias, ssh_configuration: data.ssh_configuration });
        const untrack = context.onClose(() => remote.close());
        try {
          guard();
          const observed = await remote.inspect({ id: record.id, plan: record.plan, plan_sha256: data.plan_sha256, request_id: intent.request_id });
          guard();
          remoteFacts = { ...observed, binding: !data.managed ? 'unrecorded' : stable(observed.managed) === stable(data.managed) ? 'matching' : 'changed' };
          if (data.managed && remoteFacts.binding !== 'matching') remoteFacts.integrity = 'changed';
        } finally { await remote.close(); untrack(); }
        guard();
      }
      const facts = deploymentObservationFacts({ local: this.local.observe(record), remote: remoteFacts });
      // Retain only bounded observation facts, not newly observed configuration or private proofs.
      context.checkpoint(row => { row.private_data.reconciliations.at(-1).facts = facts; });
      return facts;
    });
    return publicDeployment(this.plans.operations.view(result));
  }
  /** Actual production selection: a registered deployment never falls back to bare lush-runner. */
  managedNode(node, options = {}) {
    const records = this.plans.store.list().items.filter(record => record.node_id === node.id);
    if (!records.length) return null;
    check(records.length === 1 && records[0].status === 'confirmed' && records[0].private_data.confirmation?.status === 'complete', 'Managed Runner installation is unconfirmed or blocked');
    const record = records[0], binding = assertDeploymentBinding(record, this.local, { confirmed: true, observation: true });
    check(this.plans.currentSnapshot() === record.private_data.ssh_configuration, 'Managed Runner SSH configuration changed');
    return { ...binding, managed: recoveryManaged(record, options), configuration: record.private_data.ssh_configuration };
  }
  close() { return Promise.all([this.recovery.close(), this.plans.close()]).then(() => {}); }
}
