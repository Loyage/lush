import { test, expect } from 'bun:test';
import { CONVERGENCE_LIMITS, CONVERGENCE_STATES, CONVERGENCE_COUNT_STATES,
  convergenceJSON, convergenceRevision, convergenceBooking } from '../src/core/convergence-contract.js';

test('convergence preparation has bounded members and resources', () => {
  expect(CONVERGENCE_LIMITS.members).toBe(8);
  expect(CONVERGENCE_LIMITS.preparation_concurrency).toBeGreaterThan(0);
  expect(CONVERGENCE_LIMITS.validation_timeout_ms).toBeGreaterThan(0);
  expect(Object.isFrozen(CONVERGENCE_LIMITS)).toBe(true);
  for (const state of CONVERGENCE_COUNT_STATES) expect(CONVERGENCE_STATES).toContain(state);
  expect(CONVERGENCE_COUNT_STATES).not.toContain('integrated');
});

test('safe JSON parsing preserves raw Store values and an explicit malformed fallback', () => {
  expect(convergenceJSON('{"generation":1}')).toEqual({ generation: 1 });
  expect(convergenceJSON(null, {})).toEqual({});
  expect(convergenceJSON('broken', null)).toBeNull();
  const value = { tree: 'fixed' }; expect(convergenceJSON(value)).toBe(value);
});

test('revision is deterministic and distinguishes branch and generation identity', () => {
  const a = { branch: 'main', generation: 1 };
  expect(convergenceRevision(a)).toBe(convergenceRevision({ ...a }));
  expect(convergenceRevision(a)).not.toBe(convergenceRevision({ branch: 'other', generation: 1 }));
  expect(convergenceRevision(a)).not.toBe(convergenceRevision({ branch: 'main', generation: 2 }));
});

test('a new booking never treats historical v2 or malformed JSON as convergence', () => {
  expect(convergenceBooking({ reservation: JSON.stringify({ version: 3, kind: 'merge', status: 'requested' }) })).toMatchObject({ version: 3 });
  expect(convergenceBooking({ reservation: JSON.stringify({ version: 2, kind: 'merge', status: 'requested' }) })).toBeNull();
  expect(convergenceBooking({ reservation: 'broken' })).toBeNull();
});
