import { test, expect } from 'bun:test';
import { PARAMS, assertAllowed } from '../src/rpc/registry.js';
import { HANDLERS } from '../src/rpc/dispatcher.js';
import { HELP } from '../src/cli/help.js';

const removed = ['input.submit','draft.commit','spec.add','plan.approve','candidate.accept',
  'showcase.start','sleep.start','explanation.start','intro.start','task.verify','task.merge','branch.merge_all',
  'worker.merge_many','system.usage'];

test('only worker-centred methods are externally dispatchable', () => {
  expect(Object.keys(HANDLERS).sort()).toEqual(Object.keys(PARAMS).sort());
  for (const method of removed) {
    expect(HANDLERS[method]).toBeUndefined();
    expect(() => assertAllowed(method, {}, null)).toThrow(`unknown method: ${method}`);
  }
  expect(assertAllowed('say.submit', { content: '实现目标' }, null)).toBeNull();
  expect(assertAllowed('say.submit', { draft_id: 1, expected_revision: 1 }, null)).toBeNull();
  expect(() => assertAllowed('worker.spawn', { parent: 1, role: 'worker', goal: 'x' }, null)).toThrow('unknown parameter');
  expect(() => assertAllowed('worker.integrate', { id: 1, commit: 'a' }, null)).toThrow('agent only');
  expect(() => assertAllowed('worker.approve_merge', { id: 1 }, 42)).toThrow('requires user approval');
});

test('CLI help documents only the core workflow', () => {
  expect(HELP).toContain("say '目标'");
  expect(HELP).toContain('worker approve-merge');
  expect(HELP).not.toContain('candidate prepare');
  expect(HELP).not.toContain('draft commit');
});
