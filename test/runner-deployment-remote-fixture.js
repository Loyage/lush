import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import { deploymentAptScript } from '../src/core/runner-deployment-remote-apt.js';
import { randomUUID, createHash } from 'node:crypto';
import { DeploymentRemote, deploymentAbiEvidence } from '../src/core/runner-deployment-remote.js';
export const digest = value => createHash('sha256').update(value).digest('hex');
export const fixedPath = '/usr/sbin:/usr/bin:/sbin:/bin:/run/current-system/sw/bin';
export function remoteFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-test-deployment-remote-')), home = path.join(root, 'home'), bin = path.join(root, 'adapter');
  fs.mkdirSync(home, { mode: 0o700 }); fs.mkdirSync(bin, { mode: 0o700 });
  const write = (name, value) => fs.writeFileSync(path.join(bin, name), '#!/bin/sh\n' + value + '\n', { mode: 0o700 });
  const q = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;
  write('getent', `printf '%s\\n' ${q(`${os.userInfo().username}:x:${process.getuid()}:${process.getgid()}::${home}:/bin/sh`)}`);
  // NEVER invoke host sudo/systemctl. These are controlled observational adapters.
  write('sudo', `printf '%s\\n' "$*" >> ${q(path.join(root, 'sudo-calls'))}; exit 1`);
  write('systemctl', '[ "$1" != --version ] || { echo "systemd 254 (isolated fixture)"; exit 0; }; exit 1');
  const records = [], remotes = [], children = new Set(); let onSpawn = null;
  const spawn_process = (command, args, options) => {
    const file = args[args.indexOf('-F') + 1]; records.push({ command, args, env: Object.keys(options.env), config: fs.readFileSync(file, 'utf8'), mode: fs.statSync(file).mode & 0o777 });
    const mode = onSpawn ? onSpawn(args) : null;
    // Use the production command and stdio, replacing only its fixed system-command
    // lookup with isolated getent/sudo/systemctl adapters. No real SSH/sudo is used.
    let script = args.at(-1).replaceAll(fixedPath, bin + ':' + fixedPath);
    if (mode?.probe_cgroup) {
      const cgroot = path.join(root, 'sim-cgroup');
      script = script.replaceAll('/sys/fs/cgroup', cgroot).replace('systemctl_path=$(command -v systemctl 2>/dev/null || :)', 'systemctl_path=/usr/bin/systemctl');
      script = `(${script}) | /usr/bin/sed 's|${cgroot}|/sys/fs/cgroup|g'`;
    }
    if (mode?.apt_script) { const prefix = 'exec /bin/sh -c '; const body = script.slice(prefix.length).slice(1, -1).replaceAll(`'"'"'`, `'`); script = prefix + q(body.replace(q(deploymentAptScript()), q(mode.apt_script))); }
    if (mode?.rewrite) script = mode.rewrite(script);
    if (mode?.drop_ack) script = `(${script}) > /dev/null; exit 91`;
    const child = spawn('/bin/sh', ['-c', script], options);
    if (mode?.tamper_program) { const destination = child.stdin; let changed = false; const wire = new Transform({ transform(chunk, encoding, done) { const bytes = Buffer.from(chunk); if(!changed && bytes.length) {bytes[0] ^= 1; changed = true;} done(null,bytes); } }); wire.pipe(destination); child.stdin = wire; }
    children.add(child); child.once('close', () => children.delete(child)); return child;
  };
  const remote = (options = {}) => { const r = new DeploymentRemote({ ssh_alias: 'fixture', ssh_configuration: 'Host fixture\nhostname "fixture.invalid"\n', spawn_process, ...options }); remotes.push(r); return r; };
  const library = '/lib64/ld-linux-x86-64.so.2';
  const abi = deploymentAbiEvidence({ files: [{ path: library, realpath: fs.realpathSync(library), sha256: digest(fs.readFileSync(library)), size: fs.statSync(library).size }] });
  const artifact = (bytes, files) => { const file = path.join(root, randomUUID()); fs.writeFileSync(file, bytes, { mode: 0o600 }); return { file, sha256: digest(bytes), size: bytes.length, ...(files ? { files } : {}) }; };
  const plan = async (r = remote(), { runtime, runner, ...extra } = {}) => {
    const id = randomUUID(), probe = await r.probe({ id, abi });
    return { remote: r, probe, id, plan_sha256: 'a'.repeat(64), plan: { target: probe.target, remote: probe.remote, abi, ssh_config_sha256: r.configuration_sha256,
      install_root: probe.install_root, actions: [], cgroup: { status: 'ready', path: '/sys/fs/cgroup/isolated-fixture/lush-runner', evidence: { boot_id: probe.remote.boot_id, dev: '1', ino: '2', unit: `user@${process.getuid()}.service`, control_group: '/isolated-fixture', delegated_parent: '/sys/fs/cgroup/isolated-fixture' } },
      runtime: runtime || { sha256: 'b'.repeat(64), size: 1 }, runner: runner || { sha256: 'c'.repeat(64), size: 1 }, ...extra } };
  };
  return { root, home, bin, abi, records, remote, plan, artifact, hook(fn) { onSpawn = fn; }, async close() { await Promise.all(remotes.map(r => r.close())); for (const c of children) c.kill('SIGKILL'); fs.rmSync(root, { recursive: true, force: true }); } };
}
export function tar(entries) {
  const buffers = [];
  for (const { name, bytes = Buffer.from('fixture'), type = '0', link = '' } of entries) {
    const header = Buffer.alloc(512);
    const ascii = (value, start, size) => header.write(value, start, Math.min(size, Buffer.byteLength(value)), 'ascii');
    ascii(name, 0, 100); ascii('0000600\0', 100, 8); ascii('0000000\0', 108, 8); ascii('0000000\0', 116, 8); ascii(bytes.length.toString(8).padStart(11, '0') + '\0', 124, 12); ascii('00000000000\0', 136, 12);
    header.fill(32, 148, 156); ascii(type, 156, 1); ascii(link, 157, 100); ascii('ustar\0', 257, 6); ascii('00', 263, 2);
    ascii([...header].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
    buffers.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  buffers.push(Buffer.alloc(1024)); return Buffer.concat(buffers);
}
export function fakeRuntimeEvidence(request) {
  const { plan: p, id, plan_sha256 } = request, r = p.remote;
  const prefix = [id, plan_sha256, r.machine_id, r.boot_id, p.target.uid, r.home_dev, r.home_ino].join(':');
  fs.writeFileSync(path.join(p.install_root, 'stages/runtime.done'), prefix + '\n', { mode: 0o600 });
  return prefix;
}
