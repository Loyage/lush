import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { sshTrialArguments, safeSshAlias } from './runner-ssh.js';
import { deploymentAbiEvidence, deploymentAbiScript, reviewedDeploymentRuntime } from './runner-deployment-remote-abi.js';
import { runtimeControl, controlShell } from './runner-deployment-remote-control.js';

const quote = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;
const assert = value => { if (!value) throw new Error('Managed Runner installation changed or is invalid'); };
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/, HEX = /^[a-f0-9]{64}$/;
export function validateManagedDescription(m) {
  assert(m && m.version === 1 && UUID.test(m.deployment_id));
  for (const key of ['manifest_sha256', 'runtime_sha256', 'runner_sha256', 'plan_sha256', 'ssh_config_sha256']) assert(HEX.test(m[key]));
  assert(m.target && m.remote && m.abi && Number.isSafeInteger(m.target.uid) && m.target.uid > 0 && /^[0-9]+:[0-9]+$/.test(m.root_identity));
  assert(typeof m.target.home === 'string' && /^\/[A-Za-z0-9_./+-]+$/.test(m.target.home) && !m.target.home.includes('..') && !m.target.home.includes('//'));
  assert(m.install_root === `${m.target.home}/.local/share/lush-runner/managed/${m.deployment_id}` && m.root === `${m.install_root}/workspaces` && m.config_file === `${m.install_root}/config.json`);
  assert(Number.isSafeInteger(m.runtime_size) && m.runtime_size > 0 && m.runtime_size <= 256 * 1024 * 1024 && safeSshAlias(m.ssh_alias));
  assert(m.cgroup_evidence && m.cgroup_evidence.boot_id === m.remote.boot_id && typeof m.cgroup_root === 'string' && /^\/sys\/fs\/cgroup\/[A-Za-z0-9_./@:-]+$/.test(m.cgroup_root) && !m.cgroup_root.includes('..') && !m.cgroup_root.includes('//'));
  assert(m.control&&Object.keys(m.control).sort().join()===['lease','activity_lock','epoch','gate','recoveries','generations','workspaces','config'].sort().join()&&Object.values(m.control).every(v=>/^[0-9]+:[0-9]+$/.test(v)),'Managed execution lease is unavailable');
  if(m.runtime_generation){const g=m.runtime_generation;assert(UUID.test(g.recovery_id)&&HEX.test(g.sha256)&&UUID.test(g.publication_id)&&g.generation?.id===g.recovery_id,'Managed runtime generation is invalid');}
  deploymentAbiEvidence(m.abi);
  assert(!m.abi.profile || /^[a-f0-9]{64}$/.test(m.remote.abi_observed_sha256) && reviewedDeploymentRuntime({ source: 'official-bun', version: '1.4.2', sha256: m.runtime_sha256, size: m.runtime_size }, m.abi));
  return m;
}

/** Self-contained startup verifier. It never reads stdin, leaving protocol frames
 * untouched. The optional adapters are test-only and never selected by JSON. */
export async function managedLaunchRuntime(m, adapters = {}, abi_script = deploymentAbiScript, control_runtime = runtimeControl) {
  const control = adapters.control || await control_runtime(m, {mode:adapters.provisional?'provisional':adapters.recover?'inspect':'normal',held_fd:adapters.held_fd ?? null,...(adapters.provisional || {})});
  try {
  const fs = await import('node:fs'), crypto = await import('node:crypto'), url = await import('node:url');
  const assert = value => { if (!value) throw new Error('Managed Runner integrity verification failed'); };
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const identity = s => `${s.dev}:${s.ino}`;
  const openDirectory = absolute => {
    assert(typeof absolute === 'string' && absolute.startsWith('/') && !absolute.endsWith('/') && !absolute.includes('//') && absolute.split('/').slice(1).every(part => part && !['.', '..'].includes(part)));
    let fd = fs.openSync('/', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      for (const part of absolute.slice(1).split('/')) {
        const next = fs.openSync(`/proc/self/fd/${fd}/${part}`, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        const stat = fs.fstatSync(next);
        if (![0, m.target.uid].includes(stat.uid) || (stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1777) === 0o1777)) { fs.closeSync(next); assert(false); }
        fs.closeSync(fd); fd = next;
      }
      assert(fs.realpathSync(absolute) === absolute && identity(fs.statSync(absolute)) === identity(fs.fstatSync(fd))); return fd;
    } catch (error) { fs.closeSync(fd); throw error; }
  };
  const read = (name, size, mode = 0o600) => {
    assert(typeof name === 'string' && /^[A-Za-z0-9_.+-]+(?:\/[A-Za-z0-9_.+-]+)*$/.test(name) && !name.split('/').some(p => ['.', '..'].includes(p)) && Number.isSafeInteger(size) && size >= 0 && size <= 256 * 1024 * 1024);
    const parts = name.split('/'), basename = parts.pop(), parent = m.install_root + (parts.length ? '/' + parts.join('/') : ''), p = openDirectory(parent); let fd;
    try {
      fd = fs.openSync(`/proc/self/fd/${p}/${basename}`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); const s = fs.fstatSync(fd);
      assert(s.isFile() && s.nlink === 1 && s.uid === m.target.uid && (s.mode & 0o7777) === mode && s.size === size); const bytes = fs.readFileSync(fd);
      assert(bytes.length === size && identity(fs.lstatSync(parent + '/' + basename)) === identity(s)); return bytes;
    } finally { if (fd !== undefined) fs.closeSync(fd); fs.closeSync(p); }
  };
  assert(process.platform === 'linux' && process.arch === m.target.arch && m.target.uid > 0 && process.getuid() === m.target.uid);
  const boot_id=hash(fs.readFileSync('/proc/sys/kernel/random/boot_id'));
  assert(hash(fs.readFileSync('/etc/machine-id')) === m.remote.machine_id);
  if(!adapters.recover) assert(boot_id === (control.generation?.boot_id || m.remote.boot_id));
  const home = openDirectory(m.target.home); try { assert(identity(fs.fstatSync(home)) === `${m.remote.home_dev}:${m.remote.home_ino}`); } finally { fs.closeSync(home); }
  const root = openDirectory(m.install_root); try { assert(identity(fs.fstatSync(root)) === m.root_identity && (fs.fstatSync(root).mode & 0o7777) === 0o700); } finally { fs.closeSync(root); }
  assert(m.abi && Array.isArray(m.abi.files) && (m.abi.profile === 'official-linux-x64-baseline' || (m.abi.kind === undefined || m.abi.kind === 'central-files-v1') && m.abi.files.length > 0));
  assert(Array.isArray(m.abi.cpu_features) && m.abi.cpu_features.length > 0 && m.abi.cpu_features.length <= 512);
  const cores = [...fs.readFileSync('/proc/cpuinfo', 'utf8').matchAll(/^(?:flags|Features)\s*:\s*(.*)$/gm)].map(match => new Set(match[1].trim().toLowerCase().split(/\s+/)));
  assert(cores.length > 0 && cores.every(core => m.abi.cpu_features.every(flag => core.has(flag))));
  if (m.abi.profile) {
    const cp = await import('node:child_process');
    const output = cp.execFileSync('/bin/sh', ['-c', abi_script(m.abi) + '\nprintf "%s:%s" "$abi_ready" "$abi_observed_sha256"'], { env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000, maxBuffer: 4096 });
    assert(output.toString() === '1:' + m.remote.abi_observed_sha256);
  } else for (const row of m.abi.files) { const s = fs.statSync(row.path); assert(s.uid === 0 && (s.mode & 0o022) === 0 && fs.realpathSync(row.path) === row.realpath && s.size === row.size && hash(fs.readFileSync(row.path)) === row.sha256); }
  const stat = fs.lstatSync(m.install_root + '/manifest.json'); assert(stat.size <= 1024 * 1024);
  const bytes = read('manifest.json', stat.size); assert(hash(bytes) === m.manifest_sha256); const manifest = JSON.parse(bytes);
  assert(manifest.id === m.deployment_id && manifest.plan_sha256 === m.plan_sha256 && manifest.node_id === m.node_id && Array.isArray(manifest.files) && manifest.files.length <= 2048);
  for (const row of manifest.files) assert(hash(read(row.path, row.size, row.mode)) === row.sha256);
  assert(manifest.cgroup.path === m.cgroup_root && Object.keys(manifest.cgroup.evidence).length === Object.keys(m.cgroup_evidence).length && Object.entries(manifest.cgroup.evidence).every(([key, value]) => m.cgroup_evidence[key] === value));
  assert(manifest.control&&Object.keys(manifest.control).length===Object.keys(m.control).length&&Object.entries(manifest.control).every(([k,v])=>m.control[k]===v));
  if(adapters.recover) return await adapters.recover({manifest,boot_id});
  const generation=control.generation;
  if(generation){assert(generation.deployment_id===m.deployment_id && generation.node_id===m.node_id && generation.original_manifest_sha256===m.manifest_sha256 && generation.original_config_sha256===manifest.files.find(r=>r.path==='config.json').sha256 && generation.boot_id===boot_id);const s=fs.lstatSync(m.install_root+'/sealed');assert(s.size<=4096&&hash(read('sealed',s.size,0o600))===generation.original_seal_sha256);const seal=JSON.parse(read('sealed',s.size,0o600));assert(seal.runner_id===generation.runner_id);}
  const live=generation?{...m,cgroup_root:generation.cgroup.path,cgroup_evidence:generation.cgroup.evidence}:m;
  if (adapters.verifyCgroup) assert(await adapters.verifyCgroup(live.cgroup_root, live.cgroup_evidence));
  else {
    const cg = openDirectory(live.cgroup_root), e = live.cgroup_evidence;
    try {
      const s = fs.fstatSync(cg); assert(s.uid === m.target.uid && identity(s) === `${e.dev}:${e.ino}` && Number(fs.statfsSync(`/proc/self/fd/${cg}`).type) === 0x63677270);
      assert(fs.readFileSync(`/proc/self/fd/${cg}/cgroup.type`, 'utf8').trim() === 'domain');
      // Reconnect must remain possible to query/stop original commands. Do not
      // require an already configured production subtree to be unpopulated.
      for (const name of ['cgroup.procs', 'cgroup.kill']) fs.accessSync(`/proc/self/fd/${cg}/${name}`, fs.constants.W_OK);
    } finally { fs.closeSync(cg); }
    const parent = openDirectory(e.delegated_parent);
    try { if (e.parent_dev) assert(identity(fs.fstatSync(parent)) === `${e.parent_dev}:${e.parent_ino}`); } finally { fs.closeSync(parent); }
    assert(typeof e.unit === 'string' && /^[A-Za-z0-9_.@-]+\.service$/.test(e.unit) && ['/usr/bin/systemctl', '/bin/systemctl', '/run/current-system/sw/bin/systemctl'].includes(e.systemctl_path || '/usr/bin/systemctl'));
    const cp = await import('node:child_process');
    const props = await new Promise((resolve, reject) => {
      const child = cp.spawn(e.systemctl_path || '/usr/bin/systemctl', ['show', e.unit, '--no-pager', '--property=ControlGroup,Delegate,DelegateSubgroup,FragmentPath,User,ActiveState,DropInPaths'], { env: { PATH: '/usr/bin:/bin:/run/current-system/sw/bin', LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let size = 0, diagnostic = 0, failed = false; const chunks = [];
      const timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, 10000);
      child.stdout.on('data', bytes => { size += bytes.length; if (size > 16384) { failed = true; child.kill('SIGKILL'); } else chunks.push(bytes); });
      child.stderr.on('data', bytes => { diagnostic += bytes.length; if (diagnostic > 16384) { failed = true; child.kill('SIGKILL'); } });
      child.on('error', () => { failed = true; });
      child.on('close', code => { clearTimeout(timer); if (failed || code !== 0) { reject(new Error('Managed delegation not confirmed')); return; }
        const values = {}; for (const line of Buffer.concat(chunks).toString().trim().split('\n')) { const i = line.indexOf('='); if (i > 0) { if (Object.hasOwn(values, line.slice(0, i))) { reject(new Error('Managed delegation not confirmed')); return; } values[line.slice(0, i)] = line.slice(i + 1); } } resolve(values);
      });
    });
    assert(props.Delegate === 'yes' && props.ControlGroup === e.control_group && e.delegated_parent === '/sys/fs/cgroup' + e.control_group);
    if (e.fragment_path) {
      assert(props.FragmentPath === e.fragment_path && props.DelegateSubgroup === 'supervisor' && props.User === String(m.target.uid) && props.ActiveState === 'active' && !props.DropInPaths);
      const fd = fs.openSync(e.fragment_path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { const s = fs.fstatSync(fd); assert(s.isFile() && s.uid === 0 && (s.mode & 0o7777) === 0o644 && s.nlink === 1 && s.size <= 4096 && hash(fs.readFileSync(fd)) === e.unit_sha256); } finally { fs.closeSync(fd); }
    }
  }
  const finalRoot = openDirectory(m.install_root); try { assert(identity(fs.fstatSync(finalRoot)) === m.root_identity); } finally { fs.closeSync(finalRoot); }
  if (adapters.start) return await adapters.start(live, generation);
  process.env.HOME = m.target.home; process.env.USER = m.target.user; process.env.LOGNAME = m.target.user;
  const entry = await import(url.pathToFileURL(m.install_root + '/runner/src/runner/index.js').href);
  if(!generation) return await entry.runRunner({ config_file: m.config_file });
  const configRow=manifest.files.find(row=>row.path==='config.json');
  const effective=()=>{ control.checkpoint(); const bytes=read('config.json',configRow.size,configRow.mode); assert(hash(bytes)===configRow.sha256); return {...JSON.parse(bytes),cgroup_root:live.cgroup_root}; };
  const node=await entry.createRunnerNode(effective(),{refresh_config:effective}), connection=entry.serveConnection(node,{input:process.stdin,output:process.stdout});
  const stop=()=>{void connection.stop();};process.once('SIGTERM',stop);process.once('SIGINT',stop);
  try {await connection.done;} finally {process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);await node.close();}
  } finally {if(!adapters.control) control.close();}
}

export function managedRunnerCommand(managed) {
  const m = validateManagedDescription(managed);
  const program = `(${managedLaunchRuntime.toString()})(${JSON.stringify(m)}, {held_fd:8}, ${deploymentAbiScript.toString()}, ${runtimeControl.toString()}).catch(() => { process.stderr.write('Managed Runner verification failed\\n'); process.exitCode = 1; });`;
  return managedProgramCommand(m, program);
}
export function managedProgramCommand(managed, program, admission = {mode:'normal'}) {
  const m=validateManagedDescription(managed), root=quote(m.install_root);
  return `exec /bin/sh -c ${quote(`set -eu\nPATH=/usr/bin:/bin:/run/current-system/sw/bin; export PATH\nLC_ALL=C; export LC_ALL\ncd -P -- ${root}\n[ "$(pwd -P)" = ${root} ]\n${controlShell(m,admission)}\n[ ! -L bun ]\nexec 9< ./bun\n[ "$(stat -Lc '%u:%a:%h:%s' /proc/self/fd/9)" = ${quote(`${m.target.uid}:700:1:${m.runtime_size}`)} ]\n[ "$(sha256sum /proc/self/fd/9 | cut -d ' ' -f 1)" = ${quote(m.runtime_sha256)} ]\n[ "$(stat -c '%d:%i' bun)" = "$(stat -Lc '%d:%i' /proc/self/fd/9)" ]\nexec /usr/bin/env -i PATH=/usr/bin:/bin:/run/current-system/sw/bin HOME=${root} USER=${quote(m.target.user)} LOGNAME=${quote(m.target.user)} LANG=C LC_ALL=C BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 /proc/self/fd/9 --no-install --no-env-file --config=/dev/null -e ${quote(program)}\n`)}`;
}
export function managedRunnerArguments(options) { return managedProgramArguments(options, managedRunnerCommand(options.managed)); }
export function managedProgramArguments({ ssh_alias, ssh_configuration_file, managed }, command) {
  const m = validateManagedDescription(managed); assert(ssh_alias === m.ssh_alias);
  const fd = fs.openSync(ssh_configuration_file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { const stat = fs.fstatSync(fd); assert(stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o7777) === 0o600 && stat.nlink === 1 && stat.size <= 131072 && createHash('sha256').update(fs.readFileSync(fd)).digest('hex') === m.ssh_config_sha256); }
  finally { fs.closeSync(fd); }
  const args = sshTrialArguments(ssh_alias, ssh_configuration_file).slice(0, -1); args[args.indexOf('StdinNull=yes')] = 'StdinNull=no'; args.push(command); return args;
}
