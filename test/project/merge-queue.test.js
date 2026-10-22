import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until } from '../helpers.js';

test('child auto-delivery, explicit parent Squash and batch acceptance preserve code and reclaim worktrees', async () => {
  const f = fixture({ resolve() { return { agent: 'mock' }; }, async run({ task, cwd }) {
    if (task.task_kind === 'child') {
      fs.writeFileSync(path.join(cwd, 'feature.txt'), 'delivered code\n');
      await git(cwd, 'add', 'feature.txt'); await git(cwd, 'commit', '-m', 'child feature');
    }
    return 'reviewed result';
  } });
  f.project.stopping = true; await repo(f.root);
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
    await f.project.reserveTask(parent.id, 'merge');
    await until(() => f.store.task(parent.id).integration === 'merged', 12000);
    expect(await git(f.root, 'show', 'main:feature.txt')).toBe('delivered code');
    expect(await git(f.root, 'rev-list', '--count', `${baseline}..main`)).toBe('1');
    expect(f.store.task(parent.id).status).toBe('awaiting_acceptance');
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
  } finally { await f.close(); }
});
