import { test, expect, setDefaultTimeout } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { repo, git, until } from '../helpers.js';
import { setup, fetch } from './harness.js';
import { hookSchedule } from '../../src/ui/web/assets/hook-schedule.js';
setDefaultTimeout(20000);
const get = async (f, route) => (await fetch(f.url + route)).json();
async function action(f, method, params) {
  const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }) });
  const value = await response.json(); expect(response.status).toBe(200); return value;
}
async function attach(f, id, hook) {
  const model = await get(f, `/api/worker/${id}/hooks`);
  return (await action(f, 'worker.hook_attach', { id, hook, expected_revision: model.revision })).mounts.at(-1);
}
function clock(f) {
  let now = Date.parse('2030-01-01T00:00:00Z');
  f.project.scheduledHookOptions = { now: () => now, setTimeout: () => 1, clearTimeout: () => {} };
  return { advance: ms => { now += ms; }, once: () => ({ kind: 'once', at: new Date(now + 60000).toISOString(), timezone: 'UTC' }) };
}

test('real HTTP template mount starts daemon timer and creates one Git workspace without browser polling', async () => {
  const f = await setup(); f.project.kick = () => {};
  try {
    await repo(f.root); const main = await f.project.ensureMainTask();
    const profile = { agent: 'pi', model: 'test/codex', append_prompt: 'PRIVATE_SCHEDULE_PROMPT', env: { KEY: 'PRIVATE_SCHEDULE_ENV' } };
    const schedule = { kind: 'once', at: new Date(Date.now() + 1000).toISOString(), timezone: 'Asia/Shanghai' };
    let catalogue = await get(f, '/api/hooks');
    catalogue = await action(f, 'hooks.save', { expected_revision: catalogue.revision, template: {
      name: 'scheduled HTTP creation', trigger: 'time.scheduled', mode: 'once', enabled: true, schedule,
      actions: [{ type: 'create_worker', content: 'night job', start: false, profile }],
    } });
    const template = catalogue.templates[0];
    expect(JSON.stringify(template)).not.toContain('PRIVATE_SCHEDULE');
    const mount = await attach(f, main.id, { template_id: template.id });
    expect(mount).toMatchObject({ state: 'waiting', schedule, pending_due_at: null });
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(0);
    // Only observe database output, never manually tick or read the UI to execute.
    await until(() => JSON.parse(f.store.task(main.id).hooks).mounts.at(-1).state === 'succeeded');
    const model = await get(f, `/api/worker/${main.id}/hooks`), done = model.mounts.find(item => item.id === mount.id);
    expect(done).toMatchObject({ enabled: false, state: 'succeeded', pending_due_at: null, next_run_at: null });
    expect(done.last_execution.due_at).toBe(schedule.at);
    const created = await get(f, `/api/worker/${done.last_execution.worker_id}`);
    expect(created).toMatchObject({ goal: 'night job', status: 'paused', parent_id: main.id, base_commit: await git(f.root, 'rev-parse', 'main') });
    expect(fs.existsSync(path.join(created.workspace, '.git'))).toBe(true);
    expect(JSON.parse(f.store.task(created.id).retry_profile).env).toEqual(profile.env);
    for (const route of ['/api/hooks', `/api/worker/${main.id}/hooks`, `/api/worker/${created.id}`, '/api/snapshot']) {
      expect(JSON.stringify(await get(f, route))).not.toContain('PRIVATE_SCHEDULE');
    }
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(1);
  } finally { await f.close(); }
});

test('HTTP failed self-retry and paused resume preserve explicit profiles and safe numbered projections', async () => {
  const f = await setup(); f.project.kick = () => {};
  try {
    await repo(f.root);
    const failed = (await action(f, 'order.submit', { content: 'failed target', branch: 'main', start: false })).task;
    const paused = (await action(f, 'order.submit', { content: 'paused target', branch: 'main', start: false })).task;
    f.store.update(failed.id, { status: 'failed', error: 'quota depleted' });
    const time = clock(f), profile = { agent: 'pi', model: 'test/chosen-codex', append_prompt: 'PRIVATE_RETRY_PROMPT', env: { KEY: 'PRIVATE_RETRY_ENV' } };
    let catalogue = await get(f, '/api/hooks');
    catalogue = await action(f, 'hooks.save', { expected_revision: catalogue.revision, template: {
      name: 'night retry', trigger: 'time.scheduled', mode: 'once', enabled: true, schedule: time.once(),
      actions: [{ type: 'retry_worker', target_id: failed.id, profile }],
    } });
    const publicTemplate = catalogue.templates[0];
    const edited = { ...publicTemplate, name: 'renamed night retry', actions: publicTemplate.actions.map(({ model_selection, target_worker_number, ...item }) => item) };
    catalogue = await action(f, 'hooks.save', { expected_revision: catalogue.revision, template: edited });
    expect(catalogue.templates[0].actions[0]).toMatchObject({ target_worker_number: failed.worker_number, model_selection: { model: profile.model } });
    expect(JSON.stringify(catalogue)).not.toContain('PRIVATE_RETRY');
    expect((await get(f, `/api/worker/${failed.id}/hooks`)).can_attach).toBe(true);
    const retry = await attach(f, failed.id, { template_id: edited.id });
    const resume = await attach(f, paused.id, { name: 'continue tonight', trigger: 'time.scheduled', mode: 'once', enabled: true,
      schedule: time.once(), actions: [{ type: 'resume_worker', target_id: paused.id }] });
    time.advance(60000); f.project.observeScheduledTaskHooks(); await f.project.hookQueue;
    expect(f.store.task(failed.id).status).toBe('queued'); expect(f.store.task(paused.id).status).toBe('queued');
    expect(JSON.parse(f.store.task(failed.id).retry_profile).env).toEqual(profile.env);
    for (const [id, mount] of [[failed.id, retry], [paused.id, resume]]) {
      const model = await get(f, `/api/worker/${id}/hooks`);
      expect(model.mounts.find(item => item.id === mount.id)).toMatchObject({ state: 'succeeded', enabled: false, pending_due_at: null });
      expect(JSON.stringify(model)).not.toContain('PRIVATE_RETRY');
    }
  } finally { await f.close(); }
});

test('daemon automatic answers and Worker timers coexist with independent authorization and no early scheduled creation', async () => {
  const f = await setup(); f.project.kick = () => {};
  try {
    await repo(f.root);
    const source = (await action(f, 'order.submit', { content: 'ask a question', branch: 'main', start: false })).task;
    f.store.update(source.id, { status: 'waiting' });
    const time = clock(f);
    const mount = await attach(f, source.parent_id, { name: 'future creation independent of questions', trigger: 'time.scheduled', mode: 'once', enabled: true,
      schedule: time.once(), actions: [{ type: 'create_worker', content: 'next timed job', start: false }] });
    let catalogue = await get(f, '/api/hooks');
    const templateRevision = catalogue.revision;
    catalogue = await action(f, 'hooks.auto_select', { enabled: true, expected_revision: catalogue.daemon_hooks.revision });
    const daemonRevision = catalogue.daemon_hooks.revision;
    expect(catalogue.revision).toBe(templateRevision);
    const notice = f.project.notice(source.id, 'Choose', 'Which direction?');
    expect(notice).toMatchObject({ status: 'answered', answer_source: 'lush' });
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(1);
    let model = await get(f, `/api/worker/${source.parent_id}/hooks`);
    expect(model.mounts.find(item => item.id === mount.id)).toMatchObject({ state: 'waiting', pending_due_at: null });
    time.advance(60000); f.project.observeScheduledTaskHooks(); await f.project.hookQueue;
    model = await get(f, `/api/worker/${source.parent_id}/hooks`);
    expect(model.mounts.find(item => item.id === mount.id)).toMatchObject({ state: 'succeeded', enabled: false });
    expect((await get(f, '/api/hooks')).daemon_hooks.revision).toBe(daemonRevision);
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(2);
    f.project.observeScheduledTaskHooks(); await f.project.hookQueue;
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(2);
  } finally { await f.close(); }
});

test('a skipped one-shot cannot be re-enabled after a clock rollback to create a live but ineligible timer', async () => {
  const f = await setup(); f.project.kick = () => {};
  try {
    await repo(f.root); const main = await f.project.ensureMainTask(), time = clock(f);
    const mount = await attach(f, main.id, { name: 'missed time', trigger: 'time.scheduled', mode: 'once', enabled: true,
      schedule: time.once(), actions: [{ type: 'notify', title: 'must not execute', body: '' }] });
    time.advance(120000); f.project.recoverTaskHooks(); await f.project.hookQueue;
    const model = await get(f, `/api/worker/${main.id}/hooks`);
    expect(model.mounts.find(item => item.id === mount.id)).toMatchObject({ state: 'skipped', enabled: false, next_run_at: null });
    time.advance(-120000);
    const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'worker.hook_update', params: { id: main.id, hook_id: mount.id, enabled: true, expected_revision: model.revision } }) });
    expect(response.status).toBe(400); expect((await response.json()).error).toContain('skipped');
    expect(f.project.scheduledHookTimer).toBeNull();
  } finally { await f.close(); }
});

test('browser time definition reaches HTTP and frozen creation remains submitted until the current Git tip is safe', async () => {
  const f = await setup(); f.project.kick = () => {};
  try {
    await repo(f.root);
    const source = (await action(f, 'order.submit', { content: 'hold main', branch: 'main', start: false })).task;
    const mainId = source.parent_id, time = clock(f);
    f.store.update(source.id, { reservation: JSON.stringify({ version: 1, kind: 'merge', status: 'requested', commit: source.base_commit }) });
    // Pure browser conversion is fed into the real HTTP/runtime validator.
    const schedule = hookSchedule('once', '2030-01-01T08:01:00', '', 'Asia/Shanghai');
    const mount = await attach(f, mainId, { name: 'frozen timed job', trigger: 'time.scheduled', mode: 'once', enabled: true,
      schedule, actions: [{ type: 'create_worker', content: 'after safe point', start: false }] });
    time.advance(60000); f.project.observeScheduledTaskHooks(); await f.project.hookQueue;
    let model = await get(f, `/api/worker/${mainId}/hooks`), pending = model.mounts.find(item => item.id === mount.id);
    expect(pending).toMatchObject({ state: 'waiting', pending_due_at: schedule.at }); expect(pending.reason).toContain('冻结');
    const before = f.store.task(mainId).hooks;
    await get(f, `/api/worker/${mainId}/hooks`); expect(f.store.task(mainId).hooks).toBe(before);
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(1);
    fs.writeFileSync(path.join(f.root, 'new-tip.txt'), 'before timed fork');
    await git(f.root, 'add', '.'); await git(f.root, 'commit', '-m', 'advance fixed parent before gate release');
    const tip = await git(f.root, 'rev-parse', 'main');
    await action(f, 'worker.unreserve', { id: source.id }); await f.project.runParentReadyHooks(mainId);
    model = await get(f, `/api/worker/${mainId}/hooks`); const done = model.mounts.find(item => item.id === mount.id);
    expect(done).toMatchObject({ state: 'succeeded', enabled: false, pending_due_at: null });
    expect(f.store.task(done.last_execution.worker_id).base_commit).toBe(tip);
    f.project.observeScheduledTaskHooks(); await f.project.hookQueue;
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(2);
  } finally { await f.close(); }
});
