import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash } from '../../src/runner/protocol.js';
import { RunnerClient } from '../../src/runner/client.js';
import { RunnerToolBridge, RemoteBridgeClient } from '../../src/agent/remote-bridge.js';
import { REMOTE_PI_VERSION, REMOTE_RUNNER_METHODS } from '../../src/agent/remote-contract.js';
import { remoteFixture, git, command } from './remote-harness.js';

// Integration of the independently delivered Workspaces and Bridge seams, not Project scheduling or SSH/cgroup proof.
test('Run Bridge commit feeds guarded central reception and another node, then lease release gates resource cleanup', async () => {
  const f = await remoteFixture(); let bridge;
  try {
    const parent = await f.worker();
    const run = f.store.startRun(f.store.update(parent.task.id, { status: 'running' }), { agent: 'mock' });
    const { operation_id, ...base } = parent.options.identity;
    const identity = { ...base, run_id: run.id };
    const authorization = f.store.authorizeRunnerRun(identity, f.policy.authorization_version);
    const run_token = hash('bridge-workspaces-run');
    await parent.client.call('lease.grant', { run_id: run.id, run_token });
    const runClient = parent.client.forRun({ run_id: run.id, run_token });
    const workspace = await parent.client.call('workspace.inspect');
    const control = path.join(f.root, 'bridge-control'); fs.mkdirSync(control, { mode: 0o700 });
    const token = randomUUID();
    bridge = new RunnerToolBridge({ client: runClient, identity, token, path: workspace.directory,
      authorize({ identity: current, token: currentToken }) {
        expect(currentToken).toBe(token);
        f.store.assertRunnerAuthorization(current, authorization.authorization_version);
      },
      cooperate() { throw new Error('Collaboration is outside this Workspaces integration test'); },
      control: { directory: control, resources: {} },
    });
    await bridge.listen(path.join(control, 'bridge.sock'));
    const rpc = new RemoteBridgeClient({ version: 1, runner_protocol: 1, pi_version: REMOTE_PI_VERSION,
      socket: bridge.socket, identity, path: workspace.directory }, token);
    const context = await rpc.call('context');
    const result = await rpc.call('tool', { name: 'bash', args: { context_ack: context.fingerprint,
      command: "printf BRIDGE_COMMIT > from-bridge.txt; git add from-bridge.txt; git -c user.name=Fixture -c user.email=fixture@example.com commit -m bridge >/dev/null; git rev-parse HEAD" } });
    expect(result.isError).toBe(false);
    const commit = result.content[0].text.split('\n')[0]; expect(commit).toMatch(/^[a-f0-9]{40}$/);
    expect(REMOTE_RUNNER_METHODS).not.toContain('workspace.git.export');
    await expect(rpc.call('workspace.git.export')).rejects.toThrow('not allowlisted');
    await expect(runClient.call('workspace.git.export', {})).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const received = await f.workspaces.receiveRemoteCommit({ ...parent.options, identity, request_id: 'bridge-live-receive',
      old_commit: parent.commit, original_commit: parent.commit, commit });
    expect(received.state).toBe('accepted');
    expect(f.store.runnerRun(run.id).state).toBe('active');
    expect(await git(f.project, 'rev-parse', parent.task.branch)).toBe(commit);
    const child = await f.worker(1, parent.task.branch, commit);
    expect(await command(child.client, 'cat from-bridge.txt')).toBe('BRIDGE_COMMIT');
    // Bridge stop/drain does not release the Run lease and is not final delivery by itself.
    expect((await bridge.close()).stopped).toBe(true);
    await expect(f.workspaces.inspectRemoteWorkspace({ ...parent.options, request_id: 'before-release', require_no_lease: true }))
      .rejects.toMatchObject({ code: 'BUSY' });
    const stopped = await parent.client.call('lease.release');
    f.store.releaseRunnerRun(identity, authorization.revision, { stopped: stopped.stopped });
    f.store.finishRun(run.id, 'completed');
    f.store.update(parent.task.id, { status: 'awaiting_acceptance' });
    expect((await f.workspaces.receiveRemoteCommit({ ...parent.options, request_id: 'bridge-final-receive',
      old_commit: commit, original_commit: parent.commit, commit, final_delivery: true, agent_exited: true })).state).toBe('accepted');
    // A distinct control workflow needs its own operation_id; the Store never broadens a prior object operation into cleanup.
    const cleanupClient = new RunnerClient({ transport: parent.client.transport,
      identity: { ...base, operation_id: 'bridge-resource-reclamation' },
      auth: { machine_token: hash('machine'), control_token: hash('control') } });
    await cleanupClient.handshake();
    expect((await f.workspaces.cleanupRemoteWorkspace({ ...parent.options, client: cleanupClient, identity: cleanupClient.identity,
      request_id: 'bridge-cleanup', head_commit: commit, agent_exited: true })).state).toBe('removed');
    expect((await parent.client.call('workspace.inspect')).state).toBe('removed');
  } finally { await bridge?.close(); await f.close(); }
});
