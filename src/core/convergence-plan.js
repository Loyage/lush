import { check } from './types.js';
import { CONVERGENCE_LIMITS } from './convergence-contract.js';

/** Code dependencies must land first. Unrelated ready work can bypass a blocked head. */
export function selectConvergenceMembers(candidates, dependencies, landedIds, limit = CONVERGENCE_LIMITS.members) {
  check(Number.isSafeInteger(limit) && limit >= 1 && limit <= CONVERGENCE_LIMITS.members, 'invalid convergence member bound');
  const seen = new Set();
  for (const member of candidates) {
    check(Number.isSafeInteger(member.task_id) && member.task_id > 0
      && Number.isSafeInteger(member.delivery_id) && member.delivery_id > 0
      && Number.isSafeInteger(member.enqueue_seq) && member.enqueue_seq > 0, 'invalid fixed delivery identity');
    check(!seen.has(member.task_id), 'duplicate fixed delivery source'); seen.add(member.task_id);
  }
  return [...candidates].sort((a, b) => a.enqueue_seq - b.enqueue_seq || a.delivery_id - b.delivery_id)
    .filter(member => (dependencies.get(member.task_id) ?? []).every(upstream => landedIds.has(upstream)))
    .slice(0, limit);
}

/** Persist this complete balanced binary topology before calculating any objects. */
export function convergenceTopology(members) {
  check(Array.isArray(members) && members.length >= 1 && members.length <= CONVERGENCE_LIMITS.members, 'convergence needs 1..8 fixed members');
  const tasks = new Set(), deliveries = new Set(), nodes = [];
  let level = members.map(member => {
    check(Number.isSafeInteger(member.task_id) && member.task_id > 0
      && Number.isSafeInteger(member.delivery_id) && member.delivery_id > 0, 'invalid fixed delivery identity');
    check(!tasks.has(member.task_id) && !deliveries.has(member.delivery_id), 'duplicate convergence member');
    tasks.add(member.task_id); deliveries.add(member.delivery_id);
    const node = { key: `leaf:${member.delivery_id}`, kind: 'leaf', delivery_id: member.delivery_id,
      member_ids: [member.task_id], inputs: [], depth: 0 };
    nodes.push(node); return node;
  });
  let round = 1;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (!level[i + 1]) { next.push(level[i]); continue; }
      const left = level[i], right = level[i + 1];
      const node = { key: `pair:${round}:${i / 2}`, kind: 'pair', inputs: [left.key, right.key],
        member_ids: [...left.member_ids, ...right.member_ids], depth: Math.max(left.depth, right.depth) + 1 };
      nodes.push(node); next.push(node);
    }
    level = next; round += 1;
  }
  return { version: 1, nodes, root: level[0].key };
}
