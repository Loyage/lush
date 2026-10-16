import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { temp, repo, env } from '../helpers.js';
import { Config } from '../../src/config.js';
import { UIClient } from '../../src/ui/client.js';
import { cli } from './harness.js';
import { managementToolCLI } from '../agent/management-tool-cli-fixture.js';
import { bindMockPiSource } from './pi-runtime-fixture.js';
import { fetch, startTestWeb } from '../web/auth-fixture.js';

const route = '/api/host/management/permissions';
async function get(base) { const response = await fetch(base + route); expect(response.status).toBe(200); return response.json(); }
async function save(base, value, patch) {
  const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ permissions: { ...value.permissions, ...patch }, expected_revision: value.revision }) });
  expect(response.status).toBe(200); return response.json();
}
async function settledCall(client, task, status) {
  const end = Date.now() + 6000;
  while (Date.now() < end) {
    const record = await client.request('worker.inspect', { id: task.id });
    const call = (record.management.pending_signal ?? record.management.last_execution)?.control_calls[0];
    if (call?.status === status && !record.agent.active) return { record, call };
    if (record.error) throw new Error(record.error);
    await Bun.sleep(25);
  }
  throw new Error(`temporary daemon did not settle management call as ${status}`);
}

test('independent daemons adopt Host first save and reconcile shared confirmations without model replay or daemon restart', async () => {
  const roots = [temp(),temp()], device = temp(), extra = { LUSH_GLOBAL_CONFIG: device, LUSH_PROVIDER: 'pi' };
  let web;
  const clients = roots.map(root => new UIClient(Config.fromEnv(env(extra), root)));
  try {
    await Promise.all(roots.map(root => repo(root)));
    const providers = roots.map(root => managementToolCLI(root, 'node'));
    for (const provider of providers) provider.plan([{ name: 'manager_call', params: { method: 'draft.add', params: { content: 'cross-process pending request' } } }]);
    const started = await Promise.all(roots.map((root, i) => cli(root, ['start'], { ...extra, LUSH_PI_COMMAND: providers[i].command })));
    expect(started[0].pid).not.toBe(started[1].pid);
    await bindMockPiSource(roots[0], extra);
    let attachments = 0;
    web = startTestWeb(null, 0, { env: env(extra), projectHost: { launcher: true,
      require() { attachments++; throw new Error('Host permissions must not attach a project'); } } });
    const base = `http://127.0.0.1:${web.port}`, draft = await get(base);
    expect(draft.configured).toBe(false);
    for (const client of clients) expect((await client.request('management.permissions')).scope).toBe('project');
    let current = await save(base, draft, { 'draft.add': 'confirmation' });
    for (const client of clients) expect(await client.request('management.permissions')).toEqual(current);
    const managers = await Promise.all(clients.map(client => client.request('management.submit', {
      instruction: 'check one fixed pending operation', profile: { agent: 'pi', config_mode: 'pi' },
    }).then(result => result.task)));
    const pending = await Promise.all(clients.map((client, i) => settledCall(client, managers[i], 'pending_confirmation')));
    for (const row of pending) expect(row.record.calls).toBe(1);
    current = await save(base, current, { 'draft.add': 'unavailable' });
    const rejected = await Promise.all(clients.map((client, i) => settledCall(client, managers[i], 'rejected')));
    for (const [i, row] of rejected.entries()) {
      expect(row.record.calls).toBe(1);
      const notices = await clients[i].request('notice.list', {});
      expect(notices.find(notice => notice.id === row.call.notice_id).status).toBe('dismissed');
      expect((await clients[i].request('input.history', { limit: 100 })).items.map(item => item.kind)).toEqual(['management']);
      expect(await clients[i].request('management.permissions')).toEqual(current);
    }
    expect(attachments).toBe(0);
  } finally {
    const outcomes = await Promise.allSettled([Promise.resolve().then(() => web?.stop(true)), ...roots.map(root => cli(root, ['stop'], extra))]);
    const failures = outcomes.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), `temporary daemon cleanup failed; retained ${roots.join(', ')} and ${device}`);
    for (const root of [...roots,device]) fs.rmSync(root, { recursive: true, force: true });
  }
});
