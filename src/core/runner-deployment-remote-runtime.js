import { deploymentSystemSpecification } from './runner-deployment-remote-system.js';
import { deploymentAbiScript } from './runner-deployment-remote-abi.js';
import { deploymentAptScript } from './runner-deployment-remote-apt.js';

/** Self-contained program, hash-pinned in the fixed SSH command and sent over stdin after Bun verification.
 * Adapter functions exist only for isolated tests; no JSON field selects an adapter.
 */
export async function remoteRuntime(request = null, adapters = {}, system_spec = deploymentSystemSpecification, abi_script = deploymentAbiScript, apt_script = deploymentAptScript) {
  const fs = await import('node:fs'), crypto = await import('node:crypto'), cp = await import('node:child_process');
  const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const HEX = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
  const safe = value => typeof value === 'string' && /^[A-Za-z0-9_./+-]+$/.test(value) && !value.split('/').some(part => !part || part === '.' || part === '..');
  const assert = (condition, code = 'identity_changed') => { if (!condition) throw Object.assign(new Error('Remote deployment refused'), { code }); };
  let rootfd, lockfd, ffi, flock, started = false, stage, stagesIdentity;
  let input = Buffer.alloc(0);
  try {
    if (!request) {
      const chunks = []; let size = 0;
      for await (const chunk of process.stdin) { size += chunk.length; assert(size <= 16 * 1024 * 1024 + 131072, 'config_invalid'); chunks.push(chunk); }
      input = Buffer.concat(chunks); const newline = input.indexOf(10);
      assert(newline > 0 && newline <= 131072, 'config_invalid'); request = JSON.parse(input.subarray(0, newline).toString()); input = input.subarray(newline + 1);
    } else if (adapters.payload) input = adapters.payload;
    const { id, plan, plan_sha256, operation } = request;
    assert(UUID.test(id) && HEX.test(plan_sha256) && plan && plan.target && plan.remote, 'config_invalid');
    assert(['runner', 'configure', 'inspect', 'seal', 'git_install', 'cgroup_setup'].includes(operation), 'config_invalid'); stage = operation;
    const t = plan.target, r = plan.remote, root = `${t.home}/.local/share/lush-runner/managed/${id}`;
    assert(plan.install_root === root && t.os === 'linux' && ['x64', 'arm64'].includes(t.arch) && Number.isSafeInteger(t.uid) && t.uid > 0);
    assert(HEX.test(r.machine_id) && HEX.test(r.boot_id) && /^[0-9]+$/.test(r.home_dev) && /^[0-9]+$/.test(r.home_ino));
    const prefix = [id, plan_sha256, r.machine_id, r.boot_id, t.uid, r.home_dev, r.home_ino].join(':');
    const identity = stat => `${stat.dev}:${stat.ino}`;
    const fdpath = (fd, name = '') => `/proc/self/fd/${fd}${name ? '/' + name : ''}`;
    const directory = absolute => {
      assert(typeof absolute === 'string' && absolute.startsWith('/') && safe(absolute.slice(1)));
      let fd = fs.openSync('/', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try {
        for (const part of absolute.slice(1).split('/')) {
          const next = fs.openSync(fdpath(fd, part), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
          const s = fs.fstatSync(next); assert(s.isDirectory() && [0, t.uid].includes(s.uid));
          assert((s.mode & 0o022) === 0 || s.uid === 0 && (s.mode & 0o1777) === 0o1777);
          fs.closeSync(fd); fd = next;
        }
        assert(fs.realpathSync(absolute) === absolute && identity(fs.statSync(absolute)) === identity(fs.fstatSync(fd)));
        return fd;
      } catch (error) { fs.closeSync(fd); throw error; }
    };
    const parent = name => {
      assert(safe(name)); const parts = name.split('/'), basename = parts.pop();
      let fd = fs.openSync(fdpath(rootfd), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      try {
        for (const part of parts) {
          const next = fs.openSync(fdpath(fd, part), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
          const stat = fs.fstatSync(next); if (!(stat.uid === t.uid && (stat.mode & 0o7777) === 0o700) || part === 'stages' && stagesIdentity && identity(stat) !== stagesIdentity) { fs.closeSync(next); assert(false); } fs.closeSync(fd); fd = next;
        }
        return { fd, basename };
      } catch (error) { fs.closeSync(fd); throw error; }
    };
    const read = (name, max = 131072, mode = 0o600) => {
      const p = parent(name); let fd;
      try {
        fd = fs.openSync(fdpath(p.fd, p.basename), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const stat = fs.fstatSync(fd); assert(stat.isFile() && stat.uid === t.uid && (stat.mode & 0o7777) === mode && stat.nlink === 1 && stat.size <= max);
        const bytes = fs.readFileSync(fd); assert(bytes.length === stat.size && identity(fs.lstatSync(fdpath(p.fd, p.basename))) === identity(stat)); return bytes;
      } finally { if (fd !== undefined) fs.closeSync(fd); fs.closeSync(p.fd); }
    };
    const exists = name => { try { fs.lstatSync(fdpath(rootfd, name)); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
    const unchanged = () => {
      const current = directory(root); try { assert(identity(fs.fstatSync(current)) === identity(fs.fstatSync(rootfd))); } finally { fs.closeSync(current); }
    };
    const write = (name, value, mode = 0o600) => {
      unchanged(); const p = parent(name); let fd;
      try {
        fd = fs.openSync(fdpath(p.fd, p.basename), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
        const stat = fs.fstatSync(fd); assert(stat.isFile() && stat.nlink === 1 && stat.uid === t.uid);
        fs.writeFileSync(fd, value); fs.fsyncSync(fd); assert(identity(fs.lstatSync(fdpath(p.fd, p.basename))) === identity(stat)); unchanged(); fs.fsyncSync(p.fd);
      } finally { if (fd !== undefined) fs.closeSync(fd); fs.closeSync(p.fd); }
      fs.fsyncSync(rootfd);
    };
    const mkdir = name => {
      unchanged(); const p = parent(name);
      try { fs.mkdirSync(fdpath(p.fd, p.basename), { mode: 0o700 }); const fd = directory(`${root}/${name}`); fs.closeSync(fd); fs.fsyncSync(p.fd); }
      finally { fs.closeSync(p.fd); }
    };
    rootfd = directory(root); const rs = fs.fstatSync(rootfd); assert(rs.uid === t.uid && (rs.mode & 0o7777) === 0o700);
    stagesIdentity = identity(fs.lstatSync(fdpath(rootfd, 'stages')));
    assert(read('receipt', 2048).toString().trimEnd() === `${prefix}:${identity(rs)}:${stagesIdentity}:${identity(fs.lstatSync(fdpath(rootfd, 'execution-lock')))}`);
    const homefd = directory(t.home);
    try { assert(identity(fs.fstatSync(homefd)) === `${r.home_dev}:${r.home_ino}`); } finally { fs.closeSync(homefd); }
    if (adapters.observe) assert(await adapters.observe(plan));
    else {
      assert(process.platform === 'linux' && process.arch === t.arch && process.getuid() === t.uid);
      assert(digest(fs.readFileSync('/etc/machine-id')) === r.machine_id && digest(fs.readFileSync('/proc/sys/kernel/random/boot_id')) === r.boot_id);
      assert(Array.isArray(plan.abi.cpu_features) && plan.abi.cpu_features.length > 0, 'unsupported');
      const cores = [...fs.readFileSync('/proc/cpuinfo', 'utf8').matchAll(/^(?:flags|Features)\s*:\s*(.*)$/gm)].map(match => new Set(match[1].trim().toLowerCase().split(/\s+/)));
      assert(cores.length > 0 && cores.every(core => plan.abi.cpu_features.every(flag => core.has(flag))), 'identity_changed');
      if (plan.abi.profile) {
        const output = cp.execFileSync('/bin/sh', ['-c', abi_script(plan.abi) + '\nprintf "%s:%s" "$abi_ready" "$abi_observed_sha256"'], { env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000, maxBuffer: 4096 });
        assert(output.toString() === '1:' + r.abi_observed_sha256, 'identity_changed');
      } else for (const row of plan.abi.files) { const s = fs.statSync(row.path); assert(s.uid === 0 && (s.mode & 0o022) === 0 && fs.realpathSync(row.path) === row.realpath && s.size === row.size && digest(fs.readFileSync(row.path)) === row.sha256); }
    }
    // Kernel lock: no stale PID guessing. Inspect opens the precreated file read-only.
    lockfd = fs.openSync(fdpath(rootfd, 'execution-lock'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const lockstat = fs.fstatSync(lockfd); assert(lockstat.isFile() && lockstat.uid === t.uid && (lockstat.mode & 0o7777) === 0o600 && lockstat.nlink === 1);
    assert(read('receipt', 2048).toString().trimEnd() === `${prefix}:${identity(rs)}:${stagesIdentity}:${identity(lockstat)}`);
    const bunffi = await import('bun:ffi');
    for (const library of ['libc.so.6', 'libc.musl-x86_64.so.1', 'libc.musl-aarch64.so.1']) {
      try { ffi = bunffi.dlopen(library, { flock: { args: ['i32', 'i32'], returns: 'i32' } }); break; } catch {}
    }
    assert(ffi, 'unsupported'); flock = ffi.symbols.flock; assert(flock(lockfd, operation === 'inspect' ? 5 : 6) === 0, 'busy');
    const global = directory(`${t.home}/.lush-runner-deployment.lock`);
    try {
      const owner = fs.openSync(fdpath(global, 'owner'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { const s = fs.fstatSync(owner); assert(s.isFile() && s.uid === t.uid && (s.mode & 0o7777) === 0o600 && s.nlink === 1 && s.size <= 2048 && fs.readFileSync(owner, 'utf8').trimEnd() === prefix); }
      finally { fs.closeSync(owner); }
    } finally { fs.closeSync(global); }
    const stagesfd = directory(`${root}/stages`); fs.closeSync(stagesfd);
    const stages = ['prepare', 'runtime', 'runner', 'git_install', 'cgroup_setup', 'configure', 'seal'];
    const evidence = name => {
      const result = { stage: name, status: 'not_started' };
      if (exists(`stages/${name}.started`)) result.status = 'unknown';
      if (exists(`stages/${name}.done`)) result.status = 'done';
      if (exists(`stages/${name}.failed`)) result.status = 'failed';
      for (const suffix of ['started', 'done', 'failed']) if (exists(`stages/${name}.${suffix}`)) {
        const bytes = read(`stages/${name}.${suffix}`);
        if (['prepare', 'runtime'].includes(name)) assert(bytes.toString().trimEnd() === prefix);
        else { const record = JSON.parse(bytes); assert(record.id === id && record.plan_sha256 === plan_sha256 && record.stage === name && record.status === suffix); }
      }
      return result;
    };
    const done = name => assert(evidence(name).status === 'done', 'stage_failed');
    const runFixed = async (command, args) => {
      const spawn = adapters.spawn_process || cp.spawn;
      return await new Promise((resolve, reject) => {
        let child, size = 0, stderr = 0, chunks = [], failure = false;
        try { child = spawn(command, args, { env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C', HOME: t.home, USER: t.user, LOGNAME: t.user }, stdio: ['ignore', 'pipe', 'pipe'] }); }
        catch { reject(Object.assign(new Error('System action unknown'), { code: 'not_confirmed', unknown: true })); return; }
        const timer = setTimeout(() => { failure = true; child.kill('SIGKILL'); }, 105000);
        child.stdout.on('data', chunk => { size += chunk.length; if (size > 16384) { failure = true; child.kill('SIGKILL'); } else chunks.push(chunk); });
        child.stderr.on('data', chunk => { stderr += chunk.length; if (stderr > 16384) { failure = true; child.kill('SIGKILL'); } });
        child.once('error', () => { failure = true; });
        child.once('close', code => { clearTimeout(timer); if (failure) reject(Object.assign(new Error('System action unknown'), { code: 'not_confirmed', unknown: true })); else resolve({ code, output: Buffer.concat(chunks).toString('utf8') }); });
      });
    };
    const specification = () => {
      assert(plan.system && plan.system.systemd >= 250 && plan.system.system_tools && plan.system_setup, 'unsupported');
      const spec = system_spec({ id, uid: t.uid, sleep_path: plan.system.sleep_path, git_candidate: plan.system.git_candidate || null, git_transaction: plan.system.git_transaction }, apt_script, digest);
      assert(JSON.stringify(plan.system_setup) === JSON.stringify(spec.plan), 'identity_changed'); return spec;
    };
    const unitProperties = async unit => {
      const command = plan.actions.some(a => a.id === 'cgroup_setup') ? '/usr/bin/systemctl' : plan.cgroup.evidence?.systemctl_path || '/usr/bin/systemctl';
      assert(['/usr/bin/systemctl', '/bin/systemctl', '/run/current-system/sw/bin/systemctl'].includes(command), 'identity_changed');
      const answer = await runFixed(command, ['show', unit, '--no-pager', '--property=LoadState,ActiveState,SubState,FragmentPath,User,Delegate,DelegateSubgroup,ControlGroup,MainPID,DropInPaths,ExecStart,Type,ExitType,KillMode,Result,InvocationID,ExecMainCode,ExecMainStatus,ExecMainStartTimestampMonotonic,ExecMainExitTimestampMonotonic']);
      const props = {};
      for (const line of answer.output.trim().split('\n')) { const i = line.indexOf('='); if (i < 1) continue; const key = line.slice(0, i); assert(!Object.hasOwn(props, key), 'identity_changed'); props[key] = line.slice(i + 1); }
      assert(props.LoadState, 'not_confirmed'); return props;
    };
    const unitContent = async unit => {
      if (adapters.readUnit) return await adapters.readUnit(unit);
      let fd;
      try {
        fd = fs.openSync(unit.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); const s = fs.fstatSync(fd);
        assert(s.isFile() && s.uid === 0 && (s.mode & 0o7777) === 0o644 && s.nlink === 1 && s.size < 4096 && fs.realpathSync(unit.path) === unit.path, 'identity_changed');
        return digest(fs.readFileSync(fd));
      } finally { if (fd !== undefined) fs.closeSync(fd); }
    };
    const verifiedUnit = async () => {
      const spec = specification(), u = plan.system_setup.unit, props = await unitProperties(u.name);
      assert(props.LoadState === 'loaded' && props.ActiveState === 'active' && props.FragmentPath === u.path && props.User === String(t.uid) && props.Delegate === 'yes' && props.DelegateSubgroup === 'supervisor' && !props.DropInPaths, 'identity_changed');
      assert(props.ExecStart?.includes(`path=${u.sleep_path} ;`) && props.ExecStart.includes(`argv[]=${u.sleep_path} infinity ;`) && (props.ExecStart.match(/\{/g) || []).length === 1, 'identity_changed');
      assert(await unitContent(u) === digest(spec.unit_text), 'identity_changed');
      assert(typeof props.ControlGroup === 'string' && /^\/[A-Za-z0-9_./@:-]+$/.test(props.ControlGroup) && props.ControlGroup !== '/' && !props.ControlGroup.includes('..') && !props.ControlGroup.includes('//') && !props.ControlGroup.endsWith('/'), 'identity_changed');
      return props;
    };
    const verifyCgroup = async (cg, empty = true) => {
      assert(cg && cg.path && cg.evidence && cg.evidence.boot_id === r.boot_id, 'identity_changed');
      if (adapters.verifyCgroup) { assert(await adapters.verifyCgroup(cg.path, cg.evidence, empty), 'identity_changed'); return; }
      const e = cg.evidence;
      assert(cg.path.startsWith('/sys/fs/cgroup/') && fs.realpathSync(cg.path) === cg.path, 'identity_changed');
      const fd = directory(cg.path);
      try {
        const s = fs.fstatSync(fd); assert(s.uid === t.uid && String(s.dev) === e.dev && String(s.ino) === e.ino && Number(fs.statfsSync(fdpath(fd)).type) === 0x63677270, 'identity_changed');
        assert(fs.readFileSync(fdpath(fd, 'cgroup.type'), 'utf8').trim() === 'domain', 'unsupported');
        if (empty) assert(fs.readFileSync(fdpath(fd, 'cgroup.procs'), 'utf8').trim() === '' && /^populated 0$/m.test(fs.readFileSync(fdpath(fd, 'cgroup.events'), 'utf8')), 'stage_failed');
        fs.accessSync(fdpath(fd), fs.constants.W_OK | fs.constants.X_OK); fs.accessSync(fdpath(fd, 'cgroup.kill'), fs.constants.W_OK); fs.accessSync(fdpath(fd, 'cgroup.procs'), fs.constants.W_OK);
      } finally { fs.closeSync(fd); }
      if (plan.actions.some(a => a.id === 'cgroup_setup')) {
        const props = await verifiedUnit(); assert(props.ControlGroup === e.control_group && e.unit === plan.system_setup.unit.name && e.delegated_parent === '/sys/fs/cgroup' + props.ControlGroup && cg.path === e.delegated_parent + '/runner', 'identity_changed');
        const p = directory(e.delegated_parent); try { assert(identity(fs.fstatSync(p)) === `${e.parent_dev}:${e.parent_ino}`, 'identity_changed'); } finally { fs.closeSync(p); }
      } else {
        assert(e.unit === `user@${t.uid}.service` && e.delegated_parent === '/sys/fs/cgroup' + e.control_group && cg.path === e.delegated_parent + '/lush-runner', 'identity_changed');
        const props = await unitProperties(e.unit); assert(props.Delegate === 'yes' && props.ControlGroup === e.control_group, 'identity_changed');
      }
    };
    const chosenCgroup = () => plan.actions.some(a => a.id === 'cgroup_setup') ? JSON.parse(read('stages/cgroup_setup.done')).result.cgroup : plan.cgroup;
    const verifyFiles = async () => {
      const manifest = JSON.parse(read('manifest.json', 1024 * 1024));
      assert(manifest.version === 1 && manifest.id === id && manifest.plan_sha256 === plan_sha256 && Array.isArray(manifest.files) && manifest.files.length <= 2048);
      for (const row of manifest.files) assert(HEX.test(row.sha256) && read(row.path, row.size, row.mode).length === row.size && digest(read(row.path, row.size, row.mode)) === row.sha256, 'artifact_changed');
      await verifyCgroup(manifest.cgroup, false); return manifest;
    };
    const installerEvidence = async () => {
      const spec = specification(), meta = plan.system_setup.git_install, p = await unitProperties(meta.unit_name);
      if (p.LoadState === 'not-found') return { unit: meta.unit_name, tree_stopped: false, success: false, state: 'not-found' };
      assert(p.LoadState === 'loaded' && p.FragmentPath === meta.unit_path && p.User === '0' && p.Type === 'exec' && p.ExitType === 'cgroup' && p.KillMode === 'control-group' && !p.DropInPaths, 'identity_changed');
      if (adapters.readInstallerUnit) assert(await adapters.readInstallerUnit() === meta.unit_sha256);
      else { const fd = fs.openSync(meta.unit_path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); try { const s = fs.fstatSync(fd); assert(s.isFile() && s.uid === 0 && s.nlink === 1 && (s.mode & 0o7777) === 0o644 && s.size <= 131072 && digest(fs.readFileSync(fd)) === meta.unit_sha256); } finally { fs.closeSync(fd); } }
      let recorded = null;
      if (adapters.readInstallerObservation) recorded = await adapters.readInstallerObservation();
      else {
        let fd;
        try { fd = fs.openSync(meta.observation_path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); const s = fs.fstatSync(fd); assert(s.isFile() && s.uid === 0 && s.nlink === 1 && (s.mode & 0o7777) === 0o644 && s.size <= 2048); recorded = fs.readFileSync(fd, 'utf8'); }
        catch (e) { if (e.code !== 'ENOENT') throw e; } finally { if (fd !== undefined) fs.closeSync(fd); }
      }
      let original = null;
      if (recorded !== null) { const rows = recorded.trimEnd().split('\n'); assert(rows.length === 5 && rows[0] === id && rows[1] === meta.unit_name && /^[a-f0-9]{32}$/.test(rows[2]) && rows[3] === meta.transaction.solution_sha256 && rows[4] === 'systemctl-wait-exit-type-cgroup'); original = rows[2]; }
      const invoked = /^[a-f0-9]{32}$/.test(p.InvocationID) && /^[1-9][0-9]*$/.test(p.ExecMainStartTimestampMonotonic) && /^[1-9][0-9]*$/.test(p.ExecMainExitTimestampMonotonic) && BigInt(p.ExecMainExitTimestampMonotonic) >= BigInt(p.ExecMainStartTimestampMonotonic);
      const stopped = (original !== null || invoked) && p.ActiveState === 'inactive' && p.SubState === 'dead' && p.MainPID === '0' && p.ControlGroup === '';
      return { unit: meta.unit_name, invocation_id: original || (invoked ? p.InvocationID : null), barrier: original ? 'systemctl-wait-exit-type-cgroup' : 'manager-exit-type-cgroup', tree_stopped: stopped, success: stopped && (original !== null || p.Result === 'success' && p.ExecMainCode === '1' && p.ExecMainStatus === '0'), state: ['active', 'inactive', 'failed', 'activating', 'deactivating'].includes(p.ActiveState) ? p.ActiveState : 'unknown' };
    };
    const record = (status, value = {}) => write(`stages/${stage}.${status}`, JSON.stringify({ version: 1, id, plan_sha256, stage, status, ...value }) + '\n');
    if (operation === 'inspect') {
      const result = { ok: true, id, stage: 'inspect', stages: stages.map(evidence), integrity: 'not_configured', sealed: false };
      if (evidence('configure').status === 'done') { await verifyFiles(); result.integrity = 'verified'; result.managed = JSON.parse(read('stages/configure.done')).result.managed; }
      if (evidence('seal').status === 'done') { assert(exists('sealed')); result.sealed = true; }
      if (evidence('cgroup_setup').status === 'done') { result.cgroup = chosenCgroup(); await verifyCgroup(result.cgroup, false); }
      else if (evidence('cgroup_setup').status !== 'not_started') { const props = await unitProperties(plan.system_setup.unit.name); result.system = { unit: plan.system_setup.unit.name, load_state: ['loaded', 'not-found', 'error'].includes(props.LoadState) ? props.LoadState : 'unknown', active: props.ActiveState === 'active' }; }
      if (plan.system_setup?.git_install && evidence('git_install').status !== 'not_started') result.installer = await installerEvidence();
      return result;
    }
    assert(!exists('sealed'), 'already_exists'); assert(evidence(stage).status === 'not_started', 'stage_already_started');
    done('runtime'); if (operation !== 'runner') done('runner');
    // Only complete approved new-package transactions may enter the installer.
    // Root rechecks and a final archive gate defend the solver/execution gap.
    if (['git_install', 'cgroup_setup'].includes(operation)) assert(plan.actions.some(a => a.id === operation), 'config_invalid');
    if (operation === 'git_install') assert(plan.system_setup?.git_install?.transaction?.supported === true && plan.system.git_transaction.architecture === (t.arch === 'x64' ? 'amd64' : 'arm64'), 'unsupported');
    record('started'); started = true;
    let result;
    if (operation === 'runner') {
      const a = request.artifact;
      assert(a && Number.isSafeInteger(a.size) && a.size > 0 && a.size <= 16 * 1024 * 1024 && HEX.test(a.sha256), 'config_invalid');
      assert(input.length === a.size && digest(input) === a.sha256 && a.sha256 === plan.runner.sha256 && a.size === plan.runner.size, 'artifact_changed');
      assert(Array.isArray(a.files) && a.files.length > 0 && a.files.length <= 2048 && new Set(a.files).size === a.files.length && a.files.every(safe), 'config_invalid');
      const expected = new Set(a.files), entries = [], paths = new Set(); let offset = 0, ended = false;
      const ascii = bytes => { assert(bytes.every(x => x === 0 || x >= 32 && x <= 126), 'artifact_changed'); return bytes.toString('ascii').replace(/\0.*$/, ''); };
      const octal = bytes => { const s = ascii(bytes).trim(); assert(/^[0-7]+$/.test(s), 'artifact_changed'); return parseInt(s, 8); };
      while (offset + 512 <= input.length) {
        const header = input.subarray(offset, offset + 512); offset += 512;
        if (header.every(x => x === 0)) { assert(input.subarray(offset).every(x => x === 0), 'artifact_changed'); ended = true; break; }
        const checksum = octal(header.subarray(148, 156)); let sum = 0;
        for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i]; assert(sum === checksum, 'artifact_changed');
        assert(ascii(header.subarray(257, 263)) === 'ustar', 'artifact_changed');
        let name = ascii(header.subarray(0, 100)), prefix = ascii(header.subarray(345, 500)); if (prefix) name = prefix + '/' + name;
        const type = header[156], size = octal(header.subarray(124, 136));
        assert(type === 0 || type === 48 || type === 53, 'artifact_changed');
        if (type === 53) name = name.replace(/\/$/, '');
        assert(safe(name) && !paths.has(name) && ascii(header.subarray(157, 257)) === '' && offset + size <= input.length, 'artifact_changed'); paths.add(name);
        assert(type !== 53 || size === 0, 'artifact_changed');
        if (type !== 53) { assert(expected.delete(name), 'artifact_changed'); entries.push({ name, bytes: input.subarray(offset, offset + size) }); }
        offset += Math.ceil(size / 512) * 512;
      }
      assert(ended && expected.size === 0 && entries.length === a.files.length && entries.some(e => e.name === 'bin/lush-runner') && entries.some(e => e.name === 'src/runner/index.js'), 'artifact_changed');
      // No filesystem writes from the archive until its complete structure is validated.
      mkdir('runner'); const made = new Set(['runner']);
      for (const entry of entries) {
        const parts = entry.name.split('/'); let dir = 'runner';
        for (const part of parts.slice(0, -1)) { dir += '/' + part; if (!made.has(dir)) { mkdir(dir); made.add(dir); } }
        write('runner/' + entry.name, entry.bytes, 0o600);
      }
      write('runner-artifact.json', JSON.stringify({ sha256: a.sha256, size: a.size, files: entries.map(e => ({ path: 'runner/' + e.name, sha256: digest(e.bytes), size: e.bytes.length, mode: 0o600 })) }) + '\n');
      result = { ok: true, stage, sha256: a.sha256, size: a.size };
    } else if (operation === 'configure') {
      for (const action of plan.actions || []) if (['git_install', 'cgroup_setup'].includes(action.id)) done(action.id);
      const config = request.node_config, keys = ['version', 'node_id', 'root', 'cgroup_root', 'machine_token_hash', 'projects', 'budgets', 'max_commands', 'memory_reserve_bytes', 'output_storage_bytes'];
      assert(config && Object.keys(config).every(key => keys.includes(key)) && config.version === 1 && UUID.test(config.node_id) && config.root === `${root}/workspaces` && HEX.test(config.machine_token_hash), 'config_invalid');
      assert(config.projects && Object.keys(config.projects).length === 1 && Object.entries(config.projects).every(([id, p]) => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id) && p && Object.keys(p).every(k => ['enabled', 'control_token_hash'].includes(k)) && HEX.test(p.control_token_hash) && (p.enabled === undefined || typeof p.enabled === 'boolean')), 'config_invalid');
      const cgroup = chosenCgroup(); assert(config.cgroup_root === cgroup.path, 'config_invalid'); await verifyCgroup(cgroup);
      const configBytes = Buffer.from(JSON.stringify(config) + '\n'); assert(configBytes.length <= 65536, 'config_invalid');
      mkdir('workspaces'); write('config.json', configBytes);
      const bundle = JSON.parse(read('runner-artifact.json'));
      const files = [{ path: 'bun', sha256: plan.runtime.sha256, size: plan.runtime.size, mode: 0o700 }, ...bundle.files, { path: 'config.json', sha256: digest(configBytes), size: configBytes.length, mode: 0o600 }];
      for (const row of files) assert(digest(read(row.path, row.size, row.mode)) === row.sha256, 'artifact_changed');
      write('connection-lease', ''); write('activity-lock', ''); write('activity-epoch', '0\n'); write('recovery-gate', 'none\n'); mkdir('recoveries'); mkdir('runtime-generations');
      const control = Object.fromEntries(Object.entries({lease:'connection-lease',activity_lock:'activity-lock',epoch:'activity-epoch',gate:'recovery-gate',recoveries:'recoveries',generations:'runtime-generations',workspaces:'workspaces',config:'config.json'}).map(([key,name])=>[key,identity(fs.lstatSync(fdpath(rootfd,name)))]));
      const manifest = { version: 1, id, plan_sha256, node_id: config.node_id, cgroup, files, control };
      const manifestBytes = Buffer.from(JSON.stringify(manifest) + '\n'); write('manifest.json', manifestBytes);
      // This description contains no credentials. The parent must verify this manifest
      // plus the SSH snapshot before deriving its production SSH launch command.
      result = { ok: true, stage, managed: { version: 1, install_root: root, manifest_sha256: digest(manifestBytes), runtime_sha256: plan.runtime.sha256, runner_sha256: plan.runner.sha256, node_id: config.node_id, config_file: `${root}/config.json`, root: `${root}/workspaces`, root_identity: identity(rs), cgroup_root: config.cgroup_root, cgroup_evidence: cgroup.evidence, control } };
    } else if (operation === 'seal') {
      done('configure'); const manifest = await verifyFiles(), p = request.proof;
      assert(p && Object.keys(p).every(k => ['node_id', 'runner_id', 'execution_id', 'stopped', 'verified_at'].includes(k)) && p.node_id === manifest.node_id && UUID.test(p.runner_id) && typeof p.execution_id === 'string' && /^cmd-[a-f0-9]{64}$/.test(p.execution_id) && p.stopped === true && typeof p.verified_at === 'string' && /^\d{4}-\d\d-\d\dT[0-9:.]+Z$/.test(p.verified_at), 'config_invalid');
      write('sealed', JSON.stringify({ version: 1, id, plan_sha256, ...p }) + '\n'); result = { ok: true, stage, runner_id: p.runner_id };
    } else {
      assert(plan.actions.some(a => a.id === operation), 'config_invalid');
      const spec = specification(); assert(operation === 'git_install' ? plan.system.sudo_git_n : plan.system.sudo_n, 'privilege_denied');
      if (operation === 'cgroup_setup') assert(plan.system.systemd >= 254, 'unsupported');
      if (!adapters.spawn_process) for (const file of ['/usr/bin/sudo', '/usr/bin/env', '/bin/sh', '/usr/bin/timeout', '/usr/bin/systemd-run', '/usr/bin/systemctl', spec.plan.unit.sleep_path, ...(operation === 'git_install' ? ['/usr/bin/apt-cache', '/usr/bin/apt-get', '/usr/bin/dpkg-query'] : [])]) {
        const s = fs.statSync(file), real = fs.realpathSync(file); assert(s.isFile() && s.uid === 0 && (s.mode & 0o022) === 0 && /^\/(?:usr\/)?s?bin\//.test(real), 'unsupported');
        let parent = real.slice(0, real.lastIndexOf('/'));
        while (parent) { const d = fs.lstatSync(parent); assert(d.isDirectory() && d.uid === 0 && (d.mode & 0o022) === 0, 'unsupported'); parent = parent.slice(0, parent.lastIndexOf('/')); }
      }
      if (!adapters.spawn_process) for (const dir of ['/etc', '/etc/systemd', '/etc/systemd/system']) { const s = fs.lstatSync(dir); assert(s.isDirectory() && s.uid === 0 && (s.mode & 0o022) === 0, 'unsupported'); }
      const version = await runFixed('/usr/bin/systemctl', ['--version']); assert(Number(/^systemd ([0-9]+)/.exec(version.output)?.[1]) === plan.system.systemd, 'identity_changed');
      const installer = spec.plan.installer[operation === 'git_install' ? 'git' : 'cgroup'];
      assert((await unitProperties(installer)).LoadState === 'not-found', 'already_exists');
      if (operation === 'git_install') {
        assert(['debian', 'ubuntu'].includes(plan.system.distro) && spec.git_script, 'unsupported');
        const observation = await runFixed('/usr/bin/env', ['-i', 'PATH=/usr/sbin:/usr/bin:/sbin:/bin', 'LANG=C', 'LC_ALL=C', '/bin/sh', '-c', apt_script()]);
        assert(observation.code === 0 && observation.output.trimEnd() === spec.git_observation, 'identity_changed');
      } else assert((await unitProperties(spec.plan.unit.name)).LoadState === 'not-found', 'already_exists');
      const script = operation === 'git_install' ? spec.git_script : spec.cgroup_script;
      const process = await runFixed('/usr/bin/sudo', operation === 'git_install' ? ['-n', '/usr/bin/timeout', '-k', '5', '110', '/usr/bin/env', '-i', 'PATH=/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL=C', 'LANG=C', '/bin/sh', '-c', script] : ['-n', '/usr/bin/systemd-run', '--system', '--wait', '--collect', '--quiet', '--unit=' + installer, '--property=Type=exec', '--property=ExitType=cgroup', '--property=RuntimeMaxSec=90s', '--property=TimeoutStopSec=5s', '--property=KillMode=control-group', '--', '/usr/bin/env', '-i', 'PATH=/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL=C', 'LANG=C', '/bin/sh', '-c', script]);
      if (process.code !== 0) throw Object.assign(new Error('System action was not confirmed'), { code: 'system_action_failed', unknown: true });
      if (operation === 'git_install') {
        const installed = await runFixed('/usr/bin/dpkg-query', ['-W', '-f=${Version}', 'git']); assert(installed.code === 0 && installed.output.trim() === spec.plan.git.candidate, 'identity_changed');
        const proof = await installerEvidence(); if (!proof.success) throw Object.assign(new Error('Installer tree not confirmed'), { code: 'system_action_failed', unknown: true });
        result = { ok: true, stage, version: spec.plan.git.candidate, installer_unit: installer, installer: proof };
      } else {
        const props = await verifiedUnit(), parent = '/sys/fs/cgroup' + props.ControlGroup;
        let cg;
        if (adapters.bindCgroup) cg = await adapters.bindCgroup(parent, props);
        else {
          const fd = directory(parent);
          try {
            const stat = fs.fstatSync(fd); assert(stat.uid === t.uid && Number(fs.statfsSync(fdpath(fd)).type) === 0x63677270 && fs.readFileSync(fdpath(fd, 'cgroup.type'), 'utf8').trim() === 'domain' && fs.readFileSync(fdpath(fd, 'cgroup.procs'), 'utf8').trim() === '', 'unsupported');
            assert(/^[0-9]+$/.test(props.MainPID) && fs.readFileSync(fdpath(fd, 'supervisor/cgroup.procs'), 'utf8').trim() === props.MainPID && fs.realpathSync('/proc/' + props.MainPID + '/exe') === fs.realpathSync(spec.plan.unit.sleep_path), 'identity_changed');
            const binding = { unit: spec.plan.unit.name, control_group: props.ControlGroup, delegated_parent: parent, parent_dev: String(stat.dev), parent_ino: String(stat.ino), boot_id: r.boot_id,
              fragment_path: spec.plan.unit.path, unit_sha256: plan.system_setup.unit.sha256, sleep_path: spec.plan.unit.sleep_path, systemctl_path: '/usr/bin/systemctl' };
            write('cgroup-binding.json', JSON.stringify(binding) + '\n');
            fs.mkdirSync(fdpath(fd, 'runner'), { mode: 0o700 }); const child = fs.lstatSync(fdpath(fd, 'runner'));
            cg = { path: parent + '/runner', evidence: { ...binding, dev: String(child.dev), ino: String(child.ino) } };
          } finally { fs.closeSync(fd); }
        }
        assert(cg.path === parent + '/runner' && cg.evidence.control_group === props.ControlGroup && cg.evidence.unit === spec.plan.unit.name, 'identity_changed'); await verifyCgroup(cg);
        write('cgroup-evidence.json', JSON.stringify(cg) + '\n'); result = { ok: true, stage, cgroup: cg, installer_unit: installer };
      }
    }
    record('done', { result }); return result;
  } catch (error) {
    const code = ['unsupported', 'identity_changed', 'already_exists', 'busy', 'artifact_changed', 'stage_already_started', 'stage_failed', 'config_invalid', 'privilege_denied', 'system_action_failed'].includes(error.code) ? error.code : 'not_confirmed';
    // A failed process/connection without this final evidence remains unknown.
    if (started && rootfd !== undefined && request && !error.unknown) {
      let fd, directory;
      try {
        directory = fs.openSync(`/proc/self/fd/${rootfd}/stages`, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        const s = fs.fstatSync(directory); assert(`${s.dev}:${s.ino}` === stagesIdentity);
        fd = fs.openSync(`/proc/self/fd/${directory}/${stage}.failed`, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, JSON.stringify({ version: 1, id: request.id, plan_sha256: request.plan_sha256, stage, status: 'failed', code }) + '\n'); fs.fsyncSync(fd); fs.fsyncSync(directory);
      } catch {} finally { if (fd !== undefined) fs.closeSync(fd); if (directory !== undefined) fs.closeSync(directory); }
    }
    return { ok: false, code, unknown: error.unknown === true || code === 'identity_changed' };
  } finally {
    if (flock && lockfd !== undefined) flock(lockfd, 8);
    if (ffi) ffi.close(); if (lockfd !== undefined) fs.closeSync(lockfd); if (rootfd !== undefined) fs.closeSync(rootfd);
  }
}
