import { randomUUID } from 'node:crypto';
import { check } from './types.js';
import { hash, stable } from '../runner/protocol.js';
import { assertDeploymentBinding } from './runner-deployment-binding.js';
import { validateRecoveryRequest, validateRecoveryApproval, abandonRecoveryState } from './runner-deployment-recovery-view.js';
import { verifyDeploymentRunner } from './runner-deployment-verify.js';

const encodedHash = value => hash(JSON.stringify(value) + '\n');
const sealHash = r => encodedHash({ version: 1, id: r.id, plan_sha256: r.private_data.plan_sha256, node_id: r.node_id,
  runner_id: r.runner_id, execution_id: r.private_data.proof.stop_execution_id, stopped: true, verified_at: r.private_data.proof.checked_at });
const empty = () => ({ version: 1, items: [], generations: [], current: null, pending: null, gate: null });
function state(record) {
  const s = record.private_data.recovery ?? empty();
  check(s.version === 1 && Array.isArray(s.items) && s.items.length <= 16 && Array.isArray(s.generations) && s.generations.length <= 16
    && (s.gate === null || typeof s.gate === 'string'), 'Original installation recovery journal is invalid');
  return s;
}
function generation(record, envelope, previous, published = false) {
  const g = envelope?.generation;
  const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
  check(g?.version === 1 && uuid(envelope.recovery_id) && (!published || uuid(envelope.publication_id))
    && /^[a-f0-9]{64}$/.test(g.boot_id) && /^\/sys\/fs\/cgroup\/[A-Za-z0-9_./@:-]+$/.test(g.cgroup?.path) && !g.cgroup.path.includes('..')
    && g.cgroup.evidence?.boot_id === g.boot_id && encodedHash(g) === envelope.sha256 && envelope.recovery_id === g.id && g.deployment_id === record.id && g.node_id === record.node_id
    && g.runner_id === record.runner_id && g.original_manifest_sha256 === record.private_data.managed.manifest_sha256
    && g.original_seal_sha256 === sealHash(record) && /^[a-f0-9]{64}$/.test(g.original_config_sha256)
    && g.previous_generation_sha256 === previous, 'Recovered generation identity changed');
}
/** Current published descriptor only. A pending/unknown candidate never becomes ordinary authority. */
export function recoveryManaged(record, { observation = false } = {}) {
  const s = state(record), original = record.private_data.managed;
  check(observation || !s.gate && !s.items.some(item => item.applied && item.status !== 'ready'), 'Managed Runner recovery is running or unknown; no ordinary admission');
  let previous = null, published = null;
  for (const envelope of s.generations) {
    generation(record, envelope, previous, true);
    const receipt = s.items.find(item => item.id === envelope.recovery_id);
    check(stable(receipt?.activation) === stable(envelope) && receipt.proof?.expected_runner_id === record.runner_id
      && receipt.proof.stop_confirmed === true && receipt.proof.barrier_confirmed === true, 'Recovered generation is not explicitly activated');
    if (receipt.status !== 'ready') { check(observation && s.gate === envelope.recovery_id && envelope === s.generations.at(-1), 'Recovered publication is unknown'); break; }
    previous = envelope.sha256; published = envelope;
  }
  check(stable(s.current) === stable(s.generations.at(-1) ?? null), 'Published recovery generation changed');
  return { ...structuredClone(original), ...(published ? { runtime_generation: structuredClone(published) } : {}) };
}

/** Trusted orchestration only. Uses the existing installation flock; never holds a settings/receipt
 * write lock over SSH. Original installation status/proofs/config/credentials remain immutable. */
export class DeploymentRecovery {
  #active = new Map(); #closed = false; #closing;
  constructor({ plans, local, transport_factory, timeout_ms = 10000 }) { Object.assign(this, { plans, local, transport_factory, timeout_ms }); }
  get pending() { return this.#active.size; }
  #binding(record) {
    check(record.status === 'confirmed' && record.private_data.confirmation?.status === 'complete', 'Recovery requires the original independently confirmed installation');
    const binding = assertDeploymentBinding(record, this.local, { confirmed: true, observation: true });
    check(this.plans.currentSnapshot() === record.private_data.ssh_configuration, 'Original recovery SSH configuration changed');
    const node = binding.node;
    return { ...binding, policy: hash(stable({ id: node.id, ssh_alias: node.ssh_alias, enabled: node.enabled, expected_runner_id: node.expected_runner_id, budgets: node.budgets })) };
  }
  #guard(e) {
    check(!this.#closed && !e.stopping && !e.failed, 'Recovery is stopping or uncertain'); e.lease.assert();
    check(this.plans.store.read(e.record.id).revision === e.record.revision, 'Recovery receipt changed');
    check(this.plans.currentSnapshot() === e.ssh, 'Original recovery SSH configuration changed');
    if (e.kind !== 'reconcile') check(this.#binding(e.record).policy === e.policy, 'Recovery central configuration changed');
  }
  #update(e, mutate) {
    this.#guard(e);
    e.record = this.plans.store.change(e.record.id, e.record.revision, row => {
      row.private_data.recovery ??= empty();
      if (!e.claimed) abandonRecoveryState(row.private_data.recovery);
      mutate(row.private_data.recovery);
      const item = row.private_data.recovery.items.find(item => item.id === e.id);
      if (item) item.updated_at = new Date().toISOString();
    }, { guard: () => this.#guard(e) });
    return e.record;
  }
  #item(e, s = state(e.record)) { const item = s.items.find(item => item.id === e.id); check(item, 'Original recovery request not found'); return item; }
  #fail(e) {
    e.failed = true;
    try {
      const latest = this.plans.store.read(e.record.id), item = state(latest).items.find(item => item.id === e.id);
      if (!item || (e.kind === 'reconcile' ? item.observations?.at(-1)?.id !== e.observation_id : item.operation_id !== e.operation_id)) return;
      e.record = this.plans.store.change(latest.id, latest.revision, row => {
        const item = row.private_data.recovery.items.find(item => item.id === e.id);
        if (e.kind === 'reconcile') { const observed = item.observations.at(-1); if (observed.status === 'running') observed.status = 'unknown'; }
        else { item.status = 'unknown'; if (item.applied) row.private_data.recovery.gate = e.id;
          for (const stage of item.stages) if (stage.status === 'running') stage.status = 'unknown'; }
      }, { guard: e.lease.assert });
    } catch { /* Durable running + abandoned flock projects unknown; never overwrite newer ownership. */ }
  }
  #dispose(e) { return e.disposal ??= Promise.allSettled([...e.closers].map(close => Promise.resolve().then(close))); }
  #start(request, kind, admit, work) {
    check(!this.#closed, 'Recovery service is closed');
    const lease = this.plans.store.lease(request.id); let e;
    try {
      const record = this.plans.store.read(request.id); check(record.revision === request.expected_revision, 'Recovery revision changed');
      const binding = kind === 'reconcile' ? null : this.#binding(record);
      e = { lease, record, kind, id: request.recovery_id ?? randomUUID(), operation_id: randomUUID(), observation_id: randomUUID(), policy: binding?.policy,
        ssh: record.private_data.ssh_configuration, closers: new Set(), controller: new AbortController(), claimed: false };
      admit(e, binding); this.#active.set(record.id, e);
    } catch (error) { lease.release(); throw error; }
    e.promise = (async () => {
      try { await work(e); }
      catch { if (!e.claimed) throw new Error('Recovery intent could not be persisted; no action sent'); this.#fail(e); }
      finally { await this.#dispose(e); this.#active.delete(e.record.id); e.lease.release(); }
      return this.plans.operations.view(e.record);
    })();
    return e.promise;
  }
  #remote(e) { const remote = this.plans.remote_factory({ ssh_alias: e.record.ssh_alias, ssh_configuration: e.ssh }); e.closers.add(() => remote.close()); return remote; }
  async #stage(e, id, send, publish = null) {
    const request_id = randomUUID();
    this.#update(e, s => { const item = this.#item(e, s); check(!item.stages.some(stage => stage.id === id), 'Recovery stage cannot be replayed');
      item.stages.push({ id, status: 'running', request_id }); });
    const value = await send(request_id); this.#guard(e);
    this.#update(e, s => { const item = this.#item(e, s); publish?.(item, value, s); item.stages.find(stage => stage.id === id).status = 'complete'; });
    return value;
  }
  plan(request) {
    validateRecoveryRequest('plan', request);
    return this.#start(request, 'plan', (e, binding) => {
      const s = state(e.record); recoveryManaged(e.record); check(s.items.length < 16, 'Recovery history limit reached');
      e.frozen = { managed: recoveryManaged(e.record), from_generation: s.generations.length, policy: binding.policy,
        verification_budgets: { max_commands: 1, timeout_ms: Math.min(this.timeout_ms, binding.node.budgets.timeout_ms), output_bytes: Math.min(4096, binding.node.budgets.output_bytes) },
        blockers: Math.min(this.timeout_ms, binding.node.budgets.timeout_ms) < 100 || binding.node.budgets.output_bytes < 64 ? ['verification_budget_too_small'] : [] };
    }, async e => {
      this.#update(e, s => {
        for (const old of s.items) if (old.status === 'running' && !old.applied) old.status = 'unknown';
        s.items.push({ id: e.id, operation_id: e.operation_id, from_revision: e.record.revision, original_operation_id: e.record.private_data.operation_id,
          status: 'running', applied: false, created_at: new Date().toISOString(), frozen: e.frozen, stages: [] });
      }); e.claimed = true;
      const remote = this.#remote(e);
      await this.#stage(e, 'check_original', async () => {
        this.#guard(e);
        const result = await remote.recoveryCheck({ managed: e.frozen.managed, recovery_id: e.id });
        check(result?.ok === true && result.plan_sha256 === encodedHash(result.plan), 'Recovery plan bytes changed');
        const p = result.plan;
        check(p.recovery_id === e.id && p.deployment_id === e.record.id && p.node_id === e.record.node_id && p.runner_id === e.record.runner_id
          && p.original_manifest_sha256 === e.frozen.managed.manifest_sha256 && p.original_seal_sha256 === sealHash(e.record)
          && p.previous_generation_sha256 === (state(e.record).current?.sha256 ?? null), 'Original recovery identity changed');
        if (p.supported) {
          check(p.version === 1 && typeof p.epoch === 'string' && /^(?:0|[1-9][0-9]{0,14})$/.test(p.epoch) && /^[a-f0-9]{64}$/.test(p.boot_id)
            && /^[a-f0-9]{64}$/.test(p.original_config_sha256) && p.commands?.supported === true && p.commands.total === 0
            && p.unit?.name === e.frozen.managed.cgroup_evidence.unit && p.unit?.path === e.frozen.managed.cgroup_evidence.fragment_path
            && p.unit?.sha256 === e.frozen.managed.cgroup_evidence.unit_sha256 && typeof p.unit?.active === 'boolean'
            && (!e.frozen.managed.runtime_generation || p.original_config_sha256 === e.frozen.managed.runtime_generation.generation.original_config_sha256), 'Original unit or command evidence changed');
          validateRecoveryApproval(p, p.actions.map(a => a.id));
        }
        return result;
      }, (item, result) => { item.plan = result.plan; item.plan_sha256 = result.plan_sha256; });
      await remote.close(); this.#guard(e);
      this.#update(e, s => { const item = this.#item(e, s); item.status = item.plan.supported && !item.frozen.blockers.length ? 'planned' : 'blocked'; });
    });
  }
  apply(request) {
    validateRecoveryRequest('apply', request);
    return this.#start(request, 'apply', e => {
      const s = state(e.record), item = this.#item(e); recoveryManaged(e.record);
      check(item.status === 'planned' && !item.applied && item.plan_sha256 === encodedHash(item.plan) && item.frozen.policy === e.policy
        && item.frozen.from_generation === s.generations.length, 'Recovery plan changed or cannot be replayed');
      validateRecoveryApproval(item.plan, request.approved_actions); e.frozen = item.frozen;
    }, async e => {
      this.#update(e, s => { const item = this.#item(e, s); item.status = 'running'; item.applied = true; item.operation_id = e.operation_id;
        item.approval = { confirm: true, actions: [...request.approved_actions], plan_sha256: item.plan_sha256 }; s.gate = e.id; }); e.claimed = true;
      const item = this.#item(e), remote = this.#remote(e), base = { managed: e.frozen.managed, recovery_id: e.id, plan_sha256: item.plan_sha256 };
      const candidate = await this.#stage(e, 'bind_runtime_generation', async () => {
        this.#guard(e); return await remote.recoveryApply({ ...base, recovery_plan: item.plan, approved_actions: item.plan.actions.map(a => a.id) });
      }, (item, result) => { check(result?.ok === true, 'Recovery binding unconfirmed'); generation(e.record, { recovery_id: e.id, sha256: result.sha256, generation: result.generation }, state(e.record).current?.sha256 ?? null);
        check(result.generation.original_config_sha256 === item.plan.original_config_sha256 && result.generation.boot_id === item.plan.boot_id
          && result.generation.cgroup?.evidence?.boot_id === item.plan.boot_id && result.generation.unit?.name === item.plan.unit.name
          && result.generation.unit?.path === item.plan.unit.path && result.generation.unit?.sha256 === item.plan.unit.sha256, 'Recovery candidate changed'); item.candidate = result; });
      const proof = await this.#stage(e, 'verify_runner', async () => verifyDeploymentRunner({ deployment_id: e.record.id, node_id: e.record.node_id, project_id: e.record.project_id,
        operation_id: e.operation_id, expected_runner_id: e.record.runner_id, runtime_path: `${e.record.plan.install_root}/bun`, runtime_version: e.record.plan.runtime.version,
        implementation_version: e.record.plan.runner.version, arch: e.record.plan.target.arch, auth: structuredClone(e.record.private_data.local.pairing.auth),
        ...{ timeout_ms: e.frozen.verification_budgets.timeout_ms, output_bytes: e.frozen.verification_budgets.output_bytes },
        transport_factory: () => { this.#guard(e); return this.transport_factory({ managed: e.frozen.managed, configuration: e.ssh, recovery_id: e.id, generation_sha256: candidate.sha256 }); },
        checkpoint: event => this.#update(e, s => { const item = this.#item(e, s); item.verification ??= []; check(item.verification.length < 64, 'Recovery verification journal limit'); item.verification.push(event); }),
        guard: () => this.#guard(e), signal: e.controller.signal, on_client: client => { const close = () => client.close(); e.closers.add(close); return () => e.closers.delete(close); } }), (item, proof) => {
          check(proof.expected_runner_id === e.record.runner_id && proof.runner_id === e.record.runner_id && proof.stop_confirmed && proof.barrier_confirmed, 'Original Runner verification unconfirmed'); item.proof = proof;
        });
      await this.#stage(e, 'seal_generation', async () => { this.#guard(e); return await remote.recoverySeal({ ...base,
        proof: { node_id: e.record.node_id, runner_id: proof.runner_id, execution_id: proof.stop_execution_id, stopped: true, verified_at: proof.checked_at } }); }, (item, result) => {
        check(result?.ok === true && result.sha256 === candidate.sha256 && stable(result.generation) === stable(candidate.generation), 'Sealed generation changed'); item.seal = result;
      });
      const publication_id = randomUUID(), envelope = { recovery_id: e.id, sha256: candidate.sha256, publication_id, generation: candidate.generation };
      await this.#stage(e, 'publish_generation', async () => envelope, (item, value, s) => { item.publication = value; s.pending = value; });
      await this.#stage(e, 'activate_generation', async () => { this.#guard(e); return await remote.recoveryActivate({ ...base, generation_sha256: envelope.sha256, central_publication_id: publication_id }); }, (item, result) => {
        check(result?.ok === true && stable(result.runtime_generation) === stable(envelope), 'Original generation activation unconfirmed'); item.activation = result.runtime_generation;
      });
      await remote.close(); this.#guard(e);
      this.#update(e, s => { const item = this.#item(e, s); check(s.gate === e.id && stable(s.pending) === stable(envelope), 'Recovery publication gate changed');
        item.status = 'ready'; s.generations.push(envelope); s.current = envelope; s.pending = null; s.gate = null; });
    });
  }
  reconcile(request) {
    validateRecoveryRequest('reconcile', request);
    return this.#start(request, 'reconcile', e => { const item = this.#item(e); check(item.applied && item.plan_sha256 && (item.observations?.length ?? 0) < 16, 'Original applied recovery required'); e.frozen = item.frozen; }, async e => {
      this.#update(e, s => { const item = this.#item(e, s); if (item.status === 'running') item.status = 'unknown';
        item.observations ??= []; for (const o of item.observations) if (o.status === 'running') o.status = 'unknown';
        item.observations.push({ id: e.observation_id, status: 'running', request_id: randomUUID() }); }); e.claimed = true;
      const remote = this.#remote(e), item = this.#item(e);
      const observed = await remote.recoveryInspect({ managed: item.frozen.managed, recovery_id: e.id, plan_sha256: item.plan_sha256 });
      await remote.close(); this.#guard(e);
      this.#update(e, s => { const o = this.#item(e, s).observations.at(-1); check(o.id === e.observation_id, 'Recovery observation identity changed');
        o.status = 'complete'; o.remote_status = ['prepared', 'sealed', 'activated'].includes(observed.status) ? observed.status : 'unknown'; });
      // No activation/publication/gate transition, including a positive original activated observation.
    });
  }
  close() {
    if (!this.#closing) { this.#closed = true; const entries = [...this.#active.values()];
      for (const e of entries) { e.stopping = true; e.controller.abort(); if (e.claimed) this.#fail(e); void this.#dispose(e); }
      this.#closing = Promise.allSettled(entries.map(e => e.promise)).then(() => {}); }
    return this.#closing;
  }
}
