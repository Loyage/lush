import { test, expect } from 'bun:test';
import { fixture, repo } from '../helpers.js';

const phases = ['executing', 'resolving', 'requested', 'suspended', 'blocked'];
test('graph merge summaries count full direct-parent reservations, bound IDs per phase, and never write', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const parent = await f.project.ensureMainTask();
    const add = (status, patch = {}, taskPatch = {}) => {
      const { parent_id = parent.id, ...rest } = taskPatch;
      const task = f.store.create({ role: 'agent', task_kind: 'child', parent_id, goal: 'summary fixture' });
      f.store.update(task.id, { status: 'completed', target_branch: 'main',
        reservation: JSON.stringify({ version: 2, kind: 'merge', queue_protocol: 1, parent_id: parent.id, status, ...patch }), ...rest });
      return task.id;
    };
    const included = [];
    f.store.transaction(() => {
      for (const phase of phases) for (let i = 0; i < 7; i++) included.push(add(phase));
      add('pending'); add('integrated'); add('unknown');
      add('requested', { version: 1 }); add('resolving', { queue_protocol: null });
      add('executing', { parent_id: 99999 }); add('blocked', { kind: 'showcase' });
      add('requested', {}, { parent_id: null });
      add('requested', {}, { reservation: '{invalid' });
      // These recent rows evict every request from the graph window, not the aggregate.
      for (let i = 0; i < 205; i++) add('pending');
    });
    const facts = f.store.all('SELECT id,parent_id,status,reservation FROM tasks');
    const events = f.store.get('SELECT count(*) AS n FROM events').n;
    const graph = await f.project.taskGraph();
    expect(graph.nodes).toHaveLength(200);
    expect(graph.truncated).toBe(true);
    expect(graph.nodes.some(node => included.includes(node.id))).toBe(false);
    const summary = graph.nodes.find(node => node.id === parent.id).merge_queue;
    expect(summary).toMatchObject({ total: 35, truncated: true, limit_per_status: 3,
      counts: { executing: 7, resolving: 7, requested: 7, suspended: 7, blocked: 7 } });
    expect(summary.items).toHaveLength(15);
    expect(JSON.stringify(summary).length).toBeLessThan(1000);
    for (const phase of phases) {
      const items = summary.items.filter(item => item.status === phase);
      expect(items).toHaveLength(3);
      expect(items.map(item => item.id)).toEqual([...items.map(item => item.id)].sort((a, b) => b - a));
    }
    const empty = graph.nodes.find(node => node.id !== parent.id).merge_queue;
    expect(empty).toMatchObject({ total: 0, items: [], truncated: false });
    expect(f.store.all('SELECT id,parent_id,status,reservation FROM tasks')).toEqual(facts);
    expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(events);
  } finally { await f.close(); }
});
