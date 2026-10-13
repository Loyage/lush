import { test, expect, setDefaultTimeout } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { setup, fetch } from './harness.js';
import { fixture, repo, git, until } from '../helpers.js';
import { RPCClient } from '../../src/rpc/client.js';
import { managementCatalog } from '../../src/rpc/management-policy.js';
import { Project } from '../../src/core/project.js';
setDefaultTimeout(20000);
const get = async (f, route = '/api/hooks') => (await fetch(f.url + route)).json();
async function post(f, method, params, status = 200) {
  const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: f.url },
    body: JSON.stringify({ method, params }) });
  const value = await response.json(); expect(response.status).toBe(status); return value;
}
const settings = async (f, patch) => post(f, 'hooks.automation_settings', { patch, expected_revision: (await get(f)).automation_settings.revision });
const hooks = (f, id) => get(f, `/api/worker/${id}/hooks`);
const toggle = async (f, id, enabled) => post(f, 'worker.acceptance_notice', { id, enabled, expected_revision: (await hooks(f, id)).revision });
// Creation/start-pending is an independent reminder and must not be suppressed by this feature.
const notices = (f, id) => f.store.all("SELECT n.* FROM notices n LEFT JOIN events e ON e.id=n.source_event_id WHERE n.task_id=? AND n.kind='info' AND coalesce(e.type,'')!='task.start_pending' ORDER BY n.id", id);
const ready = (f, id) => until(() => f.store.task(id).status === 'awaiting_acceptance' && !f.project.running.has(id)
  && !f.project.taskMergeBusy?.size && !f.project.completionQueued?.size, 10000);

test('real HTTP/RPC project policy is isolated even on one device; strict patch/revision and safe current display policy', async () => {
  const a = await setup(), b = fixture(undefined, { LUSH_GLOBAL_CONFIG: a.config.env.LUSH_GLOBAL_CONFIG });
  a.project.kick = b.project.kick = () => {};
  try {
    await Promise.all([repo(a.root), repo(b.root)]);
    a.store.run("INSERT INTO meta(key,value) VALUES ('completion_defaults',?)", JSON.stringify({ version: 1, enabled: true, level: 'archive' }));
    a.project.deviceAutomation.save({ auto_select: { enabled: false } }, a.project.deviceAutomation.get().revision);
    const file = path.join(a.config.deviceHome, 'automation.json'), raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.completion_defaults = { enabled: true, level: 'archive' }; fs.writeFileSync(file, JSON.stringify(raw));
    const initial = await get(a), before = a.store.all('SELECT * FROM events');
    expect(initial.automation_settings).toMatchObject({ version: 1, completion_defaults: { enabled: false, level: 'merge' },
      acceptance_notice_defaults: { enabled: true }, display_principles: { completion: 'all', push: 'all', convergence: 'all', acceptance_notice: 'all' } });
    await get(a); expect(a.store.all('SELECT * FROM events')).toEqual(before);
    const old = (await post(a, 'order.submit', { content: 'old', start: false })).task;
    const changed = await settings(a, { completion_defaults: { enabled: true, level: 'accept' }, acceptance_notice_defaults: { enabled: false },
      display_principles: { completion: 'main', acceptance_notice: 'user' } });
    expect(changed.completion_defaults.revision).toBe(changed.automation_settings.revision);
    expect(changed.daemon_hooks.revision).toBe(initial.daemon_hooks.revision);
    expect(b.project.automationSettings()).toEqual(initial.automation_settings);
    expect((await hooks(a, old.id)).acceptance_notice.enabled).toBe(true);
    expect((await hooks(a, old.id)).completion.level).toBe('off');
    expect((await hooks(a, old.id)).automation_settings.display_principles.completion).toBe('main');
    const fresh = (await post(a, 'order.submit', { content: 'fresh', start: false })).task;
    expect((await hooks(a, fresh.id)).completion.level).toBe('accept');
    expect((await hooks(a, fresh.id)).acceptance_notice.enabled).toBe(false);
    for (const patch of [{}, { auto_select: { enabled: true } }, { completion_defaults: { enabled: 1 } }, { completion_defaults: { level: 'off' } },
      { acceptance_notice_defaults: {} }, { acceptance_notice_defaults: { locked: false } }, { display_principles: { push: 'owner' } },
      { display_principles: { inherit: 'all' } }, { convergence_defaults: { enabled: true } }])
      expect((await post(a, 'hooks.automation_settings', { patch, expected_revision: changed.automation_settings.revision }, 400)).error).toBeString();
    expect((await post(a, 'hooks.automation_settings', { patch: { completion_defaults: { enabled: false } }, expected_revision: initial.automation_settings.revision }, 400)).error).toContain('revision');
    const rpc = new RPCClient(a.config.socket);
    expect((await rpc.request('hooks.list')).automation_settings).toEqual(changed.automation_settings);
    const updated = await rpc.request('hooks.automation_settings', { patch: { display_principles: { push: 'user', convergence: 'main' } }, expected_revision: changed.automation_settings.revision });
    expect(updated.automation_settings.display_principles).toMatchObject({ push: 'user', convergence: 'main' });
    expect(JSON.stringify(updated)).not.toContain('authorization');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).completion_defaults).toEqual(raw.completion_defaults);
    expect(a.store.get("SELECT value FROM meta WHERE key='completion_defaults'").value).toContain('archive');
  } finally { await b.close(); await a.close(); }
});

test('real controlled Provider has no user-setting permission; order/child notice switches do not unlock completion or bypass freeze', async () => {
  const f = await setup(); let checked = 0;
  try {
    await repo(f.root);
    f.project.provider = { resolve() { return { agent: 'mock' }; }, async run({ task, token }) {
      const rpc = new RPCClient(f.config.socket);
      for (const [method, params] of [['hooks.automation_settings', { patch: { acceptance_notice_defaults: { enabled: false } }, expected_revision: 'x' }],
        ['worker.acceptance_notice', { id: task.id, enabled: false, expected_revision: 'x' }]]) {
        await expect(rpc.request(method, { ...params, _token: token })).rejects.toThrow('requires user approval'); checked++;
      }
      return 'controlled answer';
    } };
    const parent = (await post(f, 'order.submit', { content: 'parent', start: false })).task;
    f.project.stopping = true;
    const child = await f.project.spawn(parent.id, 'child');
    const before = await hooks(f, child.id);
    expect(before.acceptance_notice).toMatchObject({ enabled: false, editable: true });
    const on = await toggle(f, child.id, true);
    expect(on.acceptance_notice.enabled).toBe(true);
    expect(on.completion).toMatchObject({ level: 'merge', locked: true, editable: false });
    expect((await post(f, 'worker.acceptance_notice', { id: child.id, enabled: false, expected_revision: before.revision }, 400)).error).toContain('revision');
    expect((await post(f, 'worker.completion', { id: child.id, level: 'accept', expected_revision: on.revision }, 400)).error).toContain('锁定');
    for (const extra of [{ force: true }, { locked: false }, { scope: 'device' }])
      expect((await post(f, 'worker.acceptance_notice', { id: child.id, enabled: false, expected_revision: on.revision, ...extra }, 400)).error).toContain('unknown parameter');
    const reservation = f.store.task(child.id).reservation;
    f.store.update(child.id, { reservation: JSON.stringify({ version: 2, kind: 'merge', status: 'requested' }) });
    const frozen = await hooks(f, child.id); expect(frozen.acceptance_notice.editable).toBe(false);
    expect((await post(f, 'worker.acceptance_notice', { id: child.id, enabled: false, expected_revision: frozen.revision }, 400)).error).toContain('冻结');
    f.store.update(child.id, { reservation });
    f.project.stopping = false; f.project.kick(); await ready(f, child.id);
    expect(checked).toBe(2); expect(notices(f, child.id)).toHaveLength(1);
    expect(notices(f, child.id)[0].title).toContain('待父确认');
    for (const method of ['hooks.automation_settings','worker.acceptance_notice'])
      expect(managementCatalog().methods.find(item => item.method === method).access).toBe('unavailable');
  } finally { f.project.stopping = false; await f.close(); }
});

for (const auto of [false, true]) test(`real ${auto ? 'automatic' : 'manual'} Git delivery emits exactly once per round; closed success and failures stay separate`, async () => {
  const f = await setup(); let call = 0;
  try {
    await repo(f.root);
    f.project.provider = { resolve() { return { agent: 'mock' }; }, async run({ task }) {
      const request = JSON.parse(f.store.task(task.id).reservation ?? 'null');
      if (request?.status === 'resolving') {
        // The real Squash protocol can require preserving a fixed parent between rounds.
        await git(task.workspace, 'merge', '--no-edit', request.parent_commit);
        return `reconciled ${call}`;
      }
      call++;
      fs.writeFileSync(path.join(task.workspace, `answer-${call}.txt`), String(call));
      await git(task.workspace, 'add', '.'); await git(task.workspace, 'commit', '-m', 'controlled work'); return `done ${call}`;
    } };
    await settings(f, { completion_defaults: { enabled: auto, level: 'merge' } });
    const { task } = await post(f, 'order.submit', { content: 'work', start: false });
    await post(f, 'worker.resume', { id: task.id });
    if (!auto) {
      await until(() => f.store.task(task.id).status === 'waiting' && !f.project.running.has(task.id));
      expect(notices(f, task.id)).toHaveLength(0);
      await post(f, 'worker.reserve', { id: task.id, kind: 'merge' });
    }
    await ready(f, task.id); expect(notices(f, task.id)).toHaveLength(1);
    const first = notices(f, task.id)[0]; expect(first.source_event_id).toBeGreaterThan(0);
    await toggle(f, task.id, false); await toggle(f, task.id, true);
    f.project.notifyAcceptanceEntry(task.id, first.source_event_id);
    f.project.scheduleTaskCompletion(task.id); await f.project.completionQueue;
    for (const route of ['/api/hooks', `/api/worker/${task.id}/hooks`, `/api/worker/${task.id}`]) await get(f, route);
    expect(notices(f, task.id)).toHaveLength(1);
    await post(f, 'worker.message', { id: task.id, body: 'next round' });
    if (!auto) {
      await until(() => call === 2 && f.store.task(task.id).status === 'waiting' && !f.project.running.has(task.id));
      await post(f, 'worker.reserve', { id: task.id, kind: 'merge' });
    }
    await ready(f, task.id);
    expect(notices(f, task.id)).toHaveLength(2);
    await toggle(f, task.id, false);
    await post(f, 'worker.message', { id: task.id, body: 'closed success' });
    if (!auto) {
      await until(() => call === 3 && f.store.task(task.id).status === 'waiting' && !f.project.running.has(task.id));
      await post(f, 'worker.reserve', { id: task.id, kind: 'merge' });
    }
    await ready(f, task.id); expect(notices(f, task.id)).toHaveLength(2);
    await toggle(f, task.id, true); expect(notices(f, task.id)).toHaveLength(2); // no backfill
    await toggle(f, task.id, false);
    f.project.provider.run = async () => { throw new Error('controlled failure'); };
    await post(f, 'worker.message', { id: task.id, body: 'must preserve failure' });
    await until(() => f.store.task(task.id).status === 'failed' && !f.project.running.has(task.id));
    expect(notices(f, task.id).filter(n => n.title.includes('待验收'))).toHaveLength(2);
    expect(notices(f, task.id).filter(n => n.title.includes('异常停止'))).toHaveLength(1);
    expect(notices(f, task.id).length).toBeGreaterThanOrEqual(3); // Independent blocked/unknown diagnostics remain visible too.
    expect((await hooks(f, task.id)).acceptance_notice.editable).toBe(false);
  } finally { await f.close(); }
});

test('real no-code automatic delivery advances exact rounds; automatic acceptance succeeds silently and restart does not backfill history', async () => {
  const f = await setup(); let restarted;
  try {
    await repo(f.root);
    f.project.provider = { resolve() { return { agent: 'mock' }; }, async run() { return 'no-code answer'; } };
    await settings(f, { completion_defaults: { enabled: true, level: 'merge' } });
    const { task } = await post(f, 'order.submit', { content: 'answer', start: false });
    await post(f, 'worker.resume', { id: task.id }); await ready(f, task.id);
    expect(f.store.task(task.id).integration).toBe('none'); expect(notices(f, task.id)).toHaveLength(1);
    await post(f, 'worker.message', { id: task.id, body: 'answer again' });
    await until(() => f.store.task(task.id).calls === 2 && f.store.task(task.id).status === 'awaiting_acceptance' && !f.project.running.has(task.id));
    await f.project.completionQueue;
    expect(notices(f, task.id)).toHaveLength(2);
    expect(f.store.history(task.id).filter(e => e.type === 'task.acceptance_notice_observed').map(e => e.data.round)[1]).toBeGreaterThan(0);
    await settings(f, { completion_defaults: { enabled: true, level: 'accept' } });
    const accepted = (await post(f, 'order.submit', { content: 'automatic acceptance', start: false })).task;
    await post(f, 'worker.resume', { id: accepted.id });
    await until(() => f.store.task(accepted.id).status === 'completed' && f.store.branch(accepted.branch).status === 'archived' && !f.project.completionQueued?.size, 10000);
    expect(notices(f, accepted.id)).toHaveLength(0);
    expect(f.store.history(accepted.id).some(e => e.type === 'task.accepted')).toBe(true);
    await f.project.shutdown();
    // Simulate pre-upgrade awaiting history with no new success marker.
    f.store.run("DELETE FROM events WHERE task_id=? AND type='task.acceptance_notice_observed'", task.id);
    const count = f.store.get('SELECT count(*) AS n FROM notices').n;
    restarted = new Project(f.config, f.store); restarted.kick = () => {}; restarted.recover();
    await restarted.completionQueue;
    restarted.hooksList(); restarted.taskHooks(task.id);
    expect(f.store.get('SELECT count(*) AS n FROM notices').n).toBe(count);
  } finally { await restarted?.shutdown(); await f.close(); }
});

test('real manual parent synchronization enters awaiting acceptance for an unchanged answer without inventing a merge', async () => {
  const f = await setup();
  try {
    await repo(f.root);
    f.project.provider = { resolve() { return { agent: 'mock' }; }, async run() { return 'manual no-code answer'; } };
    const { task } = await post(f, 'order.submit', { content: 'manual answer', start: false });
    await post(f, 'worker.resume', { id: task.id });
    await until(() => f.store.task(task.id).status === 'waiting' && !f.project.running.has(task.id));
    expect(notices(f, task.id)).toHaveLength(0);
    const head = await git(f.root, 'rev-parse', 'main');
    await post(f, 'worker.sync_parent', { id: task.id });
    expect(f.store.task(task.id).status).toBe('awaiting_acceptance');
    expect(notices(f, task.id)).toHaveLength(1);
    expect(f.store.history(task.id).filter(e => e.type === 'task.merge_integrated')).toHaveLength(0);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(head);
    await post(f, 'worker.sync_parent', { id: task.id });
    expect(notices(f, task.id)).toHaveLength(1);
  } finally { await f.close(); }
});
