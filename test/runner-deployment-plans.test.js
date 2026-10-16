import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DeploymentPlans, freezeDeploymentPlan, DEPLOYMENT_NODE_BUDGETS } from '../src/core/runner-deployment-plans.js';
import { validateDeploymentApproval } from '../src/core/runner-deployment-view.js';
import { deploymentAbiEvidence } from '../src/core/runner-deployment-remote.js';
import { hash, stable } from '../src/runner/protocol.js';
import { remoteFixture } from './runner-deployment-remote-fixture.js';
import { aptFixture } from './runner-deployment-remote-apt-fixture.js';

// Tiny contract snapshots are NOT executed or claimed to be installable Bun/Runner artifacts.
// The independent bundle/official-byte/Runner suites cover real production bytes/execution.
function fixture({ real_remote = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-deployment-plans-')), config = { home: path.join(root, 'device') }, r = remoteFixture();
  const request = { name: 'Planned node', ssh_alias: 'fixture', project_id: 'project-one' };
  let calls = [], cleanup = 0, build = 0, snapshot = { status: 'ok', limited: false, configuration: 'Host fixture\nhostname "fixture.invalid"\n' }, patch = null, before_probe = null, build_error = null;
  const bundles = [];
  const build_artifacts = async () => {
    build++; if (build_error) throw new Error(build_error);
    const runtime = { ...r.artifact(Buffer.from('contract runtime bytes')), version: '1.4.2', source: 'central-bun', os: 'linux', arch: 'x64', abi: { ...r.abi, supported: true } };
    const runner = { ...r.artifact(Buffer.from('contract source bytes')), version: '0.1.0' };
    const bundle = { runtime, runner, files: ['src/runner/index.js', 'src/runner/command-child.js'], cleanup() { cleanup++; for (const file of [runtime.file, runner.file]) if (fs.existsSync(file)) fs.unlinkSync(file); } };
    bundles.push(bundle); return bundle;
  };
  const probeFor = id => ({ target: { os: 'linux', arch: 'x64', uid: process.getuid(), user: os.userInfo().username, home: r.home },
    install_root: `${r.home}/.local/share/lush-runner/managed/${id}`, remote: { machine_id: 'a'.repeat(64), boot_id: 'b'.repeat(64), home_dev: '1', home_ino: '2', abi_sha256: hash(JSON.stringify(deploymentAbiEvidence(r.abi))) },
    abi: { status: 'ready' }, dependencies: [{ name: 'Git', status: 'ready', version: '2.39' }, { name: 'Bun', status: 'needs_install' }],
    cgroup: { status: 'ready', path: '/sys/fs/cgroup/contract/lush-runner', evidence: { dev: '1', ino: '2' } }, system: { systemd: 254, system_tools: true, sleep_path: '/usr/bin/sleep', sudo_n: true, sudo_git_n: true, git_candidate: null },
    install: { exists: false, managed: false, legacy: false }, pending: { exists: false } });
  const plans = new DeploymentPlans(config, { snapshot: () => snapshot, build_artifacts, remote_factory(options) {
    const remote = r.remote(options);
    const actual = remote.probe.bind(remote);
    remote.probe = async args => {
      calls.push(args);
      const stored = plans.store.read(args.id);
      expect(stored.status).toBe('running'); expect(stored.private_data.active_stage).toBe('probe');
      expect(stored.private_data.intents.probe.request_id).toMatch(/^[a-f0-9-]{36}$/);
      if (before_probe) await before_probe();
      const result = real_remote ? await actual(args) : probeFor(args.id);
      return patch ? patch(result) : result;
    };
    return remote;
  } });
  return { root, config, r, request, plans, bundles, calls, probeFor, build_artifacts,
    get cleanup() { return cleanup; }, get builds() { return build; }, set snapshot(value) { snapshot = value; },
    set patch(value) { patch = value; }, set before_probe(value) { before_probe = value; }, set build_error(value) { build_error = value; },
    async close() { await plans.close(); await r.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('construction/read are inert; explicit plan journals original probe intent and freezes all metadata without local paths or private evidence in public output', async () => {
  const f = fixture();
  try {
    expect(fs.existsSync(f.config.home)).toBe(false); expect(f.plans.read()).toEqual({ version: 1, items: [] }); expect(f.builds).toBe(0); expect(f.calls).toEqual([]);
    const result = await f.plans.plan(f.request), record = f.plans.store.read(result.id);
    expect(result.status).toBe('planned'); expect(result.plan.supported).toBe(true); expect(result.plan.node_budgets).toEqual(DEPLOYMENT_NODE_BUDGETS);
    expect(result.plan.files).toEqual(['bun', 'runner/src/runner/index.js', 'runner/src/runner/command-child.js', 'config.json', 'manifest.json']);
    expect(result.stages).toEqual([{ id: 'prepare_artifacts', status: 'complete', message: '已确认完成' }, { id: 'probe', status: 'complete', message: '已确认完成' }]);
    expect(record.private_data.plan_sha256).toBe(hash(stable(record.plan))); expect(record.private_data.ssh_sha256).toBe(hash(record.private_data.ssh_configuration));
    expect(record.plan.abi).toEqual(deploymentAbiEvidence(f.r.abi)); expect(record.plan.remote).toEqual(record.private_data.remote);
    expect(record.private_data.plan_proof).toMatch(/^[a-f0-9]{64}$/);
    expect(f.plans.artifacts(record)).toBe(f.bundles[0]); expect(f.cleanup).toBe(0);
    const publicJson = JSON.stringify(result);
    for (const forbidden of ['private_data', 'machine_id', 'boot_id', 'ssh_config_sha256', 'system_setup', 'abi_sha256', f.bundles[0].runtime.file, 'fixture.invalid']) expect(publicJson).not.toContain(forbidden);
    expect(JSON.stringify(record)).not.toContain(f.bundles[0].runtime.file);
    expect(() => f.plans.store.change(record.id, record.revision, row => { row.plan.node_budgets.timeout_ms++; })).toThrow('fixed plan');
    expect(fs.existsSync(path.join(f.config.home, 'runners.json'))).toBe(false); expect(fs.existsSync(path.join(f.config.home, 'runner-credentials.json'))).toBe(false);
    validateDeploymentApproval(record.plan, record.plan.actions.map(item => item.id));
  } finally { await f.close(); }
  expect(f.cleanup).toBe(1);
});

test('read-safe SSH snapshots reject incomplete/unsupported config before artifacts, receipts or any process; missing config retains manual alias support', async () => {
  const f = fixture();
  try {
    for (const status of ['unavailable', 'ok']) {
      f.snapshot = { status, limited: true, configuration: '' };
      await expect(f.plans.plan(f.request)).rejects.toThrow('SSH configuration');
      expect(f.builds).toBe(0); expect(f.calls).toEqual([]); expect(fs.existsSync(f.config.home)).toBe(false);
    }
    f.snapshot = { status: 'missing', limited: true, configuration: '\n' };
    expect((await f.plans.plan(f.request)).status).toBe('planned');
  } finally { await f.close(); }
});

for (const condition of ['managed', 'legacy', 'pending', 'abi', 'cpu', 'root', 'git', 'cgroup', 'sudo_cgroup', 'sudo_git', 'node']) test(`blocked ${condition} plans never install/register/pair and dispose their temporary artifacts`, async () => {
  const f = fixture();
  try {
    if (condition === 'node') f.plans.settings.save({ nodes: [{ ...f.request, project_id: undefined, enabled: true, budgets: DEPLOYMENT_NODE_BUDGETS }].map(({ project_id, ...node }) => node) }, f.plans.settings.read().revision);
    const a = condition === 'sudo_git' ? aptFixture(f.r) : null;
    f.patch = probe => {
      if (condition === 'managed' || condition === 'legacy') probe.install[condition] = true;
      if (condition === 'pending') probe.pending.exists = true;
      if (condition === 'abi') probe.abi.status = 'unsupported';
      if (condition === 'cpu') probe.target.arch = 'arm64';
      if (condition === 'root') probe.target.uid = 0;
      if (condition === 'git') probe.dependencies[0].status = 'unsupported';
      if (condition === 'cgroup') probe.cgroup.status = 'unsupported';
      if (condition === 'sudo_cgroup') { probe.cgroup.status = 'needs_setup'; probe.system.sudo_n = false; }
      if (a) { const tx = a.transaction(); probe.dependencies[0].status = 'needs_install'; Object.assign(probe.system, { git_transaction: tx, git_candidate: tx.candidate, sudo_git_n: false }); }
      return probe;
    };
    const result = await f.plans.plan(f.request);
    expect(result.status).toBe('blocked'); expect(result.plan.supported).toBe(false); expect(result.plan.blockers.length).toBeGreaterThan(0); expect(f.cleanup).toBe(1);
    expect(() => f.plans.artifacts(f.plans.store.read(result.id))).toThrow('unavailable');
    expect(fs.readdirSync(f.r.home)).toEqual([]); expect(f.plans.settings.read().nodes.length).toBe(condition === 'node' ? 1 : 0);
  } finally { await f.close(); }
});

test('complete privileged previews retain every exact install-only Git dependency and separate fixed units; no repository/config details leak', async () => {
  const f = fixture();
  try {
    const a = aptFixture(f.r); a.stock(); const transaction = a.transaction();
    f.patch = probe => { probe.cgroup.status = 'needs_setup'; probe.dependencies[0].status = 'needs_install'; Object.assign(probe.system, { git_transaction: transaction, git_candidate: transaction.candidate }); return probe; };
    const result = await f.plans.plan(f.request), record = f.plans.store.read(result.id);
    expect(result.status).toBe('planned'); const actions = result.plan.actions.filter(item => item.privileged);
    expect(actions.map(item => item.id)).toEqual(['git_install', 'cgroup_setup']);
    expect(actions[0].packages).toEqual(transaction.packages); expect(actions[0].packages_truncated).toBe(false);
    for (const action of actions) { expect(action.unit_sha256).toMatch(/^[a-f0-9]{64}$/); expect(action.unit_path).toStartWith('/etc/systemd/system/'); expect(action.effect.length).toBeGreaterThan(0); }
    expect(actions[0].unit_path).not.toBe(actions[1].unit_path);
    expect(record.plan.system.git_transaction).toEqual(transaction); expect(record.plan.system_setup.git_install.transaction).toEqual(transaction);
    expect(record.plan.system.git_transaction.configuration_policy).toBe('stock-debconf-isolation-v1');
    expect(JSON.stringify(result)).not.toContain(transaction.repositories_sha256); expect(JSON.stringify(result)).not.toContain('invocation_path'); expect(JSON.stringify(result)).not.toContain('scripts');
    expect(() => validateDeploymentApproval(record.plan, record.plan.actions.filter(item => !item.privileged).map(item => item.id))).toThrow('Every planned');
  } finally { await f.close(); }
});

test('real controlled SSH probe runs from a frozen safe snapshot and returns honest blocked system evidence, never mutates the target', async () => {
  const f = fixture({ real_remote: true });
  try {
    const result = await f.plans.plan(f.request), record = f.plans.store.read(result.id);
    expect(f.r.records).toHaveLength(1); expect(f.r.records[0].args).toContain('StrictHostKeyChecking=yes'); expect(f.r.records[0].args).toContain('StdinNull=no');
    expect(record.plan.remote.abi_sha256).toBe(hash(JSON.stringify(deploymentAbiEvidence(f.r.abi)))); expect(result.status).toBe('blocked');
    expect(result.plan.blockers.some(item => item.code === 'cgroup_setup_unavailable')).toBe(true);
    expect(fs.readdirSync(f.r.home)).toEqual([]); expect(f.cleanup).toBe(1); expect(f.plans.settings.read().nodes).toEqual([]);
  } finally { await f.close(); }
});

test('target/SSH drift during probe and artifact preparation failure stay unknown, sanitize private diagnostics and retain original request IDs without replay', async () => {
  for (const failure of ['snapshot', 'build']) {
    const f = fixture();
    try {
      if (failure === 'snapshot') f.before_probe = () => { f.snapshot = { status: 'ok', limited: false, configuration: 'Host fixture\nhostname "changed.invalid"\n' }; };
      else f.build_error = 'secret raw provider diagnostics';
      const result = await f.plans.plan(f.request), record = f.plans.store.read(result.id);
      expect(result.status).toBe('unknown'); expect(JSON.stringify(result)).not.toContain('secret raw');
      expect(record.private_data.plan_sha256).toBeUndefined();
      expect(() => f.plans.operations.run(record.id, record.revision, { stages: ['probe_again'] }, () => {})).toThrow('cannot be replayed');
      expect(f.calls.length).toBe(failure === 'snapshot' ? 1 : 0); expect(f.cleanup).toBe(failure === 'snapshot' ? 1 : 0);
    } finally { await f.close(); }
  }
});

test('artifact snapshot integrity is checked before caller may mutate central/remote state; another process never reconstructs artifacts from receipts', async () => {
  const f = fixture();
  try {
    const result = await f.plans.plan(f.request), record = f.plans.store.read(result.id);
    const reopened = new DeploymentPlans(f.config, { build_artifacts() { throw new Error('MUST NOT BUILD'); }, remote_factory() { throw new Error('MUST NOT CONNECT'); } });
    try { expect(() => reopened.artifacts(record)).toThrow('unavailable'); expect(reopened.read().items[0]).toEqual(record); } finally { await reopened.close(); }
    const original = fs.readFileSync(f.bundles[0].runtime.file); fs.writeFileSync(f.bundles[0].runtime.file, Buffer.alloc(original.length));
    expect(() => f.plans.artifacts(record)).toThrow('bytes are unavailable'); expect(f.calls).toHaveLength(1);
    expect(f.plans.settings.read().nodes).toEqual([]); expect(f.plans.store.read(result.id)).toEqual(record);
  } finally { await f.close(); }
});

for (const tamper of ['mode', 'symlink', 'missing']) test(`artifact ${tamper} cannot be adopted as a still-live local snapshot`, async () => {
  const f = fixture();
  try {
    const result = await f.plans.plan(f.request), record = f.plans.store.read(result.id), file = f.bundles[0].runtime.file;
    if (tamper === 'mode') fs.chmodSync(file, 0o644);
    if (tamper === 'missing') fs.unlinkSync(file);
    if (tamper === 'symlink') { fs.renameSync(file, file + '.original'); fs.symlinkSync(file + '.original', file); }
    expect(() => f.plans.artifacts(record)).toThrow('bytes are unavailable');
    expect(f.calls).toHaveLength(1); expect(f.plans.store.read(result.id)).toEqual(record);
  } finally { await f.close(); }
});

test('shutdown during an original asynchronous probe preserves unknown intent, closes the transport and cannot publish a late plan', async () => {
  const f = fixture(); let release, arrived;
  const ready = new Promise(resolve => { arrived = resolve; });
  f.before_probe = () => { arrived(); return new Promise(resolve => { release = resolve; }); };
  try {
    const pending = f.plans.plan(f.request); await ready;
    const closing = f.plans.close(); release(); await closing;
    const result = await pending; expect(result.status).toBe('unknown'); expect(f.plans.store.read(result.id).private_data.plan_sha256).toBeUndefined();
    expect(f.cleanup).toBe(1); expect(f.plans.pending).toBe(0); expect(f.plans.settings.read().nodes).toEqual([]);
  } finally { await f.close(); }
});

test('invalid file manifests cannot become complete approval previews, including duplicates, links/traversal syntax and over-limit source lists', async () => {
  const f = fixture();
  try {
    const bundle = await f.build_artifacts(), id = randomUUID();
    for (const files of [['../escape'], ['/absolute'], ['same', 'same'], Array.from({ length: 510 }, (_, i) => 'source' + i)]) {
      expect(() => freezeDeploymentPlan({ id, request: f.request, bundle: { ...bundle, files }, probe: f.probeFor(id), ssh_sha256: 'a'.repeat(64), nodes: [] })).toThrow('preview');
    }
    bundle.cleanup();
  } finally { await f.close(); }
});
