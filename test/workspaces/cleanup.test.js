import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { git } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/protocol.js';
import { createSignal } from '../../src/signal.js';
import { setup, change } from './harness.js';

test('cleanup refuses unmerged work, including commits on failed tasks', async () => {
  const f = await setup();
  try {
    const cwd = await change(f,f.task);
    await expect(f.project.workspaces.cleanup(f.task.id)).rejects.toThrow('unmerged');
    f.store.update(f.task.id,{status:'failed',integration:'none'});
    await expect(f.project.workspaces.cleanup(f.task.id)).rejects.toThrow();
    expect(fs.existsSync(cwd)).toBe(true);
  } finally { await f.close(); }
});

test('worker.cleanup over RPC honors keep_branch and reports what it reclaimed', async () => {
  const f = await setup();
  try {
    await change(f, f.task);
    await f.project.workspaces.merge(f.task.id);
    const branch = f.store.task(f.task.id).branch;
    const rpc = new Dispatcher(f.project, createSignal(), {});
    const kept = await rpc.dispatch('worker.cleanup', { id: f.task.id, keep_branch: true });
    expect(kept.cleanup).toEqual({ id: f.task.id, worktree: 'removed', branch: 'kept', reason: 'kept by --keep-branch' });
    expect(await git(f.root,'branch','--list',branch)).toContain(branch);
    const removed = await rpc.dispatch('worker.cleanup', { id: f.task.id });
    expect(removed.cleanup).toEqual({ id: f.task.id, worktree: 'absent', branch: 'removed', reason: null });
    expect(await git(f.root,'branch','--list',branch)).toBe('');
    await expect(rpc.dispatch('worker.cleanup', { id: f.task.id, nope: true })).rejects.toThrow('unknown parameter');
  } finally { await f.close(); }
});
