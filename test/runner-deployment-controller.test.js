import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeploymentController } from '../src/core/runner-deployment-controller.js';
import { DeploymentPlans } from '../src/core/runner-deployment-plans.js';
import { deploymentTransport, deploymentRecoveryTransport } from '../src/core/runner-deployment-transport.js';
import { StdioTransport } from '../src/runner/transport.js';
import { RunnerService } from '../src/core/runner-service.js';
import { deploymentAbiEvidence } from '../src/core/runner-deployment-remote.js';
import { recoveryManaged } from '../src/core/runner-deployment-recovery.js';
import { publicRecovery } from '../src/core/runner-deployment-recovery-view.js';
import { IMPLEMENTATION_VERSION, hash } from '../src/runner/protocol.js';

// Explicit central-orchestration fixture: system observations/uploads use a controlled executor,
// NOT a fake claim of real SSH/artifact extraction/cgroup installation. Positive verification uses
// an actual independent Runner/guard/Bun/native FFI process-group fixture, never production bypass.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-controller-')), home = path.join(root, 'remote'), config = { home: path.join(root, 'device') };
  fs.mkdirSync(home, { mode: 0o700 });
  const safetyBin = path.join(root, 'no-network'); fs.mkdirSync(safetyBin, { mode: 0o700 });
  fs.writeFileSync(path.join(safetyBin, 'ssh'), '#!/bin/sh\nexit 91\n', { mode: 0o700 });
  const configuration = 'Host fixture\nhostname "fixture.invalid"\n';
  const abi = deploymentAbiEvidence({ files: [{ path: '/lib64/ld-linux-x86-64.so.2', realpath: '/lib64/ld-linux-x86-64.so.2', size: 1, sha256: 'a'.repeat(64) }] });
  const state = { calls: [], frames: [], observations: [], cleanup: 0, connections: 0, fault: null, transform: null, stale: false, change_snapshot: false, installer: false, sealed: false };
  const request = { name: 'Controlled node', ssh_alias: 'fixture', project_id: 'controller-test' };
  const artifact = (kind, body) => { const file = path.join(root, kind); fs.writeFileSync(file, body, { mode: 0o600 }); return { file, size: Buffer.byteLength(body), sha256: hash(body) }; };
  const probe = id => ({ target: { os: 'linux', arch: process.arch, uid: process.getuid(), user: os.userInfo().username, home }, install_root: `${home}/.local/share/lush-runner/managed/${id}`,
    remote: { machine_id: 'b'.repeat(64), boot_id: (state.stale ? 'd' : 'c').repeat(64), home_dev: '1', home_ino: '2', abi_sha256: hash(JSON.stringify(abi)) }, abi: { status: 'ready' },
    dependencies: [{ name: 'Git', status: 'ready' }, { name: 'Bun', status: 'needs_install' }], cgroup: { status: 'ready', path: '/sys/fs/cgroup/controller-fixture/lush-runner', evidence: { dev: '1', ino: '2', boot_id: 'c'.repeat(64), ...(state.recovery_unit ? {
      unit: `lush-runner-delegate-${process.getuid()}-${id}.service`, fragment_path: `/etc/systemd/system/lush-runner-delegate-${process.getuid()}-${id}.service`, unit_sha256: '1'.repeat(64),
      delegated_parent: '/sys/fs/cgroup/controller-fixture', sleep_path: '/usr/bin/sleep', systemctl_path: '/usr/bin/systemctl' } : {}) } },
    system: state.system_setup ? { systemd: 254, system_tools: true, sleep_path: '/usr/bin/sleep', sudo_n: true } : { systemd: 0 }, install: { exists: false, managed: false, legacy: false }, pending: { exists: false } });
  const observeProbe = id => { const result = probe(id); if (state.system_setup) result.cgroup = { status: 'needs_setup', message: 'Query actual ControlGroup after authorized setup' }; return result; };
  let plans;
  const execute = (method, args) => {
    const row = plans.store.read(args.id); state.calls.push(method);
    if (method === 'inspect' && row.private_data.reconciliations?.at(-1)?.status === 'running') {
      expect(plans.store.isActive(args.id)).toBe(true); expect(row.private_data.reconciliations.at(-1).request_id).toBe(args.request_id);
      if (method === state.fault) throw new Error('PRIVATE-SSH-STDERR-DO-NOT-EXPOSE');
      return;
    }
    expect(row.status).toBe('running'); expect(row.private_data.active_stage).toBe({ prepare: 'prepare_remote', runtime: 'install_runtime', runner: 'install_runner', configure: 'configure_runner', seal: 'seal_runner' }[method] ?? (method === 'inspect' ? 'confirm_remote' : method));
    expect(row.private_data.intents[row.private_data.active_stage].request_id).toBe(args.request_id);
    if (method === state.fault) throw new Error('PRIVATE-SSH-STDERR-DO-NOT-EXPOSE');
  };
  plans = new DeploymentPlans(config, { snapshot: () => ({ status: 'ok', limited: false, configuration: state.change_snapshot ? configuration + '#changed\n' : configuration }),
    build_artifacts: async () => ({ runtime: { ...artifact('runtime', 'contract runtime'), version: Bun.version, source: 'central-bun', os: 'linux', arch: process.arch, abi: { ...abi, supported: true } },
      runner: { ...artifact('runner', 'contract archive'), version: IMPLEMENTATION_VERSION }, files: ['src/runner/index.js'], cleanup() { state.cleanup++; } }),
    remote_factory: () => ({
      async probe({ id }) { state.calls.push('probe'); return observeProbe(id); },
      async prepare(args) { execute('prepare', args); state.installer = true; fs.mkdirSync(args.plan.install_root, { recursive: true, mode: 0o700 }); return { root_identity: '1:2' }; },
      async upload(args) {
        execute(args.kind, args);
        if (args.kind === 'runtime') fs.symlinkSync(process.execPath, path.join(args.plan.install_root, 'bun')); // Test-only native runtime mapping, never production upload behavior.
        return { ok: true, stage: args.kind, sha256: args.artifact.sha256, size: args.artifact.size };
      },
      async system(args) { execute(args.action, args); state.bound_cgroup = { path: '/sys/fs/cgroup/delegate-new/runner', evidence: { dev: '1', ino: '42', boot_id: 'c'.repeat(64) } }; return { ok: true, cgroup: state.bound_cgroup }; },
      async configure(args) {
        execute('configure', args); state.remote_config = args.node_config;
        fs.writeFileSync(path.join(args.plan.install_root, 'config.json'), JSON.stringify({ ...args.node_config, memory_reserve_bytes: 0 }), { mode: 0o600 });
        // Emulate the new configure descriptor's fixed control identities, not a
        // live lease/publication/SSH attestation. The controlled transport below
        // still deliberately bypasses managed launch; remote tests exercise it.
        for (const name of ['workspaces', 'recoveries', 'runtime-generations']) fs.mkdirSync(path.join(args.plan.install_root, name), { mode: 0o700 });
        for (const [name, bytes] of Object.entries({ 'connection-lease': '', 'activity-lock': '', 'activity-epoch': '0\n', 'recovery-gate': 'none\n' })) fs.writeFileSync(path.join(args.plan.install_root, name), bytes, { flag: 'wx', mode: 0o600 });
        const control = Object.fromEntries(Object.entries({ lease: 'connection-lease', activity_lock: 'activity-lock', epoch: 'activity-epoch', gate: 'recovery-gate', recoveries: 'recoveries', generations: 'runtime-generations', workspaces: 'workspaces', config: 'config.json' }).map(([key, name]) => { const stat = fs.statSync(path.join(args.plan.install_root, name)); return [key, `${stat.dev}:${stat.ino}`]; }));
        state.managed = { version: 1, deployment_id: args.id, plan_sha256: args.plan_sha256, node_id: args.node_config.node_id,
          cgroup_root: args.node_config.cgroup_root, cgroup_evidence: state.bound_cgroup?.evidence ?? args.plan.cgroup.evidence, install_root: args.plan.install_root,
          root: `${args.plan.install_root}/workspaces`, config_file: `${args.plan.install_root}/config.json`, root_identity: '1:2', manifest_sha256: '9'.repeat(64),
          runtime_sha256: args.plan.runtime.sha256, runtime_size: args.plan.runtime.size, runner_sha256: args.plan.runner.sha256,
          ssh_alias: 'fixture', ssh_config_sha256: hash(configuration), target: args.plan.target, remote: args.plan.remote, abi: args.plan.abi, control };
        return { managed: state.managed };
      },
      async seal(args) { execute('seal', args); state.sealed = true; state.seal_proof = args.proof; state.after_seal?.(); return { runner_id: args.proof.runner_id }; },
      async inspect(args) { execute('inspect', args); await state.inspect_hook?.(); return { integrity: state.integrity ?? (state.managed ? 'verified' : 'not_configured'), sealed: state.sealed, managed: state.managed, ...state.inspection_data }; },
      async recoveryCheck(args) { return await state.recovery_methods.check(args); },
      async recoveryApply(args) { return await state.recovery_methods.apply(args); },
      async recoverySeal(args) { return await state.recovery_methods.seal(args); },
      async recoveryActivate(args) { return await state.recovery_methods.activate(args); },
      async recoveryInspect(args) { return await state.recovery_methods.inspect(args); },
      async close() { state.closed = true; },
    }) });
  const transport_factory = ({ managed }) => {
    state.connections++;
    const transport = new StdioTransport({ command: process.execPath, args: [path.resolve(import.meta.dir, 'runner/fixtures/integration-node.js'), path.join(managed.install_root, 'config.json')], env: { PATH: '/usr/bin:/bin', HOME: home }, request_ms: 2000 });
    return { async request(frame, options) {
      state.frames.push({ method: frame.method, request_id: frame.request_id });
      const row = plans.store.read(managed.deployment_id);
      if (row.status === 'running' && (frame.method === 'hello' || ['workspace.register', 'command.start', 'command.cancel'].includes(frame.method))) {
        if (row.private_data.operation_kind === 'confirm') expect(row.private_data.confirmation.hello_intent.request_id).toBe(frame.request_id);
        else expect(row.private_data.verification.some(event => event.phase === 'intent' && event.request_id === frame.request_id)).toBe(true);
      }
      const result = await transport.request(frame, options);
      if (['command.start', 'command.status', 'command.cancel'].includes(frame.method)) {
        const fields = ['state', 'reason', 'stop_confirmed', 'exit_code', 'output_complete', 'truncated'];
        state.observations.push({ method: frame.method, ...(result.error ? { code: result.error.code } : Object.fromEntries(fields.filter(key => Object.hasOwn(result.result ?? {}, key)).map(key => [key, result.result[key]]))) });
        if (state.observations.length > 32) state.observations.shift();
      }
      return state.transform ? state.transform(frame, result) : result;
    }, close: () => transport.close() };
  };
  const controller = new DeploymentController(config, { plans, verification_timeout_ms: 8000, transport_factory, recovery_transport_factory: args => {
    const record = plans.store.read(args.managed.deployment_id), item = record.private_data.recovery.items.at(-1);
    expect(item.stages.at(-1)).toMatchObject({ id: 'verify_runner', status: 'running' });
    expect(item.candidate.sha256).toBe(args.generation_sha256); expect(item.id).toBe(args.recovery_id);
    state.recovery_transport_hook?.(args);
    return transport_factory(args); // Explicit process-group/native Runner adapter, NOT the provisional SSH/FD launcher.
  } });
  return { root, config, plans, controller, state, request,
    async plan() { const result = await controller.plan(request); expect(result.status).toBe('planned'); return result; },
    apply(plan, overrides = {}) { return controller.apply({ id: plan.id, expected_revision: plan.revision, approved_actions: plan.plan.actions.map(item => item.id), confirm: true, ...overrides }); },
    confirm(record, overrides = {}) { return controller.confirm({ id: record.id, expected_revision: record.revision, runner_id: record.runner_id, confirm: true, ...overrides }); },
    reconcile(record, overrides = {}) { return controller.reconcile({ id: record.id, expected_revision: record.revision, ...overrides }); },
    check(service, node_id) {
      // Transport construction precedes its first await. Even a routing regression must never call real SSH.
      const before = process.env.PATH; process.env.PATH = `${safetyBin}:${before}`;
      try { return service.checkNode(node_id, request.project_id); } finally { process.env.PATH = before; }
    },
    async close() { await controller.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('approved private controller -> real central registration/pairing -> independent actual Runner/Bun/FFI/live cancel/barrier -> original seal, never enable/pin', async () => {
  const f = fixture();
  try {
    const plan = await f.plan(), result = await f.apply(plan), record = f.plans.store.read(plan.id);
    if (result.status !== 'ready') console.error(JSON.stringify({ fixture_diagnostic: { status: result.status, stages: result.stages, frames: f.state.frames.map(frame => frame.method) } }));
    expect(result.status).toBe('ready'); expect(f.state.connections).toBe(1);
    expect(f.state.calls).toEqual(['probe', 'probe', 'prepare', 'runtime', 'runner', 'configure', 'seal']);
    expect(record.private_data.proof).toMatchObject({ runner_id: result.runner_id, runtime_verified: true, ffi_verified: true, stop_confirmed: true, barrier_confirmed: true });
    expect(f.state.frames.filter(frame => frame.method === 'command.start')).toHaveLength(2); expect(f.state.frames.filter(frame => frame.method === 'command.cancel')).toHaveLength(1);
    const auth = f.controller.local.credentials.snapshot(result.node_id, f.request.project_id);
    expect(f.state.remote_config.machine_token_hash).toBe(hash(auth.machine_token)); expect(f.state.remote_config.projects[f.request.project_id].control_token_hash).toBe(hash(auth.control_token));
    expect(f.state.seal_proof).toEqual({ node_id: result.node_id, runner_id: result.runner_id, execution_id: record.private_data.proof.stop_execution_id, stopped: true, verified_at: record.private_data.proof.checked_at });
    expect(f.controller.local.settings.read().nodes[0]).toMatchObject({ enabled: false, expected_runner_id: null });
    const publicJson = JSON.stringify(result);
    for (const secret of [auth.machine_token, auth.control_token, hash(auth.machine_token), hash(auth.control_token), 'private_data', 'manifest_sha256', 'PRIVATE-SSH']) expect(publicJson).not.toContain(secret);
    expect(f.state.cleanup).toBe(1); const count = f.state.calls.length;
    await expect(f.apply(result)).rejects.toThrow('cannot be replayed'); expect(f.state.calls.length).toBe(count);
  } finally { await f.close(); }
});

for (const kind of ['confirmation', 'missing_approval', 'extra_approval', 'revision', 'artifact', 'ssh']) test(`pre-dispatch ${kind} rejection cannot register, pair, SSH-recheck or install`, async () => {
  const f = fixture();
  try {
    const plan = await f.plan();
    const override = kind === 'confirmation' ? { confirm: false } : kind === 'missing_approval' ? { approved_actions: [] } : kind === 'extra_approval' ? { approved_actions: [...plan.plan.actions.map(a => a.id), 'cgroup_setup'] } : kind === 'revision' ? { expected_revision: plan.revision + 1 } : {};
    if (kind === 'artifact') fs.writeFileSync(path.join(f.root, 'runtime'), 'wrong');
    if (kind === 'ssh') f.state.change_snapshot = true;
    await expect(f.apply(plan, override)).rejects.toThrow();
    expect(f.state.calls).toEqual(['probe']); expect(f.controller.local.settings.read().nodes).toEqual([]); expect(f.controller.local.credentials.read().nodes).toEqual([]);
    expect(f.plans.store.read(plan.id).status).toBe('planned');
  } finally { await f.close(); }
});

test('rechecked target drift acknowledges stale evidence before prepare, registration, token generation or any upload', async () => {
  const f = fixture();
  try {
    const plan = await f.plan(); f.state.stale = true; const result = await f.apply(plan);
    expect(result.status).toBe('failed'); expect(f.state.calls).toEqual(['probe', 'probe']); expect(f.state.installer).toBe(false);
    expect(f.controller.local.settings.read().nodes).toEqual([]); expect(f.controller.local.credentials.read().nodes).toEqual([]); expect(f.state.cleanup).toBe(1);
  } finally { await f.close(); }
});

for (const fault of ['prepare', 'runtime', 'runner', 'configure', 'seal']) test(`lost ${fault} ACK retains original stage and honest partial central state; no automatic retry or local rollback`, async () => {
  const f = fixture();
  try {
    const plan = await f.plan(); f.state.fault = fault; const result = await f.apply(plan), record = f.plans.store.read(plan.id);
    expect(result.status).toBe('unknown'); expect(JSON.stringify(result)).not.toContain('PRIVATE-SSH'); expect(f.state.calls.filter(call => call === fault)).toHaveLength(1);
    const nodes = f.controller.local.settings.read().nodes;
    expect(nodes.length).toBe(fault === 'prepare' ? 0 : 1);
    if (nodes.length) { expect(nodes[0]).toMatchObject({ enabled: false, expected_runner_id: null }); expect(f.controller.local.credentials.read().nodes).toHaveLength(1); }
    if (fault !== 'seal') { expect(f.state.connections).toBe(0); expect(record.private_data.proof).toBeUndefined(); }
    else { expect(f.state.connections).toBe(1); expect(record.private_data.proof.stop_confirmed).toBe(true); expect(record.private_data.seal).toBeUndefined(); }
    const count = f.state.calls.length; await expect(f.apply(result)).rejects.toThrow('cannot be replayed'); expect(f.state.calls.length).toBe(count);
    expect(f.plans.operations.view(record).status).toBe('unknown'); expect(f.state.cleanup).toBe(1);
  } finally { await f.close(); }
});

test('actual live verification cancellation ACK loss never seals/pins/clears unknown; pre-send intents retain original IDs', async () => {
  const f = fixture(); let reached = false;
  try {
    const plan = await f.plan();
    f.state.transform = (frame, response) => { if (frame.method === 'command.cancel') { reached = true; throw new Error('SECRET-LOST-ACK'); } return response; };
    const result = await f.apply(plan), record = f.plans.store.read(plan.id);
    expect(reached).toBe(true); expect(result.status).toBe('unknown'); expect(f.state.frames.filter(frame => frame.method === 'command.start')).toHaveLength(2);
    expect(f.state.frames.filter(frame => frame.method === 'command.cancel')).toHaveLength(1); expect(f.state.sealed).toBe(false); expect(record.private_data.proof).toBeUndefined();
    expect(record.private_data.verification.some(event => event.phase === 'intent' && event.method === 'command.cancel')).toBe(true);
    expect(record.private_data.intents.verify_runner.status).toBe('unknown'); expect(f.controller.local.settings.read().nodes[0]).toMatchObject({ enabled: false, expected_runner_id: null });
  } finally { await f.close(); }
});

test('changed central node between local pairing and remote upload is rejected before uploaded data, preserving only approved partial facts', async () => {
  const f = fixture();
  try {
    const plan = await f.plan(), original = f.controller.local.pair.bind(f.controller.local);
    f.controller.local.pair = context => { const result = original(context), view = f.controller.local.settings.read(); f.controller.local.settings.save({ nodes: view.nodes.map(node => ({ ...node, enabled: true })) }, view.revision); return result; };
    const result = await f.apply(plan);
    expect(result.status).toBe('unknown'); expect(f.state.calls).toEqual(['probe', 'probe', 'prepare']); expect(f.controller.local.credentials.read().nodes).toHaveLength(1);
    expect(f.state.connections).toBe(0); expect(f.state.sealed).toBe(false);
  } finally { await f.close(); }
});

test('approved system preparation freezes its unit preview while actual late-bound cgroup proof is used for configure and managed verification', async () => {
  const f = fixture();
  try {
    f.state.system_setup = true; const plan = await f.plan(), original = f.plans.store.read(plan.id).plan;
    expect(plan.plan.cgroup.status).toBe('needs_setup'); expect(plan.plan.actions.some(action => action.id === 'cgroup_setup' && action.privileged)).toBe(true);
    const result = await f.apply(plan), record = f.plans.store.read(plan.id);
    expect(result.status).toBe('ready'); expect(f.state.calls).toEqual(['probe', 'probe', 'prepare', 'runtime', 'runner', 'cgroup_setup', 'configure', 'seal']);
    expect(f.state.remote_config.cgroup_root).toBe('/sys/fs/cgroup/delegate-new/runner'); expect(record.plan).toEqual(original);
    expect(record.private_data.system_results.cgroup_setup.cgroup).toEqual(f.state.bound_cgroup);
    expect(record.private_data.managed.cgroup_evidence.ino).toBe('42'); expect(record.plan.cgroup.path).toBeUndefined();
  } finally { await f.close(); }
});

test('central security change after original seal still prevents ready publication without pretending to undo the sealed remote installation', async () => {
  const f = fixture();
  try {
    const plan = await f.plan();
    f.state.after_seal = () => { const view = f.controller.local.settings.read(); f.controller.local.settings.save({ nodes: view.nodes.map(node => ({ ...node, enabled: true })) }, view.revision); };
    const result = await f.apply(plan), record = f.plans.store.read(plan.id);
    expect(result.status).toBe('unknown'); expect(record.private_data.seal).toBeDefined(); expect(f.state.sealed).toBe(true);
    expect(record.stages.at(-1).status).toBe('complete'); expect(f.controller.local.settings.read().nodes[0].enabled).toBe(true); // User change is not rolled back.
  } finally { await f.close(); }
});

test('service close during actual live verification records unknown and drains the retained connection; no late result seals or publishes ready', async () => {
  const f = fixture(); let release, arrived;
  const ready = new Promise(resolve => { arrived = resolve; });
  let held = false;
  f.state.transform = async (frame, response) => {
    if (!held && frame.method === 'command.status' && response.result?.state === 'running' && f.state.frames.filter(value => value.method === 'command.start').length === 2) {
      held = true; arrived(); await new Promise(resolve => { release = resolve; });
    }
    return response;
  };
  try {
    const plan = await f.plan(), pending = f.apply(plan);
    await Promise.race([ready, pending.then(result => {
      if (held) return;
      console.error(JSON.stringify({ shutdown_fixture_ended_before_injection: { status: result.status, stages: result.stages, observations: f.state.observations } }));
      throw new Error('Actual live shutdown injection was not reached before the original workflow ended');
    })]);
    const closing = f.controller.close(); release(); await closing;
    const result = await pending;
    expect(held).toBe(true); expect(result.status).toBe('unknown'); expect(f.state.sealed).toBe(false);
    expect(f.plans.store.read(plan.id).private_data.proof).toBeUndefined(); expect(f.controller.pending).toBe(0); expect(f.state.cleanup).toBe(1);
    expect(f.controller.local.settings.read().nodes[0]).toMatchObject({ enabled: false, expected_runner_id: null });
  } finally { release?.(); await f.close(); }
});

test('independent confirmation rechecks original seal and actual persistent Runner identity, then pins/enables exactly once without project authorization or new commands', async () => {
  const f = fixture(); let service;
  try {
    const planned = await f.plan(), ready = await f.apply(planned), original = f.plans.store.read(ready.id);
    expect(() => f.controller.managedNode(f.controller.local.settings.read().nodes[0])).toThrow('unconfirmed');
    const result = await f.confirm(ready), confirmed = f.plans.store.read(result.id);
    expect(result.status).toBe('confirmed'); expect(confirmed.private_data.confirmation.status).toBe('complete');
    expect(confirmed.plan).toEqual(original.plan); expect(confirmed.stages.slice(0, original.stages.length)).toEqual(original.stages);
    expect(confirmed.private_data.proof).toEqual(original.private_data.proof); expect(confirmed.private_data.local).toEqual(original.private_data.local);
    const node = f.controller.local.settings.read().nodes[0]; expect(node).toMatchObject({ enabled: true, expected_runner_id: ready.runner_id });
    expect(f.controller.managedNode(node)).toMatchObject({ node, managed: original.private_data.managed });
    expect(f.state.connections).toBe(2); expect(f.state.frames.filter(frame => frame.method === 'command.start')).toHaveLength(2);
    expect(f.state.frames.filter(frame => frame.method === 'lease.grant')).toEqual([]);
    const calls = f.state.calls.length; await expect(f.confirm(result)).rejects.toThrow('cannot be replayed'); expect(f.state.calls.length).toBe(calls);
    service = new RunnerService(f.config, null, { deployment: { plans: f.plans, local: f.controller.local, transport_factory: f.controller.transport_factory } });
    const diagnostic = await f.check(service, node.id);
    expect(diagnostic.runner_id).toBe(ready.runner_id); expect(diagnostic.pinned).toBe(true); expect(f.state.connections).toBe(3);
    expect(f.state.frames.filter(frame => frame.method === 'command.start')).toHaveLength(2); // Production routing authenticated; no Worker/Run launch.
  } finally { await service?.close(); await f.close(); }
});

for (const drift of ['node', 'credentials', 'ssh', 'identity', 'seal', 'ack', 'pin_ack']) test(`independent confirmation ${drift} failure never adopts a changed installation or repeats the original pin`, async () => {
  const f = fixture();
  try {
    const plan = await f.plan(), ready = await f.apply(plan);
    if (drift === 'node') { const view = f.controller.local.settings.read(); f.controller.local.settings.save({ nodes: view.nodes.map(node => ({ ...node, enabled: true })) }, view.revision); }
    if (drift === 'credentials') f.controller.local.credentials.save({ node_id: ready.node_id, machine_token: 'f'.repeat(64) }, f.controller.local.credentials.read().revision);
    if (drift === 'ssh') f.state.change_snapshot = true;
    if (drift === 'seal') f.state.integrity = 'changed';
    if (drift === 'ack') f.state.fault = 'inspect';
    if (drift === 'identity') f.state.transform = (frame, result) => { if (frame.method === 'hello') result.result.runner_id = '00000000-0000-4000-8000-000000000001'; return result; };
    let pinned = 0;
    if (drift === 'pin_ack') {
      const pin = f.controller.local.settings.pinDeployment.bind(f.controller.local.settings);
      f.controller.local.settings.pinDeployment = (...args) => { pinned++; pin(...args); throw new Error('LOST-LOCAL-PIN-ACK'); };
    }
    if (['node', 'credentials', 'ssh'].includes(drift)) {
      await expect(f.confirm(ready)).rejects.toThrow(); expect(f.plans.store.read(ready.id).status).toBe('ready');
    } else {
      const failed = await f.confirm(ready); expect(failed.status).toBe('unknown');
      await expect(f.confirm(failed)).rejects.toThrow('cannot be replayed'); expect(pinned).toBe(drift === 'pin_ack' ? 1 : 0);
    }
    expect(() => f.controller.managedNode(f.controller.local.settings.read().nodes[0])).toThrow();
    if (!['node', 'pin_ack'].includes(drift)) expect(f.controller.local.settings.read().nodes[0]).toMatchObject({ enabled: false, expected_runner_id: null });
    expect(f.state.frames.filter(frame => frame.method === 'command.start')).toHaveLength(2);
  } finally { await f.close(); }
});

test('managed default routing refuses an unknown receipt even if a partial pin write enabled the public node; it cannot fall back to bare manual SSH', async () => {
  const f = fixture(); let service;
  try {
    const plan = await f.plan(), ready = await f.apply(plan), pin = f.controller.local.settings.pinDeployment.bind(f.controller.local.settings);
    f.controller.local.settings.pinDeployment = (...args) => { pin(...args); throw new Error('LOST-ACK'); };
    const unknown = await f.confirm(ready); expect(unknown.status).toBe('unknown');
    const node = f.controller.local.settings.read().nodes[0]; expect(node.enabled).toBe(true);
    const before = f.state.connections;
    service = new RunnerService(f.config, null, { deployment: { plans: f.plans, local: f.controller.local, transport_factory: f.controller.transport_factory } });
    await expect(f.check(service, node.id)).rejects.toThrow('no local fallback');
    expect(f.state.connections).toBe(before);
  } finally { await service?.close(); await f.close(); }
});

test('disabling a confirmed managed node preserves explicit authenticated observation while ordinary admission stays disabled and central budget edits do not mutate the install plan', async () => {
  const f = fixture(); let service;
  try {
    const plan = await f.plan(), ready = await f.apply(plan), confirmed = await f.confirm(ready), view = f.controller.local.settings.read();
    const original = f.plans.store.read(confirmed.id).plan;
    f.controller.local.settings.save({ nodes: view.nodes.map(node => ({ ...node, enabled: false, budgets: { ...node.budgets, timeout_ms: 5000 } })) }, view.revision);
    service = new RunnerService(f.config, null, { deployment: { plans: f.plans, local: f.controller.local, transport_factory: f.controller.transport_factory } });
    expect(() => service.node(confirmed.node_id)).toThrow('disabled');
    const result = await f.check(service, confirmed.node_id); expect(result.runner_id).toBe(confirmed.runner_id); expect(result.pinned).toBe(true);
    expect(f.plans.store.read(confirmed.id).plan).toEqual(original); expect(f.state.frames.filter(frame => frame.method === 'command.start')).toHaveLength(2);
  } finally { await service?.close(); await f.close(); }
});

test('default managed connection rechecks durable receipt state after handshake and refuses a concurrent newly unknown binding', async () => {
  const f = fixture(); let service, changed = false;
  try {
    const plan = await f.plan(), ready = await f.apply(plan), confirmed = await f.confirm(ready);
    f.state.transform = (frame, response) => {
      if (frame.method === 'hello') {
        const record = f.plans.store.read(confirmed.id);
        f.plans.store.change(record.id, record.revision, row => { row.status = 'unknown'; }); changed = true;
      }
      return response;
    };
    service = new RunnerService(f.config, null, { deployment: { plans: f.plans, local: f.controller.local, transport_factory: f.controller.transport_factory } });
    await expect(f.check(service, confirmed.node_id)).rejects.toThrow('no local fallback');
    expect(changed).toBe(true); expect(f.state.connections).toBe(3); expect(f.state.frames.filter(frame => frame.method === 'command.start')).toHaveLength(2);
  } finally { await service?.close(); await f.close(); }
});

test('confirmation shutdown preserves running intent as unknown across a new reader and cannot enable a late original identity', async () => {
  const f = fixture(); let release, arrived;
  const readySignal = new Promise(resolve => { arrived = resolve; });
  try {
    const plan = await f.plan(), ready = await f.apply(plan);
    f.state.transform = async (frame, response) => {
      if (frame.method === 'hello') { arrived(); await new Promise(resolve => { release = resolve; }); }
      return response;
    };
    const pending = f.confirm(ready);
    await Promise.race([readySignal, pending.then(result => { if (!release) throw new Error(`Confirmation shutdown injection was not reached (${result.status})`); })]);
    const running = f.plans.store.read(ready.id); expect(running.status).toBe('running'); expect(running.private_data.confirmation.status).toBe('running');
    const closing = f.controller.close(); release(); await closing;
    const result = await pending; expect(result.status).toBe('unknown');
    const record = f.plans.store.read(result.id); expect(f.plans.operations.view(record).status).toBe('unknown'); expect(f.plans.store.isActive(result.id)).toBe(false);
    expect(f.controller.local.settings.read().nodes[0]).toMatchObject({ enabled: false, expected_runner_id: null });
    expect(record.private_data.proof.stop_confirmed).toBe(true); expect(record.private_data.seal).toBeDefined(); // Original install facts survive.
  } finally { release?.(); await f.close(); }
});

test('reconciliation of an untouched plan journals observation only, keeps temporary artifacts and original approval opportunity, and never contacts SSH', async () => {
  const f = fixture();
  try {
    const plan = await f.plan(), before = f.plans.store.read(plan.id), result = await f.reconcile(plan);
    expect(result.status).toBe('planned'); expect(result.observation).toMatchObject({ status: 'complete', local: { registration: 'unrecorded', pairing: 'unrecorded' }, remote: { integrity: 'not_started' } });
    expect(f.state.calls).toEqual(['probe']); expect(f.state.connections).toBe(0); expect(f.plans.artifacts(f.plans.store.read(plan.id))).toBeDefined();
    const after = f.plans.store.read(plan.id); expect(after.plan).toEqual(before.plan); expect(after.stages).toEqual(before.stages); expect(after.private_data.operation_id).toBe(before.private_data.operation_id);
    await expect(f.reconcile(plan)).rejects.toThrow('revision changed'); expect(f.state.calls).toEqual(['probe']);
  } finally { await f.close(); }
});

test('original lost prepare ACK reconciliation can inspect partial remote facts but never replays writes, authenticates a new Runner or promotes unknown', async () => {
  const f = fixture();
  try {
    const plan = await f.plan(); f.state.fault = 'prepare'; const unknown = await f.apply(plan), before = f.plans.store.read(plan.id);
    const result = await f.reconcile(unknown), after = f.plans.store.read(plan.id);
    expect(result.status).toBe('unknown'); expect(result.observation).toMatchObject({ status: 'complete', remote: { integrity: 'not_configured', sealed: false, binding: 'unrecorded' } });
    expect(after.stages).toEqual(before.stages); expect(after.private_data.intents).toEqual(before.private_data.intents); expect(after.private_data.operation_id).toBe(before.private_data.operation_id);
    expect(after.private_data.reconciliations[0]).toMatchObject({ original_operation_id: before.private_data.operation_id, from_revision: before.revision });
    expect(f.state.calls).toEqual(['probe', 'probe', 'prepare', 'inspect']); expect(f.state.connections).toBe(0);
    expect(f.controller.local.settings.read().nodes).toEqual([]); await expect(f.apply(result)).rejects.toThrow('cannot be replayed');
  } finally { await f.close(); }
});

test('reconciliation of actual verified ready preserves disabled/unpinned state and strips installer-private evidence even from durable observation facts', async () => {
  const f = fixture();
  try {
    const ready = await f.apply(await f.plan()), before = f.plans.store.read(ready.id), frames = f.state.frames.length;
    f.state.inspection_data = { stages: [{ stage: 'git_install', status: 'unknown', raw_stderr: 'INSPECTION-SECRET' }], installer: { state: 'inactive', tree_stopped: true, success: false, barrier: 'manager-exit-type-cgroup', invocation_id: 'INSPECTION-SECRET', unit: 'INSPECTION-SECRET' }, script: 'INSPECTION-SECRET', machine_token: 'INSPECTION-SECRET' };
    const result = await f.reconcile(ready), after = f.plans.store.read(ready.id);
    expect(result.status).toBe('ready'); expect(result.observation).toMatchObject({ status: 'complete', local: { registration: 'matching', pairing: 'matching' }, remote: { integrity: 'verified', sealed: true, binding: 'matching', installer: { state: 'inactive', tree_stopped: true, success: false } } });
    expect(f.state.frames).toHaveLength(frames); expect(f.state.connections).toBe(1); expect(after.private_data.proof).toEqual(before.private_data.proof); expect(after.private_data.seal).toEqual(before.private_data.seal);
    expect(f.controller.local.settings.read().nodes[0]).toMatchObject({ enabled: false, expected_runner_id: null });
    expect(JSON.stringify(after.private_data.reconciliations)).not.toContain('INSPECTION-SECRET'); expect(JSON.stringify(result)).not.toContain('private_data');
    expect(result.observation.remote.stages).toEqual([{ stage: 'git_install', status: 'unknown' }]);
  } finally { await f.close(); }
});

test('lost pin ACK reconciles the same original sealed installation without silently completing confirmation, replaying pin or granting execution', async () => {
  const f = fixture();
  try {
    const ready = await f.apply(await f.plan()), pin = f.controller.local.settings.pinDeployment.bind(f.controller.local.settings); let pins = 0;
    f.controller.local.settings.pinDeployment = (...args) => { pins++; pin(...args); throw new Error('PRIVATE-PIN-ACK'); };
    const unknown = await f.confirm(ready), before = f.plans.store.read(ready.id), frames = f.state.frames.length;
    const result = await f.reconcile(unknown), after = f.plans.store.read(ready.id);
    expect(result.status).toBe('unknown'); expect(result.observation).toMatchObject({ status: 'complete', local: { registration: 'changed', pairing: 'matching' }, remote: { integrity: 'verified', sealed: true, binding: 'matching' } });
    expect(pins).toBe(1); expect(f.state.frames).toHaveLength(frames); expect(after.private_data.confirmation).toEqual(before.private_data.confirmation); expect(after.private_data.proof).toEqual(before.private_data.proof);
    expect(f.controller.local.settings.read().nodes[0]).toMatchObject({ enabled: true, expected_runner_id: ready.runner_id });
    await expect(f.confirm(result)).rejects.toThrow('cannot be replayed'); expect(() => f.controller.managedNode({ id: ready.node_id })).toThrow('unconfirmed or blocked'); expect(pins).toBe(1);
  } finally { await f.close(); }
});

test('confirmed installation observations use its confirmed pin while retaining central disable/budget policy and never launch another command', async () => {
  const f = fixture();
  try {
    const confirmed = await f.confirm(await f.apply(await f.plan())), settings = f.controller.local.settings.read();
    f.controller.local.settings.save({ nodes: settings.nodes.map(node => ({ ...node, enabled: false, budgets: { ...node.budgets, timeout_ms: 5000 } })) }, settings.revision);
    const frames = f.state.frames.length, result = await f.reconcile(confirmed);
    expect(result.status).toBe('confirmed'); expect(result.observation.local).toEqual({ registration: 'matching', pairing: 'matching' }); expect(f.state.frames).toHaveLength(frames);
    expect(f.controller.local.settings.read().nodes[0]).toMatchObject({ enabled: false, expected_runner_id: confirmed.runner_id, budgets: { timeout_ms: 5000 } });
  } finally { await f.close(); }
});

for (const fault of ['ssh', 'ack', 'descriptor']) test(`original reconciliation ${fault} cannot authorize or rewrite the installation from an incomplete observation`, async () => {
  const f = fixture();
  try {
    const ready = await f.apply(await f.plan()), before = f.plans.store.read(ready.id);
    if (fault === 'ssh') f.state.change_snapshot = true;
    if (fault === 'ack') f.state.fault = 'inspect';
    if (fault === 'descriptor') f.state.inspection_data = { managed: { ...f.state.managed, manifest_sha256: 'e'.repeat(64) } };
    const result = await f.reconcile(ready), after = f.plans.store.read(ready.id);
    expect(result.status).toBe('ready'); expect(result.observation.status).toBe(fault === 'descriptor' ? 'complete' : 'unknown');
    if (fault === 'descriptor') expect(result.observation.remote).toMatchObject({ integrity: 'changed', binding: 'changed' });
    expect(after.private_data.managed).toEqual(before.private_data.managed); expect(after.private_data.proof).toEqual(before.private_data.proof); expect(after.stages).toEqual(before.stages);
    expect(f.state.connections).toBe(1); expect(f.controller.local.settings.read().nodes[0].enabled).toBe(false); expect(JSON.stringify(result)).not.toContain('PRIVATE-SSH');
  } finally { await f.close(); }
});

test('reconciliation shutdown persists observation unknown before drain, denies late observation success and preserves the original ready receipt', async () => {
  const f = fixture(); let release, reached;
  const entered = new Promise(resolve => { reached = resolve; });
  try {
    const ready = await f.apply(await f.plan()), before = f.plans.store.read(ready.id);
    f.state.inspect_hook = () => { reached(); return new Promise(resolve => { release = resolve; }); };
    const pending = f.reconcile(ready);
    await Promise.race([entered, pending.then(result => { if (!release) throw new Error(`Inspection injection not reached (${result.observation.status})`); })]);
    expect(f.controller.pending).toBe(1); const closing = f.controller.close();
    expect(f.plans.store.read(ready.id).private_data.reconciliations.at(-1).status).toBe('unknown'); release(); await closing;
    const result = await pending, after = f.plans.store.read(ready.id); expect(result.status).toBe('ready'); expect(result.observation.status).toBe('unknown'); expect(f.controller.pending).toBe(0);
    expect(after.private_data.proof).toEqual(before.private_data.proof); expect(after.stages).toEqual(before.stages); expect(f.state.connections).toBe(1);
  } finally { release?.(); await f.close(); }
});

test('confirmation refuses missing or incomplete original execution-control facts before SSH; it never retrofits a legacy descriptor', async () => {
  const f = fixture();
  try {
    const planned = await f.plan(), ready = await f.apply(planned), original = f.plans.store.read(ready.id);
    expect(ready.status).toBe('ready');
    const calls = f.state.calls.length, connections = f.state.connections;
    for (const control of [undefined, Object.fromEntries(Object.entries(original.private_data.managed.control).filter(([key]) => key !== 'config'))]) {
      const current = f.plans.store.read(ready.id), changed = f.plans.store.change(current.id, current.revision, row => { row.private_data.managed.control = control; });
      await expect(f.confirm(changed)).rejects.toThrow('Managed Runner installation changed or is invalid');
      expect(f.state.calls).toHaveLength(calls); expect(f.state.connections).toBe(connections);
      const after = f.plans.store.read(ready.id);
      expect(after.status).toBe('ready'); expect(after.private_data.confirmation).toBeUndefined();
      expect(after.private_data.managed.control).toEqual(control); expect(after.private_data.proof).toEqual(original.private_data.proof);
      expect(f.controller.local.settings.read().nodes[0]).toMatchObject({ enabled: false, expected_runner_id: null });
    }
  } finally { await f.close(); }
});

test('a malformed managed transport descriptor is refused without launching SSH and does not retain its private snapshot', () => {
  const existing = () => fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('lush-managed-ssh-')).sort();
  const before = existing();
  for (const transport of [deploymentTransport, deploymentRecoveryTransport]) expect(() => transport({ managed: { ssh_alias: 'fixture' }, configuration: 'PRIVATE-CONFIG' })).toThrow('could not be prepared');
  expect(existing()).toEqual(before);
});

// Recovery orchestration seam: frozen system/database/generation observations are controlled;
// authentication/commands/output/live cancellation still use the actual independent native Runner.
// This does NOT substitute for the full uploaded production/provisional/cgroup acceptance chain.
async function recoveryFixture(f, { inactive = false, blocked = null } = {}) {
  f.state.recovery_unit = true; // Fixed original unit evidence belongs to the initial controlled configure, never a recovery retrofit.
  const confirmed = await f.confirm(await f.apply(await f.plan())); expect(confirmed.status).toBe('confirmed');
  const original = f.plans.store.read(confirmed.id), calls = [], sha = value => hash(JSON.stringify(value) + '\n');
  const immutable = { deployment_id: original.id, node_id: original.node_id, runner_id: original.runner_id, original_manifest_sha256: original.private_data.managed.manifest_sha256,
    original_config_sha256: hash(fs.readFileSync(path.join(original.plan.install_root, 'config.json'))),
    original_seal_sha256: sha({ version: 1, id: original.id, plan_sha256: original.private_data.plan_sha256, ...f.state.seal_proof }) };
  const unit = { name: `lush-runner-delegate-${process.getuid()}-${original.id}.service`, path: `/etc/systemd/system/lush-runner-delegate-${process.getuid()}-${original.id}.service`, sha256: '1'.repeat(64), active: !inactive };
  const planFor = ({ managed, recovery_id }) => ({ version: 1, recovery_id, ...immutable, previous_generation_sha256: managed.runtime_generation?.sha256 ?? null,
    // Remote runtimeControl returns a bounded decimal string, never a JS number.
    boot_id: 'e'.repeat(64), epoch: '1', gate: 'none', unit, cgroup: { path: '/sys/fs/cgroup/reconstructed/runner', evidence: { ...managed.cgroup_evidence, boot_id: 'e'.repeat(64), ino: '88' } },
    commands: { supported: blocked !== 'database_wal_or_journal_pending', total: blocked === 'old_commands_unconfirmed' ? 1 : 0, last_rowid: 2 },
    actions: [{ id: 'bind_runtime_generation', privileged: false, effect: 'Bind the original installation generation without rewriting original config or slots' },
      ...(inactive ? [{ id: 'start_original_unit', privileged: true, unit_path: unit.path, unit_sha256: unit.sha256, unit_summary: 'Start only the original verified unit once', effect: 'Start the original unit once; never enable, restart or recreate' }] : [])],
    blockers: blocked ? [blocked] : [], supported: !blocked });
  let candidate;
  function before(method, args) {
    calls.push(method); const row = f.plans.store.read(original.id), item = row.private_data.recovery.items.find(item => item.id === args.recovery_id);
    expect(row.status).toBe('confirmed'); expect(f.plans.store.isActive(row.id)).toBe(true);
    if (method === 'inspect') expect(item.observations.at(-1).status).toBe('running');
    else expect(item.stages.at(-1)).toMatchObject({ id: { check: 'check_original', apply: 'bind_runtime_generation', seal: 'seal_generation', activate: 'activate_generation' }[method], status: 'running' });
    if (method !== 'check') expect(row.private_data.recovery.gate).toBe(args.recovery_id);
  }
  f.state.recovery_methods = {
    async check(args) { before('check', args); const plan = planFor(args); return { ok: true, plan, plan_sha256: sha(plan) }; },
    async apply(args) { before('apply', args); expect(args.plan_sha256).toBe(sha(args.recovery_plan));
      expect(args.approved_actions).toEqual(args.recovery_plan.actions.map(a => a.id));
      const { recovery_plan: p, recovery_id } = args;
      const generation = { version: 1, id: recovery_id, ...immutable, previous_generation_sha256: p.previous_generation_sha256, boot_id: p.boot_id, cgroup: p.cgroup, unit, epoch: p.epoch };
      candidate = { ok: true, generation, sha256: sha(generation) }; return candidate; },
    async seal(args) { before('seal', args); expect(args.proof.runner_id).toBe(original.runner_id); expect(args.proof.execution_id).not.toBe(original.private_data.proof.stop_execution_id); return candidate; },
    async activate(args) { before('activate', args); const item = f.plans.store.read(original.id).private_data.recovery.items.at(-1);
      expect(item.publication.publication_id).toBe(args.central_publication_id); expect(item.stages.find(s => s.id === 'publish_generation').status).toBe('complete');
      expect(f.plans.store.read(original.id).private_data.recovery.current?.recovery_id).not.toBe(args.recovery_id);
      return { ok: true, runtime_generation: { recovery_id: args.recovery_id, sha256: candidate.sha256, publication_id: args.central_publication_id, generation: candidate.generation } }; },
    async inspect(args) { before('inspect', args); return { ok: true, status: 'activated', private_token: 'PRIVATE-INSPECTION', generation: candidate?.generation }; },
  };
  const read = () => f.plans.store.read(original.id);
  return { original, calls, read, async plan() { return await f.controller.planRecovery({ id: original.id, expected_revision: read().revision }); },
    apply(planned, overrides = {}) { const p = planned.recoveries.at(-1); return f.controller.applyRecovery({ id: original.id, expected_revision: read().revision, recovery_id: p.id,
      approved_actions: p.plan.actions.map(a => a.id), confirm: true, ...overrides }); },
    reconcile() { return f.controller.reconcileRecovery({ id: original.id, expected_revision: read().revision, recovery_id: read().private_data.recovery.items.at(-1).id }); } };
}
const withoutRecovery = value => { const r = structuredClone(value); delete r.private_data.recovery; delete r.revision; delete r.updated_at; return r; };

test('recovery freezes original generation, approves, authenticates original Runner before real native commands, seals, CAS publishes then activates; second generation preserves history', async () => {
  const f = fixture();
  try {
    const r = await recoveryFixture(f), config = fs.readFileSync(path.join(r.original.plan.install_root, 'config.json'));
    const planned = await r.plan(); expect(planned.recoveries.at(-1)).toMatchObject({ status: 'planned', plan: { boot_changed: true, from_generation: 0, to_generation: 1, supported: true } });
    expect(f.controller.managedNode(f.controller.local.settings.read().nodes[0]).managed.runtime_generation).toBeUndefined();
    const result = await r.apply(planned), first = r.read().private_data.recovery.current;
    expect(result.recoveries.at(-1).status).toBe('ready'); expect(result.status).toBe('confirmed'); expect(result.runtime_generation).toBe(1);
    expect(r.calls).toEqual(['check', 'apply', 'seal', 'activate']); expect(r.read().private_data.recovery.gate).toBeNull();
    expect(r.read().private_data.recovery.items.at(-1).proof).toMatchObject({ expected_runner_id: r.original.runner_id, runner_id: r.original.runner_id, runtime_verified: true, ffi_verified: true, stop_confirmed: true, barrier_confirmed: true });
    expect(f.controller.managedNode(f.controller.local.settings.read().nodes[0]).managed.runtime_generation).toEqual(first);
    expect(f.state.frames.filter(frame => frame.method === 'command.start')).toHaveLength(4); // original2 + fresh recovery2, never replay.
    const next = await r.plan(), final = await r.apply(next), current = r.read().private_data.recovery.current;
    expect(next.recoveries.at(-1).plan.from_generation).toBe(1); expect(final.runtime_generation).toBe(2); expect(current.generation.previous_generation_sha256).toBe(first.sha256);
    expect(r.read().private_data.recovery.generations[0]).toEqual(first); expect(withoutRecovery(r.read())).toEqual(withoutRecovery(r.original));
    expect(fs.readFileSync(path.join(r.original.plan.install_root, 'config.json'))).toEqual(config);
    for (const secret of [r.original.private_data.local.pairing.auth.machine_token, r.original.private_data.local.pairing.auth.control_token, 'original_config_sha256', 'original_manifest_sha256', 'previous_generation_sha256', 'publication_id', 'private_data']) expect(JSON.stringify(final)).not.toContain(secret);
  } finally { await f.close(); }
});

for (const epoch of ['0', '1', '999999999999999', 1, null, '', '01', '-1', '1.0', '1\n', '1000000000000000']) test(`recovery preserves canonical decimal-string epochs and rejects invalid forms: ${JSON.stringify(epoch)}`, async () => {
  const f = fixture();
  try {
    const r = await recoveryFixture(f), prior = f.state.recovery_methods.check;
    let observed;
    f.state.recovery_methods.check = async args => {
      const result = await prior(args), plan = { ...result.plan, epoch };
      observed = { ok: true, plan, plan_sha256: hash(JSON.stringify(plan) + '\n') }; return observed;
    };
    const result = await r.plan(), item = r.read().private_data.recovery.items.at(-1);
    const valid = typeof epoch === 'string' && ['0', '1', '999999999999999'].includes(epoch);
    expect(result.recoveries.at(-1).status).toBe(valid ? 'planned' : 'unknown');
    if (valid) {
      expect(item.plan).toEqual(observed.plan); expect(item.plan_sha256).toBe(observed.plan_sha256);
      expect(JSON.stringify(item.plan) + '\n').toBe(JSON.stringify(observed.plan) + '\n');
    } else expect(item.plan).toBeUndefined();
    expect(r.calls).toEqual(['check']); expect(r.read().private_data.recovery.gate).toBeNull();
    expect(f.state.frames.filter(frame => frame.method === 'command.start')).toHaveLength(2); // Original verification only.
  } finally { await f.close(); }
});

for (const failure of ['confirm', 'missing', 'privileged', 'duplicate', 'stale_revision', 'ssh', 'policy', 'unconfirmed']) test(`recovery refuses ${failure} before effects and does not refresh authorization`, async () => {
  const f = fixture();
  try {
    const r = await recoveryFixture(f, { inactive: true }), planned = await r.plan(), before = r.calls.length;
    const overrides = failure === 'confirm' ? { confirm: false } : failure === 'missing' ? { approved_actions: [] } : failure === 'privileged' ? { approved_actions: ['bind_runtime_generation'] }
      : failure === 'duplicate' ? { approved_actions: ['bind_runtime_generation', 'start_original_unit', 'start_original_unit'] }
      : failure === 'stale_revision' ? { expected_revision: 1 } : {};
    if (failure === 'ssh') f.state.change_snapshot = true;
    if (failure === 'policy') { const settings = f.controller.local.settings.read(); f.controller.local.settings.save({ nodes: settings.nodes.map(node => ({ ...node, enabled: false })) }, settings.revision); }
    if (failure === 'unconfirmed') { const row = r.read(); f.plans.store.change(row.id, row.revision, value => { value.private_data.confirmation.status = 'unknown'; }); }
    await expect(r.apply(planned, overrides)).rejects.toThrow(); expect(r.calls.length).toBe(before);
    expect(r.read().private_data.recovery.gate).toBeNull(); expect(r.read().private_data.recovery.items.at(-1).status).toBe('planned');
  } finally { await f.close(); }
});

for (const blocked of ['old_commands_unconfirmed', 'database_wal_or_journal_pending']) test(`recovery preserves ${blocked} blocker and old command authority; no apply or clear`, async () => {
  const f = fixture();
  try { const r = await recoveryFixture(f, { blocked }), result = await r.plan(); expect(result.recoveries.at(-1).status).toBe('blocked');
    expect(result.recoveries.at(-1).plan.blockers[0].code).toBe(blocked); await expect(r.apply(result)).rejects.toThrow(); expect(r.calls).toEqual(['check']);
    expect(withoutRecovery(r.read())).toEqual(withoutRecovery(r.original));
  } finally { await f.close(); }
});

for (const stage of ['apply', 'seal', 'activate', 'verification']) test(`lost recovery ${stage} ACK preserves original request, leaves durable admission gate; read-only original reconciliation cannot activate or replay`, async () => {
  const f = fixture();
  try {
    const r = await recoveryFixture(f), planned = await r.plan();
    if (stage === 'verification') f.state.transform = (frame, result) => { if (frame.method === 'hello') throw Error('PRIVATE-LOST-HELLO'); return result; };
    else { const prior = f.state.recovery_methods[stage]; f.state.recovery_methods[stage] = async args => { await prior(args); throw Error('PRIVATE-LOST-ACK'); }; }
    const failed = await r.apply(planned), before = [...r.calls], privateBefore = r.read().private_data.recovery;
    expect(failed.recoveries.at(-1).status).toBe('unknown'); expect(failed.status).toBe('confirmed'); expect(privateBefore.gate).toBe(planned.recoveries.at(-1).id);
    expect(() => f.controller.managedNode(f.controller.local.settings.read().nodes[0])).toThrow('running or unknown');
    expect(f.controller.managedNode(f.controller.local.settings.read().nodes[0], { observation: true }).managed.runtime_generation).toBeUndefined();
    // A fresh daemon/controller consults the durable gate, not the old in-memory active map.
    const fresh = new DeploymentController(f.config, { plans: f.plans, local: f.controller.local });
    expect(() => fresh.managedNode(f.controller.local.settings.read().nodes[0])).toThrow('running or unknown');
    await expect(r.apply(failed)).rejects.toThrow(); await expect(r.plan()).rejects.toThrow(); expect(r.calls).toEqual(before);
    const observed = await r.reconcile(); expect(r.calls).toEqual([...before, 'inspect']);
    expect(observed.recoveries.at(-1)).toMatchObject({ status: 'unknown', observation: { status: 'complete', remote_status: 'activated' } });
    expect(r.read().private_data.recovery.gate).toBe(privateBefore.gate); expect(r.read().private_data.recovery.generations).toEqual([]);
    expect(r.read().private_data.recovery.items.at(-1).candidate).toEqual(privateBefore.items.at(-1).candidate);
    expect(JSON.stringify(observed)).not.toContain('PRIVATE-'); expect(JSON.stringify(r.read().private_data.recovery.items.at(-1).observations)).not.toContain('PRIVATE-');
    expect(withoutRecovery(r.read())).toEqual(withoutRecovery(r.original));
  } finally { await f.close(); }
});

test('shutdown journals unknown before draining recovery; exclusive local lease bars parallel observation, late result cannot publish', async () => {
  const f = fixture(); let release;
  try {
    const r = await recoveryFixture(f), planned = await r.plan(); let entered;
    const called = new Promise(resolve => { entered = resolve; }), prior = f.state.recovery_methods.apply;
    f.state.recovery_methods.apply = async args => { const result = await prior(args); entered(); await new Promise(resolve => { release = resolve; }); return result; };
    const running = r.apply(planned); await Promise.race([called, running.then(() => { throw Error('Recovery did not reach apply fault'); })]);
    expect(f.controller.pending).toBe(1); await expect(r.reconcile()).rejects.toThrow('already executing');
    const closed = f.controller.close(); expect(r.read().private_data.recovery.items.at(-1).status).toBe('unknown'); expect(r.read().private_data.recovery.gate).toBeTruthy();
    release(); await closed; const result = await running;
    expect(result.recoveries.at(-1).status).toBe('unknown'); expect(r.calls).toEqual(['check', 'apply']); expect(f.state.connections).toBe(2);
    expect(f.plans.store.isActive(r.original.id)).toBe(false); expect(f.controller.pending).toBe(0);
  } finally { release?.(); await f.close(); }
});

for (const point of ['publish_generation', 'final_ready']) test(`lost local ${point} publication acknowledgement preserves unknown gate and never replays activation`, async () => {
  const f = fixture();
  try {
    const r = await recoveryFixture(f), planned = await r.plan(), change = f.plans.store.change.bind(f.plans.store); let reached = false;
    f.plans.store.change = (...args) => { const result = change(...args), s = result.private_data.recovery, item = s?.items.at(-1);
      if (!reached && (point === 'publish_generation' ? item?.stages.some(s => s.id === point && s.status === 'complete') : item?.status === 'ready')) {
        reached = true; throw Error('PRIVATE-LOST-PUBLICATION-ACK');
      } return result; };
    const result = await r.apply(planned); expect(reached).toBe(true); expect(result.recoveries.at(-1).status).toBe('unknown');
    expect(r.read().private_data.recovery.gate).toBe(planned.recoveries.at(-1).id);
    expect(r.calls.filter(c => c === 'activate')).toHaveLength(point === 'final_ready' ? 1 : 0);
    expect(() => recoveryManaged(r.read())).toThrow('running or unknown'); expect(recoveryManaged(r.read(), { observation: true }).runtime_generation).toBeUndefined();
    const before = [...r.calls]; await r.reconcile(); expect(r.calls).toEqual([...before, 'inspect']); expect(r.read().private_data.recovery.items.at(-1).status).toBe('unknown');
    expect(r.read().private_data.recovery.generations).toHaveLength(point === 'final_ready' ? 1 : 0); // retain append-only fact, never delete/adopt it.
  } finally { await f.close(); }
});

test('exact inactive original unit preview requires distinct approval and is sent once in frozen order, not a refreshed install permission', async () => {
  const f = fixture();
  try { const r = await recoveryFixture(f, { inactive: true }), settings = f.controller.local.settings.read(), starts = [];
    f.controller.local.settings.save({ nodes: settings.nodes.map(node => ({ ...node, enabled: false, budgets: { ...node.budgets, timeout_ms: 5000, output_bytes: 1024 } })) }, settings.revision);
    f.state.transform = (frame, result) => { if (frame.method === 'command.start') starts.push(frame.params); return result; };
    const planned = await r.plan(), p = planned.recoveries.at(-1).plan;
    expect(p.verification_budgets).toEqual({ max_commands: 1, timeout_ms: 5000, output_bytes: 1024 });
    expect(p.actions[1]).toMatchObject({ id: 'start_original_unit', privileged: true, unit_path: `/etc/systemd/system/lush-runner-delegate-${process.getuid()}-${r.original.id}.service`, unit_sha256: '1'.repeat(64) });
    const result = await r.apply(planned, { approved_actions: p.actions.map(a => a.id).reverse() }); expect(result.recoveries.at(-1).status).toBe('ready');
    expect(r.calls).toEqual(['check', 'apply', 'seal', 'activate']); expect(starts).toHaveLength(2);
    for (const start of starts) expect(start).toMatchObject({ command_ms: 5000, output_bytes: 1024 });
    expect(f.controller.local.settings.read().nodes[0].enabled).toBe(false);
  } finally { await f.close(); }
});

test('a fresh service gates ordinary node selection before Worker creation but retains original-ID diagnostic route; read never repairs recovery', async () => {
  const f = fixture(); let service;
  try {
    const r = await recoveryFixture(f), planned = await r.plan(); f.state.recovery_methods.apply = async () => { throw Error('PRIVATE-ACK-LOST'); }; await r.apply(planned);
    const node = f.controller.local.settings.read().nodes[0];
    service = new RunnerService(f.config, { runnerProject: () => ({ project_id: f.request.project_id, allowed_node_ids: [node.id], default_node_id: node.id }) }, {
      deployment: { plans: f.plans, local: f.controller.local }, transport_factory: (node, options) => f.controller.transport_factory(f.controller.managedNode(node, options)) });
    const prior = fs.readFileSync(path.join(f.config.home, 'runner-deployments.json'));
    expect(() => service.selectNode(node.id)).toThrow('running or unknown');
    expect(service.readDeployments().items[0].recoveries.at(-1).status).toBe('unknown');
    expect(fs.readFileSync(path.join(f.config.home, 'runner-deployments.json'))).toEqual(prior);
    const diagnostic = await service.checkNode(node.id); expect(diagnostic.runner_id).toBe(r.original.runner_id);
    // Failed-before-effects controlled remote has no remote gate; production may additionally
    // refuse observation connections if its own shell sees uncertain effects.
    expect(() => service.selectNode(node.id)).toThrow('running or unknown');
  } finally { await service?.close(); await f.close(); }
});

test('recovery read derives abandoned running unknown without writes; unrelated original observation cannot resurrect it', async () => {
  const f = fixture();
  try {
    const r = await recoveryFixture(f), planned = await r.plan(), current = r.read();
    const abandoned = f.plans.store.change(current.id, current.revision, row => { const s = row.private_data.recovery, item = s.items.at(-1); item.applied = true; item.status = 'running'; s.gate = item.id; item.stages.push({ id: 'bind_runtime_generation', status: 'running', request_id: 'original-private-request' }); });
    expect(f.plans.operations.view(abandoned).private_data.recovery.items.at(-1).status).toBe('unknown'); expect(r.read().private_data.recovery.items.at(-1).status).toBe('running');
    const observed = await f.controller.reconcile({ id: current.id, expected_revision: abandoned.revision });
    expect(observed.recoveries.at(-1).status).toBe('unknown'); expect(r.read().private_data.recovery.items.at(-1).stages.at(-1).request_id).toBe('original-private-request');
    expect(r.read().private_data.recovery.gate).toBe(planned.recoveries.at(-1).id); expect(r.calls).toEqual(['check']);
  } finally { await f.close(); }
});

test('recovery history is bounded without overwrite and public projection never exposes private plans, hashes, commands or proof bodies', async () => {
  const f = fixture();
  try {
    const r = await recoveryFixture(f);
    for (let i = 0; i < 16; i++) await r.plan();
    const before = r.read(); await expect(r.plan()).rejects.toThrow('history limit'); expect(r.read()).toEqual(before); expect(r.calls).toHaveLength(16);
    const projected = publicRecovery({ ...before.private_data.recovery.items[0], private_token: 'PRIVATE', proof: { body: 'PRIVATE' },
      plan: { ...before.private_data.recovery.items[0].plan, original_config_sha256: 'PRIVATE', commands: { supported: true, total: 0, executions: ['PRIVATE'] }, unit_body: 'PRIVATE', cgroup: { path: '/sys/fs/cgroup/safe', evidence: { hash: 'PRIVATE' } } } });
    expect(JSON.stringify(projected)).not.toContain('PRIVATE'); expect(projected.plan.old_commands.message).toContain('旧 Worker');
    expect(() => recoveryManaged({ private_data: { recovery: { version: 99 } } })).toThrow('journal is invalid');
  } finally { await f.close(); }
});

test('a central budget below verifier input limits blocks a recovery plan without widening budget or sending any recovery effect', async () => {
  const f = fixture();
  try { const r = await recoveryFixture(f), settings = f.controller.local.settings.read();
    f.controller.local.settings.save({ nodes: settings.nodes.map(node => ({ ...node, budgets: { ...node.budgets, timeout_ms: 1, output_bytes: 1 } })) }, settings.revision);
    const planned = await r.plan(); expect(planned.recoveries.at(-1)).toMatchObject({ status: 'blocked', plan: { supported: false, blockers: [{ code: 'verification_budget_too_small' }] } });
    await expect(r.apply(planned)).rejects.toThrow(); expect(r.calls).toEqual(['check']); expect(r.read().private_data.recovery.gate).toBeNull();
  } finally { await f.close(); }
});

test('recovery gate revokes an already watched Run through retained fixed stop authority and a ready new generation cannot resurrect its authorization', async () => {
  const f = fixture(); let service, unwatch;
  try {
    const r = await recoveryFixture(f), writes = [], identity = { project_id: f.request.project_id, node_id: r.original.node_id, runner_id: r.original.runner_id,
      worker_id: 1, workspace_id: 'old-owned-workspace', generation: 1, run_id: 1 };
    // Controlled authorization Store/stop callback only; not a physical stop or project DB proof.
    service = new RunnerService(f.config, { runnerBinding: () => ({ ...identity, state: 'ready' }), runnerRun: () => ({ authorization_version: 1 }),
      runnerProject: () => ({ project_id: identity.project_id, allowed_node_ids: [identity.node_id] }), assertRunnerAuthorization() {}, run: (...args) => writes.push(args) },
    { deployment: { plans: f.plans, local: f.controller.local } });
    let stops = 0, reached = false;
    unwatch = service.watchRun(identity, async () => { stops++; expect(identity.runner_id).toBe(r.original.runner_id); return { stopped: true, unknown: false }; });
    const original = f.state.recovery_methods.apply;
    f.state.recovery_methods.apply = async args => { reached = true; await service.checkWatches(); expect(stops).toBe(1); return await original(args); };
    const result = await r.apply(await r.plan()); expect(reached).toBe(true); expect(result.recoveries.at(-1).status).toBe('ready');
    await service.checkWatches(); expect(stops).toBe(1); expect(writes).toHaveLength(1); expect(writes[0][0]).toContain("state='revoked'");
    expect(() => service.assertBinding(identity)).toThrow('Run was revoked');
    expect(f.controller.local.settings.read().nodes[0].expected_runner_id).toBe(identity.runner_id);
  } finally { unwatch?.(); await service?.close(); await f.close(); }
});
