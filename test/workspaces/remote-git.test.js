import { test, expect } from 'bun:test';
import { hash } from '../../src/runner/protocol.js';
import { remoteFixture, command, git } from './remote-harness.js';

test('independent Runner repositories receive a live parent commit and seed another node without central editable worktrees', async () => {
  const f = await remoteFixture();
  try {
    const parent = await f.worker();
    const run = f.store.startRun(f.store.update(parent.task.id, { status: 'running' }), { agent: 'mock' });
    const { operation_id, ...base } = parent.options.identity;
    const identity = { ...base, run_id: run.id };
    f.store.authorizeRunnerRun(identity, f.policy.authorization_version);
    const run_token = hash('live-parent');
    await parent.client.call('lease.grant', { run_id: run.id, run_token });
    const runClient = parent.client.forRun({ run_id: run.id, run_token });
    const commit = await command(runClient, "printf 'REMOTE_NEW\n' > remote.txt; git add remote.txt; git -c user.name=Fixture -c user.email=fixture@example.com commit -m new >/dev/null; git rev-parse HEAD");
    expect(commit).not.toBe(parent.commit);
    const context = await runClient.call('file.context', { scope: 'workspace' });
    const active = await runClient.call('command.start', { script: 'printf READY; sleep 30', context_ack: context.fingerprint });
    // Test a running writer, not the fixture's deliberately unprovable pre-bootstrap cancellation window.
    const deadline = Date.now() + 4000;
    while (true) {
      const output = await runClient.call('command.output', { execution_id: active.execution_id });
      if (output.chunks.some(chunk => Buffer.from(chunk.data, 'base64').toString().includes('READY'))) break;
      if (Date.now() > deadline) throw new Error('fixture writer did not start');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await expect(f.workspaces.receiveRemoteCommit({ ...parent.options, identity, request_id: 'receive-busy',
      old_commit: parent.commit, original_commit: parent.commit, commit })).rejects.toMatchObject({ code: 'BUSY' });
    expect((await runClient.call('command.cancel', { execution_id: active.execution_id })).stop_confirmed).toBe(true);
    await expect(f.workspaces.receiveRemoteCommit({ ...parent.options, identity: { ...identity, run_id: run.id + 1 }, request_id: 'wrong-run',
      old_commit: parent.commit, original_commit: parent.commit, commit })).rejects.toThrow();
    const received = await f.workspaces.receiveRemoteCommit({ ...parent.options, identity, request_id: 'receive-live',
      old_commit: parent.commit, original_commit: parent.commit, commit });
    expect(received.state).toBe('accepted');
    expect(f.store.runnerRun(run.id).state).toBe('active');
    expect(await git(f.project, 'rev-parse', parent.task.branch)).toBe(commit);
    expect(await git(f.project, 'show', `${commit}:remote.txt`)).toBe('REMOTE_NEW');
    expect(await f.workspaces.workspaceForBranch(parent.task.branch)).toBeNull();
    await expect(f.workspaces.ensure(parent.task)).rejects.toThrow('local fallback');
    await expect(f.workspaces.finish(parent.task)).rejects.toThrow('exit barrier');
    await expect(f.workspaces.dropBranch(parent.task)).rejects.toThrow('confirmed removed');
    await expect(f.workspaces.archiveBranches([parent.task.branch])).rejects.toThrow('confirmed removed');
    const child = await f.worker(1, parent.task.branch, commit);
    expect((await f.workspaces.inspectRemoteWorkspace({ ...child.options, request_id: 'child-inspect' })).head_commit).toBe(commit);
    expect(await command(child.client, 'cat remote.txt; git remote')).toBe('REMOTE_NEW');
    expect(await git(f.project, 'rev-parse', 'HEAD')).toBe(parent.commit);
    await parent.client.call('lease.release');
    await expect(f.workspaces.receiveRemoteCommit({ ...parent.options, identity, request_id: 'stale-node-lease',
      old_commit: commit, original_commit: parent.commit, commit })).rejects.toMatchObject({ code: 'STALE' });
  } finally { await f.close(); }
});

test('SHA-256 object repositories retain exact format through distribution and reception', async () => {
  const f = await remoteFixture({ sha256: true });
  try {
    const worker = await f.worker();
    expect(worker.commit.length).toBe(64);
    const commit = await command(worker.client, "printf sha256 > format.txt; git add format.txt; git -c user.name=T -c user.email=t@t commit -m format >/dev/null; git rev-parse HEAD");
    const receipt = await f.workspaces.receiveRemoteCommit({ ...worker.options, request_id: 'sha256-receive',
      old_commit: worker.commit, original_commit: worker.commit, commit, final_delivery: true, agent_exited: true });
    expect(receipt.state).toBe('accepted');
    expect(await git(f.project, 'show', `${commit}:format.txt`)).toBe('sha256');
  } finally { await f.close(); }
});
