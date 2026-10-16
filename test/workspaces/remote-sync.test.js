import { test, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { Database } from 'bun:sqlite';
import path from 'node:path';
import { hash, stable, RunnerError } from '../../src/runner/protocol.js';
import { phaseId } from '../../src/core/workspaces/remote-transfer.js';
import { remoteFixture, command, git } from './remote-harness.js';

async function landing(f, worker) {
  const old_commit = worker.commit;
  const tree = await git(f.project, 'rev-parse', `${old_commit}^{tree}`);
  const new_commit = await git(f.project, 'commit-tree', tree, '-p', old_commit, '-m', 'central landed squash');
  const options = { ...worker.options, request_id: `sync-${randomUUID()}` };
  const data = { old_commit, new_commit, attempt_id: 1 };
  let receipt = f.store.createRunnerReceipt({ ...options.identity, request_id: options.request_id, kind: 'parent_sync',
    authorization_version: options.authorization_version, params_hash: hash(stable(data)), data });
  await f.workspaces.exclusive(() => f.workspaces.git(f.project, 'update-ref', `refs/heads/${worker.task.branch}`, new_commit, old_commit));
  receipt = f.store.updateRunnerReceipt({ ...options.identity, request_id: options.request_id },
    { state: 'landed', evidence: { head_commit: new_commit, verified: true } }, receipt.revision);
  return { options, old_commit, new_commit, receipt };
}

test('persistent parent sync reconciles lost apply ACK without repeating central landing or remote merge', async () => {
  const f = await remoteFixture();
  try {
    const parent = await f.worker(), sync = await landing(f, parent);
    const original = parent.client.transport.request.bind(parent.client.transport);
    let applies = 0;
    parent.client.transport.request = async (frame, options) => {
      const result = await original(frame, options);
      if (frame.request_id === phaseId(sync.options.request_id, 'sync-apply')) {
        applies++; throw new RunnerError('UNKNOWN', 'test drops completed apply ACK');
      }
      return result;
    };
    await expect(f.workspaces.syncRemoteWorkspace(sync.options)).rejects.toMatchObject({ code: 'UNKNOWN' });
    expect(f.store.runnerReceipt(sync.options.request_id).state).toBe('applying');
    expect(f.store.runnerBinding(parent.task.id).head_commit).toBe(sync.old_commit);
    expect((await parent.client.call('request.status', { request_id: phaseId(sync.options.request_id, 'sync-apply') })).state).toBe('completed');
    const result = await f.workspaces.syncRemoteWorkspace(sync.options);
    expect(result.state).toBe('acknowledged'); expect(applies).toBe(1);
    expect(f.store.runnerBinding(parent.task.id).head_commit).toBe(sync.new_commit);
    expect(await git(f.project, 'rev-parse', parent.task.branch)).toBe(sync.new_commit);
    expect((await f.workspaces.inspectRemoteWorkspace({ ...parent.options, request_id: 'after-sync' })).head_commit).toBe(sync.new_commit);
  } finally { await f.close(); }
});

test('sync preserves dirty or unknown HEAD without resetting the source', async () => {
  const f = await remoteFixture();
  try {
    const worker = await f.worker(), sync = await landing(f, worker);
    await command(worker.client, 'printf dirty > local.txt');
    await expect(f.workspaces.syncRemoteWorkspace(sync.options)).rejects.toThrow('dirty or unknown HEAD');
    expect(await command(worker.client, 'cat local.txt; git rev-parse HEAD')).toBe('dirty' + sync.old_commit);
    expect(f.store.runnerReceipt(sync.options.request_id).state).toBe('landed');
    // Agent explicitly commits its dirty file; sync must not reset the now-divergent source.
    const unexpected = await command(worker.client, 'git add local.txt; git -c user.name=T -c user.email=t@t commit -m unexpected >/dev/null; git rev-parse HEAD');
    await expect(f.workspaces.syncRemoteWorkspace(sync.options)).rejects.toThrow('dirty or unknown HEAD');
    expect((await f.workspaces.inspectRemoteWorkspace({ ...worker.options, request_id: 'unexpected' })).head_commit).toBe(unexpected);
  } finally { await f.close(); }
});

test('cleanup refuses dirty and legacy identities, but reclaims new command homes and the registered repository' , async () => {
  const f = await remoteFixture();
  try {
    const worker = await f.worker();
    const context = await worker.client.call('file.context', { path: 'dirty.txt' });
    await worker.client.call('file.write', { path: 'dirty.txt', content: 'dirty', expected_sha256: null, context_ack: context.fingerprint });
    await expect(f.workspaces.cleanupRemoteWorkspace({ ...worker.options, request_id: 'dirty-cleanup', head_commit: worker.commit, agent_exited: true })).rejects.toMatchObject({ code: 'STALE' });
    expect((await worker.client.call('file.read', { path: 'dirty.txt' })).text).toBe('dirty');
    const unused = await f.worker(1);
    const cleanup = await f.workspaces.cleanupRemoteWorkspace({ ...unused.options, request_id: 'clean-unused', head_commit: unused.commit, agent_exited: true });
    expect(cleanup.state).toBe('removed');
    expect((await unused.client.call('workspace.inspect')).state).toBe('removed');
    await expect(unused.client.call('file.read', { path: 'file.txt' })).rejects.toMatchObject({ code: 'STALE' });
    const commands = await f.worker(1);
    const home = await command(commands.client, 'printf cache > "$HOME/cache"; mkdir "$TMPDIR/tmp"; printf temp > "$TMPDIR/tmp/file"; printf %s "$HOME"');
    expect(fs.existsSync(path.join(home, 'tmp/file'))).toBe(true);
    const cleanupOptions = { ...commands.options, request_id: 'commands-cleanup', head_commit: commands.commit, agent_exited: true };
    expect((await f.workspaces.cleanupRemoteWorkspace(cleanupOptions)).state).toBe('removed');
    expect(fs.existsSync(home)).toBe(false);
    expect((await f.workspaces.cleanupRemoteWorkspace(cleanupOptions)).state).toBe('removed');
    const legacy = await f.worker(1);
    const legacyHome = await command(legacy.client, 'printf %s "$HOME"');
    const config = JSON.parse(fs.readFileSync(legacy.configFile, 'utf8'));
    const db = new Database(path.join(config.root, 'runner.db'));
    try { db.exec("UPDATE executions SET spec_json=json_remove(spec_json,'$.resources_version'); DELETE FROM command_resources"); }
    finally { db.close(); }
    const kept = await f.workspaces.cleanupRemoteWorkspace({ ...legacy.options, request_id: 'partial-cleanup', head_commit: legacy.commit, agent_exited: true });
    expect(kept).toMatchObject({ removed: false, partial: true, reason: 'command_resource_identity_unrecorded' });
    expect(fs.existsSync(legacyHome)).toBe(true);
    expect(f.store.runnerBinding(legacy.task.id).state).toBe('ready');
    expect(f.store.runnerReceipt('partial-cleanup').state).toBe('removing');
  } finally { await f.close(); }
});
