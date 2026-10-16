import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { check } from '../types.js';
import { hash, stable, RunnerError } from '../../runner/protocol.js';
import { TRANSFER_CHUNK, TRANSFER_LIMIT } from '../../runner/artifact-transfer.js';

// Object generation/validation runs outside the central ref lock, with independent budgets.
async function objectGit(cwd, args, outputFile = null) {
  const child = spawn('git', ['-C', cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', ...args], {
    detached: true, env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file', GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let failure = null, bytes = 0; const chunks = [];
  const kill = reason => { failure ??= reason; try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } };
  child.stdout.on('data', data => { bytes += data.length; if (bytes > 1024 * 1024) kill('object Git output exceeded budget'); else chunks.push(data); });
  child.stderr.on('data', data => { bytes += data.length; if (bytes > 1024 * 1024) kill('object Git diagnostics exceeded budget'); });
  const timer = setTimeout(() => kill('object Git exceeded execution budget'), 10000);
  const sizeTimer = outputFile ? setInterval(() => {
    for (const file of [outputFile, outputFile + '.lock']) {
      try { if (fs.statSync(file).size > TRANSFER_LIMIT) kill('remote bundle exceeds object transfer budget'); } catch { /* not published */ }
    }
  }, 10) : null;
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    check(!failure && code === 0, failure ?? 'Git object verification failed');
    return Buffer.concat(chunks).toString().trim();
  } finally { clearTimeout(timer); clearInterval(sizeTimer); }
}

export const identityKeys = ['project_id', 'node_id', 'runner_id', 'worker_id', 'workspace_id', 'generation'];
export const baseIdentity = value => Object.fromEntries(identityKeys.map(key => [key, value[key]]));
export const oid = value => check(typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value), 'remote Git requires a fixed commit');
export const phaseId = (request, phase) => hash(stable([request, phase]));
export function guarded(owner, options) {
  check(typeof options.guard === 'function', 'remote workspace requires a current synchronous authorization guard');
  check(!options.guard()?.then, 'remote workspace guard must be synchronous');
  const binding = owner.store.runnerBinding(options.identity.worker_id);
  check(binding && identityKeys.every(key => binding[key] === options.identity[key]), 'remote workspace identity or generation changed');
  if (options.identity.run_id !== undefined) owner.store.assertRunnerAuthorization({ ...baseIdentity(options.identity), run_id: options.identity.run_id }, options.authorization_version);
  const client = options.client;
  if (client) check(client.runner_id && identityKeys.every(key => client.identity[key] === options.identity[key])
    && client.identity.operation_id && !client.identity.run_id
    && (options.identity.operation_id === undefined || options.identity.operation_id === client.identity.operation_id),
  'remote workspace requires a pinned control RunnerClient');
  return binding;
}
export async function call(owner, options, method, params, phase) {
  guarded(owner, options);
  const request_id = phaseId(options.request_id, phase);
  const fingerprint = hash(stable({ method, identity: options.client.identity, params }));
  // Explicit receipt reconciliation, never blind replay after a dropped ACK.
  let receipt;
  try { receipt = await options.client.call('request.status', { request_id }); }
  catch (error) { if (error.code !== 'NOT_FOUND') throw error; }
  guarded(owner, options);
  if (receipt) {
    if (receipt.error) throw new RunnerError(receipt.error.code, receipt.error.message);
    check(receipt.state === 'completed', `remote request ${request_id} is unknown; preserve workspace`);
    check(receipt.result?.request_fingerprint === fingerprint, 'remote request id has different parameters');
    return receipt.result;
  }
  const result = await options.client.call(method, params, { request_id });
  guarded(owner, options);
  check(result?.request_fingerprint === fingerprint, 'remote request result does not match fixed parameters');
  return result;
}
export function assertions(branch, commit, clean = false, ignored = false) {
  return [
    { argv: ['symbolic-ref', '--short', 'HEAD'], expect: branch },
    { argv: ['rev-parse', '--verify', 'HEAD'], expect: commit },
    ...(clean ? [{ argv: ['status', '--porcelain=v1', '--untracked-files=all', ...(ignored ? ['--ignored'] : [])], expect: '' }] : []),
  ];
}
export async function bundle(owner, commit, fn) {
  oid(commit);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-remote-objects-'));
  const filename = path.join(directory, 'objects.bundle');
  const ref = `refs/lush/remote-transfers/${randomUUID()}`;
  try {
    await owner.exclusive(() => owner.git(owner.config.project, 'update-ref', ref, commit, '0'.repeat(commit.length)));
    await objectGit(owner.config.project, ['bundle', 'create', filename, ref], filename);
    const size = fs.statSync(filename).size;
    check(size > 0 && size <= TRANSFER_LIMIT, 'remote bundle exceeds object transfer budget');
    const raw = fs.readFileSync(filename), split = raw.indexOf('\n\n');
    check(split > 0 && split < 4096, 'unexpected bundle header');
    // Stable authorized header makes explicit resumption independent of the temporary ref name.
    const header = Buffer.from(raw.subarray(0, split).toString().replace(ref, 'refs/heads/lush-transfer'));
    const bytes = Buffer.concat([header, raw.subarray(split)]);
    return await fn({ bytes, sha256: hash(bytes), size: bytes.length });
  } finally {
    await owner.exclusive(() => owner.git(owner.config.project, 'update-ref', '-d', ref, commit));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
export async function upload(owner, options, object, artifact_id) {
  for (let offset = 0; offset < object.size; offset += TRANSFER_CHUNK) {
    await call(owner, options, 'artifact.upload', { artifact_id, sha256: object.sha256, size: object.size, offset,
      data: object.bytes.subarray(offset, offset + TRANSFER_CHUNK).toString('base64') }, `upload:${artifact_id}:${offset}`);
  }
  return { artifact_id };
}
export async function download(owner, options, artifact) {
  check(artifact && /^[a-f0-9]{64}$/.test(artifact.sha256) && Number.isSafeInteger(artifact.size)
    && artifact.size > 0 && artifact.size <= TRANSFER_LIMIT, 'invalid remote artifact digest or size');
  const pages = []; let offset = 0;
  while (offset < artifact.size) {
    guarded(owner, options);
    const page = await options.client.call('artifact.download', { artifact_id: artifact.artifact_id, expected_sha256: artifact.sha256, offset });
    guarded(owner, options);
    const bytes = Buffer.from(page.data, 'base64');
    check(page.artifact_id === artifact.artifact_id && page.sha256 === artifact.sha256 && page.size === artifact.size && page.offset === offset
      && bytes.length > 0 && bytes.length <= TRANSFER_CHUNK && page.next_offset === offset + bytes.length && page.next_offset <= artifact.size,
    'remote artifact page does not match fixed object');
    pages.push(bytes); offset = page.next_offset;
  }
  const bytes = Buffer.concat(pages);
  check(bytes.length === artifact.size && hash(bytes) === artifact.sha256, 'remote artifact digest mismatch');
  return bytes;
}
export async function quarantine(owner, bytes, commit, original, fn) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-remote-candidate-'));
  const filename = path.join(directory, 'objects.bundle'), repository = path.join(directory, 'repo');
  try {
    fs.writeFileSync(filename, bytes, { mode: 0o600 }); fs.mkdirSync(repository);
    await objectGit(repository, ['init', '--bare', `--object-format=${commit.length === 64 ? 'sha256' : 'sha1'}`]);
    await objectGit(repository, ['bundle', 'verify', filename]); // Reject missing prerequisites in an independent object store.
    await objectGit(repository, ['-c', 'fetch.fsckObjects=true', 'fetch', '--no-tags', '--no-write-fetch-head', filename, `${commit}:refs/heads/candidate`]);
    await objectGit(repository, ['fsck', '--strict', '--no-reflogs', commit]);
    check(await objectGit(repository, ['rev-parse', '--verify', 'refs/heads/candidate^{commit}']) === commit, 'bundle does not contain exact commit');
    let ancestor = false;
    try { await objectGit(repository, ['merge-base', '--is-ancestor', original, commit]); ancestor = true; } catch { /* not retained */ }
    check(ancestor, 'remote commit lost original source ancestry');
    return await fn(repository);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
