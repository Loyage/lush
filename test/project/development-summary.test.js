import { test, expect } from 'bun:test';
import { fixture } from '../helpers.js';
import { handlers } from '../../src/rpc/handlers/system.js';

const summary = (f, params = {}, actor = null) => handlers['system.summary'].call({ identity: {} }, f.project, params, actor);

test('explicit development summary uses exact full-project counts, distinct acceptance roles and bounded recent text', async () => {
  const f = fixture();
  try {
    const create = (kind, status, integration = 'none', goal = 'development') => {
      const task = f.store.create({ role: 'agent', goal, task_kind: kind });
      f.store.update(task.id, { status, integration }); return task;
    };
    create('main', 'waiting');
    create('order', 'awaiting_acceptance', 'merged');
    create('child', 'awaiting_acceptance', 'merged');
    create('child', 'failed', 'conflict');
    create('order', 'running', 'merging');
    create('order', 'paused');
    create('management', 'running'); // not a development Worker
    f.store.transaction(() => { for (let i = 0; i < 130; i++) create('say', 'completed', 'pending'); });
    const recent = create('order', 'waiting', 'none', '长'.repeat(1000));
    f.store.setTaskDisplayTitle(recent.id, '自定义标题');
    f.project.running.set(recent.id, {});
    const value = f.project.developmentSummary();
    expect(value).toMatchObject({ workers_total: 137, active: 3, agents_running: 1, awaiting_acceptance: 1,
      parent_confirmation: 1, pending_merges: 130, merging: 1, merge_conflicts: 1 });
    expect(value.counts.find(row => row.status === 'completed').count).toBe(130);
    expect(value.recent_workers).toHaveLength(3);
    expect(value.recent_workers[0]).toMatchObject({ id: recent.id, display_title: '自定义标题', goal: '长'.repeat(200) });
    expect(Object.keys(value.recent_workers[0]).sort()).toEqual(['id','worker_number','display_title','goal','status','integration'].sort());
    f.project.running.clear();
    expect(summary(f)).not.toHaveProperty('development');
    expect(summary(f, { development: false })).not.toHaveProperty('development');
    expect(summary(f, { development: true }).development.workers_total).toBe(137);
    expect(summary(f, { development: true }, 999)).not.toHaveProperty('development');
    expect(() => summary(f, { development: 'yes' })).toThrow('boolean');
  } finally { f.project.running.clear(); await f.close(); }
});

test('empty explicit development summary is truthful zero; normal and Agent summary skip the extra query', async () => {
  const f = fixture();
  try {
    expect(f.project.developmentSummary()).toEqual({ workers_total: 0, active: 0, agents_running: 0,
      awaiting_acceptance: 0, parent_confirmation: 0, pending_merges: 0, merging: 0, merge_conflicts: 0,
      counts: [], recent_workers: [] });
    f.project.developmentSummary = () => { throw Error('must not aggregate'); };
    expect(summary(f)).not.toHaveProperty('development');
    expect(summary(f, { development: true }, 999)).not.toHaveProperty('development');
  } finally { await f.close(); }
});
