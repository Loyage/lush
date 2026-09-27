import { test, expect } from 'bun:test';
import path from 'node:path';
import { setup } from './harness.js';

test('AP names become the branch and worktree name, falling back to the goal', async () => {
  const f = await setup();
  const ns = f.project.workspaces.namespace;
  try {
    const named = f.project.spawn(f.ap.parent_id,'改进 Web 页面布局','worker',[],'Web Composer Layout!');
    expect(named.name).toBe('web-composer-layout');
    const cwd = await f.project.workspaces.ensure(named);
    expect(f.store.ap(named.id).branch).toBe(`lush/${ns}/${named.id}-web-composer-layout`);
    expect(cwd).toBe(path.join(f.config.home,'worktrees',`${named.id}-web-composer-layout`));

    const fallback = f.project.spawn(f.ap.parent_id,'fix login redirect bug','worker');
    expect(fallback.name).toBe('fix-login-redirect-bug');
    await f.project.workspaces.ensure(fallback);
    expect(f.store.ap(fallback.id).branch).toBe(`lush/${ns}/${fallback.id}-fix-login-redirect-bug`);
    expect(f.store.ap(fallback.id).workspace).toBe(path.join(f.config.home,'worktrees',`${fallback.id}-fix-login-redirect-bug`));

    const unnamed = f.project.spawn(f.ap.parent_id,'改进登录流程','worker');
    expect(unnamed.name).toBeNull();
    await f.project.workspaces.ensure(unnamed);
    expect(f.store.ap(unnamed.id).branch).toBe(`lush/${ns}/ap-${unnamed.id}`);
    expect(f.store.ap(unnamed.id).workspace).toBe(path.join(f.config.home,'worktrees',`ap-${unnamed.id}`));

    expect(() => f.project.spawn(f.ap.parent_id,'goal','worker',[],'修复登录')).toThrow('ASCII');
  } finally { await f.close(); }
});
