import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runnerProject } from './fixtures/runner-project.js';
import { git } from '../helpers.js';

test('remote Shell Hook refuses local execution even when an external checkout occupies its central ref', async () => {
  const f = await runnerProject({ async run() { throw new Error('must not invoke'); } });
  try {
    const task = (await f.dispatcher.dispatch('order.submit', { content: 'remote Hook', start: false })).task;
    const checkout = path.join(f.config.home, 'external-checkout');
    // Model an external Git action, not a supported second checkout created by Lush.
    await git(f.root, 'worktree', 'add', checkout, task.branch);
    await expect(f.project.workspaces.runHookCommand(task, 'printf escaped > escaped.txt', () => true))
      .rejects.toThrow('local execution fallback is forbidden');
    expect(fs.existsSync(path.join(checkout, 'escaped.txt'))).toBe(false);
    expect(task.workspace).toBeNull();
    await git(f.root, 'worktree', 'remove', checkout);
  } finally { await f.close(); }
});
