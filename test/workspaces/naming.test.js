import { test, expect } from 'bun:test';
import path from 'node:path';
import { setup } from './harness.js';

test('task names become the branch and worktree name, falling back to the goal', async () => {
  const f = await setup();
  const ns = f.project.workspaces.namespace;
  try {
    const named = await f.project.spawn(f.task.id,'改进 Web 页面布局',undefined,[],'Web Composer Layout!');
    expect(named.name).toBe('web-composer-layout');
    const cwd = await f.project.workspaces.ensure(named);
    expect(f.store.task(named.id).branch).toBe(`lush/${ns}/${named.id}-web-composer-layout`);
    expect(cwd).toBe(path.join(f.config.home,'worktrees',`${named.id}-web-composer-layout`));

    const fallback = await f.project.spawn(f.task.id,'fix login redirect bug');
    expect(fallback.name).toBe('fix-login-redirect-bug');
    await f.project.workspaces.ensure(fallback);
    expect(f.store.task(fallback.id).branch).toBe(`lush/${ns}/${fallback.id}-fix-login-redirect-bug`);
    expect(f.store.task(fallback.id).workspace).toBe(path.join(f.config.home,'worktrees',`${fallback.id}-fix-login-redirect-bug`));

    const unnamed = await f.project.spawn(f.task.id,'改进登录流程');
    expect(unnamed.name).toBeNull();
    await f.project.workspaces.ensure(unnamed);
    expect(f.store.task(unnamed.id).branch).toBe(`lush/${ns}/task-${unnamed.id}`);
    expect(f.store.task(unnamed.id).workspace).toBe(path.join(f.config.home,'worktrees',`task-${unnamed.id}`));

    await expect(f.project.spawn(f.task.id,'goal',undefined,[],'修复登录')).rejects.toThrow('ASCII');
  } finally { await f.close(); }
});
