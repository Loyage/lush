import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCgroupController, commandGroupName } from '../../src/runner/cgroup.js';
import { RunnerNode } from '../../src/runner/node.js';
import { createCommandService } from '../../src/runner/commands.js';
import { hash } from '../../src/runner/protocol.js';

test('production refuses absent, filesystem fake and undelegated root without fallback', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-cgroup-reject-'));
  try {
    const fake = path.join(root, 'fake'); fs.mkdirSync(fake);
    for (const file of ['cgroup.procs', 'cgroup.kill', 'cgroup.events', 'cgroup.type']) fs.writeFileSync(path.join(fake, file), file === 'cgroup.type' ? 'domain\n' : '');
    for (const cgroup_root of [undefined, '/sys/fs/cgroup', path.join(root, 'absent'), fake]) {
      const controller = createCgroupController({ cgroup_root, node_id: 'node' });
      expect(() => controller.preflight()).toThrow();
    }
    const node = new RunnerNode({ root: path.join(root, 'node'), node_id: 'node', cgroup_root: fake,
      machine_token_hash: hash(hash('fixture-machine')), projects: { p: { control_token_hash: hash(hash('fixture-control')) } } });
    const command = createCommandService({ store: node.store, config: node.config });
    node.services = { ...command.services, check_context() {} }; node.preflight = command.preflight;
    const session = node.openSession();
    const request = method => ({ version: 1, request_id: method, method,
      identity: { project_id: 'p', node_id: 'node', runner_id: node.runner_id, worker_id: 1, workspace_id: 'w1', generation: 1, operation_id: 'op' },
      auth: { machine_token: hash('fixture-machine'), control_token: hash('fixture-control') }, params: {} });
    try {
      expect((await node.dispatch(request('hello'), session)).error.code).toBe('UNSUPPORTED');
      await node.dispatch(request('workspace.register'), session);
      const start = request('command.start'); start.params = { script: 'touch escaped' };
      expect((await node.dispatch(start, session)).error.code).toBe('UNSUPPORTED');
      expect(node.store.db.query('SELECT count(*) AS count FROM executions').get().count).toBe(0);
    } finally { await node.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('cgroup namespace binds immutable execution and workspace identities', () => {
  const first = commandGroupName({ workspace_key: 'a', execution_id: 'one' });
  expect(first).toMatch(/^lush-[a-f0-9]{64}$/);
  expect(commandGroupName({ workspace_key: 'b', execution_id: 'one' })).not.toBe(first);
  expect(commandGroupName({ workspace_key: 'a', execution_id: 'two' })).not.toBe(first);
});
