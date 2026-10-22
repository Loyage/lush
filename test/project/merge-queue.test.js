import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until, gate } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { RPCServer } from '../../src/rpc/server.js';
import { UIClient } from '../../src/ui/client.js';
import { createSignal } from '../../src/signal.js';

test('child auto-delivery, explicit parent Squash and batch acceptance preserve code and reclaim worktrees', async () => {
  const repairGate = gate(); let repairing = false;
  const f = fixture({ resolve() { return { agent: 'mock' }; }, async run({ task, cwd, api }) {
    const booking = JSON.parse(api.store.task(task.id).reservation ?? 'null');
    if (booking?.status === 'resolving') {
      repairing = true; await repairGate.promise;
      await git(cwd, 'merge', '--no-edit', booking.baseline);
    } else if (task.goal === 'parallel feature') {
      fs.writeFileSync(path.join(cwd, 'parallel.txt'), 'independent code\n');
      await git(cwd, 'add', 'parallel.txt'); await git(cwd, 'commit', '-m', 'parallel feature');
    }
    if (task.task_kind === 'child') {
      fs.writeFileSync(path.join(cwd, 'feature.txt'), 'delivered code\n');
      await git(cwd, 'add', 'feature.txt'); await git(cwd, 'commit', '-m', 'child feature');
    }
    return 'reviewed result';
  } });
  f.project.stopping = true; await repo(f.root);
  const rpc = new RPCServer(f.config.socket, new Dispatcher(f.project, createSignal(), {})); await rpc.start();
  const client = new UIClient(f.config);
  try {
    const parent = (await f.project.order('collect feature')).task;
    f.store.update(parent.id, { status: 'waiting' });
    const child = await f.project.spawn(parent.id, 'implement feature');
    const baseline = await git(f.root, 'rev-parse', 'main');
    f.project.stopping = false; f.project.kick();
    await until(() => f.store.task(child.id).integration === 'merged' &&
      f.store.task(parent.id).calls === 1 && f.store.task(parent.id).status === 'waiting' && !f.project.running.size, 12000);
    expect(await git(parent.workspace, 'show', 'HEAD:feature.txt')).toBe('delivered code');
    expect(await git(f.root, 'rev-parse', 'main')).toBe(baseline);
    expect(fs.existsSync(child.workspace)).toBe(true);
    // A real divergent delivery holds main while independent Worker creation uses its pinned baseline.
    fs.writeFileSync(path.join(f.root, 'main.txt'), 'new main code\n');
    await git(f.root, 'add', 'main.txt'); await git(f.root, 'commit', '-m', 'advance main');
    const repairBaseline = await git(f.root, 'rev-parse', 'main');
    await f.project.reserveTask(parent.id, 'merge');
    await until(() => repairing, 12000);
    expect(f.project.branchFreeze('main').creation_commit).toBe(repairBaseline);
    const graph = await client.request('worker.graph', { details: false });
    expect(graph.nodes.find(row => row.id === parent.parent_id).freeze.creation_commit).toBe(repairBaseline);
    expect(() => f.project.assertBranchWritable('main')).toThrow('frozen');
    expect(() => f.project.assertWorkerCreationAllowed(parent.branch)).toThrow('frozen');
    expect(() => f.project.assertWorkerCreationAllowed('main', 'snapshot', baseline)).toThrow('fixed repair baseline');
    const booking = f.store.task(parent.id).reservation;
    f.store.update(parent.id, { reservation: JSON.stringify({ ...JSON.parse(booking), status: 'blocked' }) });
    expect(() => f.project.assertWorkerCreationAllowed('main')).toThrow('frozen');
    f.store.update(parent.id, { reservation: booking });
    const parallel = (await client.request('worker.create', { mode: 'spawn' })).task;
    expect(parallel).toMatchObject({ status: 'paused', input_id: null, base_commit: repairBaseline, target_branch: 'main' });
    await client.request('worker.message', { id: parallel.id, body: 'parallel feature' });
    const emitted = await client.request('input.emit', { content: 'independent order', branch: 'main', client_request_id: 'repair-snapshot' });
    await until(() => f.project.inputEmissionResult(emitted.draft_id).dispatch.state === 'succeeded', 12000);
    const independent = f.store.task(f.project.inputEmissionResult(emitted.draft_id).dispatch.worker_id);
    expect(independent.base_commit).toBe(repairBaseline);
    await until(() => f.store.task(parallel.id).status === 'waiting' && f.store.task(independent.id).status === 'waiting', 12000);
    await f.project.reserveTask(parallel.id, 'merge');
    await until(() => JSON.parse(f.store.task(parallel.id).reservation).status === 'requested', 12000);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(repairBaseline);
    expect(f.project.activeTaskMerge(parent.parent_id).id).toBe(parent.id);
    expect(f.store.task(parent.id).reservation).toBe(booking);
    repairGate.resolve();
    await until(() => f.store.task(parent.id).integration === 'merged' && f.store.task(parallel.id).integration === 'merged', 12000);
    expect(await git(f.root, 'show', 'main:feature.txt')).toBe('delivered code');
    expect(await git(f.root, 'show', 'main:parallel.txt')).toBe('independent code');
    expect(await git(f.root, 'rev-list', '--count', `${repairBaseline}..main`)).toBe('2');
    expect(f.store.task(parent.id).status).toBe('awaiting_acceptance');
    await f.project.acceptTask(parallel.id);
    await f.project.acceptTask(independent.id);
    const temporary = f.project.createTemporaryAutomation({ hook: { name: '验收告知', trigger: 'worker.accepted', mode: 'persistent', enabled: true,
      actions: [{ type: 'notify', title: 'accepted-hook', body: '保留验收触发与审计' }] },
      expected_revisions: { registry: f.project.hooksList().registry.revision }, client_request_id: 'acceptance-mounts' });
    for (const row of [parent, child]) f.project.attachTaskHook(row.id, { template_id: temporary.template_id, template_version: 1,
      enabled: row.id === parent.id }, f.project.taskHooks(row.id).revision);
    const mounts = () => f.project.hooksList().registry.items;
    expect(mounts().find(item => item.id === temporary.template_id).mount_count).toBe(2);
    // Legacy completed without an acceptance receipt is not accepted.
    f.store.update(child.id, { status: 'completed' });
    expect(mounts().find(item => item.id === 'builtin:completion').mount_count).toBe(2);
    expect(f.project.taskHooks(child.id).mounted_features.completion).toBe(true);
    f.store.update(child.id, { status: 'awaiting_acceptance' });
    const original = new Map([parent, child].map(row => [row.id, f.store.task(row.id).auto_merge]));
    let release;
    f.project.hookQueue = new Promise(resolve => { release = resolve; });
    try {
      await f.project.acceptTask(parent.id);
      for (const id of ['builtin:completion', 'builtin:acceptance-notice', temporary.template_id])
        expect(mounts().find(item => item.id === id)).toMatchObject({ mount_count: 0, targets: [] });
      expect(mounts().find(item => item.id === 'system:delivery-handler')).toMatchObject({ mount_count: 1,
        targets: [{ worker_id: parent.parent_id, worker_number: null, hook_id: 'delivery-handler', version: 1 }] });
      expect(f.project.temporaryAutomationHistory({ id: temporary.template_id }).usage).toMatchObject({
        mount_count: 0, pending_count: 1, running_count: 1, reclaimable: false });
      expect(() => f.project.reclaimTemporaryAutomation({ id: temporary.template_id,
        expected_revision: f.project.hooksList().registry.revision, client_request_id: 'premature-reclaim' })).toThrow('pending, running or unknown');
    } finally { release(); }
    await f.project.hookQueue;
    expect(f.store.get("SELECT count(*) AS n FROM notices WHERE title='accepted-hook'").n).toBe(1);
    expect(f.project.temporaryAutomationHistory({ id: temporary.template_id }).usage).toMatchObject({
      mount_count: 0, attached_total: 2, succeeded_total: 1, reclaimable: true });
    for (const row of [parent, child]) {
      expect(f.store.task(row.id)).toMatchObject({ status: 'completed', integration: 'merged', workspace: null, result: 'reviewed result' });
      expect(fs.existsSync(row.workspace)).toBe(false);
      expect(f.store.branch(row.branch).status).toBe('archived');
      expect(f.project.taskHooks(row.id)).toMatchObject({ mounts: [], can_attach: false,
        mounted_features: { completion: false, acceptance_notice: false, convergence: false, push: false } });
      expect(f.store.task(row.id).auto_merge).toBe(original.get(row.id));
      expect(JSON.parse(f.store.task(row.id).hooks).mounts).toHaveLength(1); // History is retained, not migrated away.
    }
    expect(f.project.reclaimTemporaryAutomation({ id: temporary.template_id,
      expected_revision: f.project.hooksList().registry.revision, client_request_id: 'accepted-reclaim' }).reclaimed).toBe(true);
  } finally { repairGate.resolve(); await rpc.close(); await f.close(); }
});
