import { test, expect } from 'bun:test';
import { hash } from '../../src/runner/protocol.js';
import { phaseId } from '../../src/core/workspaces/remote-transfer.js';
import { remoteFixture, command, git } from './remote-harness.js';

const commitScript = "printf recovered > recovered.txt; git add recovered.txt; git -c user.name=T -c user.email=t@t commit -m recovered >/dev/null; git rev-parse HEAD";

test('central CAS before receipt failure reconciles only the exact fixed commit and rejects changed old requests', async () => {
  const f = await remoteFixture();
  try {
    const worker = await f.worker(), commit = await command(worker.client, commitScript);
    const options = { ...worker.options, request_id: 'cas-db-window', old_commit: worker.commit, original_commit: worker.commit, commit };
    const update = f.store.updateRunnerReceipt.bind(f.store);
    let failed = false;
    f.store.updateRunnerReceipt = (...args) => {
      if (args[1].state === 'accepted' && !failed) { failed = true; throw new Error('test crash after Git CAS'); }
      return update(...args);
    };
    await expect(f.workspaces.receiveRemoteCommit(options)).rejects.toThrow('after Git CAS');
    expect(await git(f.project, 'rev-parse', worker.task.branch)).toBe(commit);
    expect(f.store.runnerReceipt(options.request_id).state).toBe('received');
    expect(f.store.runnerBinding(worker.task.id).head_commit).toBe(worker.commit);
    expect((await f.workspaces.receiveRemoteCommit(options)).state).toBe('accepted');
    await expect(f.workspaces.receiveRemoteCommit({ ...options, original_commit: 'f'.repeat(40) })).rejects.toThrow('request changed');
    expect(await git(f.project, 'rev-parse', 'main')).toBe(worker.commit);
  } finally { await f.close(); }
});

test('symbolic central ref cannot redirect reception into another branch', async () => {
  const f = await remoteFixture();
  try {
    const worker = await f.worker();
    await git(f.project, 'symbolic-ref', `refs/heads/${worker.task.branch}`, 'refs/heads/main');
    await expect(f.workspaces.inspectRemoteWorkspace({ ...worker.options, request_id: 'symbolic' })).rejects.toThrow('symbolic');
    expect(await git(f.project, 'rev-parse', 'main')).toBe(worker.commit);
  } finally { await f.close(); }
});

test('failed bundle verification remains an unknown locked request, not a replayable Git operation', async () => {
  const f = await remoteFixture();
  try {
    const worker = await f.worker();
    const bytes = Buffer.from('invalid bundle');
    await worker.client.call('artifact.upload', { artifact_id: 'invalid-bundle', sha256: hash(bytes), size: bytes.length, offset: 0, data: bytes.toString('base64') });
    const params = { steps: [{ argv: ['bundle', 'verify', { artifact_id: 'invalid-bundle' }] }] };
    await expect(worker.client.call('workspace.git.apply', params, { request_id: 'unknown-git' })).rejects.toMatchObject({ code: 'UNKNOWN' });
    expect((await worker.client.call('request.status', { request_id: 'unknown-git' })).state).toBe('unknown');
    await expect(worker.client.call('workspace.git.apply', params, { request_id: 'unknown-git' })).rejects.toMatchObject({ code: 'UNKNOWN' });
    expect((await worker.client.call('workspace.barrier')).stopped).toBe(false);
    await expect(f.workspaces.cleanupRemoteWorkspace({ ...worker.options, request_id: 'unknown-cleanup', head_commit: worker.commit, agent_exited: true })).rejects.toThrow('unknown writers');
  } finally { await f.close(); }
});

test('a mid-transfer guard revocation prevents central publication and source is preserved', async () => {
  const f = await remoteFixture();
  try {
    const worker = await f.worker(), commit = await command(worker.client, commitScript);
    const call = worker.client.call.bind(worker.client); let revoked = false;
    worker.client.call = async (method, ...args) => { const result = await call(method, ...args); if (method === 'artifact.download') revoked = true; return result; };
    await expect(f.workspaces.receiveRemoteCommit({ ...worker.options, guard() { if (revoked) throw new Error('authorization revoked'); },
      request_id: 'revoke-receive', old_commit: worker.commit, original_commit: worker.commit, commit })).rejects.toThrow('authorization revoked');
    expect(await git(f.project, 'rev-parse', worker.task.branch)).toBe(worker.commit);
    expect((await call('request.status', { request_id: phaseId('revoke-receive', 'export') })).state).toBe('completed');
  } finally { await f.close(); }
});
