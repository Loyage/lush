import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { safeSshAlias, sshTrialArguments } from './runner-ssh.js';
import { check } from './types.js';
import { bootstrapScript } from './runner-deployment-remote-bootstrap.js';
import { remoteRuntime } from './runner-deployment-remote-runtime.js';
import { deploymentSystemSpecification } from './runner-deployment-remote-system.js';
import { deploymentAbiEvidence, deploymentAbiScript, reviewedDeploymentRuntime } from './runner-deployment-remote-abi.js';
import { deploymentAptScript, parseDeploymentApt } from './runner-deployment-remote-apt.js';
import { managedLaunchRuntime, managedProgramCommand, validateManagedDescription } from './runner-deployment-remote-launch.js';
import { runtimeControl } from './runner-deployment-remote-control.js';
import { recoveryRuntime } from './runner-deployment-remote-recovery.js';
export { managedRecoveryRunnerArguments } from './runner-deployment-remote-recovery.js';
export { deploymentAbiEvidence, validateDeploymentAbi } from './runner-deployment-remote-abi.js';
export { buildDeploymentSystemPlan } from './runner-deployment-remote-system.js';
export { managedRunnerCommand, managedRunnerArguments } from './runner-deployment-remote-launch.js';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HEX = /^[a-f0-9]{64}$/;
const ABS = /^\/[A-Za-z0-9_./+-]+$/;
const quote = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;
const hash = value => createHash('sha256').update(value).digest('hex');
const REMOTE_PATH = '/usr/sbin:/usr/bin:/sbin:/bin:/run/current-system/sw/bin';
const codes = new Set(['not_confirmed', 'unsupported', 'identity_changed', 'already_exists', 'busy', 'artifact_changed', 'stage_already_started', 'stage_failed', 'config_invalid', 'privilege_denied', 'system_action_failed', 'timeout', 'output_limit', 'closed', 'stale', 'not_found', 'recovery_blocked', 'original_unit_unverifiable']);
export class DeploymentRemoteError extends Error {
  constructor(code = 'not_confirmed', unknown = false) {
    super('Runner deployment remote operation was not confirmed'); this.name = 'DeploymentRemoteError';
    this.code = codes.has(code) ? code : 'not_confirmed'; this.unknown = unknown;
  }
}
function absolute(value) { return typeof value === 'string' && ABS.test(value) && value !== '/' && path.posix.normalize(value) === value && !value.split('/').includes('..'); }
function configuration(value) {
  check(typeof value === 'string' && Buffer.byteLength(value) <= 131072, 'Invalid deployment SSH snapshot');
  for (const line of value.split('\n').filter(Boolean)) {
    const host = /^Host (.+)$/.exec(line), option = /^(hostname|user|port|identityfile|identitiesonly) "([^"\x00-\x1f\x7f\\`$%']+)"$/.exec(line);
    if (host) check(host[1].split(' ').every(token => /^!?[A-Za-z0-9*?][A-Za-z0-9_.*?!-]{0,127}$/.test(token)), 'Invalid deployment SSH snapshot');
    else {
      check(option, 'Invalid deployment SSH snapshot');
      const [, key, literal] = option;
      check(key !== 'hostname' || /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,252}$/.test(literal), 'Invalid deployment SSH snapshot');
      check(key !== 'user' || /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(literal), 'Invalid deployment SSH snapshot');
      check(key !== 'port' || /^[0-9]{1,5}$/.test(literal) && Number(literal) >= 1 && Number(literal) <= 65535, 'Invalid deployment SSH snapshot');
      check(key !== 'identityfile' || absolute(literal) && literal.startsWith(`${os.userInfo().homedir}/`), 'Invalid deployment SSH snapshot');
      check(key !== 'identitiesonly' || /^(yes|no)$/.test(literal), 'Invalid deployment SSH snapshot');
    }
  }
  return value;
}

/** Read-only POSIX bootstrap: no executable from the user's home and no sudo action is run. */
function probeScript(id, evidence) {
  return `set -eu
PATH=${quote(REMOTE_PATH)}; export PATH
LC_ALL=C; export LC_ALL
os=$(uname -s 2>/dev/null || :)
arch=$(uname -m 2>/dev/null || :)
uid=$(id -u)
user=$(id -un)
home=$(getent passwd "$uid" | cut -d : -f 6)
case "$home" in /*) ;; *) exit 41;; esac
[ "$home" != / ] && [ "$(readlink -f -- "$home")" = "$home" ] && [ "$(stat -Lc '%u' -- "$home")" = "$uid" ] || exit 41
case "$home$user" in *[!A-Za-z0-9_./+-]*) exit 41;; esac
home_dev=$(stat -Lc '%d' -- "$home")
home_ino=$(stat -Lc '%i' -- "$home")
machine=$(sha256sum /etc/machine-id 2>/dev/null | cut -d ' ' -f 1)
boot=$(sha256sum /proc/sys/kernel/random/boot_id 2>/dev/null | cut -d ' ' -f 1)
${deploymentAbiScript(evidence)}
git_version=''
if command -v git >/dev/null 2>&1; then git_version=$(git --version 2>/dev/null | head -c 120); fi
distro=unknown
if [ -f /etc/os-release ]; then distro=$(sed -n 's/^ID=//p' /etc/os-release | tr -d '"' | head -n 1); fi
case "$distro" in debian|ubuntu) ;; *) distro=other;; esac
systemd_version=0
if command -v systemctl >/dev/null 2>&1; then systemd_version=$(systemctl --version 2>/dev/null | head -n 1 | cut -d ' ' -f 2); fi
case "$systemd_version" in ''|*[!0-9]*) systemd_version=0;; esac
sudo_n=0
if command -v sudo >/dev/null 2>&1 && sudo -n -l /usr/bin/systemd-run >/dev/null 2>&1; then sudo_n=1; fi
git_candidate=''
if [ -z "$git_version" ] && command -v apt-cache >/dev/null 2>&1; then git_candidate=$(apt-cache policy git 2>/dev/null | sed -n 's/^[ ]*Candidate: //p' | head -n 1); fi
case "$git_candidate" in ''|*[!A-Za-z0-9.+:~_-]*|'(none)') git_candidate='';; esac
sleep_path=''; system_tools=1
for tool in /usr/bin/systemctl /usr/bin/systemd-run /usr/bin/sleep /usr/bin/sudo; do
  if [ ! -f "$tool" ] || [ "$(stat -Lc '%u' "$tool")" != 0 ]; then system_tools=0; fi
  case "$(stat -Lc '%a' "$tool" 2>/dev/null || :)" in [4567][0145][0145]|4[4567][0145][0145]) ;; *) system_tools=0;; esac
done
if [ "$system_tools" = 1 ]; then sleep_path=/usr/bin/sleep; fi
cg=''; cg_dev=''; cg_ino=''; cg_unit=''; cg_control=''
unit="user@$uid.service"
parent=$(systemctl show "$unit" --property=ControlGroup --value 2>/dev/null || :)
delegate=$(systemctl show "$unit" --property=Delegate --value 2>/dev/null || :)
case "$parent" in /*) ;; *) parent='';; esac
case "$parent" in *[!A-Za-z0-9_./@:-]*|*'..'*|'/'|*'//'*|*'/') parent='';; esac
systemctl_path=$(command -v systemctl 2>/dev/null || :)
case "$systemctl_path" in /usr/bin/systemctl|/bin/systemctl|/run/current-system/sw/bin/systemctl) ;; *) parent='';; esac
if [ -n "$parent" ] && [ "$delegate" = yes ]; then
  candidate="/sys/fs/cgroup$parent/lush-runner"
  if [ "$(readlink -f "$candidate" 2>/dev/null || :)" = "$candidate" ] && [ "$(stat -f -c '%t' "$candidate" 2>/dev/null || :)" = 63677270 ] && [ "$(stat -c '%u' "$candidate" 2>/dev/null || :)" = "$uid" ] && [ "$(cat "$candidate/cgroup.type" 2>/dev/null || :)" = domain ] && [ -r "$candidate/cgroup.procs" ] && [ -z "$(cat "$candidate/cgroup.procs")" ] && grep -qx 'populated 0' "$candidate/cgroup.events" && [ -w "$candidate/cgroup.kill" ] && [ -w "$candidate/cgroup.procs" ] && [ -w "$candidate" ]; then
    cg="$candidate"; cg_dev=$(stat -c '%d' "$cg"); cg_ino=$(stat -c '%i' "$cg"); cg_unit="$unit"; cg_control="$parent"
  fi
fi
pending=0
lock="$home/.lush-runner-deployment.lock"
if [ -e "$lock" ] || [ -L "$lock" ]; then pending=1; fi
layout="$home"
managed_exists=0
for component in .local share lush-runner managed; do
  layout="$layout/$component"
  if [ -L "$layout" ]; then pending=1; break; fi
  if [ ! -e "$layout" ]; then break; fi
  if [ ! -d "$layout" ] || [ "$(stat -c '%u' "$layout")" != "$uid" ]; then pending=1; break; fi
  case "$(stat -c '%a' "$layout")" in [57][0145][0145]) ;; *) pending=1; break;; esac
  if [ "$component" = managed ] && [ -n "$(find "$layout" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null | head -c 1)" ]; then pending=1; managed_exists=1; fi
done
install="$home/.local/share/lush-runner/managed/${id}"
exists=0
if [ -e "$install" ] || [ -L "$install" ]; then exists=1; fi
legacy=0
if [ -e "$home/.config/lush-runner/config.json" ] || [ -L "$home/.config/lush-runner/config.json" ]; then legacy=1; fi
printf 'os=%s\narch=%s\nuid=%s\nuser=%s\nhome=%s\nhome_dev=%s\nhome_ino=%s\nmachine=%s\nboot=%s\nabi_ready=%s\ngit=%s\ndistro=%s\nsystemd=%s\nsudo_n=%s\ngit_candidate=%s\npending=%s\nexists=%s\nlegacy=%s\n' "$os" "$arch" "$uid" "$user" "$home" "$home_dev" "$home_ino" "$machine" "$boot" "$abi_ready" "$git_version" "$distro" "$systemd_version" "$sudo_n" "$git_candidate" "$pending" "$exists" "$legacy"
printf 'system_tools=%s\\nsleep_path=%s\\ncg=%s\\ncg_dev=%s\\ncg_ino=%s\\ncg_unit=%s\\ncg_control=%s\\n' "$system_tools" "$sleep_path" "$cg" "$cg_dev" "$cg_ino" "$cg_unit" "$cg_control"
printf 'systemctl_path=%s\\nabi_observed_sha256=%s\\nmanaged_exists=%s\\n' "$systemctl_path" "$abi_observed_sha256" "$managed_exists"
apt_observation=$(/usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C LANG=C /bin/sh -c ${quote(deploymentAptScript())})
sudo_git_n=0
if printf '%s\\n' "$apt_observation" | grep -qx apt_supported=1 && sudo -n -l /usr/bin/timeout >/dev/null 2>&1; then sudo_git_n=1; fi
printf 'sudo_git_n=%s\\n%s\\n' "$sudo_git_n" "$apt_observation"
`;
}
function parseProbe(source, evidence, id) {
  const values = Object.fromEntries(source.trim().split('\n').map(line => { const i = line.indexOf('='); check(i > 0, 'Invalid deployment probe response'); return [line.slice(0, i), line.slice(i + 1)]; }));
  check(values.os === 'Linux' && /^(x86_64|aarch64)$/.test(values.arch) && /^[0-9]{1,10}$/.test(values.uid)
    && Number(values.uid) > 0 && /^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,79}$/.test(values.user) && absolute(values.home)
    && /^[0-9]+$/.test(values.home_dev) && /^[0-9]+$/.test(values.home_ino) && HEX.test(values.machine) && HEX.test(values.boot), 'Unsupported deployment target or identity');
  const transaction = parseDeploymentApt(source);
  const target = { os: 'linux', arch: values.arch === 'x86_64' ? 'x64' : 'arm64', uid: Number(values.uid), user: values.user, home: values.home };
  const ready = values.abi_ready === '1' && (!evidence.profile || HEX.test(values.abi_observed_sha256));
  const cgroup = values.cg && /^\/sys\/fs\/cgroup\/[A-Za-z0-9_./@:-]+$/.test(values.cg) && path.posix.normalize(values.cg) === values.cg && /^[0-9]+$/.test(values.cg_dev) && /^[0-9]+$/.test(values.cg_ino)
    ? { status: 'ready', path: values.cg, evidence: { boot_id: values.boot, dev: values.cg_dev, ino: values.cg_ino, unit: values.cg_unit, control_group: values.cg_control, systemctl_path: values.systemctl_path, delegated_parent: `/sys/fs/cgroup${values.cg_control}` } }
    : { status: Number(values.systemd) >= 254 ? 'needs_setup' : 'unsupported', message: 'Setup requires systemd >=254; fixed unit ControlGroup is queried and bound after startup. Older systems require an existing verified delegation.' };
  return { target, install_root: `${target.home}/.local/share/lush-runner/managed/${id}`,
    remote: { machine_id: values.machine, boot_id: values.boot, home_dev: values.home_dev, home_ino: values.home_ino, abi_sha256: hash(JSON.stringify(evidence)), ...(evidence.profile && ready ? { abi_observed_sha256: values.abi_observed_sha256 } : {}) },
    abi: { status: ready ? 'ready' : 'unsupported', sha256: hash(JSON.stringify(evidence)), cpu: ready ? 'matched' : 'unsupported' },
    dependencies: [{ name: 'Git', status: values.git ? 'ready' : transaction.supported && Number(values.systemd) >= 250 && values.system_tools === '1' ? 'needs_install' : 'unsupported', ...(values.git ? {} : { message: 'Automatic Git setup requires a complete verified no-upgrade transaction and systemd >=250; unsupported policy/solver requires manual preparation' }), ...(values.git && /^git version [A-Za-z0-9.+_-]{1,100}$/.test(values.git) ? { version: values.git.slice(12) } : {}) },
      { name: 'Bun', status: ready ? 'needs_install' : 'unsupported', message: ready ? 'Central verified runtime must be uploaded' : 'Central runtime ABI files do not match' }],
    cgroup,
    system: { distro: values.distro, systemd: Number(values.systemd), sudo_n: values.sudo_n === '1', sudo_git_n: values.sudo_git_n === '1', system_tools: values.system_tools === '1', sleep_path: values.sleep_path || null, git_candidate: transaction.supported ? transaction.candidate : null, git_transaction: transaction },
    install: { exists: values.exists === '1', managed: values.managed_exists === '1', legacy: values.legacy === '1' }, pending: { exists: values.pending === '1' } };
}

/** Internal trusted adapter. No remote commands or paths are accepted from browser parameters.
 * A new instance is constructed from the current fail-closed SSH snapshot for each operation.
 */
export class DeploymentRemote {
  request(request) { return { ...request, plan: request.plan ? { ...request.plan, abi: deploymentAbiEvidence(request.plan.abi) } : request.plan, plan_sha256: request.plan_sha256 ?? request.plan?.plan_sha256 }; }
  validate(request) {
    const { id, plan, plan_sha256 } = this.request(request);
    check(UUID.test(id) && HEX.test(plan_sha256) && plan && plan.target && plan.remote, 'Invalid deployment fixed plan');
    const t = plan.target, r = plan.remote;
    check(t.os === 'linux' && ['x64', 'arm64'].includes(t.arch) && Number.isSafeInteger(t.uid) && t.uid > 0 && /^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,79}$/.test(t.user)
      && absolute(t.home) && plan.install_root === `${t.home}/.local/share/lush-runner/managed/${id}`, 'Invalid deployment installation target');
    check(HEX.test(r.machine_id) && HEX.test(r.boot_id) && /^[0-9]+$/.test(r.home_dev) && /^[0-9]+$/.test(r.home_ino)
      && r.abi_sha256 === hash(JSON.stringify(deploymentAbiEvidence(plan.abi))) && plan.ssh_config_sha256 === this.configuration_sha256, 'Deployment fixed evidence changed');
    check(reviewedDeploymentRuntime(plan.runtime, plan.abi) && (!plan.abi.profile || t.arch === 'x64' && HEX.test(r.abi_observed_sha256)), 'Unsupported deployment runtime provenance; reviewed ABI policy is required');
    check((plan.runtime?.arch === undefined || plan.runtime.arch === t.arch) && (plan.runtime?.os === undefined || plan.runtime.os === t.os), 'Deployment artifact platform changed');
    for (const [kind, limit] of [['runtime', 256 * 1024 * 1024], ['runner', 16 * 1024 * 1024]]) check(plan[kind] && HEX.test(plan[kind].sha256) && Number.isSafeInteger(plan[kind].size) && plan[kind].size > 0 && plan[kind].size <= limit, 'Invalid deployment artifact');
    check(plan.cgroup && Array.isArray(plan.actions) && plan.actions.length <= 16 && plan.actions.every(a => a && typeof a.id === 'string'), 'Invalid deployment actions');
  }
  async bootstrap(request, operation, options = {}) {
    request = this.request(request); this.validate(request);
    const script = bootstrapScript({ ...request, ...options, operation });
    return this.result(await this.run(`exec /bin/sh -c ${quote(script)}`, options));
  }
  result(output) {
    let result;
    try { result = JSON.parse(output); } catch { throw new DeploymentRemoteError('not_confirmed', true); }
    if (!result || result.ok !== true) throw new DeploymentRemoteError(result?.code || 'not_confirmed', result?.unknown === true || result?.code === 'identity_changed');
    return result;
  }
  async execute(request, operation, payload = null) {
    request = this.request(request);
    const header = Buffer.from(JSON.stringify({ id: request.id, plan: request.plan, plan_sha256: request.plan_sha256, operation,
      ...(request.artifact ? { artifact: request.artifact } : {}), ...(request.node_config ? { node_config: request.node_config } : {}), ...(request.proof ? { proof: request.proof } : {}) }) + '\n');
    check(header.length <= 131072, 'Deployment private request exceeds its bound');
    const source = `async bytes => { const n=bytes.indexOf(10); if(n<1 || n>131072) throw new Error('frame'); return (${remoteRuntime.toString()})(JSON.parse(bytes.subarray(0,n).toString()), {payload:bytes.subarray(n+1)}, ${deploymentSystemSpecification.toString()}, ${deploymentAbiScript.toString()}, ${deploymentAptScript.toString()}); }`;
    const program = Buffer.from(JSON.stringify(source) + '\n'); check(program.length <= 131072, 'Deployment program exceeds its bound');
    const input = (await import('node:stream')).Readable.from((async function* () { yield program; yield header; if(payload) for await (const chunk of payload) yield chunk; })());
    // Only hash-pinned internal source travels in the first stdin frame. Keeping
    // the large verifier out of argv avoids ARG_MAX; config stays stdin-only.
    const loader = `const fs=await import('node:fs'),c=await import('node:crypto');const parts=[];let size=0;for await(const b of process.stdin){size+=b.length;if(size>17039360)throw new Error('bound');parts.push(b)}const all=Buffer.concat(parts),n=all.indexOf(10);if(n<1||n>131072||c.createHash('sha256').update(all.subarray(0,n)).digest('hex')!==${JSON.stringify(hash(program.subarray(0, -1)))})throw new Error('source');console.log(JSON.stringify(await (0,eval)('('+JSON.parse(all.subarray(0,n).toString())+')')(all.subarray(n+1))));`;
    try { return await this.bootstrap(request, 'runtime-exec', { input, runtime_script: `(async()=>{${loader}})().catch(()=>console.log('{"ok":false,"code":"not_confirmed"}'));` }); }
    finally { if (input?.destroy) input.destroy(); }
  }
  constructor({ ssh_alias, ssh_configuration, spawn_process = spawn, timeout_ms = 120000 } = {}) {
    check(safeSshAlias(ssh_alias), 'Invalid deployment SSH alias');
    this.alias = ssh_alias; this.configuration = configuration(ssh_configuration); this.configuration_sha256 = hash(this.configuration);
    check(Number.isSafeInteger(timeout_ms) && timeout_ms > 0 && timeout_ms <= 180000, 'Invalid deployment deadline');
    this.spawn = spawn_process; this.timeout = timeout_ms; this.children = new Set(); this.closed = false;
    this.directory = null; this.busy = false;
  }
  async run(command, { input = null, stdout_bytes = 65536 } = {}) {
    if (this.closed) throw new DeploymentRemoteError('closed');
    check(!this.busy, 'Deployment SSH operation already in progress'); this.busy = true;
    try {
      if (!this.directory) { this.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-deploy-ssh-')); fs.chmodSync(this.directory, 0o700); fs.writeFileSync(path.join(this.directory, 'config'), this.configuration, { mode: 0o600, flag: 'wx' }); }
      check(fs.realpathSync(this.directory) === this.directory && (fs.lstatSync(this.directory).mode & 0o777) === 0o700 && hash(this.configuration) === this.configuration_sha256, 'Deployment SSH snapshot changed');
      const config = path.join(this.directory, 'config'), descriptor = fs.openSync(config, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(descriptor);
        check(stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600 && stat.nlink === 1 && stat.size <= 131072 && hash(fs.readFileSync(descriptor)) === this.configuration_sha256, 'Deployment SSH snapshot changed');
      } finally { fs.closeSync(descriptor); }
      const args = sshTrialArguments(this.alias, config).slice(0, -1);
      const index = args.indexOf('StdinNull=yes'); args[index] = 'StdinNull=no'; args.push(command);
      const user = os.userInfo(), env = Object.fromEntries(['PATH', 'SSH_AUTH_SOCK'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
      Object.assign(env, { HOME: user.homedir, USER: user.username, LOGNAME: user.username, LANG: 'C', LC_ALL: 'C' });
      return await new Promise((resolve, reject) => {
        let child, timer, output = 0, errors = 0, failure = null; const chunks = [];
        try { child = this.spawn('ssh', args, { env, stdio: ['pipe', 'pipe', 'pipe'] }); }
        catch { reject(new DeploymentRemoteError('not_confirmed')); return; }
        this.children.add(child);
        const stop = code => { failure ||= code; child.kill('SIGKILL'); };
        child.stdout.on('data', chunk => { output += chunk.length; if (output > stdout_bytes) stop('output_limit'); else chunks.push(chunk); });
        child.stderr.on('data', chunk => { errors += chunk.length; if (errors > 16384) stop('output_limit'); });
        child.on('error', () => { failure ||= 'not_confirmed'; }); child.stdin.on('error', () => { failure ||= 'not_confirmed'; });
        child.once('close', code => {
          clearTimeout(timer); this.children.delete(child);
          if (failure || code !== 0) reject(new DeploymentRemoteError(failure || 'not_confirmed', true));
          else resolve(Buffer.concat(chunks).toString('utf8'));
        });
        timer = setTimeout(() => stop('timeout'), this.timeout);
        if (input?.pipe) { input.once('error', () => stop('not_confirmed')); input.pipe(child.stdin); }
        else if (input) child.stdin.end(input); else child.stdin.end();
      });
    } finally { this.busy = false; }
  }
  async probe({ id, abi }) {
    check(typeof id === 'string' && UUID.test(id), 'Invalid deployment receipt id'); const evidence = deploymentAbiEvidence(abi);
    try { return parseProbe(await this.run(`exec /bin/sh -c ${quote(probeScript(id, evidence))}`), evidence, id); }
    catch (error) { if (error instanceof DeploymentRemoteError) throw error; throw new DeploymentRemoteError('unsupported'); }
  }
  async prepare(request) {
    const result = await this.bootstrap(request, 'prepare');
    if (!/^[0-9]+:[0-9]+$/.test(result.root_identity)) throw new DeploymentRemoteError('not_confirmed', true);
    return { ok: true, stage: 'prepare', root_identity: result.root_identity };
  }
  async upload(request) {
    this.validate(request); const { kind, artifact, plan } = request;
    check(['runtime', 'runner'].includes(kind) && artifact && artifact.sha256 === plan[kind].sha256 && artifact.size === plan[kind].size
      && typeof artifact.file === 'string' && path.isAbsolute(artifact.file) && fs.realpathSync(artifact.file) === artifact.file, 'Deployment artifact changed');
    let fd, input;
    try {
      fd = fs.openSync(artifact.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const initial = fs.fstatSync(fd);
      const stable = () => {
        const stat = fs.fstatSync(fd), name = fs.lstatSync(artifact.file);
        check(stat.isFile() && stat.uid === process.getuid() && stat.nlink === 1 && (stat.mode & 0o077) === 0 && stat.size === artifact.size && stat.dev === initial.dev && stat.ino === initial.ino
          && stat.mtimeMs === initial.mtimeMs && stat.ctimeMs === initial.ctimeMs && name.dev === initial.dev && name.ino === initial.ino && !name.isSymbolicLink(), 'Deployment artifact changed');
      };
      stable();
      const sum = createHash('sha256'), chunk = Buffer.alloc(1024 * 1024); let read, offset = 0;
      while ((read = fs.readSync(fd, chunk, 0, chunk.length, offset)) > 0) { sum.update(chunk.subarray(0, read)); offset += read; }
      check(sum.digest('hex') === artifact.sha256, 'Deployment artifact changed'); stable();
      // A generic Readable never owns/closes the descriptor; fs.ReadStream.destroy
      // may close even an externally supplied fd on some supported Bun versions.
      const { Readable } = await import('node:stream'); let position = 0;
      input = new Readable({ read() {
        try {
          if (position >= artifact.size) { this.push(null); return; }
          const bytes = Buffer.alloc(Math.min(65536, artifact.size - position)), count = fs.readSync(fd, bytes, 0, bytes.length, position);
          if (!count) { this.destroy(new Error('Deployment artifact changed')); return; }
          position += count; this.push(bytes.subarray(0, count));
        } catch (error) { this.destroy(error); }
      } });
      let result;
      if (kind === 'runtime') result = await this.bootstrap(request, 'runtime', { input, artifact: { sha256: artifact.sha256, size: artifact.size } });
      else {
        check(Array.isArray(artifact.files) && artifact.files.length > 0 && artifact.files.length <= 2048 && artifact.files.every(file => typeof file === 'string' && /^[A-Za-z0-9_./+-]+$/.test(file) && !file.startsWith('/') && path.posix.normalize(file) === file), 'Invalid deployment bundle manifest');
        result = await this.execute({ id: request.id, plan: request.plan, plan_sha256: request.plan_sha256, artifact: { sha256: artifact.sha256, size: artifact.size, files: artifact.files } }, 'runner', input);
      }
      try { stable(); } catch { throw new DeploymentRemoteError('artifact_changed', true); }
      if (result.sha256 !== artifact.sha256 || result.size !== artifact.size) throw new DeploymentRemoteError('not_confirmed', true);
      return { ok: true, stage: kind, sha256: artifact.sha256, size: artifact.size };
    } finally { if (input) input.destroy(); if (fd !== undefined) fs.closeSync(fd); }
  }
  cgroup(request, value) {
    const e = value?.evidence, bad = () => { throw new DeploymentRemoteError('identity_changed', true); };
    if (!e || typeof value.path !== 'string' || !/^\/sys\/fs\/cgroup\/[A-Za-z0-9_./@:-]+$/.test(value.path) || path.posix.normalize(value.path) !== value.path || e.boot_id !== request.plan.remote.boot_id
      || !/^[0-9]+$/.test(e.dev) || !/^[0-9]+$/.test(e.ino) || !/^\/[A-Za-z0-9_./@:-]+$/.test(e.control_group) || e.control_group.includes('..') || e.delegated_parent !== '/sys/fs/cgroup' + e.control_group) bad();
    const setup = request.plan.actions.some(a => a.id === 'cgroup_setup');
    if (setup && (e.unit !== request.plan.system_setup.unit.name || e.fragment_path !== request.plan.system_setup.unit.path || e.unit_sha256 !== request.plan.system_setup.unit.sha256 || !/^[0-9]+$/.test(e.parent_dev) || !/^[0-9]+$/.test(e.parent_ino) || value.path !== e.delegated_parent + '/runner')) bad();
    if (!setup && (e.unit !== `user@${request.plan.target.uid}.service` || value.path !== e.delegated_parent + '/lush-runner')) bad();
    const evidence = Object.fromEntries(['boot_id', 'dev', 'ino', 'unit', 'control_group', 'delegated_parent', 'parent_dev', 'parent_ino', 'fragment_path', 'unit_sha256', 'sleep_path', 'systemctl_path'].filter(key => e[key] !== undefined).map(key => [key, e[key]]));
    return { path: value.path, evidence };
  }
  describe(request, m) {
    if (!m || m.install_root !== request.plan.install_root || !HEX.test(m.manifest_sha256) || !UUID.test(m.node_id) || !/^[0-9]+:[0-9]+$/.test(m.root_identity)
      || m.config_file !== `${m.install_root}/config.json` || m.root !== `${m.install_root}/workspaces` || !m.cgroup_evidence || m.cgroup_evidence.boot_id !== request.plan.remote.boot_id)
      throw new DeploymentRemoteError('not_confirmed', true);
    return { version: 1, deployment_id: request.id, plan_sha256: this.request(request).plan_sha256, install_root: m.install_root, root_identity: m.root_identity, manifest_sha256: m.manifest_sha256,
      runtime_sha256: request.plan.runtime.sha256, runtime_size: request.plan.runtime.size, runner_sha256: request.plan.runner.sha256, node_id: m.node_id, config_file: m.config_file, root: m.root,
      cgroup_root: m.cgroup_root, cgroup_evidence: this.cgroup(request, { path: m.cgroup_root, evidence: m.cgroup_evidence }).evidence, ssh_alias: this.alias, ssh_config_sha256: this.configuration_sha256,
      target: Object.fromEntries(['os', 'arch', 'uid', 'user', 'home'].map(key => [key, request.plan.target[key]])),
      remote: Object.fromEntries(['machine_id', 'boot_id', 'home_dev', 'home_ino', 'abi_sha256', 'abi_observed_sha256'].filter(key => request.plan.remote[key] !== undefined).map(key => [key, request.plan.remote[key]])),
      abi: deploymentAbiEvidence(request.plan.abi), control: m.control };
  }
  async recoveryCall(operation, {managed,...request}) {
    validateManagedDescription(managed);
    check(managed.ssh_alias===this.alias && managed.ssh_config_sha256===this.configuration_sha256,'Recovery SSH snapshot changed');
    const source=`async request => (${recoveryRuntime.toString()})(${JSON.stringify(managed)},request,{held_fd:8},${managedLaunchRuntime.toString()},${runtimeControl.toString()},${deploymentAbiScript.toString()})`;
    const program=Buffer.from(JSON.stringify(source)+'\n'), data=Buffer.from(JSON.stringify({...request,operation})+'\n');check(program.length<=131072&&data.length<=65536,'Recovery request exceeds its bound');
    const loader=`(async()=>{const c=await import('node:crypto'),parts=[];let size=0;for await(const b of process.stdin){size+=b.length;if(size>196608)throw new Error('bound');parts.push(b)}const b=Buffer.concat(parts),n=b.indexOf(10);if(n<1||n>131072||c.createHash('sha256').update(b.subarray(0,n)).digest('hex')!==${JSON.stringify(hash(program.subarray(0,-1)))})throw new Error('source');console.log(JSON.stringify(await (0,eval)('('+JSON.parse(b.subarray(0,n))+')')(JSON.parse(b.subarray(n+1)))));})().catch(()=>console.log('{"ok":false,"code":"not_confirmed"}'));`;
    return this.result(await this.run(managedProgramCommand(managed,loader,{mode:operation,recovery_id:request.recovery_id}),{input:Buffer.concat([program,data])}));
  }
  recoveryCheck(request) {return this.recoveryCall('check',request);}
  recoveryApply(request) {return this.recoveryCall('apply',request);}
  recoveryInspect(request) {return this.recoveryCall('inspect',request);}
  recoverySeal(request) {return this.recoveryCall('seal',request);}
  recoveryActivate(request) {return this.recoveryCall('activate',request);}
  async configure(request) {
    const result = await this.execute(request, 'configure');
    if (result.managed?.node_id !== request.node_config.node_id || result.managed?.cgroup_root !== request.node_config.cgroup_root) throw new DeploymentRemoteError('not_confirmed', true);
    return { ok: true, stage: 'configure', managed: this.describe(request, result.managed) };
  }
  async system(request) {
    if (request.action === 'git_install' && !request.plan?.system_setup?.git_install?.transaction?.supported) throw new DeploymentRemoteError('unsupported');
    check(['git_install', 'cgroup_setup'].includes(request.action) && request.plan?.actions?.some(row => row.id === request.action), 'Unapproved deployment system action');
    const result = await this.execute({ id: request.id, plan: request.plan, plan_sha256: request.plan_sha256 }, request.action);
    return { ok: true, stage: request.action, ...(request.action === 'cgroup_setup' ? { cgroup: this.cgroup(request, result.cgroup) } : { version: result.version, installer: this.installer(request, result.installer) }), installer_unit: result.installer_unit };
  }
  installer(request, value) {
    if (!value || value.unit !== request.plan.system_setup?.installer.git || !['active', 'inactive', 'failed', 'activating', 'deactivating', 'unknown', 'not-found'].includes(value.state) || !(value.invocation_id == null || /^[a-f0-9]{32}$/.test(value.invocation_id))) throw new DeploymentRemoteError('not_confirmed', true);
    return { unit: value.unit, state: value.state, invocation_id: value.invocation_id || null, tree_stopped: value.tree_stopped === true, success: value.success === true, barrier: ['systemctl-wait-exit-type-cgroup', 'manager-exit-type-cgroup'].includes(value.barrier) ? value.barrier : null };
  }
  async inspect(request) {
    const bootstrap = await this.bootstrap(request, 'inspect-bootstrap');
    if (bootstrap.runtime !== 'verified') return { ok: true, stage: 'inspect', integrity: bootstrap.runtime === 'changed' ? 'changed' : 'not_configured', sealed: false,
      stages: [{ stage: 'prepare', status: bootstrap.prepare === 'done' ? 'done' : 'unknown' }, { stage: 'runtime', status: bootstrap.failed === 1 ? 'failed' : bootstrap.done === 1 && bootstrap.runtime === 'verified' ? 'done' : bootstrap.started === 1 ? 'unknown' : 'not_started' }] };
    const result = await this.execute(request, 'inspect');
    if (!['not_configured', 'verified'].includes(result.integrity) || !Array.isArray(result.stages) || result.stages.length > 7 || result.stages.some(row => !['prepare', 'runtime', 'runner', 'configure', 'git_install', 'cgroup_setup', 'seal'].includes(row.stage) || !['not_started', 'done', 'failed', 'unknown'].includes(row.status))) throw new DeploymentRemoteError('not_confirmed', true);
    return { ok: true, stage: 'inspect', integrity: result.integrity, sealed: result.sealed === true, stages: result.stages.map(row => ({ stage: row.stage, status: row.status })),
      ...(result.cgroup ? { cgroup: this.cgroup(request, result.cgroup) } : {}), ...(result.system ? { system: { unit: request.plan.system_setup?.unit.name, load_state: ['loaded', 'not-found', 'error'].includes(result.system.load_state) ? result.system.load_state : 'unknown', active: result.system.active === true } } : {}), ...(result.installer ? { installer: this.installer(request, result.installer) } : {}), ...(result.managed ? { managed: this.describe(request, result.managed) } : {}) };
  }
  async seal(request) {
    const result = await this.execute(request, 'seal');
    if (result.runner_id !== request.proof.runner_id) throw new DeploymentRemoteError('not_confirmed', true);
    return { ok: true, stage: 'seal', runner_id: result.runner_id };
  }
  async close() {
    this.closed = true;
    const pending = [...this.children].map(child => new Promise(resolve => { child.once('close', resolve); child.kill('SIGKILL'); }));
    await Promise.all(pending);
    if (this.directory) { fs.rmSync(this.directory, { recursive: true, force: true }); this.directory = null; }
  }
}
