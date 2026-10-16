import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { check, fail, hash } from './protocol.js';

const CGROUP2_SUPER_MAGIC = 0x63677270;
const read = file => fs.readFileSync(file, 'utf8').trim();
function directoryIdentity(directory) {
  check(path.isAbsolute(directory) && path.resolve(directory) === directory && fs.realpathSync(directory) === directory,
    'UNSUPPORTED', 'cgroup path must be canonical and contain no symlinks');
  const stat = fs.lstatSync(directory, { bigint: true });
  check(stat.isDirectory() && !stat.isSymbolicLink(), 'UNSUPPORTED', 'Expected cgroup directory');
  return { dev: String(stat.dev), ino: String(stat.ino) };
}
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const bootId = () => read('/proc/sys/kernel/random/boot_id');
export function commandGroupName(execution) {
  return 'lush-' + hash(`${execution.workspace_key}:${execution.execution_id}`);
}

/** Linux cgroup v2 only. No process-group fallback and no system configuration writes. */
export function createCgroupController({ cgroup_root, node_id }) {
  function preflight() {
    try {
      check(process.platform === 'linux' && typeof cgroup_root === 'string' && cgroup_root !== '/sys/fs/cgroup',
        'UNSUPPORTED', 'A dedicated delegated Linux cgroup v2 subtree is required');
      const root = directoryIdentity(cgroup_root);
      check(Number(fs.statfsSync(cgroup_root).type) === CGROUP2_SUPER_MAGIC, 'UNSUPPORTED', 'Configured containment root is not cgroup v2');
      check(read(path.join(cgroup_root, 'cgroup.type')) === 'domain', 'UNSUPPORTED', 'A domain cgroup is required');
      for (const name of ['cgroup.procs', 'cgroup.kill']) fs.accessSync(path.join(cgroup_root, name), fs.constants.W_OK);
      fs.accessSync(cgroup_root, fs.constants.W_OK | fs.constants.X_OK);
      read(path.join(cgroup_root, 'cgroup.events'));
      return { root: cgroup_root, ...root, node_id, boot_id: bootId() };
    } catch (error) {
      if (error.code === 'UNSUPPORTED') throw error;
      fail('UNSUPPORTED', 'Delegated cgroup v2 is unavailable or not writable');
    }
  }
  function verify(receipt) {
    const root = preflight();
    check(receipt && receipt.kind === 'cgroup-v2' && receipt.root === root.root && receipt.node_id === node_id
      && receipt.boot_id === root.boot_id && same(receipt.root_identity, root)
      && /^lush-[a-f0-9]{64}$/.test(receipt.name), 'UNKNOWN', 'Containment ownership cannot be verified');
    const directory = path.join(root.root, receipt.name);
    let actual;
    try { actual = directoryIdentity(directory); }
    catch { fail('UNKNOWN', 'Recorded cgroup is missing or changed'); }
    check(same(actual, receipt.identity), 'UNKNOWN', 'Recorded cgroup identity changed');
    return directory;
  }
  function prepare(execution) {
    const root = preflight(), name = commandGroupName(execution), directory = path.join(root.root, name);
    // Existing groups are not silently adopted, including after interrupted preparation.
    try { fs.mkdirSync(directory); }
    catch { fail('UNKNOWN', 'Cannot create exclusive command cgroup'); }
    const identity = directoryIdentity(directory);
    const receipt = { kind: 'cgroup-v2', root: root.root, node_id, boot_id: root.boot_id,
      root_identity: { dev: root.dev, ino: root.ino }, name, identity };
    check(read(path.join(directory, 'cgroup.procs')) === '', 'UNKNOWN', 'New command cgroup is not empty');
    fs.accessSync(path.join(directory, 'cgroup.kill'), fs.constants.W_OK);
    return receipt;
  }
  function populated(receipt) {
    const directory = verify(receipt), content = read(path.join(directory, 'cgroup.events'));
    const match = /^populated ([01])$/m.exec(content);
    check(match, 'UNKNOWN', 'Invalid cgroup population receipt');
    return match[1] === '1';
  }
  function kill(receipt) { fs.writeFileSync(path.join(verify(receipt), 'cgroup.kill'), '1'); }
  async function stop(receipt, { timeout_ms = 3000 } = {}) {
    kill(receipt);
    const deadline = Date.now() + timeout_ms;
    while (populated(receipt)) {
      if (Date.now() >= deadline) fail('UNKNOWN', 'Command cgroup did not become empty');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return true;
  }
  function attach(receipt) {
    const directory = verify(receipt);
    fs.writeFileSync(path.join(directory, 'cgroup.procs'), String(process.pid));
    check(read(path.join(directory, 'cgroup.procs')).split('\n').includes(String(process.pid)), 'UNKNOWN', 'Command process did not enter its cgroup');
  }
  function availableMemory() {
    let available = os.freemem();
    // Both machine free memory and any node subtree memory ceiling constrain admission.
    try {
      const ceiling = read(path.join(cgroup_root, 'memory.max'));
      if (ceiling !== 'max') available = Math.min(available, Math.max(0, Number(ceiling) - Number(read(path.join(cgroup_root, 'memory.current')))));
    } catch { /* Memory controller may not be delegated; machine reserve still applies. */ }
    return available;
  }
  return { preflight, prepare, verify, populated, stop, attach, availableMemory };
}
