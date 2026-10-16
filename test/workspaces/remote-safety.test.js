import { test, expect } from 'bun:test';
import { RunnerClient } from '../../src/runner/client.js';
import { hash } from '../../src/runner/protocol.js';
import { TRANSFER_LIMIT, TRANSFER_CHUNK } from '../../src/runner/artifact-transfer.js';
import { assertions, bundle, quarantine } from '../../src/core/workspaces/remote-transfer.js';
import { remoteFixture, command, git } from './remote-harness.js';

const commitScript = "printf new > new.txt; git add new.txt; git -c user.name=T -c user.email=t@t commit -m new >/dev/null; git rev-parse HEAD";

test('blocked network transfer never holds the central Git queue; guard and ref drift reject publication', async () => {
  const f = await remoteFixture();
  let release;
  try {
    const worker = await f.worker(), commit = await command(worker.client, commitScript);
    const original = worker.client.call.bind(worker.client);
    let announce; const reached = new Promise(resolve => { announce = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    worker.client.call = async (method, params, options) => {
      if (method === 'artifact.download') { announce(); await blocked; }
      return original(method, params, options);
    };
    const receiving = f.workspaces.receiveRemoteCommit({ ...worker.options, request_id: 'blocked-network', old_commit: worker.commit, original_commit: worker.commit, commit });
    const outcome = receiving.then(value => ({ value }), error => ({ error }));
    await reached;
    let timeout;
    const completed = await Promise.race([
      f.workspaces.exclusive(async () => {
        await f.workspaces.git(f.project, 'update-ref', 'refs/heads/independent', worker.commit);
        const tree = await git(f.project, 'rev-parse', `${worker.commit}^{tree}`);
        const moved = await git(f.project, 'commit-tree', tree, '-p', worker.commit, '-m', 'external movement');
        await f.workspaces.git(f.project, 'update-ref', `refs/heads/${worker.task.branch}`, moved, worker.commit);
        return true;
      }),
      new Promise(resolve => { timeout = setTimeout(() => resolve(false), 1500); }),
    ]);
    clearTimeout(timeout); release();
    const result = await outcome;
    expect(completed).toBe(true);
    expect(result.error?.message).toContain('ref drifted');
    expect(f.store.runnerBinding(worker.task.id).head_commit).toBe(worker.commit);
  } finally { release?.(); await f.close(); }
});

test('wrong generation, changed guard, missing ancestry, invalid bundle and missing objects fail closed', async () => {
  const f = await remoteFixture();
  try {
    const worker = await f.worker();
    await expect(f.workspaces.inspectRemoteWorkspace({ ...worker.options, identity: { ...worker.options.identity, generation: 2 }, request_id: 'wrong-gen' })).rejects.toThrow('generation');
    await expect(f.workspaces.inspectRemoteWorkspace({ ...worker.options, guard() { throw new Error('revoked guard'); }, request_id: 'guard' })).rejects.toThrow('revoked guard');
    await expect(quarantine(f.workspaces, Buffer.from('not a bundle'), worker.commit, worker.commit, () => {})).rejects.toThrow();
    await bundle(f.workspaces, worker.commit, async object => {
      await expect(quarantine(f.workspaces, object.bytes.subarray(0, object.bytes.length - 20), worker.commit, worker.commit, () => {})).rejects.toThrow();
      await expect(quarantine(f.workspaces, object.bytes, 'f'.repeat(40), worker.commit, () => {})).rejects.toThrow();
      await expect(quarantine(f.workspaces, object.bytes, worker.commit, 'e'.repeat(40), () => {})).rejects.toThrow('ancestry');
    });
    expect(await git(f.project, 'rev-parse', worker.task.branch)).toBe(worker.commit);
  } finally { await f.close(); }
});

test('control-only transfer enforces digest, bounded pages, request identity, ownership and literal artifact IDs', async () => {
  const f = await remoteFixture();
  try {
    const worker = await f.worker();
    const bytes = Buffer.alloc(TRANSFER_CHUNK + 7, 21), sha256 = hash(bytes);
    const first = { artifact_id: 'large-bounded', size: bytes.length, sha256, offset: 0, data: bytes.subarray(0, TRANSFER_CHUNK).toString('base64') };
    expect((await worker.client.call('artifact.upload', first, { request_id: 'chunk-one' })).complete).toBe(false);
    expect((await worker.client.call('artifact.upload', first, { request_id: 'chunk-one' })).received).toBe(TRANSFER_CHUNK);
    await expect(worker.client.call('artifact.upload', { ...first, data: 'AA==' }, { request_id: 'chunk-one' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await worker.client.call('artifact.upload', { ...first, offset: TRANSFER_CHUNK, data: bytes.subarray(TRANSFER_CHUNK).toString('base64') });
    const page = await worker.client.call('artifact.download', { artifact_id: first.artifact_id, expected_sha256: sha256, offset: TRANSFER_CHUNK });
    expect(Buffer.from(page.data, 'base64')).toEqual(bytes.subarray(TRANSFER_CHUNK));
    await expect(worker.client.call('artifact.download', { artifact_id: first.artifact_id, expected_sha256: sha256, path: '/etc/passwd' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(worker.client.call('artifact.upload', { ...first, artifact_id: 'too-large', size: TRANSFER_LIMIT + 1 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(worker.client.call('artifact.upload', { ...first, artifact_id: '../escape' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    const other = new RunnerClient({ transport: worker.client.transport,
      identity: { ...worker.client.identity, worker_id: worker.task.id + 100, workspace_id: 'other-owner' },
      auth: { machine_token: hash('machine'), control_token: hash('control') } });
    await other.handshake(); await other.call('workspace.register');
    // Same installation and database: the registered object still belongs only to its first workspace.
    await expect(other.call('artifact.download', { artifact_id: first.artifact_id, expected_sha256: sha256 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const run_token = hash('control-gates'); await worker.client.call('lease.grant', { run_id: 1, run_token });
    const run = worker.client.forRun({ run_id: 1, run_token });
    await expect(run.call('artifact.upload', { ...first, artifact_id: 'run-upload' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(run.call('workspace.git.export', { steps: assertions(worker.task.branch, worker.commit) })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await worker.client.call('lease.release');
  } finally { await f.close(); }
});

test('read seam fixes HEAD/content and never falls back locally; unsafe Git paths, dirty final delivery and stale request are rejected', async () => {
  const f = await remoteFixture();
  try {
    const worker = await f.worker();
    const content = await worker.client.call('file.read', { path: 'file.txt' });
    const read = await f.workspaces.readRemoteFile({ ...worker.options, request_id: 'read-seam' }, { path: 'file.txt', expected_head: worker.commit, expected_sha256: content.sha256 });
    expect(read.source).toBe('runner'); expect(read.sha256).toBe(content.sha256);
    await expect(f.workspaces.readRemoteFile({ ...worker.options, request_id: 'stale-read' }, { path: 'file.txt', expected_head: worker.commit, expected_sha256: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'STALE' });
    await expect(worker.client.call('workspace.git.apply', { steps: [{ argv: ['fetch', '--no-tags', '--no-write-fetch-head', '/tmp/other', worker.commit] }] })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    const context = await worker.client.call('file.context', { path: 'dirty.txt' });
    await worker.client.call('file.write', { path: 'dirty.txt', content: 'dirty', expected_sha256: null, context_ack: context.fingerprint });
    await expect(f.workspaces.receiveRemoteCommit({ ...worker.options, request_id: 'dirty-final', commit: worker.commit, old_commit: worker.commit,
      original_commit: worker.commit, final_delivery: true, agent_exited: true })).rejects.toMatchObject({ code: 'STALE' });
    await worker.client.close();
    await expect(f.workspaces.readRemoteFile({ ...worker.options, request_id: 'offline' }, { path: 'file.txt', expected_head: worker.commit, expected_sha256: content.sha256 })).rejects.toThrow();
  } finally { await f.close(); }
});
