import { test, expect } from 'bun:test';
// Further full-stack cases live in convergence-assembled-workers.test.js, sharing its real fixture.
import methods from '../../src/core/project/convergence-acceptance.js';

test('infrastructure acceptance never authorizes another source Worker or an unknown/deleted source', () => {
  const tasks = { 1: { id: 1, status: 'awaiting_acceptance', task_kind: 'integration' } };
  const creation = { run_id: 4, node_id: 5, generation: 1 };
  const project = { running: new Map(), store: {
    get(sql, id) { if (sql.includes('tasks')) return tasks[id] ?? null;
      if (sql.includes('integration_created')) return { data: JSON.stringify(creation) }; return null; },
    deliveryRun() { return { id: 4, state: 'integrated' }; },
    deliveryMembers(_id, active) { return active ? [] : [{ task_id: 2 }, { task_id: 3 }]; },
  } };
  expect(methods.convergenceAcceptanceHelpers.call(project, [tasks[1]], new Set([2]))).toHaveLength(0);
  expect(methods.convergenceAcceptanceHelpers.call(project, [tasks[1]], new Set([2, 3]))).toHaveLength(1);
});
