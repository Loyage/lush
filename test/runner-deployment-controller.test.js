import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeploymentController } from '../src/core/runner-deployment-controller.js';
import { DeploymentPlans } from '../src/core/runner-deployment-plans.js';
import { StdioTransport } from '../src/runner/transport.js';
import { deploymentAbiEvidence } from '../src/core/runner-deployment-remote.js';
import { IMPLEMENTATION_VERSION, hash } from '../src/runner/protocol.js';

// Controlled system observations/uploads; verification uses an independent Runner/guard/Bun/FFI.
// This is not real SSH, artifact extraction or cgroup installation evidence.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-controller-')), home = path.join(root, 'remote');
  fs.mkdirSync(home, { mode: 0o700 });
  const configuration = 'Host fixture\nhostname "fixture.invalid"\n';
  const abi = deploymentAbiEvidence({ files: [{ path: '/lib64/ld-linux-x86-64.so.2', realpath: '/lib64/ld-linux-x86-64.so.2', size: 1, sha256: 'a'.repeat(64) }] });
  const state = { calls: [], frames: [], cleanup: 0, connections: 0 };
  const artifact = (kind, body) => { const file = path.join(root, kind); fs.writeFileSync(file, body, { mode: 0o600 }); return { file, size: Buffer.byteLength(body), sha256: hash(body) }; };
  const probe = id => ({ target: { os: 'linux', arch: process.arch, uid: process.getuid(), user: os.userInfo().username, home }, install_root: `${home}/.local/share/lush-runner/managed/${id}`,
    remote: { machine_id: 'b'.repeat(64), boot_id: 'c'.repeat(64), home_dev: '1', home_ino: '2', abi_sha256: hash(JSON.stringify(abi)) }, abi: { status: 'ready' },
    dependencies: [{ name: 'Git', status: 'ready' }, { name: 'Bun', status: 'needs_install' }],
    cgroup: { status: 'ready', path: '/sys/fs/cgroup/controller-fixture/lush-runner', evidence: { dev: '1', ino: '2', boot_id: 'c'.repeat(64) } },
    system: { systemd: 0 }, install: { exists: false, managed: false, legacy: false }, pending: { exists: false } });
  let plans;
  const execute = (method, args) => {
    state.calls.push(method);
    const row = plans.store.read(args.id), stage = { prepare: 'prepare_remote', runtime: 'install_runtime', runner: 'install_runner', configure: 'configure_runner', seal: 'seal_runner' }[method];
    expect(row.status).toBe('running'); expect(row.private_data.active_stage).toBe(stage);
    expect(row.private_data.intents[stage].request_id).toBe(args.request_id);
  };
  plans = new DeploymentPlans({ home: path.join(root, 'device') }, {
    snapshot: () => ({ status: 'ok', limited: false, configuration }),
    build_artifacts: async () => ({ runtime: { ...artifact('runtime', 'contract runtime'), version: Bun.version, source: 'central-bun', os: 'linux', arch: process.arch, abi: { ...abi, supported: true } },
      runner: { ...artifact('runner', 'contract archive'), version: IMPLEMENTATION_VERSION }, files: ['src/runner/index.js'], cleanup() { state.cleanup++; } }),
    remote_factory: () => ({
      async probe({ id }) { state.calls.push('probe'); return probe(id); },
      async prepare(args) { execute('prepare', args); fs.mkdirSync(args.plan.install_root, { recursive: true, mode: 0o700 }); return { root_identity: '1:2' }; },
      async upload(args) {
        execute(args.kind, args);
        if (args.kind === 'runtime') fs.symlinkSync(process.execPath, path.join(args.plan.install_root, 'bun'));
        return { ok: true, stage: args.kind, sha256: args.artifact.sha256, size: args.artifact.size };
      },
      async configure(args) {
        execute('configure', args); state.remote_config = args.node_config;
        fs.writeFileSync(path.join(args.plan.install_root, 'config.json'), JSON.stringify({ ...args.node_config, memory_reserve_bytes: 0 }), { mode: 0o600 });
        for (const name of ['workspaces', 'recoveries', 'runtime-generations']) fs.mkdirSync(path.join(args.plan.install_root, name), { mode: 0o700 });
        for (const [name, bytes] of Object.entries({ 'connection-lease': '', 'activity-lock': '', 'activity-epoch': '0\n', 'recovery-gate': 'none\n' })) fs.writeFileSync(path.join(args.plan.install_root, name), bytes, { flag: 'wx', mode: 0o600 });
        const control = Object.fromEntries(Object.entries({ lease: 'connection-lease', activity_lock: 'activity-lock', epoch: 'activity-epoch', gate: 'recovery-gate', recoveries: 'recoveries', generations: 'runtime-generations', workspaces: 'workspaces', config: 'config.json' }).map(([key, name]) => {
          const stat = fs.statSync(path.join(args.plan.install_root, name)); return [key, `${stat.dev}:${stat.ino}`];
        }));
        return { managed: { version: 1, deployment_id: args.id, plan_sha256: args.plan_sha256, node_id: args.node_config.node_id,
          cgroup_root: args.node_config.cgroup_root, cgroup_evidence: args.plan.cgroup.evidence, install_root: args.plan.install_root,
          root: `${args.plan.install_root}/workspaces`, config_file: `${args.plan.install_root}/config.json`, root_identity: '1:2', manifest_sha256: '9'.repeat(64),
          runtime_sha256: args.plan.runtime.sha256, runtime_size: args.plan.runtime.size, runner_sha256: args.plan.runner.sha256,
          ssh_alias: 'fixture', ssh_config_sha256: hash(configuration), target: args.plan.target, remote: args.plan.remote, abi: args.plan.abi, control } };
      },
      async seal(args) { execute('seal', args); state.seal_proof = args.proof; return { runner_id: args.proof.runner_id }; },
      async close() {},
    }),
  });
  const controller = new DeploymentController({ home: path.join(root, 'device') }, { plans, verification_timeout_ms: 8000, transport_factory: ({ managed }) => {
    state.connections++;
    const transport = new StdioTransport({ command: process.execPath, args: [path.resolve(import.meta.dir, 'runner/fixtures/integration-node.js'), path.join(managed.install_root, 'config.json')], env: { PATH: '/usr/bin:/bin', HOME: home }, request_ms: 2000 });
    return { async request(frame, options) {
      state.frames.push(frame.method);
      if (['hello', 'workspace.register', 'command.start', 'command.cancel'].includes(frame.method)) {
        const row = plans.store.read(managed.deployment_id);
        expect(row.private_data.verification.some(event => event.phase === 'intent' && event.request_id === frame.request_id)).toBe(true);
      }
      return transport.request(frame, options);
    }, close: () => transport.close() };
  } });
  return { root, plans, controller, state, async close() { await controller.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('approved controller stages register/pair, verify real Runner/Bun/FFI/live cancel/barrier and seal the installation', async () => {
  const f = fixture(), project_id = 'controller-test';
  try {
    const planned = await f.controller.plan({ name: 'Controlled node', ssh_alias: 'fixture', project_id });
    expect(planned.status).toBe('planned');
    const result = await f.controller.apply({ id: planned.id, expected_revision: planned.revision, approved_actions: planned.plan.actions.map(item => item.id), confirm: true });
    expect(result.status).toBe('ready'); expect(f.state.connections).toBe(1);
    expect(f.state.calls).toEqual(['probe', 'probe', 'prepare', 'runtime', 'runner', 'configure', 'seal']);
    const record = f.plans.store.read(planned.id);
    expect(record.private_data.proof).toMatchObject({ runner_id: result.runner_id, runtime_verified: true, ffi_verified: true, stop_confirmed: true, barrier_confirmed: true });
    expect(f.state.frames.filter(method => method === 'command.start')).toHaveLength(2);
    expect(f.state.frames.filter(method => method === 'command.cancel')).toHaveLength(1);
    const auth = f.controller.local.credentials.snapshot(result.node_id, project_id);
    expect(f.state.remote_config.machine_token_hash).toBe(hash(auth.machine_token));
    expect(f.state.remote_config.projects[project_id].control_token_hash).toBe(hash(auth.control_token));
    expect(f.state.seal_proof).toMatchObject({ node_id: result.node_id, runner_id: result.runner_id, stopped: true });
    expect(f.controller.local.settings.read().nodes[0]).toMatchObject({ enabled: false, expected_runner_id: null });
    expect(f.state.cleanup).toBe(1);
  } finally { await f.close(); }
});
