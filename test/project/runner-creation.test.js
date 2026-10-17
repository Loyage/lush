import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fixture, repo, git } from '../helpers.js';
import { hash } from '../../src/runner/protocol.js';

const profile = { agent: 'pi', config_mode: 'lush', model: '', thinking: '', default_prompt: '', append_prompt: '', extensions: [], skills: [] };

test('creation fixes the selected remote node while existing local Workers and their children stay local', async () => {
  const f = fixture({ resolve: () => profile, async run() { throw new Error('creation fixture must not start a Provider'); } });
  await repo(f.root); f.project.kick = () => {};
  const service = f.project.runners;
  const order = node => f.project.order('work', null, [], null, false, undefined, null, false, node);
  try {
    const saved = await service.saveNodes({ nodes: [{ name: 'A', ssh_alias: 'fixture-A', enabled: true,
      expected_runner_id: randomUUID(), budgets: { max_commands: 1, timeout_ms: 1000, output_bytes: 4096 } }] }, service.readNodes().revision);
    const node = saved.nodes[0];
    const policy = (await service.savePolicy({ allowed_node_ids: [node.id], default_node_id: 'local' }, 0)).policy;
    await service.saveCredentials({ node_id: node.id, project_id: policy.project_id,
      machine_token: hash('machine'), control_token: hash('control') }, service.readCredentials().revision);
    const local = (await order()).task;
    await service.savePolicy({ allowed_node_ids: [node.id], default_node_id: node.id }, service.readPolicy().revision);
    const remote = await order();
    expect(remote.task.workspace).toBeNull(); expect(remote.anchor.workspace).toBeNull();
    expect(f.store.runnerBinding(remote.task.id)).toMatchObject({ node_id: node.id, runner_id: node.expected_runner_id, state: 'preparing' });
    expect(f.store.branch(remote.task.branch).worktree).toBeNull();
    expect(await git(f.root, 'rev-parse', remote.task.branch)).toBe(remote.task.base_commit);
    expect(await git(f.root, 'worktree', 'list', '--porcelain')).not.toContain(`branch refs/heads/${remote.task.branch}\n`);
    expect(f.store.runnerBinding(local.id)).toBeNull(); expect(fs.existsSync(local.workspace)).toBe(true);
    const child = await f.project.spawn(local.id, 'inherits local');
    expect(f.store.runnerBinding(child.id)).toBeNull(); expect(child.workspace).toBeTruthy();
    const override = (await order('local')).task;
    expect(override.workspace).toBeTruthy(); expect(f.store.runnerBinding(override.id)).toBeNull();
  } finally { await service.close(); await f.close(); }
});
