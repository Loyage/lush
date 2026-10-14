import { setup } from './harness.js';
import { repo } from '../helpers.js';
import { projectRouteId } from '../../src/host/registry.js';
import { saveProjectAppearance } from '../../src/host/project-appearance.js';

/** Real isolated Host -> RPC -> SQLite projection; no scheduler or paid Provider. */
export async function deliveryViewFixture() {
  const f = await setup();
  try {
    f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {}; f.project.scheduleConvergence = () => {};
    f.providerCalls = 0;
    f.project.provider = { run() { f.providerCalls++; throw new Error('fixture forbids model calls'); } };
    await repo(f.root); await f.project.bootstrapMain();
    saveProjectAppearance(f.root, { initialize: true }, { env: f.config.env });
    f.parent = f.store.get("SELECT * FROM tasks WHERE task_kind='main'");
    const commit = f.parent.base_commit;
    const source = title => {
      const row = f.store.create({ role: 'agent', task_kind: 'order', parent_id: f.parent.id, goal: title });
      f.store.update(row.id, { status: 'waiting', branch: `fixture-source-${row.id}`, target_branch: 'main' });
      return f.store.task(row.id);
    };
    f.batches = [];
    for (let i = 0; i < 24; i++) {
      const sources = [source(`来源本轮交付 ${i} · 完整长标题 / narrowScreenUnbrokenText0123456789`.repeat(i === 0 ? 3 : 1))];
      if (i === 0) sources.push(source('同一批次第二来源，保留独立真实父关系'));
      const members = sources.map(row => ({ task_id: row.id, delivery_id: 100 + row.id, enqueue_seq: 100 + row.id,
        source_branch: row.branch, source_commit: commit, base_commit: commit }));
      const run = f.store.createDeliveryRun({ parent_id: f.parent.id, target_branch: 'main', baseline: commit,
        validation: null, data: JSON.stringify({ verification_mode: 'agent' }), members });
      for (const member of members) f.store.update(member.task_id, { reservation: JSON.stringify({ version: 3, kind: 'merge', status: 'requested',
        parent_id: f.parent.id, commit, verification_mode: 'agent', validation: null, delivery_id: member.delivery_id, enqueue_seq: member.enqueue_seq, run_id: run.id, generation: 1 }) });
      f.store.updateDeliveryRun(run.id, { state: i === 0 ? 'blocked' : 'ready', candidate_commit: commit });
      if (i === 0) {
        const helper = f.store.create({ role: 'agent', task_kind: 'integration', parent_id: f.parent.id, goal: '真实整合 Worker · 等待用户决定接口' });
        f.store.update(helper.id, { status: 'awaiting' });
        const node = f.store.createDeliveryNode({ run_id: run.id, generation: 1, node_key: 'conflict-root', state: 'resolving', data: '{}', helper_id: helper.id });
        f.helper = helper; f.node = node; f.focusRun = run;
        f.store.run("UPDATE tasks SET worker_number=NULL WHERE id=?", helper.id);
        f.store.message(sources[0].id, 'BUFFERED_PRIVATE_BODY', null, 'frozen');
        f.sources = sources;
      }
      f.batches.push(run);
    }
    for (let i = 0; i < 22; i++) {
      const row = source(`成功历史 ${i}`);
      f.store.event(row.id, 'task.merge_integrated', { parent_id: f.parent.id, delivery_id: 5000 + row.id, attempt_id: 7000 + row.id, source_commit: commit, commit });
    }
    const intent = source('未固定意图'); f.store.update(intent.id, { reservation: JSON.stringify({ version: 2, kind: 'merge', status: 'pending' }) });
    const serial = source('v2 普通串行交付'); f.store.update(serial.id, { reservation: JSON.stringify({ version: 2, kind: 'merge', status: 'resolving', parent_id: f.parent.id, delivery_id: 9000, attempt_id: 10000, commit }) });
    f.projectId = projectRouteId(f.root); return f;
  } catch (error) { await f.close(); throw error; }
}
export function deliveryDatabase(f) {
  return JSON.stringify(Object.fromEntries(['tasks','events','messages','notices','delivery_runs','delivery_nodes','delivery_members','meta']
    .map(table => [table, f.store.all(`SELECT * FROM ${table} ORDER BY rowid`)])));
}
