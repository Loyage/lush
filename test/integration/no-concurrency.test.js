import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp, repo, env } from '../helpers.js';
import { Config } from '../../src/config.js';
import { UIClient } from '../../src/ui/client.js';
import { cli } from './harness.js';
import { bindMockPiSource } from './pi-runtime-fixture.js';

// Real independent daemons and guarded fake Agent processes, without Host registration,
// external credentials or model requests. All invocations stay alive until the test releases them.
test('independent daemons admit more than the old Worker limit and ignore legacy project/device quotas', async () => {
  const roots = [temp(), temp()], device = temp(), fake = path.join(device, 'fake-pi');
  const release = path.join(device, 'release'), seen = path.join(device, 'seen');
  const extra = { LUSH_GLOBAL_CONFIG: device, LUSH_PROVIDER: 'pi', LUSH_PI_COMMAND: fake,
    LUSH_CONCURRENCY: '1', LUSH_CONTROL_CONCURRENCY: 'invalid-ignored' };
  const started = new Set();
  fs.mkdirSync(seen, { mode: 0o700 });
  fs.mkdirSync(path.join(device, 'shared'), { mode: 0o700 });
  const legacy = JSON.stringify({ version: 1, concurrency: 1, control_concurrency: 1 });
  fs.writeFileSync(path.join(device, 'shared', 'settings.json'), legacy, { mode: 0o600 });
  fs.writeFileSync(fake, `#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
const seen = ${JSON.stringify(seen)}, release = ${JSON.stringify(release)};
fs.writeFileSync(path.join(seen, path.basename(process.env.LUSH_PROJECT) + '-' + process.env.LUSH_TASK_ID), 'started');
const end = Date.now() + 15000;
while (!fs.existsSync(release)) {
  if (Date.now() > end) throw new Error('test did not release fake Agent');
  await Bun.sleep(20);
}
console.log('controlled fake Agent exited');
`, { mode: 0o700 });
  try {
    await Promise.all(roots.map(root => repo(root)));
    for (const root of roots) {
      fs.mkdirSync(path.join(root, '.lush'), { mode: 0o700 });
      fs.writeFileSync(path.join(root, '.lush', 'settings.json'), legacy, { mode: 0o600 });
      await cli(root, ['start'], extra); started.add(root);
    }
    await bindMockPiSource(roots[0], extra);
    const clients = roots.map(root => new UIClient(Config.fromEnv(env(extra), root)));
    const groups = await Promise.all(clients.map(async (client, index) => {
      const workers = [];
      for (let n = 0; n < (index === 0 ? 9 : 2); n++) {
        const result = await client.request('order.submit', { content: `controlled Worker ${n}`, start: false });
        workers.push(result.task.id);
      }
      return workers;
    }));
    await Promise.all(clients.flatMap((client, index) => groups[index].map(id => client.request('worker.resume', { id }))));
    const end = Date.now() + 8000;
    let summaries;
    do {
      summaries = await Promise.all(clients.map(client => client.request('system.summary')));
      if (summaries.every((summary, index) => summary.agents.length === groups[index].length)
        && fs.readdirSync(seen).length === 11) break;
      await Bun.sleep(20);
    } while (Date.now() < end);
    expect(summaries.map(summary => summary.agents.length)).toEqual([9, 2]);
    expect(fs.readdirSync(seen)).toHaveLength(11);
    for (const summary of summaries) {
      expect(summary).not.toHaveProperty('concurrency');
      expect(summary).not.toHaveProperty('control_concurrency');
      expect(summary.settings).not.toHaveProperty('concurrency');
      expect(summary.settings).not.toHaveProperty('control_concurrency');
      expect(new Set(summary.agents.map(agent => agent.task_id)).size).toBe(summary.agents.length);
    }
    expect(fs.readFileSync(path.join(device, 'shared', 'settings.json'), 'utf8')).toBe(legacy);
    for (const root of roots) expect(fs.readFileSync(path.join(root, '.lush', 'settings.json'), 'utf8')).toBe(legacy);
  } finally {
    fs.writeFileSync(release, 'release', { mode: 0o600 });
    const stopped = await Promise.allSettled([...started].map(root => cli(root, ['stop'], extra)));
    const failures = stopped.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, `temporary daemon cleanup failed; retained ${[...roots, device].join(', ')}`);
    for (const root of [...roots, device]) fs.rmSync(root, { recursive: true, force: true });
  }
});
