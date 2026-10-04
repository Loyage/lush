import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { temp, repo, env } from '../helpers.js';
import { Config } from '../../src/config.js';
import { UIClient } from '../../src/ui/client.js';
import { createProjectHost } from '../../src/host/project-host.js';
import { projectRouteId } from '../../src/host/registry.js';
import { isLocked } from '../../src/daemon/locking.js';
import { stopProjectDaemon } from '../../src/host/service-control.js';

test('explicit project stop persists paused work; another Host polling cannot restart it', async () => {
  const root = temp(), global = temp(), environment = env({ LUSH_GLOBAL_CONFIG: global });
  const config = new Config({ project: root, env: environment }), client = new UIClient(config);
  const host = createProjectHost(null, { env: environment }), id = projectRouteId(root);
  try {
    await repo(root);
    await host.select(root);
    const before = await client.request('system.status');
    const result = await client.request('order.submit', { content: 'must remain paused across explicit stop', start: false });
    expect(isLocked(config.home)).toBe(true);
    expect(await host.stop(id)).toMatchObject({ stopped: true, project: root });
    expect(isLocked(config.home)).toBe(false);
    const old = await host.openRoute(id);
    await expect(old.client.request('system.summary')).rejects.toThrow();
    const another = createProjectHost(null, { env: environment });
    const attached = await another.openRoute(id);
    await expect(attached.client.request('system.summary')).rejects.toThrow();
    expect((await another.projects())[0].running).toBe(false);
    expect(isLocked(config.home)).toBe(false);
    expect(await host.stop(id)).toMatchObject({ stopped: true, already_stopped: true });
    await host.start(id);
    expect((await client.request('system.status')).pid).not.toBe(before.pid);
    const worker = await client.request('worker.inspect', { id: result.task.id });
    expect(worker.status).toBe('paused'); expect(worker.calls).toBe(0);
    // Forgetting an entry and disposing the UI has no authority to stop work.
    host.remove(id);
    expect(isLocked(config.home)).toBe(true);
  } finally {
    await stopProjectDaemon(config).catch(() => {});
    // Never delete a running fixture's state if cleanup unexpectedly fails.
    if (!isLocked(config.home)) fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(global, { recursive: true, force: true });
  }
}, 25000);
