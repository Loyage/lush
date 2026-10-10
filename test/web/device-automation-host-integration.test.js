import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, until, repo } from '../helpers.js';
import { setup, fetch } from './harness.js';

async function read(f) {
  const response = await fetch(`${f.url}/api/host/automation`);
  expect(response.status).toBe(200);
  return response.json();
}
async function save(f, patch, expected_revision) {
  const response = await fetch(`${f.url}/api/host/automation`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ patch, expected_revision }) });
  return { status: response.status, value: await response.json() };
}
function pending(f, title) {
  const task = f.store.create({ role: 'worker', goal: title });
  f.store.update(task.id, { status: 'paused' });
  return f.project.notice(task.id, title);
}
function clock(f) {
  let tick = null;
  f.project.deviceAutomationOptions = {
    setInterval(callback, ms) { expect(ms).toBe(1000); tick = callback; return 1; },
    clearInterval() { tick = null; },
  };
  return () => tick?.();
}
const notice = (f, id) => f.store.get('SELECT status,answer_source FROM notices WHERE id=?', id);

test('real Host automation routes share project policy without read-side effects or project switch fan-out', async () => {
  const a = await setup(), b = fixture(undefined, { LUSH_GLOBAL_CONFIG: a.config.env.LUSH_GLOBAL_CONFIG });
  a.project.kick = b.project.kick = () => {};
  const tickA = clock(a), tickB = clock(b);
  try {
    a.project.startDeviceAutomationMonitor(); b.project.startDeviceAutomationMonitor();
    const one = pending(a, 'A backlog'), two = pending(b, 'B backlog');
    const eventsA = a.store.all('SELECT * FROM events'), eventsB = b.store.all('SELECT * FROM events');
    const initial = await read(a);
    expect(initial).toEqual(a.project.deviceAutomation.get());
    expect(initial.auto_select.enabled).toBe(false);
    expect(a.store.all('SELECT * FROM events')).toEqual(eventsA);
    expect(b.store.all('SELECT * FROM events')).toEqual(eventsB);
    expect(fs.existsSync(path.join(a.config.deviceHome, 'automation.json'))).toBe(false);
    const enabled = await save(a, { auto_select: { enabled: true } }, initial.revision);
    expect(enabled.status).toBe(200);
    expect(b.project.deviceAutomation.get()).toEqual(enabled.value);
    await read(a);
    expect([notice(a, one.id), notice(b, two.id)]).toEqual([
      { status: 'open', answer_source: null }, { status: 'open', answer_source: null },
    ]);
    expect(a.store.all('SELECT * FROM events')).toEqual(eventsA);
    expect(b.store.all('SELECT * FROM events')).toEqual(eventsB);
    tickA(); tickB();
    expect([notice(a, one.id), notice(b, two.id)]).toEqual([
      { status: 'answered', answer_source: 'lush' }, { status: 'answered', answer_source: 'lush' },
    ]);
    const stale = await save(a, { auto_select: { enabled: false } }, initial.revision);
    expect(stale.status).toBe(400);
    expect((await read(a)).auto_select.enabled).toBe(true);
    expect((await save(a, { auto_select: { enabled: false } }, enabled.value.revision)).status).toBe(200);
    const afterClose = [pending(a, 'closed A'), pending(b, 'closed B')];
    await Promise.resolve(); tickA(); tickB();
    expect([notice(a, afterClose[0].id), notice(b, afterClose[1].id)]).toEqual([
      { status: 'open', answer_source: null }, { status: 'open', answer_source: null },
    ]);
  } finally { await b.close(); await a.close(); }
}, 15000);

test('Host default writes govern only new orders, and stopping Host does not revoke daemon authority', async () => {
  const f = await setup(); f.project.kick = () => {};
  try {
    await repo(f.root);
    const old = (await f.project.order('existing', null, [], null, false)).task;
    const initial = await read(f);
    const saved = await save(f, { completion_defaults: { enabled: true, level: 'archive' },
      auto_select: { enabled: true } }, initial.revision);
    expect(saved.status).toBe(200);
    expect(f.store.task(old.id).auto_merge).toBe(old.auto_merge);
    const fresh = (await f.project.order('future', null, [], null, false)).task;
    expect(saved.value.completion_defaults).toMatchObject({ enabled: true, level: 'accept' });
    expect(JSON.parse(fresh.auto_merge)).toMatchObject({ enabled: true, locked: false, level: 'accept' });
    const child = await f.project.spawn(fresh.id, 'child');
    expect(JSON.parse(child.auto_merge)).toEqual({ version: 1, enabled: true, locked: true });
    await f.web.stop(true);
    expect(f.project.deviceAutomation.get()).toEqual(saved.value);
    expect(f.project.stopping).toBe(false);
    const question = pending(f, 'after Host stops');
    await until(() => notice(f, question.id).status === 'answered');
    expect(notice(f, question.id).answer_source).toBe('lush');
  } finally { await f.close(); }
}, 15000);
