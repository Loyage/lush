import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { posixFiles } from './workspaces/code-posix.js';
import { collectAbiEvidence, elfDependencies } from './runner-deployment-abi.js';
import { OFFICIAL_BUN, obtainOfficialRuntime, officialAbi } from './runner-deployment-official.js';
import { BUNDLE_LIMITS, collectSources, digest, elfAbi, failure, fdPath, openRelative, readSource,
  regular, requireArtifact, runningBunHash, signature, tarSources } from './runner-deployment-package.js';

// This is the executing module's code origin, never cwd, LUSH_PROJECT or another checkout.
const CODE_ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const inode = stat => `${stat.dev}:${stat.ino}`;
// Keep explicit large artifact preparation from starving other Host/daemon work; not a retry/wait loop.
const yieldWork = () => new Promise(resolve => setImmediate(resolve));
const WORK_CHUNK = 16 * 1024 * 1024;
const normalized = value => {
  requireArtifact(typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value && !value.includes('\0'));
  return value;
};

async function verifyArtifactBytes(directory, created, buffer) {
  for (const [file, identity] of created) {
    const fd = posixFiles.openAt(directory, file);
    try {
      requireArtifact(signature(fs.fstatSync(fd, { bigint: true })) === identity.signature);
      const actual = createHash('sha256'); let length = 0, count, nextYield = WORK_CHUNK;
      while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) {
        length += count; requireArtifact(length <= identity.size); actual.update(buffer.subarray(0, count));
        if (length >= nextYield) { nextYield = length + WORK_CHUNK; await yieldWork(); }
      }
      requireArtifact(length === identity.size && actual.digest('hex') === identity.sha256
        && signature(fs.fstatSync(fd, { bigint: true })) === identity.signature);
    } finally { fs.closeSync(fd); }
  }
}

/** Internal-only seams. Callers must never populate these options from RPC/JSON/browser parameters.
 * ABI metadata describes exact central bytes, not a claim that any Linux target is compatible.
 * Source layout is retained for Bun FFI and fixed dynamic command subprocess entrypoints.
 */
export async function buildDeploymentArtifacts(options = {}) { return buildArtifacts(options); }

/** Explicit plan/apply-only entry. Never downloads unless allow_download === true.
 * cache_directory, like the other filesystem options, is server-owned and never an RPC input.
 */
export async function buildOfficialDeploymentArtifacts({ destination = os.tmpdir(), source_root = CODE_ROOT, cache_directory, allow_download = false } = {}) {
  requireArtifact(process.platform === OFFICIAL_BUN.os && process.arch === OFFICIAL_BUN.arch && process.versions.bun === OFFICIAL_BUN.version, 'UNSUPPORTED');
  normalized(destination); normalized(source_root);
  const data = await obtainOfficialRuntime({ cache_directory, allow_download });
  return buildArtifacts({ destination, source_root }, data);
}
async function buildArtifacts({ destination = os.tmpdir(), source_root = CODE_ROOT, bun_path = process.execPath } = {}, official) {
  requireArtifact(process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch) && /^\d+\.\d+\.\d+/.test(process.versions.bun ?? ''), 'UNSUPPORTED');
  let source, base, directory, runtimeParent, runtimeInput, temporary, name, directoryInode, closed = false;
  const created = new Map();
  const close = () => {
    for (const fd of [source, runtimeInput, runtimeParent, directory, base]) if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    source = runtimeInput = runtimeParent = directory = base = undefined;
    closed = true;
  };
  const cleanup = () => {
    if (closed) return;
    try {
      if (directory !== undefined) {
        const check = posixFiles.openAt(base, name, true);
        try { requireArtifact(inode(fs.fstatSync(check, { bigint: true })) === directoryInode); } finally { fs.closeSync(check); }
        // Never recursively remove an arbitrary replacement tree or unexpected caller files.
        for (const [file, identity] of created) {
          const target = `${fdPath(directory)}/${file}`;
          let stat; try { stat = fs.lstatSync(target, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
          requireArtifact(stat.isFile() && inode(stat) === identity.inode); fs.unlinkSync(target);
        }
        fs.rmdirSync(`${fdPath(base)}/${name}`);
      }
      close();
    } catch { throw failure(); }
  };
  function output(file) {
    const fd = fs.openSync(`${fdPath(directory)}/${file}`, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
    fs.fchmodSync(fd, 0o600);
    created.set(file, { inode: inode(fs.fstatSync(fd, { bigint: true })) });
    return fd;
  }
  try {
    source_root = normalized(source_root); destination = normalized(destination); bun_path = normalized(bun_path);
    source = posixFiles.openDirectory(source_root);
    const sourceInode = inode(fs.fstatSync(source, { bigint: true }));
    const snapshots = collectSources(source), tar = tarSources(snapshots), runnerHash = digest(tar);
    const protocol = snapshots.find(row => row.file === 'src/runner/protocol.js')?.data.toString('utf8');
    const version = /export const IMPLEMENTATION_VERSION = '([0-9]+\.[0-9]+\.[0-9]+)';/.exec(protocol ?? '')?.[1];
    requireArtifact(version, 'UNSUPPORTED');
    let runtimeBefore, abi, expectedRuntimeHash;
    if (official) {
      requireArtifact(official.length === OFFICIAL_BUN.size && official.length <= BUNDLE_LIMITS.runtime && digest(official) === OFFICIAL_BUN.sha256);
      abi = officialAbi(); expectedRuntimeHash = OFFICIAL_BUN.sha256;
    } else {
      runtimeParent = posixFiles.openDirectory(path.dirname(bun_path));
      runtimeInput = posixFiles.openAt(runtimeParent, path.basename(bun_path));
      runtimeBefore = fs.fstatSync(runtimeInput, { bigint: true }); regular(runtimeBefore, BUNDLE_LIMITS.runtime);
      requireArtifact((runtimeBefore.mode & 0o111n) !== 0n, 'UNSUPPORTED');
      abi = elfAbi(runtimeInput, Number(runtimeBefore.size));
      if (bun_path === process.execPath) requireArtifact(inode(runtimeBefore) === inode(fs.statSync('/proc/self/exe', { bigint: true })), 'UNSUPPORTED');
      expectedRuntimeHash = bun_path === process.execPath ? null : runningBunHash();
    }
    base = posixFiles.openDirectory(destination);
    const baseInode = inode(fs.fstatSync(base, { bigint: true }));
    const anchored = fs.mkdtempSync(`${fdPath(base)}/lush-runner-deployment-`); name = path.basename(anchored);
    directory = posixFiles.openAt(base, name, true); fs.fchmodSync(directory, 0o700);
    directoryInode = inode(fs.fstatSync(directory, { bigint: true })); temporary = path.join(destination, name);
    // Ephemeral transfer snapshots, not crash-recovery records. Verify every output byte below,
    // but do not force large durable flushes onto the device shared with Runner/receipt journals.
    // Persistent official-cache publication retains its separate fsync requirement.
    const tarOutput = output('runner.tar');
    try {
      fs.writeFileSync(tarOutput, tar);
      Object.assign(created.get('runner.tar'), { signature: signature(fs.fstatSync(tarOutput, { bigint: true })), sha256: runnerHash, size: tar.length });
    } finally { fs.closeSync(tarOutput); }
    const runtimeOutput = output('bun'), hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024); let size = 0;
    try {
      if (official) {
        fs.writeFileSync(runtimeOutput, official); hash.update(official); size = official.length;
        const inspected = elfAbi(runtimeOutput, size), dependencies = elfDependencies(runtimeOutput, size).needed.sort();
        requireArtifact(inspected.interpreter === abi.interpreter && inspected.machine === abi.machine
          && JSON.stringify(dependencies) === JSON.stringify(abi.needed), 'UNSUPPORTED');
      } else {
        let count, nextYield = WORK_CHUNK;
        while ((count = fs.readSync(runtimeInput, buffer, 0, buffer.length, null))) {
          size += count; requireArtifact(size <= Number(runtimeBefore.size) && size <= BUNDLE_LIMITS.runtime);
          const chunk = buffer.subarray(0, count); hash.update(chunk);
          let offset = 0; while (offset < count) { const written = fs.writeSync(runtimeOutput, chunk, offset, count - offset, null); requireArtifact(written > 0); offset += written; }
          if (size >= nextYield) { nextYield = size + WORK_CHUNK; await yieldWork(); }
        }
        requireArtifact(size === Number(runtimeBefore.size) && signature(runtimeBefore) === signature(fs.fstatSync(runtimeInput, { bigint: true })));
      }
      created.get('bun').signature = signature(fs.fstatSync(runtimeOutput, { bigint: true }));
    } finally { fs.closeSync(runtimeOutput); }
    const runtimeHash = hash.digest('hex');
    Object.assign(created.get('bun'), { sha256: runtimeHash, size });
    requireArtifact(expectedRuntimeHash === null || runtimeHash === expectedRuntimeHash, 'UNSUPPORTED');
    await verifyArtifactBytes(directory, created, buffer);
    // Only inspect the verified current executable; never execute a test seam's binary or loader.
    if (!official) Object.assign(abi, collectAbiEvidence(runtimeInput, size, abi));
    // Reopen all names after copying: no file/directory rename, link swap or mixed source tree is accepted.
    const rootCheck = posixFiles.openDirectory(source_root);
    try {
      requireArtifact(inode(fs.fstatSync(rootCheck, { bigint: true })) === sourceInode);
      const baseCheck = posixFiles.openDirectory(destination);
      try { requireArtifact(inode(fs.fstatSync(baseCheck, { bigint: true })) === baseInode); }
      finally { fs.closeSync(baseCheck); }
      for (const before of snapshots) {
        const after = readSource(rootCheck, before.file);
        requireArtifact(before.signature === after.signature && digest(before.data) === digest(after.data));
      }
    } finally { fs.closeSync(rootCheck); }
    if (!official) {
      const runtimeDirectoryCheck = posixFiles.openDirectory(path.dirname(bun_path));
      try {
        requireArtifact(inode(fs.fstatSync(runtimeDirectoryCheck, { bigint: true })) === inode(fs.fstatSync(runtimeParent, { bigint: true })));
        const runtimeCheck = openRelative(runtimeDirectoryCheck, path.basename(bun_path));
        try { requireArtifact(signature(fs.fstatSync(runtimeCheck, { bigint: true })) === signature(runtimeBefore)); }
        finally { fs.closeSync(runtimeCheck); }
      } finally { fs.closeSync(runtimeDirectoryCheck); }
    }
    const outputCheck = posixFiles.openAt(base, name, true);
    try {
      requireArtifact(inode(fs.fstatSync(outputCheck, { bigint: true })) === directoryInode);
      for (const [file, identity] of created) {
        const fd = posixFiles.openAt(outputCheck, file);
        try { requireArtifact(signature(fs.fstatSync(fd, { bigint: true })) === identity.signature); }
        finally { fs.closeSync(fd); }
      }
    } finally { fs.closeSync(outputCheck); }
    for (const fd of [source, runtimeInput, runtimeParent]) if (fd !== undefined) fs.closeSync(fd);
    source = runtimeInput = runtimeParent = undefined;
    return { runtime: { version: official ? OFFICIAL_BUN.version : process.versions.bun, source: official ? 'official-bun' : 'central-bun', os: process.platform, arch: process.arch,
      ...(official ? { provenance: { url: OFFICIAL_BUN.url, digest_url: OFFICIAL_BUN.digest_url, archive_sha256: OFFICIAL_BUN.archive_sha256, documentation: OFFICIAL_BUN.documentation } } : {}),
      abi, sha256: runtimeHash, size, file: path.join(temporary, 'bun') },
    runner: { version, sha256: runnerHash, size: tar.length, file: path.join(temporary, 'runner.tar') },
    files: snapshots.map(row => row.file), cleanup };
  } catch (error) {
    try { cleanup(); } catch { /* Preserve unknown replacement trees; never force-remove them. */ }
    close();
    throw failure(error?.code === 'UNSUPPORTED' ? 'UNSUPPORTED' : 'INVALID_ARTIFACT');
  }
}
