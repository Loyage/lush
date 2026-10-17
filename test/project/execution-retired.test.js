import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, until } from '../helpers.js';
import { Store } from '../../src/persistence/store.js';
import { Project } from '../../src/core/project.js';
import { PiProvider, CodexProvider } from '../../src/agent/provider.js';
import { packGraph, GRAPH_BYTE_BUDGET } from '../../src/core/project/graph-pages.js';

// Deliberately pre-pin schema: retirement detection must not require a migration.
function legacy(store, workerId, state = 'unknown') {
  store.run('CREATE TABLE IF NOT EXISTS runner_bindings(worker_id INTEGER PRIMARY KEY,node_id TEXT,state TEXT)');
  store.run('INSERT INTO runner_bindings VALUES (?,?,?)', workerId, 'old-node', state);
}
const snapshot = store => Object.fromEntries(['tasks', 'agent_runs', 'runner_bindings', 'events', 'messages'].map(table =>
  [table, store.all(`SELECT * FROM ${table} ORDER BY rowid`)]));
const profile = { agent: 'pi', config_mode: 'pi', model: '', thinking: '', extensions: [], skills: [], default_prompt: '', append_prompt: '', soft_budget: {} };

test('fresh Store has no Runner schema and new orders/children always use independent local worktrees', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    f.store.run("INSERT INTO meta(key,value) VALUES ('runner_project_v1',?)", JSON.stringify({ default_node_id: 'obsolete-node' }));
    const { task } = await f.project.order('local order');
    const child = await f.project.spawn(task.id, 'local child');
    for (const worker of [task, child]) {
      expect(worker.workspace.startsWith(path.join(f.config.home, 'worktrees') + path.sep)).toBe(true);
      expect(fs.existsSync(path.join(worker.workspace, '.git'))).toBe(true);
      expect(f.project.decorate([worker])[0].execution_retired).toBeUndefined();
    }
    expect(child.workspace).not.toBe(task.workspace);
    expect(f.store.all("SELECT name FROM sqlite_master WHERE name LIKE 'runner_%'")).toEqual([]);
    await expect(f.project.order('old selector', null, [], null, false, undefined, null, false, 'local')).rejects.toThrow(/retired/);
    await expect(f.project.spawn(task.id, 'old selector', undefined, [], null, null, 'local')).rejects.toThrow(/retired/);
    await expect(f.project.emitBufferedInput({ content: 'old selector', runner_node_id: 'local' })).rejects.toThrow(/retired/);
  } finally { await f.close(); }
});

test('saved obsolete draft placement is inert for both queued emission and create-only submission without rewriting history', async () => {
  const f = fixture({ async run() { return 'local result'; } }); f.project.stopping = true; await repo(f.root);
  try {
    const automatic = await f.project.addBufferedDraft('emit saved draft', [], 'main');
    const createOnly = await f.project.addBufferedDraft('only create saved draft', [], 'main');
    const saved = JSON.stringify({ mode: 'order', conditions: [], exclusive: false, runner_node_id: '9cf0af51-79b6-4874-8e11-eaa9cc5bd55d' });
    for (const draft of [automatic, createOnly]) f.store.run('UPDATE drafts SET input_options=? WHERE id=?', saved, draft.id);
    await f.project.emitBufferedInput({ draft_id: automatic.id, expected_revision: automatic.revision });
    const created = await f.project.submitBufferedDraft(createOnly.id, createOnly.revision, false);
    expect(created.task.status).toBe('paused');
    expect(fs.existsSync(created.task.workspace)).toBe(true);
    f.project.stopping = false; f.project.kick();
    await until(() => f.project.inputEmissionResult(automatic.id).dispatch.state === 'succeeded');
    const workerId = f.project.inputEmissionResult(automatic.id).dispatch.worker_id;
    await until(() => f.store.task(workerId).result === 'local result' && !f.project.running.size);
    for (const draft of [automatic, createOnly]) expect(f.store.draft(draft.id).input_options).toBe(saved);
    expect(f.store.all("SELECT name FROM sqlite_master WHERE name LIKE 'runner_%'")).toEqual([]);
  } finally { await f.close(); }
});

test('legacy binding (including removed) blocks execution, mutation, Git, code fallback, reclamation and deletion', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    for (const state of ['unknown', 'removed']) {
      const { task } = await f.project.order('preserve legacy ' + state, null, [], null, false);
      f.store.update(task.id, { status: 'failed' }); legacy(f.store, task.id, state);
      const before = snapshot(f.store), file = fs.readFileSync(path.join(task.workspace, 'file.txt'), 'utf8');
      expect(f.project.decorate([f.store.task(task.id)])[0]).toMatchObject({ execution_retired: true });
      expect(f.project.inspect(task.id).execution_retired).toBe(true);
      for (const call of [() => f.project.retry(task.id), () => f.project.cancel(task.id), () => f.project.message(task.id, 'do not append'),
        () => f.project.resumeTask(task.id), () => f.project.renameTask(task.id, 'do not rename'),
        () => f.store.update(task.id, { status: 'queued' }), () => f.store.deleteTasks([task.id]), () => f.store.purge()])
        expect(call).toThrow(/retired/);
      for (const call of [() => f.project.spawn(task.id, 'no child'), () => f.project.requestTaskMerge(task.id),
        () => f.project.acceptTask(task.id), () => f.project.reopenTask(task.id), () => f.project.syncTaskParent(task.id),
        () => f.project.codeState(task.id), () => f.project.workspaces.codeFile(task, { path: 'file.txt' }),
        () => f.project.diff(task.id), () => f.project.workspaces.runHookCommand(task, 'exit 99', () => true),
        () => f.project.workspaces.dropBranch(task), () => f.project.workspaces.archiveBranch(task.branch),
        () => f.project.workspaces.release(task), () => f.project.workspaces.forkTaskUnsafe(task, 'main', task.base_commit),
        () => f.project.workspaces.ensure(task), () => f.project.workspaces.finish(task),
        () => f.project.workspaces.cleanup(task.id), () => f.project.workspaces.cleanup(task.id, { keepBranch: true }),
        () => f.project.workspaces.removeBaseline(task.id)]) await expect(Promise.resolve().then(call)).rejects.toThrow(/retired/);
      const preview = await f.project.deleteTaskPreview(task.id);
      expect(preview.can_delete).toBe(false); expect(preview.blockers.join(' ')).toMatch(/retired/);
      await expect(f.project.deleteTask(task.id, { confirm: true, revision: preview.revision, force: true })).rejects.toThrow(/retired/);
      expect(snapshot(f.store)).toEqual(before);
      expect(fs.readFileSync(path.join(task.workspace, 'file.txt'), 'utf8')).toBe(file);
    }
  } finally { await f.close(); }
});

test('restart preserves legacy Run/Worker/Hook facts, skips queued remote work, and local scheduling and maintenance still settle', async () => {
  const calls = [], f = fixture({ async run({ task }) { calls.push(task.id); return 'local only'; } });
  f.project.stopping = true; await repo(f.root);
  try {
    const { task: old } = await f.project.order('orphan remote');
    const { task: queued } = await f.project.order('queued remote');
    f.store.startRun(old, profile); f.store.update(old.id, { status: 'running', calls: 1, hooks: JSON.stringify({ version: 1,
      mounts: [{ id: 'legacy-scheduled', enabled: true, state: 'waiting', schedule: { kind: 'once' },
        next_run_at: '2000-01-01T00:00:00.000Z', actions: [{ type: 'notify', title: 'must not fire', body: 'legacy' }] }], observed: {} }) });
    legacy(f.store, old.id); legacy(f.store, queued.id);
    f.store.run('CREATE TABLE runner_runs(run_id INTEGER,worker_id INTEGER,state TEXT)');
    f.store.run('INSERT INTO runner_runs VALUES (1,?,?)', old.id, 'active');
    f.store.run('CREATE TABLE runner_receipts(worker_id INTEGER,state TEXT,terminal INTEGER)');
    f.store.run('INSERT INTO runner_receipts VALUES (?,?,0)', old.id, 'unknown');
    const original = snapshot(f.store), dbPath = path.join(f.config.home, 'project.db');
    const reopened = new Store(dbPath, f.root), project = new Project(f.config, reopened, f.project.provider);
    try {
      project.recover();
      expect(reopened.all('SELECT * FROM tasks WHERE id IN (?,?) ORDER BY id', old.id, queued.id)).toEqual(original.tasks.filter(row => [old.id, queued.id].includes(row.id)));
      expect(reopened.all('SELECT * FROM agent_runs WHERE task_id=?', old.id)).toEqual(original.agent_runs);
      const sent = await project.order('new local after retirement');
      await until(() => reopened.task(sent.task.id).result === 'local only' && !project.running.size);
      expect(calls).toEqual([sent.task.id]);
      for (const table of ['tasks', 'agent_runs', 'runner_bindings', 'events', 'messages']) {
        const retained = snapshot(reopened)[table].filter(row => original[table].some(oldRow => oldRow.id === row.id && (table !== 'runner_bindings' || oldRow.worker_id === row.worker_id)));
        if (table === 'runner_bindings') expect(snapshot(reopened)[table]).toEqual(original[table]);
        else for (const row of original[table].filter(row => row.task_id === old.id || row.task_id === queued.id || row.id === old.id && table === 'tasks' || row.id === queued.id && table === 'tasks'))
          expect(retained.find(now => now.id === row.id)).toEqual(row);
      }
      project.interruptAll({ notify_completion: false });
      await until(() => project.maintenanceView().ready_to_restart);
      expect(await project.shutdown()).toEqual({ stopped: true, unknown: false });
      expect(reopened.all('SELECT * FROM runner_runs')).toEqual([{ run_id: 1, worker_id: old.id, state: 'active' }]);
    } finally { await project.shutdown(); reopened.close(); }
  } finally { await f.close(); }
});

test('legacy convergence membership cannot resume, publish, or mutate its retained delivery', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const { task } = await f.project.order('old convergence source');
    const run = f.store.createDeliveryRun({ parent_id: task.parent_id, target_branch: 'main', baseline: task.base_commit,
      members: [{ task_id: task.id, delivery_id: 1, enqueue_seq: 1, source_branch: task.branch, source_commit: task.base_commit }],
      data: { verification_mode: 'agent' } });
    f.store.update(task.id, { status: 'waiting', head_commit: task.base_commit,
      reservation: JSON.stringify({ version: 3, kind: 'merge', parent_id: task.parent_id, status: 'requested', run_id: run.id, generation: run.generation }) });
    f.store.updateDeliveryRun(run.id, { state: 'validating' }); legacy(f.store, task.id);
    const before = snapshot(f.store), delivery = f.store.deliveryRun(run.id);
    f.project.recoverConvergence(); f.project.stopping = false;
    await f.project.driveConvergence(task.parent_id);
    expect(f.project.startConvergenceJob(run.id)).toBe(false);
    expect(f.project.convergenceCanPublish(delivery)).toBe(false);
    expect(() => f.project.assertConvergenceRun(run.id, run.generation)).toThrow(/retired/);
    expect(() => f.project.setConvergenceState(run.id, run.generation, 'preparing')).toThrow(/retired/);
    expect(f.store.deliveryRun(run.id)).toEqual(delivery); expect(snapshot(f.store)).toEqual(before);
    expect(f.project.maintenanceView().pending_operations).toBe(0);
  } finally { await f.close(); }
});

test('live Worker read models keep retirement visible in lists, graphs, relations and ladder targets', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const { task: old } = await f.project.order('legacy parent', null, [], null, false);
    const child = await f.project.spawn(old.id, 'legacy child');
    const { task: local } = await f.project.order('local peer', null, [], null, false);
    for (const task of [old, child, local]) f.store.update(task.id, { status: 'failed', integration: 'pending', head_commit: task.base_commit });
    f.store.addDep(local.id, old.id, 'order'); f.store.addDep(child.id, local.id, 'order');
    f.store.update(old.id, { reservation: JSON.stringify({ version: 2, kind: 'merge', queue_protocol: 1,
      parent_id: old.parent_id, status: 'requested', commit: old.base_commit }) });
    legacy(f.store, old.id); legacy(f.store, child.id);
    const before = snapshot(f.store);
    const oldFlag = rows => {
      expect(rows.find(row => row.id === old.id)?.execution_retired).toBe(true);
      expect(rows.find(row => row.id === local.id)?.execution_retired).toBeUndefined();
    };
    oldFlag(f.project.activity().tasks); oldFlag(f.project.taskPage().tasks);
    expect(f.project.tree(old.id).execution_retired).toBe(true);
    expect(f.project.tree(old.id).children[0].execution_retired).toBe(true);
    const detail = f.project.inspect(local.id);
    expect(detail.execution_retired).toBeUndefined();
    expect(detail.deps.find(row => row.id === old.id).execution_retired).toBe(true);
    expect(detail.dependents.find(row => row.id === child.id).execution_retired).toBe(true);
    expect(f.project.taskRelations(child.id).parent.execution_retired).toBe(true);
    expect(f.project.taskRelations(old.id).children.items[0].execution_retired).toBe(true);
    for (const details of [false, true]) {
      const graph = await f.project.taskGraph({ details }); oldFlag(graph.nodes);
      expect(graph.nodes.find(node => node.id === old.parent_id).merge_queue.items.find(item => item.id === old.id).execution_retired).toBe(true);
    }
    const branchGraph = await f.project.graph();
    expect(branchGraph.error).toBeNull(); oldFlag(branchGraph.nodes.filter(node => node.kind === 'task'));
    const ladder = await f.project.ladder(); oldFlag(ladder.nodes);
    const targets = ladder.groups.flatMap(group => group.items); oldFlag(targets);
    const target = targets.find(row => row.id === old.id);
    expect(target.ready).toBe(false); expect(target.selectable).toBe(false);
    expect(target.blockers.some(blocker => blocker.code === 'execution_retired')).toBe(true);
    expect((await f.project.inputParents()).items.some(row => row.id === old.id)).toBe(false);
    expect(snapshot(f.store)).toEqual(before);
  } finally { await f.close(); }
});

test('graph byte-budget fallback retains the retirement safety flag', () => {
  const nodes = [{ id: 1, parent_id: null, execution_retired: true, title: 'x'.repeat(GRAPH_BYTE_BUDGET), status: 'failed' },
    { id: 2, parent_id: null, title: 'local', status: 'waiting' }];
  const page = { filtered: nodes, offset: 0, counts: {}, archived_count: 0, cursorAt: () => null };
  const result = packGraph(nodes, page, nodes.length, true);
  expect(result.nodes[0]).toMatchObject({ id: 1, node_truncated: true, execution_retired: true });
  expect(result.nodes[1].execution_retired).toBeUndefined();
});

test('Provider compatibility arguments cannot revive the removed remote adapter', async () => {
  for (const Provider of [PiProvider, CodexProvider]) {
    const provider = new Provider({});
    await expect(provider.run({ task: {}, remote_workspace: {} })).rejects.toThrow(/retired/);
    await expect(provider.run({ task: { execution_retired: true } })).rejects.toThrow(/retired/);
  }
});
