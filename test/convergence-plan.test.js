import { test, expect } from 'bun:test';
import { convergenceTopology, selectConvergenceMembers } from '../src/core/convergence-plan.js';

const members = n => Array.from({ length: n }, (_, i) => ({ task_id: i + 1, delivery_id: i + 101, enqueue_seq: i + 11 }));

test('all bounded batch sizes have fixed balanced pair topology and no unary fake merge', () => {
  for (let size = 1; size <= 8; size++) {
    const input = members(size), snapshot = structuredClone(input), plan = convergenceTopology(input);
    expect(input).toEqual(snapshot);
    expect(plan.nodes).toHaveLength(2 * size - 1);
    expect(new Set(plan.nodes.map(node => node.key)).size).toBe(plan.nodes.length);
    const root = plan.nodes.find(node => node.key === plan.root);
    expect(root.member_ids).toEqual(input.map(member => member.task_id));
    expect(root.depth).toBe(Math.ceil(Math.log2(size)));
    const prior = new Set();
    for (const node of plan.nodes) {
      expect(node.inputs.length).toBe(node.kind === 'pair' ? 2 : 0);
      for (const key of node.inputs) expect(prior.has(key)).toBe(true);
      prior.add(node.key);
    }
  }
});

test('single delivery never waits for an absent partner', () => {
  const selected = selectConvergenceMembers(members(1), new Map(), new Set());
  expect(selected).toHaveLength(1);
  expect(convergenceTopology(selected)).toMatchObject({ root: 'leaf:101' });
});

test('arrival ordering, not Worker ID, decides independent bounded batches', () => {
  const input = members(10).reverse();
  input[0].enqueue_seq = 1;
  const selected = selectConvergenceMembers(input, new Map(), new Set());
  expect(selected.map(member => member.task_id)).toEqual([10, 1, 2, 3, 4, 5, 6, 7]);
  expect(input[0].task_id).toBe(10);
});

test('a blocked code-dependent head does not stall independent deliveries', () => {
  const dependencies = new Map([[1, [50]], [2, [1]], [3, [60]]]);
  expect(selectConvergenceMembers(members(4), dependencies, new Set([60])).map(member => member.task_id)).toEqual([3, 4]);
  expect(selectConvergenceMembers(members(4), dependencies, new Set([50, 1, 60])).map(member => member.task_id)).toEqual([1, 2, 3, 4]);
});

test('unknown dependencies remain blocked, duplicate/malformed identities and oversized plans reject', () => {
  expect(selectConvergenceMembers(members(1), new Map([[1, [999]]]), new Set())).toEqual([]);
  expect(() => convergenceTopology(members(9))).toThrow();
  expect(() => convergenceTopology([])).toThrow();
  expect(() => convergenceTopology([members(1)[0], members(1)[0]])).toThrow();
  expect(() => selectConvergenceMembers([members(1)[0], members(1)[0]], new Map(), new Set())).toThrow();
  expect(() => selectConvergenceMembers([{ task_id: 1, delivery_id: 1, enqueue_seq: -1 }], new Map(), new Set())).toThrow();
  expect(() => selectConvergenceMembers(members(1), new Map(), new Set(), 9)).toThrow();
});
