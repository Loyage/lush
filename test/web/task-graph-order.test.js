import { expect, test } from 'bun:test';
import { taskForest } from '../../src/ui/web/assets/task-graph-layout.js';

const request = (status, parent_id = 1) => ({ version: 2, queue_protocol: 1, kind: 'merge', status, parent_id });
const node = (id, status, extra = {}) => ({ id, parent_id: 1, status, created_at: '2026-01-01T00:00:00Z', ...extra });
const order = nodes => taskForest({ nodes: [node(1, 'waiting', { parent_id: null }), ...nodes] })[0].children.map(n => n.id);

test('all development stages follow attention priority regardless of recency', () => {
  const nodes = [
    node(2, 'paused', { reservation: request('executing') }),
    node(3, 'waiting', { reservation: request('resolving') }),
    node(4, 'waiting', { reservation: request('requested') }),
    node(5, 'awaiting'),
    node(6, 'running', { notice_count: 1 }),
    node(7, 'paused', { notice: { id: 1 } }),
    node(8, 'waiting', { reservation: request('blocked') }),
    node(9, 'waiting', { reservation: request('suspended') }),
    node(10, 'failed'),
    node(11, 'completed', { integration: 'conflict' }),
    node(12, 'completed', { integration: 'pending' }),
    node(13, 'completed', { integration: 'review' }),
    node(14, 'awaiting_acceptance'),
    node(15, 'running'),
    node(16, 'waiting'),
    node(17, 'queued'),
    node(18, 'paused'),
    node(19, 'unknown'),
    node(20, 'completed', { integration: 'merged' }),
    node(21, 'completed', { integration: 'none' }),
    node(22, 'cancelled', { created_at: '2027-01-01T00:00:00Z' }),
  ];
  const expected = [3, 2, 4, 13, 12, 11, 10, 9, 8, 7, 6, 5,
    15, 16, 17, 18, 14, 19, 21, 20, 22];
  expect(order(nodes.reverse())).toEqual(expected);
  expect(taskForest({ nodes }).map(node => node.id)).toEqual(expected);
});

test('same stage uses creation time, not updated time or ID except as a tie-breaker', () => {
  const nodes = [
    node(30, 'running', { created_at: '2026-01-01T01:00:00+01:00', updated_at: '2028-01-01T00:00:00Z' }),
    node(2, 'running', { created_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' }),
    node(3, 'running', { created_at: Date.parse('2026-01-02T00:00:00Z') }),
    node(40, 'running', { created_at: undefined }),
    node(41, 'running', { created_at: 'not a date' }),
    node(42, 'running', { created_at: NaN }),
    node(43, 'running', { created_at: Infinity }),
  ];
  expect(order(nodes)).toEqual([3, 2, 30, 43, 42, 41, 40]);
  nodes[2].updated_at = '2030-01-01T00:00:00Z';
  expect(order(nodes)).toEqual([3, 2, 30, 43, 42, 41, 40]);
});

test('roots use their own stage and creation time without rolling up descendants', () => {
  const roots = [
    node(2, 'completed', { parent_id: null }),
    node(3, 'running', { parent_id: null, created_at: '2026-01-03T00:00:00Z' }),
    node(4, 'running', { parent_id: null }),
    node(5, 'awaiting', { parent_id: 999 }),
    node(6, 'waiting', { parent_id: 999, reservation: request('requested', 999) }),
    node(7, 'waiting', { parent_id: 999, reservation: request('executing', 999) }),
    node(8, 'waiting', { parent_id: 2, reservation: request('executing', 2) }),
  ];
  const forest = taskForest({ nodes: roots });
  expect(forest.map(n => n.id)).toEqual([7, 6, 5, 3, 4, 2]);
  expect(forest.at(-1).children.map(n => n.id)).toEqual([8]);
});

test('visible siblings use their own attention while reservations still validate the real parent', () => {
  const nodes = [
    node(2, 'running'),
    node(3, 'waiting', { parent_id: 99, layout_parent_id: 1, reservation: request('requested', 99) }),
    node(4, 'waiting', { parent_id: 99, layout_parent_id: 1, reservation: request('executing', 1) }),
  ];
  expect(order(nodes)).toEqual([3, 2, 4]);
  expect(nodes[1].parent_id).toBe(99);
  expect(nodes[1].reservation.parent_id).toBe(99);
});

test('legacy requests, auto-merge settings, Agent status and Git divergence do not imply current merge phases', () => {
  const nodes = [
    node(2, 'running', { integration: 'merging', auto_merge: { enabled: true },
      branch_info: { relation: { status: 'diverged' } } }),
    node(3, 'running', { reservation: request('pending') }),
    node(4, 'running', { reservation: { ...request('executing'), version: 1 } }),
    node(5, 'running', { reservation: { ...request('executing'), queue_protocol: null } }),
    node(6, 'running', { reservation: request('executing', 999) }),
    node(7, 'running', { reservation: { ...request('executing'), kind: 'showcase' } }),
    node(8, 'awaiting_acceptance'),
  ];
  expect(order(nodes)).toEqual([7, 6, 5, 4, 3, 2, 8]);
});

test('stage and open-decision changes reorder, content updates do not; input is not mutated', () => {
  const nodes = [node(2, 'queued'), node(3, 'running'), node(4, 'awaiting_acceptance')];
  const original = structuredClone(nodes);
  expect(order(nodes)).toEqual([3, 2, 4]);
  expect(nodes).toEqual(original);
  nodes[0].notice_count = 1;
  expect(order(nodes)).toEqual([2, 3, 4]);
  nodes[0].notice_count = 0;
  nodes[0].status = 'running';
  expect(order(nodes)).toEqual([3, 2, 4]);
  nodes[0].reservation = request('requested');
  expect(order(nodes)).toEqual([2, 3, 4]);
  nodes[2].result_preview = 'new result';
  nodes[2].updated_at = '2030-01-01T00:00:00Z';
  expect(order(nodes)).toEqual([2, 3, 4]);
});
