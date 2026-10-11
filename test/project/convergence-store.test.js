import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../../src/persistence/store.js';
import { temp } from '../helpers.js';

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
function setup() {
  const root = temp(), file = path.join(root, 'project.db'), store = new Store(file, root);
  const parent = store.create({ input_id: null, role: 'agent', goal: 'main', task_kind: 'main' });
  store.update(parent.id, { branch: 'main', status: 'waiting' });
  const sources = Array.from({ length: 9 }, (_, i) => {
    const task = store.create({ parent_id: parent.id, input_id: null, role: 'agent', goal: `source ${i}`, task_kind: 'child' });
    return store.update(task.id, { branch: `source-${i}`, target_branch: 'main', status: 'waiting' });
  });
  const member = (i, delivery = 100 + i) => ({ task_id: sources[i].id, delivery_id: delivery, enqueue_seq: delivery,
    source_branch: sources[i].branch, source_commit: B, base_commit: A });
  const create = (members = [member(0)], extra = {}) => store.createDeliveryRun({ parent_id: parent.id, target_branch: 'main', baseline: A, validation: null, members, ...extra });
  return { root, file, store, parent, sources, member, create, close() { store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('delivery creation claims immutable ordered snapshots, and release retains history', () => {
  const f = setup(); try {
    const run = f.create([f.member(0), f.member(1)]);
    expect(run).toMatchObject({ state: 'preparing', generation: 1, parent_id: f.parent.id, data: '{}', validation: null });
    expect(f.store.deliveryMembers(run.id).map(member => [member.task_id, member.ordinal, member.active])).toEqual([[f.sources[0].id, 0, 1], [f.sources[1].id, 1, 1]]);
    expect(() => f.create([f.member(0, 200)])).toThrow('claimed');
    expect(f.store.get('SELECT count(*) AS n FROM delivery_runs').n).toBe(1);
    expect(f.store.releaseDeliveryMembers(run.id, f.sources[0].id)).toBe(1);
    expect(f.store.releaseDeliveryMembers(run.id, f.sources[0].id)).toBe(0);
    expect(f.store.deliveryMembers(run.id, true).length).toBe(1);
    expect(f.store.deliveryMembers(run.id).length).toBe(2);
    const next = f.create([f.member(0, 200)]); expect(next.id).toBeGreaterThan(run.id);
    expect(f.store.task(f.sources[0].id).reservation).toBeNull();
  } finally { f.close(); }
});

test('member claim unique indexes survive independent SQLite connections and reject SQL bypass', () => {
  const f = setup(), other = new Store(f.file, f.root); try {
    const run = f.create();
    expect(() => other.createDeliveryRun({ parent_id: f.parent.id, target_branch: 'main', members: [f.member(0, 200)] })).toThrow('claimed');
    expect(() => other.run(`INSERT INTO delivery_members(run_id,task_id,delivery_id,enqueue_seq,source_branch,source_commit,ordinal)
      VALUES (?,?,?,?,?,?,?)`, run.id, f.sources[0].id, 201, 201, 'source-0', B, 1)).toThrow();
    f.store.updateDeliveryRun(run.id, { generation: 2 }, 1);
    expect(() => other.updateDeliveryRun(run.id, { state: 'ready' }, 1)).toThrow('generation changed');
    expect(other.deliveryRun(run.id).state).toBe('preparing');
  } finally { other.close(); f.close(); }
});

test('caller transaction rolls back creation, claims and source reservation together', () => {
  const f = setup(); try {
    expect(() => f.store.transaction(() => {
      f.create(); f.store.update(f.sources[0].id, { reservation: '{"version":3}' }); throw new Error('rollback');
    })).toThrow('rollback');
    expect(f.store.get('SELECT count(*) AS n FROM delivery_runs').n).toBe(0);
    expect(f.store.get('SELECT count(*) AS n FROM delivery_members').n).toBe(0);
    expect(f.store.task(f.sources[0].id).reservation).toBeNull();
    expect(f.create().id).toBeGreaterThan(0);
  } finally { f.close(); }
});

test('strict creation validates bounds, ownership, duplicate members and fixed references without partial rows', () => {
  const f = setup(); try {
    for (const members of [[], Array.from({ length: 9 }, (_, i) => f.member(i)), [f.member(0), f.member(0)], [f.member(0), f.member(1, 100)],
      [{ ...f.member(0), source_commit: 'HEAD' }], [{ ...f.member(0), task_id: '2' }], [{ ...f.member(0), source_branch: 'elsewhere' }]])
      expect(() => f.create(members)).toThrow();
    expect(() => f.create([f.member(0)], { target_branch: 'other' })).toThrow('real parent');
    expect(() => f.create([f.member(0)], { profile: {} })).toThrow('fields');
    expect(() => f.create([f.member(0)], { validation: { command_id: 'bad', command_version: 1 } })).toThrow('reference');
    expect(f.store.get('SELECT count(*) AS n FROM delivery_runs').n).toBe(0);
    expect(f.create(Array.from({ length: 8 }, (_, i) => f.member(i))).id).toBeGreaterThan(0);
  } finally { f.close(); }
});

test('run updates whitelist fields, enforce generation CAS, encode JSON and preserve identity', () => {
  const f = setup(); try {
    const run = f.create();
    expect(() => f.store.updateDeliveryRun(run.id, { target_branch: 'other' }, 1)).toThrow('fields');
    expect(() => f.store.updateDeliveryRun(run.id, { baseline: C }, 1)).toThrow('new generation');
    for (const generation of [0, null, 4, '2']) expect(() => f.store.updateDeliveryRun(run.id, { generation }, 1)).toThrow();
    const next = f.store.updateDeliveryRun(run.id, { generation: 2, baseline: C, data: { topology: 'fixed' }, state: 'validating' }, 1);
    expect(next).toMatchObject({ generation: 2, baseline: C, data: '{"topology":"fixed"}', state: 'validating' });
    expect(() => f.store.updateDeliveryRun(run.id, { data: 'not-json' }, 2)).toThrow('JSON');
    expect(() => f.store.updateDeliveryRun(run.id, { state: 'invented' }, 2)).toThrow('state');
    expect(f.store.deliveryRuns(f.parent.id, ['validating'])).toHaveLength(1);
    expect(f.store.deliveryRuns(f.parent.id, ['ready'])).toHaveLength(0);
  } finally { f.close(); }
});

test('fixed topology nodes are idempotent, helper bindings are narrow and old replies cannot advance a new generation', () => {
  const f = setup(); try {
    const run = f.create(), input = { base: A, left: B, right: C, member_ids: [f.sources[0].id] };
    const node = f.store.createDeliveryNode({ run_id: run.id, generation: 1, node_key: 'leaf:100', data: input });
    const helper = f.store.create({ parent_id: f.parent.id, input_id: null, role: 'agent', goal: 'repair', task_kind: 'integration' });
    expect(() => f.store.updateDeliveryNode(node.id, { helper_id: f.sources[0].id }, 1)).toThrow('binding');
    f.store.updateDeliveryNode(node.id, { data: { ...input, seed_commit: A }, helper_id: helper.id, state: 'ready', result: { tree: B, commit: C } }, 1);
    const old = f.store.createDeliveryNode({ run_id: run.id, generation: 1, node_key: 'leaf:100', data: { member_ids: input.member_ids, right: C, left: B, base: A } });
    expect(old).toMatchObject({ id: node.id, state: 'ready', helper_id: helper.id });
    expect(() => f.store.createDeliveryNode({ run_id: run.id, generation: 1, node_key: 'leaf:100', data: { ...input, left: C } })).toThrow('inputs');
    expect(() => f.store.updateDeliveryNode(node.id, { data: { ...input, seed_commit: C } }, 1)).toThrow('inputs');
    f.store.updateDeliveryRun(run.id, { generation: 2 }, 1);
    expect(() => f.store.updateDeliveryNode(node.id, { state: 'ready', result: { tree: A } }, 1)).toThrow('generation changed');
    expect(() => f.store.createDeliveryNode({ run_id: run.id, generation: 1, node_key: 'new' })).toThrow('generation changed');
    expect(f.store.updateDeliveryNode(node.id, { state: 'stale' }, 1).state).toBe('stale');
    expect(f.store.createDeliveryNode({ run_id: run.id, generation: 2, node_key: 'leaf:100', data: input }).id).not.toBe(node.id);
  } finally { f.close(); }
});

test('active uses block deletion but a settled source can disappear independently without removing shared history', () => {
  const f = setup(); try {
    const run = f.create([f.member(0), f.member(1)]), history = f.store.deliveryMembers(run.id);
    expect(() => f.store.hardDeleteTasks([f.sources[0].id])).toThrow('active convergence');
    expect(f.store.deliveryHistoryBlockers([f.sources[0].id])).toHaveLength(1);
    expect(() => f.store.deleteDeliveryHistory([f.sources[0].id, f.sources[1].id])).toThrow('active or shared');
    f.store.updateDeliveryRun(run.id, { state: 'integrated' }, 1); f.store.releaseDeliveryMembers(run.id);
    expect(f.store.deliveryHistoryBlockers([f.sources[0].id])).toEqual([]);
    expect(f.store.deleteDeliveryHistory([f.sources[0].id])).toBe(0);
    f.store.hardDeleteTasks([f.sources[0].id]);
    expect(f.store.deliveryRun(run.id).id).toBe(run.id);
    expect(f.store.deliveryMembers(run.id)).toEqual(history.map(member => ({ ...member, active: 0 })));
    expect(f.store.task(f.sources[1].id).id).toBe(f.sources[1].id);
    expect(f.store.deliveryHistoryBlockers([f.parent.id])).toHaveLength(1);
    expect(() => f.store.deleteDeliveryHistory([f.parent.id])).toThrow('shared');
    expect(f.store.deleteDeliveryHistory(f.store.tasks().map(task => task.id))).toBe(1);
    expect(f.store.deliveryRun(run.id)).toBeNull();
    const next = f.create([f.member(2)]); expect(next.id).toBeGreaterThan(run.id);
  } finally { f.close(); }
});

test('adding delivery tables to an existing SQLite database does not migrate old reservation JSON', () => {
  const f = setup(); let other;
  try {
    const first = '{ "version":1,"kind":"merge","status":"requested" }', second = '{"version":2,"kind":"merge","status":"resolving"}';
    f.store.update(f.sources[0].id, { reservation: first }); f.store.update(f.sources[1].id, { reservation: second });
    const before = JSON.stringify(f.store.tasks());
    f.store.db.exec('DROP TABLE delivery_nodes; DROP TABLE delivery_members; DROP TABLE delivery_runs;');
    other = new Store(f.file, f.root);
    expect(JSON.stringify(other.tasks())).toBe(before);
    expect(other.get('SELECT count(*) AS n FROM delivery_runs').n).toBe(0);
    expect(other.task(f.sources[0].id).reservation).toBe(first); expect(other.task(f.sources[1].id).reservation).toBe(second);
  } finally { other?.close(); f.close(); }
});

test('helper deletion waits for actual settled usage, then keeps its original identity without a live FK', () => {
  const f = setup(); try {
    const run = f.create(), helper = f.store.create({ parent_id: f.parent.id, input_id: null, role: 'agent', goal: 'repair', task_kind: 'integration' });
    f.store.run('UPDATE tasks SET worker_number=? WHERE id=?', 'W99-7', helper.id);
    f.store.updateDeliveryRun(run.id, { state: 'integrated', integration_worker_id: helper.id });
    const node = f.store.createDeliveryNode({ run_id: run.id, generation: 1, node_key: 'repair', helper_id: helper.id });
    expect(f.store.deliveryHistoryBlockers([f.sources[0].id, helper.id])).toHaveLength(1);
    f.store.releaseDeliveryMembers(run.id);
    expect(f.store.deliveryHistoryBlockers([f.sources[0].id])).toEqual([]);
    expect(f.store.deliveryHistoryBlockers([helper.id])).toHaveLength(1);
    expect(() => f.store.hardDeleteTasks([helper.id])).toThrow('active convergence');
    f.store.update(helper.id, { status: 'awaiting_acceptance' });
    expect(f.store.deliveryHistoryBlockers([helper.id])).toEqual([]);
    expect(f.store.deleteDeliveryHistory([helper.id])).toBe(0);
    f.store.hardDeleteTasks([helper.id]);
    expect(f.store.deliveryRun(run.id)).toMatchObject({ integration_worker_id: helper.id, integration_worker_number: 'W99-7' });
    expect(f.store.deliveryNode(node.id)).toMatchObject({ helper_id: helper.id, helper_worker_number: 'W99-7' });
  } finally { f.close(); }
});

test('a null merge-base is still fixed input, and JSON cannot secretly encode scalar or array payloads', () => {
  const f = setup(); try {
    const run = f.create(), input = { base: null, left: A, right: B, seed_commit: null };
    const node = f.store.createDeliveryNode({ run_id: run.id, generation: 1, node_key: 'multibase', data: input });
    expect(() => f.store.updateDeliveryNode(node.id, { data: { ...input, base: A } }, 1)).toThrow('inputs');
    expect(f.store.updateDeliveryNode(node.id, { data: { ...input, seed_commit: C } }, 1).data).toContain(C);
    for (const data of [new Date(), { toJSON: () => [] }, { toJSON: () => 'private' }])
      expect(() => f.store.updateDeliveryRun(run.id, { data }, 1)).toThrow('object');
    const circular = {}; circular.self = circular;
    expect(() => f.store.updateDeliveryRun(run.id, { data: circular }, 1)).toThrow('JSON');
  } finally { f.close(); }
});

test('deliveryNodes restores exact raw rows in id order, isolated by run and historical generation without writes', () => {
  const f = setup(); try {
    const run = f.create(), other = f.create([f.member(1)]);
    const first = f.store.createDeliveryNode({ run_id: run.id, generation: 1, node_key: 'z-last-key', data: { base: A } });
    const second = f.store.createDeliveryNode({ run_id: run.id, generation: 1, node_key: 'a-first-key', data: { base: B }, result: { tree: C }, state: 'ready' });
    f.store.createDeliveryNode({ run_id: other.id, generation: 1, node_key: 'other-run', data: { base: C } });
    f.store.updateDeliveryRun(run.id, { generation: 2 }, 1);
    const next = f.store.createDeliveryNode({ run_id: run.id, generation: 2, node_key: 'new-generation', data: { base: C } });
    const changes = f.store.get('SELECT total_changes() AS n').n;
    expect(f.store.deliveryNodes(run.id, 1)).toEqual([first, second]);
    expect(f.store.deliveryNodes(run.id, 2)).toEqual([next]);
    expect(f.store.deliveryNodes(run.id, 3)).toEqual([]);
    expect(f.store.deliveryNodes(99999, 1)).toEqual([]);
    expect(f.store.get('SELECT total_changes() AS n').n).toBe(changes);
    for (const args of [[0, 1], [run.id, 0], ['1', 1], [run.id, '1'], [run.id], [run.id, 1.5]])
      expect(() => f.store.deliveryNodes(...args)).toThrow('positive integer');
  } finally { f.close(); }
});

test('encoded JSON and object inputs store one encoding across run/node creation and patches', () => {
  const f = setup(); try {
    const validation = { command_id: '00000000-0000-0000-0000-000000000001', command_version: 1 };
    const run = f.create([f.member(0)], { validation: JSON.stringify(validation), data: '{ "topology": "fixed" }' });
    expect(JSON.parse(run.validation)).toEqual(validation); expect(JSON.parse(run.data)).toEqual({ topology: 'fixed' });
    const updated = f.store.updateDeliveryRun(run.id, { data: '{"topology":"changed"}', validation_result: '{"status":"succeeded"}',
      landing_receipt: '{"commit":"fixed"}' }, 1);
    expect(updated.data).toBe('{"topology":"changed"}');
    expect(JSON.parse(updated.validation_result)).toEqual({ status: 'succeeded' });
    expect(JSON.parse(updated.landing_receipt)).toEqual({ commit: 'fixed' });
    const data = { base: A, left: B, right: C };
    const node = f.store.createDeliveryNode({ run_id: run.id, generation: 1, node_key: 'encoded', data: JSON.stringify(data), result: '{"tree":"fixed"}' });
    expect(JSON.parse(node.data)).toEqual(data); expect(JSON.parse(node.result)).toEqual({ tree: 'fixed' });
    expect(f.store.createDeliveryNode({ run_id: run.id, generation: 1, node_key: 'encoded', data, result: { tree: 'fixed' } }).id).toBe(node.id);
    const next = f.store.updateDeliveryNode(node.id, { data: JSON.stringify({ ...data, seed_commit: A }), result: '{"tree":"next"}' }, 1);
    expect(JSON.parse(next.data)).toEqual({ ...data, seed_commit: A }); expect(JSON.parse(next.result)).toEqual({ tree: 'next' });
    expect(f.store.updateDeliveryRun(run.id, { validation_result: null }, 1).validation_result).toBeNull();
    expect(f.store.updateDeliveryNode(node.id, { result: null }, 1).result).toBeNull();
  } finally { f.close(); }
});

test('parent preparation binds planned pair inputs once, persists conflict and cannot change frozen topology', () => {
  const f = setup(); try {
    const run = f.create([f.member(0), f.member(1)]), data = { kind: 'pair', inputs: ['leaf:100','leaf:101'],
      member_ids: [f.sources[0].id,f.sources[1].id], base: A, left: null, right: null, seed_commit: null };
    const node = f.store.createDeliveryNode({ run_id: run.id, generation: 1, node_key: 'pair:1:0', data });
    const bound = { ...data, left: B, right: C };
    expect(() => f.store.updateDeliveryNode(node.id, { data: { ...bound, left: 'HEAD' } }, 1)).toThrow('Git object');
    expect(f.store.updateDeliveryNode(node.id, { data: bound }, 1).data).toContain(B);
    expect(() => f.store.updateDeliveryNode(node.id, { data: { ...bound, left: A } }, 1)).toThrow('inputs');
    expect(() => f.store.updateDeliveryNode(node.id, { data: { ...bound, inputs: ['leaf:101','leaf:100'] } }, 1)).toThrow('inputs');
    expect(() => f.store.updateDeliveryNode(node.id, { data: { ...bound, kind: 'leaf' } }, 1)).toThrow('inputs');
    expect(f.store.updateDeliveryNode(node.id, { state: 'conflict', data: { ...bound, seed_commit: C }, result: { tree: A, commit: C } }, 1).state).toBe('conflict');
    expect(f.store.updateDeliveryNode(node.id, { state: 'resolving' }, 1).state).toBe('resolving');
    expect(f.store.deliveryRuns(f.parent.id, ['preparing'], 1000).map(row => row.id)).toEqual([run.id]);
    expect(() => f.store.deliveryRuns(f.parent.id, null, 1001)).toThrow('limit');
    expect(typeof f.store.deliveryHistoryBlockers([f.sources[0].id])[0]).toBe('string');
  } finally { f.close(); }
});
