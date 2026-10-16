import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { DeploymentRemote, buildDeploymentSystemPlan, managedRunnerArguments, managedRunnerCommand, validateDeploymentAbi } from '../src/core/runner-deployment-remote.js';
import { managedLaunchRuntime } from '../src/core/runner-deployment-remote-launch.js';
import { buildDeploymentArtifacts } from '../src/core/runner-deployment-bundle.js';
import { officialAbi as packagedOfficialAbi } from '../src/core/runner-deployment-official.js';
import { hash as protocolHash } from '../src/runner/protocol.js';
import { systemFixture } from './runner-deployment-remote-system-fixture.js';
import { officialAbi, officialRuntime, officialFixture } from './runner-deployment-remote-abi-fixture.js';
import { aptFixture } from './runner-deployment-remote-apt-fixture.js';
import { parseDeploymentApt } from '../src/core/runner-deployment-remote-apt.js';
import { remoteRuntime } from '../src/core/runner-deployment-remote-runtime.js';
import { remoteFixture, tar, fakeRuntimeEvidence } from './runner-deployment-remote-fixture.js';

const entries = [{ name: 'bin/lush-runner', bytes: Buffer.from('fixture entry, not a real Runner') }, { name: 'src/runner/index.js', bytes: Buffer.from('fixture source') }, { name: 'src/runner/command-child.js', bytes: Buffer.from('dynamic fixture source') }];
test('APT read-only complete transaction binds repo/config/index/status; removals, upgrades, hooks, incomplete/unknown solver output are unsupported', async () => {
  const f = remoteFixture();
  try {
    const a = aptFixture(f), tx = a.transaction(); expect(tx).toMatchObject({ supported: true, candidate: '1:2.39.5-1', architecture: 'amd64', packages_truncated: false }); expect(tx.packages.map(p => p.name)).toEqual(['git', 'git-man']);
    const original = JSON.parse(fs.readFileSync(a.state));
    for (const patch of [{ broken: true }, { sim: original.sim + '\nRemv basepkg [1]' }, { sim: original.sim.replace('Inst git (', 'Inst git [0] (') }, { sim: original.sim.replace('Conf git-man', 'Unknown git-man') }, { sim: original.sim + '\ntruncated/unknown output' }, { config: 'DPkg::Pre-Install-Pkgs:: "/usr/local/bin/unknown-hook";\n' }, { config: 'Dir::State::status "/home/user/status";\n' }, { config: 'dpkg::PRE-install-PKGS "/home/user/script";\n' }, {config:'APT::Get::force-yes "true";\n'}]) {
      a.change({ ...original, ...patch }); expect(a.transaction().supported).toBe(false);
    }
    a.change(original); fs.appendFileSync(a.root + '/var/lib/apt/lists/index', 'repo changed'); expect(a.transaction().repositories_sha256).not.toBe(tx.repositories_sha256);
    expect(parseDeploymentApt(a.observe().replace('apt_package=git-man', 'apt_package=git'))).toMatchObject({ supported: false });
    expect(JSON.parse(fs.readFileSync(a.state)).install_calls).toBe(0); expect(fs.readdirSync(f.home)).toEqual([]);
  } finally { await f.close(); }
});

test('stock Debian debconf configuration is frozen but its preconfiguration hook is isolated; unknown hooks and custom dpkg remain blocked', async () => {
  const f=remoteFixture();
  try {
    const a=aptFixture(f); a.stock(); const before=tree(a.root), tx=a.transaction(); expect(tx).toMatchObject({supported:true,configuration_policy:'stock-debconf-isolation-v1'}); expect(tree(a.root)).toEqual(before);
    const state=JSON.parse(fs.readFileSync(a.state)), original=fs.readFileSync(a.root+'/etc/apt/apt.conf.d/70debconf','utf8');
    for(const config of [state.config+'DPkg::Post-Invoke:: "/unknown/hook";\n',state.config+'DPkg::Pre-Install-Pkgs:: "/usr/sbin/dpkg-preconfigure --apt || true; echo unknown";\n',state.config+'DPkg::Pre-Invoke:: "/unknown/pre";\n']) {a.change({config}); expect(a.transaction()).toMatchObject({supported:false,reason:'configuration_unsupported'});}
    a.change({config:state.config}); fs.writeFileSync(a.root+'/etc/dpkg/dpkg.cfg.d/custom','path-exclude=/usr/share/doc/*\n'); expect(a.transaction()).toMatchObject({supported:false,reason:'configuration_unsupported'}); expect(fs.readFileSync(a.root+'/etc/apt/apt.conf.d/70debconf','utf8')).toBe(original); expect(JSON.parse(fs.readFileSync(a.state)).install_calls).toBe(0);
  } finally {await f.close();}
});

test('native read-only apt-config proves late FD config clears stock list before installing the sole fixed archive gate; no OS config edits', async () => {
  const f=remoteFixture();
  try {
    const dir=path.join(f.root,'native-policy');fs.mkdirSync(dir);const sample=fs.readFileSync(new URL('./fixtures/runner-deployment-remote-debian/70debconf.conf',import.meta.url)); fs.writeFileSync(path.join(dir,'70debconf'),sample);
    const bootstrap=path.join(f.root,'apt-bootstrap');fs.writeFileSync(bootstrap,`Dir::Etc::parts "${dir}";\nDir::Etc::main "/dev/null";\n`);
    const env={PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',APT_CONFIG:bootstrap};const inherited=spawnSync('/usr/bin/apt-config',['dump'],{env,encoding:'utf8'});expect(inherited.status).toBe(0);expect(inherited.stdout).toContain('DPkg::Pre-Install-Pkgs:: "/usr/sbin/dpkg-preconfigure --apt || true";');
    const native=spawnSync('/bin/sh',['-c',`exec 8<<LCM_POLICY\n#clear DPkg::Pre-Install-Pkgs;\nLCM_POLICY\nexec /usr/bin/apt-config -c /proc/self/fd/8 -o 'DPkg::Pre-Install-Pkgs::=/bin/sh fixed-final-archive-gate' dump`],{env,encoding:'utf8'});
    expect(native.status).toBe(0);expect(native.stdout).not.toContain('/usr/sbin/dpkg-preconfigure');expect(native.stdout.split('\n').filter(line=>line.startsWith('DPkg::Pre-Install-Pkgs::'))).toEqual(['DPkg::Pre-Install-Pkgs:: "/bin/sh fixed-final-archive-gate";']); expect(fs.readFileSync(path.join(dir,'70debconf'))).toEqual(sample);
  } finally {await f.close();}
});

test('complete APT observation crosses the controlled SSH probe boundary without privileged effects or leaking raw policy', async () => {
  const f = remoteFixture();
  try {
    const a = aptFixture(f); fs.writeFileSync(path.join(f.bin,'git'),'#!/bin/sh\nexit 1\n',{mode:0o700}); fs.writeFileSync(path.join(f.bin,'sudo'),'#!/bin/sh\n[ "$1 $2" = "-n -l" ]\n',{mode:0o700});
    f.hook(() => ({apt_script:a.script()}));
    const r = await f.remote().probe({id:randomUUID(),abi:f.abi}); expect(r.system.git_transaction).toMatchObject({supported:true, packages_truncated:false}); expect(r.system.git_transaction.packages).toHaveLength(2); expect(r.system.sudo_git_n).toBe(true); expect(r.system.git_candidate).toBe('1:2.39.5-1'); expect(JSON.stringify(r)).not.toContain('https://example.invalid'); expect(JSON.parse(fs.readFileSync(a.state)).install_calls).toBe(0);
  } finally { await f.close(); }
});

for (const failure of [null, 'extra', 'root_drift', 'drop_ack', 'stale', 'post_drift', 'dropin']) test('fixed Git installer exact archive gate and whole-unit evidence: ' + (failure || 'success'), async () => {
  const f = remoteFixture();
  try {
    const c = await systemContext(f, ['git_install']), a = aptFixture(f); a.stock(); const tx = a.transaction(); expect(tx.supported).toBe(true);
    Object.assign(c.plan.system, { git_transaction: tx, git_candidate: tx.candidate, sudo_git_n: true }); c.plan.system_setup = buildDeploymentSystemPlan({ id: c.id, target: c.plan.target, system: c.plan.system });
    expect(c.plan.system_setup.git_install.unit_sha256).toMatch(/^[a-f0-9]{64}$/); expect(c.plan.system_setup.git_install.packages).toEqual(tx.packages);
    if(failure) a.change({ [failure]: true }); if(failure==='stale') fs.appendFileSync(a.root+'/var/lib/apt/lists/index','changed before root'); const adapter = a.adapter(c);
    const result = await remoteRuntime({ ...requestOf(c), operation: 'git_install' }, adapter);
    if(!failure) {
      expect(result).toMatchObject({ ok: true, installer: { tree_stopped: true, success: true, barrier: 'systemctl-wait-exit-type-cgroup' } });
      const state = JSON.parse(fs.readFileSync(a.state)); expect(state.installed).toBe(true); expect(state.stock_hook_suppressed).toBe(true); expect(state.last_args).toContain('--no-upgrade'); expect(state.last_args).toContain('git-man=' + tx.candidate);
      const before = adapter.calls.length; expect(await remoteRuntime({ ...requestOf(c), operation: 'git_install' }, adapter)).toMatchObject({ ok: false, code: 'stage_already_started' }); expect(adapter.calls).toHaveLength(before);
      expect(await remoteRuntime({ ...requestOf(c), operation: 'inspect' }, adapter)).toMatchObject({ installer: { tree_stopped: true, success: true } });
      a.change({gc:true}); expect(await remoteRuntime({...requestOf(c),operation:'inspect'},adapter)).toMatchObject({installer:{tree_stopped:true,success:true}});
      a.change({unit_active:true,after_main:true}); expect(await remoteRuntime({ ...requestOf(c), operation: 'inspect' }, adapter)).toMatchObject({ installer: { tree_stopped: false, success: false } });
    } else {
      expect(result).toMatchObject({ ok: false, unknown: true }); expect(JSON.parse(fs.readFileSync(a.state)).installed).toBe(['drop_ack','post_drift'].includes(failure)); expect(JSON.parse(fs.readFileSync(a.state)).install_calls).toBe(['stale','dropin'].includes(failure)?0:1);
      if(failure==='drop_ack') { const before=tree(f.home); expect(await remoteRuntime({...requestOf(c),operation:'inspect'},adapter)).toMatchObject({installer:{tree_stopped:true,success:true},stages:expect.arrayContaining([{stage:'git_install',status:'unknown'}])}); expect(tree(f.home)).toEqual(before); }
      if(failure==='stale') expect(adapter.calls.some(row=>row[0]==='/usr/bin/sudo')).toBe(false);
    }
  } finally { await f.close(); }
});

const requestOf = context => ({ id: context.id, plan: context.plan, plan_sha256: context.plan_sha256 });
async function systemContext(f, actions = ['cgroup_setup']) {
  const runtime = f.artifact(Buffer.from('unit boundary runtime bytes, never executed')), runner = f.artifact(tar(entries), entries.map(e => e.name));
  const c = await f.plan(undefined, { runtime, runner, actions: actions.map(id => ({ id, privileged: true })), cgroup: { status: 'needs_setup' }, system: { systemd: 254, system_tools: true, sudo_n: true, distro: 'debian', sleep_path: '/usr/bin/sleep', git_candidate: '1:2.39.5-1' } });
  c.plan.system_setup = buildDeploymentSystemPlan({ id: c.id, target: c.plan.target, system: c.plan.system });
  await c.remote.prepare(c); fakeRuntimeEvidence(c); fs.writeFileSync(path.join(c.plan.install_root, 'bun'), fs.readFileSync(runtime.file), { mode: 0o700 });
  expect(await remoteRuntime({ ...requestOf(c), operation: 'runner', artifact: runner }, { payload: fs.readFileSync(runner.file) })).toMatchObject({ ok: true });
  return c;
}
function tree(root) { return fs.readdirSync(root, { recursive: true }).map(name => { const file = path.join(root, name), stat = fs.lstatSync(file); return [name, stat.mode, stat.size, stat.mtimeMs]; }); }

test('fixed read-only SSH probe preserves trust, actual ABI digest evidence, bounded private identity and inert reads', async () => {
  const f = remoteFixture();
  try {
    const r = f.remote(), id = randomUUID(), result = await r.probe({ id, abi: f.abi });
    expect(result.target).toMatchObject({ os: 'linux', arch: 'x64', home: f.home, uid: process.getuid() });
    expect(result.abi.status).toBe('ready'); expect(result.remote.abi_sha256).toMatch(/^[a-f0-9]{64}$/); expect(result.pending).toEqual({ exists: false });
    expect(fs.readdirSync(f.home)).toEqual([]); expect(fs.readFileSync(path.join(f.root, 'sudo-calls'), 'utf8').trim()).toBe('-n -l /usr/bin/systemd-run');
    expect(result.dependencies.map(row => row.name)).toEqual(['Git', 'Bun']); expect(result.system.sudo_n).toBe(false);
    const record = f.records[0];
    for (const flag of ['StrictHostKeyChecking=yes', 'BatchMode=yes', 'UpdateHostKeys=no', 'PermitLocalCommand=no', 'ClearAllForwardings=yes', 'ForwardAgent=no', 'ProxyCommand=none', 'KnownHostsCommand=none', 'ControlPath=none', 'CanonicalizeHostname=no', 'PKCS11Provider=none', 'SecurityKeyProvider=none', 'StdinNull=no']) expect(record.args).toContain(flag);
    expect(record.args).not.toContain('StdinNull=yes'); expect(record.env).not.toContain('LUSH_AGENT_TOKEN'); expect(record.mode).toBe(0o600);
    const mismatched = structuredClone(f.abi); mismatched.files[0].sha256 = '0'.repeat(64);
    expect((await r.probe({ id, abi: mismatched })).abi.status).toBe('unsupported'); expect(fs.readdirSync(f.home)).toEqual([]);
    for (const alias of ['user@host', '-option', 'x;touch bad']) expect(() => f.remote({ ssh_alias: alias })).toThrow();
    for (const config of ['Host x\nProxyCommand touch /never\n', 'Include /etc/ssh/ssh_config\n', 'Match exec "secret"\n', 'Host x\nuser "a;touch bad"\n']) expect(() => f.remote({ ssh_configuration: config })).toThrow();
  } finally { await f.close(); }
});

test('exclusive remote prepare records fixed identity before install; binary stdin upload verifies source/hash and never replays', async () => {
  const f = remoteFixture();
  try {
    const artifact = f.artifact(Buffer.from('controlled runtime bytes, not executed')), c = await f.plan(undefined, { runtime: artifact });
    expect(await c.remote.prepare(c)).toMatchObject({ ok: true, stage: 'prepare' });
    const install = c.plan.install_root;
    expect(fs.statSync(path.join(install, 'receipt')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(f.home, '.lush-runner-deployment.lock')).mode & 0o777).toBe(0o700);
    const before = tree(f.home); expect(await c.remote.inspect(c)).toMatchObject({ integrity: 'not_configured', stages: [{ stage: 'prepare', status: 'done' }, { stage: 'runtime', status: 'not_started' }] }); expect(tree(f.home)).toEqual(before);
    expect(await c.remote.upload({ ...c, kind: 'runtime', artifact })).toMatchObject({ ok: true, sha256: artifact.sha256 });
    expect(fs.readFileSync(path.join(install, 'bun'))).toEqual(fs.readFileSync(artifact.file)); expect(fs.statSync(path.join(install, 'bun')).mode & 0o777).toBe(0o700);
    await expect(c.remote.upload({ ...c, kind: 'runtime', artifact })).rejects.toMatchObject({ code: 'stage_already_started', unknown: false });
    const drift = structuredClone(c.plan); drift.remote.boot_id = 'd'.repeat(64);
    await expect(c.remote.prepare({ ...c, plan: drift })).rejects.toMatchObject({ code: 'identity_changed' });
    await expect(c.remote.prepare(c)).rejects.toMatchObject({ code: 'busy' });
  } finally { await f.close(); }
});

test('independent processes and different aliases cannot bypass one remote owner lock with a new plan', async () => {
  const f = remoteFixture();
  try {
    const a = await f.plan(f.remote({ ssh_alias: 'one' })), b = await f.plan(f.remote({ ssh_alias: 'two' }));
    const result = await Promise.allSettled([a.remote.prepare(a), b.remote.prepare(b)]);
    expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(result.find(r => r.status === 'rejected').reason.code).toBe('busy');
    const next = await f.plan(f.remote({ ssh_alias: 'third' })); expect(next.probe.pending.exists).toBe(true);
    await expect(next.remote.prepare(next)).rejects.toMatchObject({ code: 'busy' });
  } finally { await f.close(); }
});

test('existing unknown dirs, symlinked hierarchy and stale target/SSH evidence fail closed without overwriting outside files', async () => {
  const f = remoteFixture();
  try {
    const c = await f.plan(); const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside, { mode: 0o700 });
    fs.symlinkSync(outside, path.join(f.home, '.local'));
    await expect(c.remote.prepare(c)).rejects.toMatchObject({ code: 'identity_changed' }); expect(fs.readdirSync(outside)).toEqual([]);
    const snapshot = structuredClone(c.plan); snapshot.ssh_config_sha256 = 'e'.repeat(64);
    const count = f.records.length; await expect(c.remote.prepare({ ...c, plan: snapshot })).rejects.toThrow('evidence changed'); expect(f.records).toHaveLength(count);
  } finally { await f.close(); }
  const g = remoteFixture();
  try {
    const c = await g.plan(); fs.mkdirSync(path.join(g.home, '.local/share/lush-runner/managed/unknown'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(g.home, '.local/share/lush-runner/managed/unknown/private'), 'do not overwrite');
    await expect(c.remote.prepare(c)).rejects.toMatchObject({ code: 'already_exists' });
    expect(fs.readFileSync(path.join(g.home, '.local/share/lush-runner/managed/unknown/private'), 'utf8')).toBe('do not overwrite');
  } finally { await g.close(); }
});

test('source name replacement during real stdin transfer is unknown; descriptor bytes cannot be redirected to a substituted source', async () => {
  const f = remoteFixture();
  try {
    const a = f.artifact(Buffer.from('fixed trusted artifact bytes')), c = await f.plan(undefined, { runtime: a }); await c.remote.prepare(c);
    const substitute = f.artifact(Buffer.from('secret-substituted-bytes'));
    f.hook(() => { fs.renameSync(a.file, a.file + '-original'); fs.symlinkSync(substitute.file, a.file); f.hook(null); });
    await expect(c.remote.upload({ ...c, kind: 'runtime', artifact: a })).rejects.toMatchObject({ code: 'artifact_changed', unknown: true });
    expect(fs.readFileSync(path.join(c.plan.install_root, 'bun'), 'utf8')).toBe('fixed trusted artifact bytes');
  } finally { await f.close(); }
});

test('real Bun bootstrap and stdio tar upload retain source layout; private config/proof and integrity evidence never expose credential hashes', async () => {
  const f = remoteFixture();
  try {
    const runtime = f.artifact(fs.readFileSync(process.execPath)), runner = f.artifact(tar(entries), entries.map(e => e.name));
    const c = await f.plan(undefined, { runtime, runner }); await c.remote.prepare(c);
    await c.remote.upload({ ...c, kind: 'runtime', artifact: runtime });
    await c.remote.upload({ ...c, kind: 'runner', artifact: runner });
    const root = c.plan.install_root;
    expect(fs.readFileSync(path.join(root, 'runner/src/runner/command-child.js'), 'utf8')).toBe('dynamic fixture source');
    const config = { version: 1, node_id: randomUUID(), root: `${root}/workspaces`, cgroup_root: c.plan.cgroup.path, machine_token_hash: '1'.repeat(64), projects: { fixture: { control_token_hash: '2'.repeat(64) } } };
    // Cgroup adapter is a unit boundary only: no fixture claims a real cgroup or Runner handshake.
    const configured = await remoteRuntime({ ...requestOf(c), operation: 'configure', node_config: config }, { verifyCgroup: () => true });
    expect(configured.ok).toBe(true); expect(configured.managed.manifest_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.statSync(path.join(root, 'config.json')).mode & 0o777).toBe(0o600); expect(JSON.parse(fs.readFileSync(path.join(root, 'config.json')))).toEqual(config);
    expect(JSON.stringify(configured)).not.toContain(config.machine_token_hash); expect(JSON.stringify(f.records)).not.toContain(config.projects.fixture.control_token_hash);
    const before = tree(f.home); expect(await remoteRuntime({ ...requestOf(c), operation: 'inspect' }, { verifyCgroup: () => true })).toMatchObject({ integrity: 'verified', sealed: false }); expect(tree(f.home)).toEqual(before);
    const proof = { node_id: config.node_id, runner_id: randomUUID(), execution_id: 'cmd-' + protocolHash(`fixture:${randomUUID()}`), stopped: true, verified_at: new Date().toISOString() };
    expect(await remoteRuntime({ ...requestOf(c), operation: 'seal', proof }, { verifyCgroup: () => true })).toMatchObject({ ok: true, runner_id: proof.runner_id });
    expect(JSON.parse(fs.readFileSync(path.join(root,'sealed'))).execution_id).toBe(proof.execution_id);
    expect(await remoteRuntime({ ...requestOf(c), operation: 'inspect' }, { verifyCgroup: () => true })).toMatchObject({ sealed: true });
    const sealedTree = tree(f.home); f.hook(args => args.at(-1).includes('all.indexOf(10)') ? {tamper_program:true} : null);
    await expect(c.remote.inspect(c)).rejects.toMatchObject({code:'not_confirmed'}); expect(tree(f.home)).toEqual(sealedTree); f.hook(null);
    const another = await f.plan(); expect(another.probe.install.managed).toBe(true); await expect(another.remote.prepare(another)).rejects.toMatchObject({code:'busy'});
    fs.writeFileSync(path.join(root, 'runner/src/runner/command-child.js'), 'changed');
    expect(await remoteRuntime({ ...requestOf(c), operation: 'inspect' }, { verifyCgroup: () => true })).toMatchObject({ ok: false, code: 'artifact_changed' });
  } finally { await f.close(); }
});

test('strict archive decoder rejects traversal, links, pax and duplicates before any archive entry is written (unit boundary)', async () => {
  for (const bad of [{ name: '../outside' }, { name: '/absolute' }, { name: 'src/link', type: '2', link: '/outside' }, { name: 'src/header', type: 'x' }, entries[0]]) {
    const f = remoteFixture();
    try {
      const archive = tar([...entries, bad]), runner = f.artifact(archive, entries.map(e => e.name)), c = await f.plan(undefined, { runner });
      await c.remote.prepare(c); fakeRuntimeEvidence(c);
      const result = await remoteRuntime({ ...requestOf(c), operation: 'runner', artifact: runner }, { payload: archive });
      expect(result.ok).toBe(false); expect(result.code).toBe('artifact_changed'); expect(fs.existsSync(path.join(c.plan.install_root, 'runner'))).toBe(false);
      const receipt = JSON.parse(fs.readFileSync(path.join(c.plan.install_root, 'stages/runner.failed'))); expect(receipt.status).toBe('failed');
    } finally { await f.close(); }
  }
});

test('no retries, raw stdout/stderr suppression, bounded deadlines, close cancellation and no privileged fallback', async () => {
  let calls = 0, live;
  const spawn_process = (_command, _args, options) => { calls++; live = spawn(process.execPath, ['-e', 'process.stderr.write("private secret raw stderr"); setInterval(()=>{},1000)'], options); return live; };
  const r = new DeploymentRemote({ ssh_alias: 'fixture', ssh_configuration: '', spawn_process, timeout_ms: 40 });
  const f = remoteFixture();
  try {
    let error; try { await r.probe({ id: randomUUID(), abi: f.abi }); } catch (e) { error = e; }
    expect(error.code).toBe('timeout'); expect(error.unknown).toBe(true); expect(error.message).not.toContain('secret'); expect(calls).toBe(1);
    const c = await f.plan(); await c.remote.prepare(c); fakeRuntimeEvidence(c);
    const result = await remoteRuntime({ ...requestOf(c), operation: 'git_install' }); expect(result.ok).toBe(false); expect(result.code).toBe('stage_failed');
    // A missing artifact prerequisite never triggers a privileged fallback.
    expect(fs.readFileSync(path.join(f.root, 'sudo-calls'), 'utf8').trim()).toBe('-n -l /usr/bin/systemd-run');
    const r2 = new DeploymentRemote({ ssh_alias: 'fixture', ssh_configuration: '', spawn_process });
    const pending = r2.probe({ id: randomUUID(), abi: f.abi }); await r2.close(); await expect(pending).rejects.toMatchObject({ unknown: true });
    await expect(r2.probe({ id: randomUUID(), abi: f.abi })).rejects.toMatchObject({ code: 'closed' });
  } finally { await r.close(); await f.close(); }
});

test('lost prepare acknowledgement leaves original fixed evidence; inspect is read-only and neither retries nor releases ownership', async () => {
  const f = remoteFixture();
  try {
    const c = await f.plan(); f.hook(() => ({ drop_ack: true }));
    await expect(c.remote.prepare(c)).rejects.toMatchObject({ code: 'not_confirmed', unknown: true }); f.hook(null);
    const owner = path.join(f.home, '.lush-runner-deployment.lock/owner'), evidence = fs.readFileSync(owner, 'utf8');
    const files = fs.readdirSync(f.home, { recursive: true });
    expect(await c.remote.inspect(c)).toMatchObject({ integrity: 'not_configured', stages: [{ stage: 'prepare', status: 'done' }, { stage: 'runtime', status: 'not_started' }] });
    expect(fs.readdirSync(f.home, { recursive: true })).toEqual(files); expect(fs.readFileSync(owner, 'utf8')).toBe(evidence);
    await expect(c.remote.prepare(c)).rejects.toMatchObject({ code: 'busy' });
  } finally { await f.close(); }
});

test('wrong byte stream is retained as failed evidence, never chmodded/executed or overwritten by a later upload', async () => {
  const f = remoteFixture();
  try {
    const artifact = f.artifact(Buffer.from('123456789')), c = await f.plan(undefined, { runtime: artifact }); await c.remote.prepare(c);
    f.hook(() => { fs.writeFileSync(artifact.file, '987654321'); f.hook(null); });
    await expect(c.remote.upload({ ...c, kind: 'runtime', artifact })).rejects.toMatchObject({ code: 'artifact_changed' });
    expect(fs.existsSync(path.join(c.plan.install_root, 'bun'))).toBe(false);
    expect(fs.statSync(path.join(c.plan.install_root, 'runtime.upload')).mode & 0o777).toBe(0o600);
    expect(await c.remote.inspect(c)).toMatchObject({ stages: [{ stage: 'prepare', status: 'done' }, { stage: 'runtime', status: 'failed' }] });
  } finally { await f.close(); }
});

test('legacy config appearing after plan or a replaced private SSH snapshot is rejected before target files change', async () => {
  const f = remoteFixture();
  try {
    const c = await f.plan(); fs.mkdirSync(path.join(f.home, '.config/lush-runner'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(f.home, '.config/lush-runner/config.json'), 'unknown config', { mode: 0o600 });
    await expect(c.remote.prepare(c)).rejects.toMatchObject({ code: 'already_exists' }); expect(fs.existsSync(path.join(f.home, '.lush-runner-deployment.lock'))).toBe(false);
    fs.writeFileSync(path.join(c.remote.directory, 'config'), 'Host x\nProxyCommand bad-secret\n'); const count = f.records.length;
    await expect(c.remote.probe({ id: c.id, abi: f.abi })).rejects.toMatchObject({ code: 'unsupported' }); expect(f.records).toHaveLength(count);
  } finally { await f.close(); }
});

test('stdout and stderr limits reject raw diagnostics with no automatic retry', async () => {
  const f = remoteFixture();
  try {
    for (const fd of [1, 2]) {
      let calls = 0;
      const remote = new DeploymentRemote({ ssh_alias: 'fixture', ssh_configuration: '', spawn_process: (_cmd, _args, options) => {
        calls++; return spawn(process.execPath, ['-e', `import fs from 'node:fs'; fs.writeSync(${fd}, 'private raw secret'.repeat(20000)); setInterval(()=>{},1000);`], options);
      } });
      try { let error; try { await remote.probe({ id: randomUUID(), abi: f.abi }); } catch (e) { error = e; }
        expect(error.code).toBe('output_limit'); expect(error.message).not.toContain('secret'); expect(error.unknown).toBe(true); expect(calls).toBe(1);
      } finally { await remote.close(); }
    }
  } finally { await f.close(); }
});

test('frozen cgroup system plan uses fixed bounded installer unit and queried cgroup binding', async () => {
  const f = remoteFixture();
  try {
    const c = await systemContext(f), adapter = systemFixture(f, c), original = structuredClone(c.plan);
    expect(c.plan.system_setup.unit).toMatchObject({ uid: process.getuid(), supervisor: 'supervisor', runner: 'runner', bind_control_group_after_start: true, enable: true, start: true });
    expect(c.plan.system_setup.unit.sha256).toMatch(/^[a-f0-9]{64}$/);
    const prepared = await remoteRuntime({ ...requestOf(c), operation: 'cgroup_setup' }, adapter);
    expect(prepared).toMatchObject({ ok: true, cgroup: { path: `/sys/fs/cgroup/fixture.slice/${c.plan.system_setup.unit.name}/runner`, evidence: { dev: '3', ino: '4' } } });
    expect(c.plan).toEqual(original); expect(fs.readFileSync(adapter.unit_file, 'utf8')).toContain('DelegateSubgroup=supervisor');
    const rootCalls = adapter.calls.filter(args => args[0] === '/usr/bin/sudo'); expect(rootCalls).toHaveLength(1);
    for (const call of rootCalls) {
      expect(call.slice(1, 4)).toEqual(['-n', '/usr/bin/systemd-run', '--system']);
      expect(call).toContain('--property=RuntimeMaxSec=90s'); expect(call).toContain('--property=KillMode=control-group');
      expect(call.at(-1)).not.toContain(c.plan.install_root); expect(call.at(-1)).not.toContain('curl');
    }
    const before = tree(f.home), observed = await remoteRuntime({ ...requestOf(c), operation: 'inspect' }, adapter);
    expect(observed).toMatchObject({ ok: true, cgroup: prepared.cgroup }); expect(tree(f.home)).toEqual(before);
    expect(await remoteRuntime({ ...requestOf(c), operation: 'cgroup_setup' }, adapter)).toMatchObject({ ok: false, code: 'stage_already_started' });
    adapter.drift(true); expect(await remoteRuntime({ ...requestOf(c), operation: 'inspect' }, adapter)).toMatchObject({ ok: false, code: 'identity_changed', unknown: true });
  } finally { await f.close(); }
});

test('unknown systemd drop-ins are refused before delegation service enable/start, not merely detected after execution', async () => {
  const f = remoteFixture();
  try {
    const c = await systemContext(f), adapter=systemFixture(f,c,{dropin:true});
    expect(await remoteRuntime({...requestOf(c),operation:'cgroup_setup'},adapter)).toMatchObject({ok:false,unknown:true});
    expect(JSON.parse(fs.readFileSync(adapter.state)).active).toBe(false); expect(fs.existsSync(path.join(path.dirname(adapter.unit_file),'multi-user.target.wants',path.basename(adapter.unit_file)))).toBe(false);
  } finally {await f.close();}
});

test('partial root effects/lost result remain unknown and inspect never replays, adopts or rolls them back', async () => {
  const f = remoteFixture();
  try {
    const c = await systemContext(f, ['cgroup_setup']), adapter = systemFixture(f, c, { fail_after_unit: true });
    expect(await remoteRuntime({ ...requestOf(c), operation: 'cgroup_setup' }, adapter)).toMatchObject({ ok: false, code: 'system_action_failed', unknown: true });
    expect(fs.existsSync(adapter.unit_file)).toBe(true); expect(fs.existsSync(path.join(c.plan.install_root, 'stages/cgroup_setup.done'))).toBe(false);
    expect(fs.existsSync(path.join(c.plan.install_root, 'stages/cgroup_setup.failed'))).toBe(false);
    const writes = adapter.calls.filter(a => a[0] === '/usr/bin/sudo').length;
    const observed = await remoteRuntime({ ...requestOf(c), operation: 'inspect' }, adapter);
    expect(observed).toMatchObject({ ok: true, system: { active: false, load_state: 'loaded' } }); expect(observed.stages.find(s => s.stage === 'cgroup_setup').status).toBe('unknown');
    expect(adapter.calls.filter(a => a[0] === '/usr/bin/sudo')).toHaveLength(writes); expect(fs.existsSync(adapter.unit_file)).toBe(true);
  } finally { await f.close(); }
});

test('missing sudo, changed system plan and unsupported automatic setup do not produce root calls', async () => {
  const f = remoteFixture();
  try {
    const c = await systemContext(f, ['cgroup_setup']), adapter = systemFixture(f, c); c.plan.system.sudo_n = false;
    expect(await remoteRuntime({ ...requestOf(c), operation: 'cgroup_setup' }, adapter)).toMatchObject({ ok: false, code: 'privilege_denied' });
    expect(adapter.calls.filter(a => a[0] === '/usr/bin/sudo')).toHaveLength(0);
    expect(buildDeploymentSystemPlan({ id: c.id, target: c.plan.target, system: { ...c.plan.system, systemd: 253 } })).toBe(null);
    expect(() => validateDeploymentAbi({ kind: 'guess-official-minimum', files: f.abi.files })).toThrow('Unsupported');
  } finally { await f.close(); }
  const g = remoteFixture();
  try {
    const c = await systemContext(g, ['cgroup_setup']), adapter = systemFixture(g, c); c.plan.system_setup.unit.path = '/etc/unknown.service';
    expect(await remoteRuntime({ ...requestOf(c), operation: 'cgroup_setup' }, adapter)).toMatchObject({ ok: false, code: 'identity_changed' });
    expect(adapter.calls.filter(a => a[0] === '/usr/bin/sudo')).toHaveLength(0);
  } finally { await g.close(); }
});

test('managed startup verifier binds fixed tree/SSH/identity/cgroup evidence, preserves protocol stdin and never embeds credential hashes', async () => {
  const f = remoteFixture();
  try {
    const c = await systemContext(f, ['cgroup_setup']), adapter = systemFixture(f, c);
    const cg = await remoteRuntime({ ...requestOf(c), operation: 'cgroup_setup' }, adapter); expect(cg.ok).toBe(true);
    const config = { version: 1, node_id: randomUUID(), root: `${c.plan.install_root}/workspaces`, cgroup_root: cg.cgroup.path, machine_token_hash: '1'.repeat(64), projects: { fixture: { control_token_hash: '2'.repeat(64) } } };
    const configured = await remoteRuntime({ ...requestOf(c), operation: 'configure', node_config: config }, adapter); expect(configured.ok).toBe(true);
    const managed = c.remote.describe(c, configured.managed); let started = 0;
    expect(await managedLaunchRuntime(managed, { verifyCgroup: adapter.verifyCgroup, start: () => ++started })).toBe(1);
    expect(started).toBe(1); const args = managedRunnerArguments({ ssh_alias: 'fixture', ssh_configuration_file: path.join(c.remote.directory, 'config'), managed });
    expect(args).toContain('StdinNull=no'); expect(args.at(-1)).toBe(managedRunnerCommand(managed));
    expect(args.join(' ')).not.toContain(config.machine_token_hash); expect(args.join(' ')).not.toContain(config.projects.fixture.control_token_hash);
    const text = managedRunnerCommand(managed); expect(text).toContain('/proc/self/fd/9 --no-install'); expect(text).toContain('input: process.stdin'); expect(text).not.toContain('for await'); expect(text).not.toContain('process.stdin.on');
    expect(() => managedRunnerArguments({ ssh_alias: 'different', ssh_configuration_file: path.join(c.remote.directory, 'config'), managed })).toThrow();
    fs.writeFileSync(path.join(c.plan.install_root, 'config.json'), JSON.stringify({ ...config, node_id: randomUUID() }));
    await expect(managedLaunchRuntime(managed, { verifyCgroup: adapter.verifyCgroup, start: () => ++started })).rejects.toThrow('integrity'); expect(started).toBe(1);
  } finally { await f.close(); }
});

test('stage-directory and independent execution-lock replacement cannot reset operation history', async () => {
  for (const name of ['stages', 'execution-lock']) {
    const f = remoteFixture();
    try {
      const c = await f.plan(); await c.remote.prepare(c); const file = path.join(c.plan.install_root, name); fs.renameSync(file, file + '-original');
      if (name === 'stages') fs.mkdirSync(file, { mode: 0o700 }); else fs.writeFileSync(file, '', { mode: 0o600 });
      await expect(c.remote.inspect(c)).rejects.toMatchObject({ code: 'identity_changed', unknown: true });
      expect(fs.existsSync(path.join(c.plan.install_root, 'bun'))).toBe(false);
    } finally { await f.close(); }
  }
});

test('CPU feature evidence is measured and frozen, and candidate-only Git cannot bypass complete transaction approval', async () => {
  const f = remoteFixture();
  try {
    const r = f.remote(), abi = { ...f.abi, cpu_features: ['lush_impossible_cpu_feature'] };
    expect((await r.probe({ id: randomUUID(), abi })).abi.status).toBe('unsupported');
    const c = await systemContext(f, ['git_install']), adapter = systemFixture(f, c); const count = f.records.length;
    await expect(c.remote.system({ ...c, action: 'git_install' })).rejects.toMatchObject({ code: 'unsupported' }); expect(f.records).toHaveLength(count);
    expect(await remoteRuntime({ ...requestOf(c), operation: 'git_install' }, adapter)).toMatchObject({ ok: false, code: 'unsupported' }); expect(adapter.calls).toHaveLength(0);
    expect(c.plan.system_setup.git.supported).toBe(false);
    const changed = structuredClone(c.plan); changed.abi.cpu_features = ['lush_impossible_cpu_feature'];
    await expect(c.remote.prepare({ ...c, plan: changed })).rejects.toThrow('evidence changed');
    const official = structuredClone(c.plan); official.runtime.source = 'official-bun';
    await expect(c.remote.prepare({ ...c, plan: official })).rejects.toThrow('runtime provenance');
  } finally { await f.close(); }
});

test('existing dedicated delegation is observed without writes; manager-only, threaded, populated or symlink roots are not adopted (filesystem adapters)', async () => {
  const f = remoteFixture();
  try {
    const root = path.join(f.root, 'sim-cgroup'), candidate = path.join(root, 'delegated-fixture/lush-runner'); fs.mkdirSync(candidate, { recursive: true, mode: 0o700 });
    for (const [name, bytes] of Object.entries({ 'cgroup.type': 'domain\n', 'cgroup.procs': '', 'cgroup.kill': '', 'cgroup.events': 'populated 0\n' })) fs.writeFileSync(path.join(candidate, name), bytes, { mode: 0o600 });
    fs.writeFileSync(path.join(f.bin, 'systemctl'), '#!/bin/sh\ncase "$*" in *--version*) echo "systemd 254 (fixture)";; *--property=ControlGroup*) echo /delegated-fixture;; *--property=Delegate*) echo yes;; *) exit 1;; esac\n', { mode: 0o700 });
    fs.writeFileSync(path.join(f.bin, 'stat'), '#!/bin/sh\nif [ "$1" = -f ]; then echo 63677270; else exec /usr/bin/stat "$@"; fi\n', { mode: 0o700 });
    f.hook(() => ({ probe_cgroup: true })); const r = f.remote(), id = randomUUID(), before = tree(root);
    const probe = await r.probe({ id, abi: f.abi }); expect(probe.cgroup).toMatchObject({ status: 'ready', path: '/sys/fs/cgroup/delegated-fixture/lush-runner', evidence: { unit: `user@${process.getuid()}.service`, control_group: '/delegated-fixture' } }); expect(tree(root)).toEqual(before);
    fs.writeFileSync(path.join(candidate, 'cgroup.type'), 'threaded\n'); expect((await r.probe({ id, abi: f.abi })).cgroup.status).toBe('needs_setup');
    fs.writeFileSync(path.join(candidate, 'cgroup.type'), 'domain\n'); fs.writeFileSync(path.join(candidate, 'cgroup.events'), 'populated 1\n'); expect((await r.probe({ id, abi: f.abi })).cgroup.status).toBe('needs_setup');
    fs.renameSync(candidate, candidate + '-original'); fs.symlinkSync(candidate + '-original', candidate); expect((await r.probe({ id, abi: f.abi })).cgroup.status).toBe('needs_setup');
  } finally { await f.close(); }
});

test('read-only privilege observation asks for the fixed installer executable, never generic root shell permission', async () => {
  const f = remoteFixture();
  try {
    fs.writeFileSync(path.join(f.bin, 'sudo'), '#!/bin/sh\n[ "$*" = "-n -l /usr/bin/systemd-run" ]\n', { mode: 0o700 });
    expect((await f.remote().probe({ id: randomUUID(), abi: f.abi })).system.sudo_n).toBe(true);
    expect(fs.readdirSync(f.home)).toEqual([]);
  } finally { await f.close(); }
});

test('managed deployment never executes uploaded Bun/source as root, even for an explicitly selected root SSH account', async () => {
  const f = remoteFixture();
  try {
    const c = await f.plan(), plan = structuredClone(c.plan); plan.target.uid = 0; plan.target.user = 'root'; const count = f.records.length;
    await expect(c.remote.prepare({ ...c, plan })).rejects.toThrow('installation target'); expect(f.records).toHaveLength(count);
    expect(() => buildDeploymentSystemPlan({ id: c.id, target: plan.target, system: { systemd: 254, system_tools: true, sleep_path: '/usr/bin/sleep' } })).toThrow('system specification');
    expect(await remoteRuntime({ ...requestOf(c), plan, operation: 'runner' })).toMatchObject({ ok: false });
    expect(fs.readdirSync(f.home)).toEqual([]);
  } finally { await f.close(); }
});

test('reviewed official profile observes every CPU, native ELF loader/libraries, glibc/kernel minimum and binds actual library drift (controlled filesystem)', async () => {
  const f = remoteFixture();
  try {
    const c = await f.plan(), fixture = officialFixture(f), abi = officialAbi();
    const probe = await c.remote.probe({ id: c.id, abi }); expect(probe.abi.status).toBe('ready'); expect(probe.remote.abi_observed_sha256).toMatch(/^[a-f0-9]{64}$/);
    Object.assign(c.plan, { abi, remote: probe.remote, runtime: officialRuntime() });
    expect(await c.remote.prepare(c)).toMatchObject({ ok: true });
    fs.appendFileSync(fixture.libs[0], 'library changed after probe');
    await expect(c.remote.inspect(c)).rejects.toMatchObject({ code: 'identity_changed' });
    for (const [name, source] of [['getconf', 'echo "glibc 2.16"'], ['uname', '[ "$1" != -r ] || { echo 3.9.0; exit 0; }; exec /usr/bin/uname "$@"'], ['ldconfig', 'exit 0']]) {
      const original = fs.readFileSync(path.join(f.bin, name)); fixture.write(name, source);
      expect((await c.remote.probe({ id: c.id, abi })).abi.status).toBe('unsupported'); fs.writeFileSync(path.join(f.bin, name), original);
    }
    fs.writeFileSync(fixture.cpu, 'flags : sse4_2\nflags : missing\n'); expect((await c.remote.probe({ id: c.id, abi })).abi.status).toBe('unsupported');
    fs.writeFileSync(fixture.cpu, 'flags : sse4_2\n'); fs.writeFileSync(fixture.loader, 'not ELF'); expect((await c.remote.probe({ id: c.id, abi })).abi.status).toBe('unsupported');
  } finally { await f.close(); }
});

test('official profile cannot authorize arbitrary bytes, a mixed central source, unknown policy fields or unsupported profile', async () => {
  const f = remoteFixture();
  try {
    const c = await f.plan(), fixture = officialFixture(f), abi = officialAbi(), p = await c.remote.probe({ id: c.id, abi });
    Object.assign(c.plan, { abi, remote: p.remote, runtime: officialRuntime() });
    for (const change of [{ source: 'central-bun' }, { version: 'latest' }, { sha256: '1'.repeat(64) }, { size: 1 }, { arch: 'arm64' }]) {
      const before = f.records.length; await expect(c.remote.prepare({ ...c, plan: { ...c.plan, runtime: { ...c.plan.runtime, ...change } } })).rejects.toThrow('runtime provenance'); expect(f.records.length).toBe(before);
    }
    for (const extra of [{ profile: 'unknown' }, { kernel_min_version: '1.0' }, { cpu_features: [] }, { files: f.abi.files }, { arbitrary: true }]) expect(() => validateDeploymentAbi({ ...abi, ...extra })).toThrow('ABI profile');
    expect(fs.readdirSync(f.home)).toEqual([]); expect(fixture.libs).toHaveLength(4);
    expect(validateDeploymentAbi(packagedOfficialAbi())).toEqual([]);
    expect(c.remote.describe(c, {install_root:c.plan.install_root,manifest_sha256:'a'.repeat(64),node_id:randomUUID(),root_identity:'1:2',config_file:c.plan.install_root+'/config.json',root:c.plan.install_root+'/workspaces',cgroup_root:c.plan.cgroup.path,cgroup_evidence:c.plan.cgroup.evidence}).remote.abi_observed_sha256).toBe(p.remote.abi_observed_sha256);
  } finally { await f.close(); }
});

test('delivered bundle preserves root-ownership ABI gate and full archive/config/current command-ID seal contract (isolated stage and cgroup adapters)', async () => {
  const f = remoteFixture(); let bundle;
  try {
    bundle = await buildDeploymentArtifacts({destination:f.root});
    expect(bundle.runtime.abi.supported).toBe(true);
    const r=f.remote(), id=randomUUID(), abi=bundle.runtime.abi, probe=await r.probe({id,abi});
    // The package producer permits a central account-owned Nix store; deployment
    // deliberately does not bless account-owned target libraries as root-trusted.
    const rootOwned=abi.files.every(row=>fs.statSync(row.path).uid===0); expect(probe.abi.status).toBe(rootOwned?'ready':'unsupported');
    const c = await f.plan(r,{runtime:bundle.runtime,runner:bundle.runner,files:bundle.files});
    await r.prepare(c); fakeRuntimeEvidence(c); fs.copyFileSync(bundle.runtime.file,c.plan.install_root+'/bun'); fs.chmodSync(c.plan.install_root+'/bun',0o700);
    expect(await remoteRuntime({...requestOf(c),operation:'runner',artifact:{...bundle.runner,files:bundle.files}},{payload:fs.readFileSync(bundle.runner.file)})).toMatchObject({ok:true});
    expect(fs.readFileSync(c.plan.install_root+'/runner/src/runner/command-child.js')).toEqual(fs.readFileSync(new URL('../src/runner/command-child.js',import.meta.url)));
    const config={version:1,node_id:randomUUID(),root:c.plan.install_root+'/workspaces',cgroup_root:c.plan.cgroup.path,machine_token_hash:'1'.repeat(64),projects:{fixture:{control_token_hash:'2'.repeat(64)}}};
    const configured=await remoteRuntime({...requestOf(c),operation:'configure',node_config:config},{verifyCgroup:()=>true}); expect(configured.ok).toBe(true);
    const described=r.describe(c,configured.managed); expect(validateDeploymentAbi(bundle.runtime.abi)).toEqual(abi.files.map(({path,realpath,sha256,size})=>({path,realpath,sha256,size}))); expect(managedRunnerCommand(described)).toContain('/proc/self/fd/9');
    const proof={node_id:config.node_id,runner_id:randomUUID(),execution_id:'cmd-'+protocolHash(`fixture:${randomUUID()}`),stopped:true,verified_at:new Date().toISOString()};
    expect(await remoteRuntime({...requestOf(c),operation:'seal',proof},{verifyCgroup:()=>true})).toMatchObject({ok:true});
    const before=tree(f.home); expect(await remoteRuntime({...requestOf(c),operation:'inspect'},{verifyCgroup:()=>true})).toMatchObject({sealed:true,integrity:'verified'}); expect(tree(f.home)).toEqual(before);
    expect(JSON.stringify(f.records)).not.toContain(config.machine_token_hash);
  } finally {try {bundle?.cleanup();} finally {await f.close();}}
});
