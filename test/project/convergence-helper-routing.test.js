import { test, expect } from 'bun:test';
import { fixture } from '../helpers.js';

test('Workspaces helper idle callback is synchronous and checks actual invocation, command, sync and run exits', async () => {
  const f = fixture(); f.project.kick = () => {};
  try {
    const idle = f.project.workspaces.convergenceHelperIdle;
    expect(idle(12, 45)).toBe(true); expect(idle(null, 45)).toBe(false); expect(idle(12, null)).toBe(false);
    f.project.running.set(12, {}); expect(idle(12, 45)).toBe(false); f.project.running.delete(12);
    f.project.commandHookRunning = new Set([12]); expect(idle(12, 45)).toBe(false); f.project.commandHookRunning.clear();
    f.project.taskSyncBusy = new Set([12]); expect(idle(12, 45)).toBe(false); f.project.taskSyncBusy.clear();
    f.project.convergenceJobs = new Map([[45, {}]]); expect(idle(12, 45)).toBe(false); f.project.convergenceJobs.clear();
    expect(idle(12, 45)).toBe(true);
  } finally { f.project.running.clear(); f.project.convergenceJobs?.clear(); await f.close(); }
});

test('helper cleanup is routed exclusively to its dedicated exact-output proof, never the ordinary ancestry rule', async () => {
  const f = fixture(); f.project.kick = () => {};
  try {
    const helper = f.store.create({ role: 'agent', task_kind: 'integration', goal: 'controlled routing' });
    let calls = 0;
    const result = { id: helper.id, worktree: 'removed', branch: 'removed', reason: null };
    f.project.workspaces.archiveConvergenceHelperUnsafe = async task => { expect(task.id).toBe(helper.id); calls++; return result; };
    f.project.workspaces.archiveSquashedTaskUnsafe = () => { throw new Error('helper is not a member Squash'); };
    f.project.workspaces.dropBranch = () => { throw new Error('no generic ancestry cleanup'); };
    expect(await f.project.workspaces.release(helper)).toEqual(result); expect(calls).toBe(1);
    expect(await f.project.workspaces.release(helper, { keepBranch: true })).toEqual({ id: helper.id,
      worktree: 'absent', branch: 'absent', reason: 'kept by --keep-branch' });
    expect(calls).toBe(1);
  } finally { await f.close(); }
});

test('missing helper proof fails closed instead of treating an obsolete seed as an ordinary empty Worker', async () => {
  const f = fixture(); f.project.kick = () => {};
  try {
    const helper = f.store.create({ role: 'agent', task_kind: 'integration', goal: 'unknown private output' });
    f.project.workspaces.archiveConvergenceHelperUnsafe = undefined;
    await expect(f.project.workspaces.release(helper)).rejects.toThrow('integration resource proof is unavailable');
  } finally { await f.close(); }
});
