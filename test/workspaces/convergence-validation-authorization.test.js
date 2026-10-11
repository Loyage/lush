import { test, expect } from 'bun:test';
import { setup } from './convergence-harness.js';

test('revocation during post-command asynchronous identity checks invalidates the final result', async () => {
  const f = await setup();
  try {
    const checkout = await f.workspaces.exclusive(() => f.workspaces.createConvergenceValidationUnsafe({ id: 1, generation: 1, commit: f.baseline }));
    let started = false, authorized = true;
    const original = f.workspaces.assertCleanBranches;
    f.workspaces.assertCleanBranches = async function(...args) {
      await original.apply(this, args);
      if (started) authorized = false;
    };
    const result = await f.workspaces.runConvergenceValidation(checkout, 'exit 0', () => authorized, { started: () => { started = true; } });
    expect(result.status).toBe('failed'); expect(result.reason).toBe('authorization'); expect(result.exit_code).toBe(0);
  } finally { f.close(); }
});
