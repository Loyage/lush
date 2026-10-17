import { test, expect } from 'bun:test';
import { fixture, repo, until } from '../helpers.js';
import { retiredHook } from '../hook-assertions.js';
import { attachRegisteredHook } from '../hook-registry.js';

test('scheduled Hook timer submits one notification without UI polling', async () => {
  const f = fixture(); f.project.kick = () => {}; await repo(f.root);
  try {
    const main = await f.project.ensureMainTask();
    const dueAt = new Date(Date.now() + 150).toISOString();
    const mount = attachRegisteredHook(f.project, main.id, { name: 'scheduled smoke', trigger: 'time.scheduled',
      mode: 'once', enabled: true, schedule: { kind: 'once', at: dueAt, timezone: 'UTC' },
      actions: [{ type: 'notify', title: 'scheduled-test', body: 'submitted' }] }).mounts.at(-1);
    await until(() => !f.project.taskHooks(main.id).mounts.some(item => item.id === mount.id));
    expect(f.store.get("SELECT count(*) AS n FROM notices WHERE title='scheduled-test'").n).toBe(1);
    expect(retiredHook(f.project, main.id, mount.id).due_at).toBe(dueAt);
    expect(f.project.scheduledHookTimer).toBeNull();
  } finally { await f.close(); }
});
