import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, temp, repo, until } from '../helpers.js';
import { Project } from '../../src/core/project.js';
import { DeviceAutomationSettings } from '../../src/core/device-automation.js';

function task(f, goal = 'pending work') {
  const row = f.store.create({ role: 'worker', goal });
  f.store.update(row.id, { status: 'paused' }); return row;
}
function configure(f, enabled) {
  return f.project.deviceAutomation.save({ auto_select: { enabled } }, f.project.deviceAutomation.get().revision);
}
const savedNotice = (f, notice) => f.store.get('SELECT * FROM notices WHERE id=?', notice.id);
const automatic = f => f.store.get("SELECT count(*) AS n FROM notices WHERE answer_source='lush'").n;

test('old project on/default-archive authorization is retained historically but never grants device authority', async () => {
  const f = fixture(); f.project.kick = () => {};
  try {
    for (const [key, value] of [['daemon_auto_select', { version: 1, enabled: true, generation: 7 }],
      ['completion_defaults', { version: 1, enabled: true, level: 'archive', generation: 9 }]])
      f.store.run('INSERT INTO meta(key,value) VALUES (?,?)', key, JSON.stringify(value));
    const before = f.store.all("SELECT * FROM meta WHERE key IN ('daemon_auto_select','completion_defaults')");
    const notice = f.project.notice(task(f).id, 'manual question');
    expect(f.project.daemonHooks()).toMatchObject({ scope: 'device', available: true, mounts: [{ enabled: false }] });
    expect(f.project.completionDefaults()).toMatchObject({ enabled: false, level: 'merge' });
    f.project.startDeviceAutomationMonitor(); await Promise.resolve();
    expect(savedNotice(f, notice).status).toBe('open');
    expect(f.store.all("SELECT * FROM meta WHERE key IN ('daemon_auto_select','completion_defaults')")).toEqual(before);
    expect(fs.existsSync(path.join(f.config.deviceHome, 'automation.json'))).toBe(false);
  } finally { await f.close(); }
});

test('a Host-style device write reaches two independent project monitors and answers both backlogs without read-side effects', async () => {
  const shared = temp(), a = fixture(undefined, { LUSH_GLOBAL_CONFIG: shared }), b = fixture(undefined, { LUSH_GLOBAL_CONFIG: shared });
  a.project.kick = b.project.kick = () => {};
  try {
    a.project.startDeviceAutomationMonitor(); b.project.startDeviceAutomationMonitor();
    const pending = [a.project.notice(task(a).id, 'project A'), b.project.notice(task(b).id, 'project B')];
    const revisions = [a.project.overviewRevision(), b.project.overviewRevision()];
    const settings = new DeviceAutomationSettings({ home: a.config.deviceHome });
    const enabled = settings.save({ auto_select: { enabled: true } }, settings.get().revision);
    for (const [f, index] of [[a, 0], [b, 1]]) {
      expect(f.project.daemonHooks()).toMatchObject({ scope: 'device', policy_revision: enabled.revision, mounts: [{ enabled: true }] });
      expect(f.project.overviewRevision()).not.toBe(revisions[index]);
      expect(savedNotice(f, pending[index]).status).toBe('open');
      f.project.hooksList(); f.project.summary();
      expect(savedNotice(f, pending[index]).status).toBe('open');
    }
    await until(() => automatic(a) === 1 && automatic(b) === 1, 4000);
    expect(a.project.deviceAutomationObservedRevision).toBe(enabled.revision);
    expect(b.project.deviceAutomationObservedRevision).toBe(enabled.revision);
    expect([a, b].every(f => f.store.get("SELECT count(*) AS n FROM events WHERE type='notice.answered'").n === 1)).toBe(true);
    settings.save({ auto_select: { enabled: false } }, enabled.revision);
    const later = [a.project.notice(task(a).id, 'later A'), b.project.notice(task(b).id, 'later B')];
    await Promise.resolve();
    expect(later.map((notice, index) => savedNotice(index ? b : a, notice).status)).toEqual(['open', 'open']);
  } finally { await a.close(); await b.close(); fs.rmSync(shared, { recursive: true, force: true }); }
}, 10000);

test('global completion defaults affect only actual future orders in both projects and never child/old task authorizations', async () => {
  const shared = temp(), a = fixture(undefined, { LUSH_GLOBAL_CONFIG: shared }), b = fixture(undefined, { LUSH_GLOBAL_CONFIG: shared });
  a.project.kick = b.project.kick = () => {};
  try {
    await Promise.all([repo(a.root), repo(b.root)]);
    const old = (await a.project.order('old', null, [], null, false)).task;
    const oldConfig = a.store.task(old.id).auto_merge;
    const settings = new DeviceAutomationSettings({ home: a.config.deviceHome });
    const enabled = settings.save({ completion_defaults: { enabled: true, level: 'archive' } }, settings.get().revision);
    expect(b.project.completionDefaults()).toMatchObject({ enabled: true, level: 'archive', revision: enabled.revision });
    const one = (await a.project.order('new A', null, [], null, false)).task;
    const two = (await b.project.order('new B', null, [], null, false)).task;
    expect([one, two].map(worker => JSON.parse(worker.auto_merge))).toMatchObject([
      { enabled: true, level: 'archive', locked: false }, { enabled: true, level: 'archive', locked: false },
    ]);
    expect(JSON.parse(one.auto_merge).completion.authorization).not.toBe(JSON.parse(two.auto_merge).completion.authorization);
    const child = await b.project.spawn(two.id, 'child');
    expect(JSON.parse(child.auto_merge)).toEqual({ version: 1, enabled: true, locked: true });
    expect(a.store.task(old.id).auto_merge).toBe(oldConfig);
    settings.save({ completion_defaults: { enabled: false } }, enabled.revision);
    expect(a.store.task(one.id).auto_merge).toBe(one.auto_merge);
    expect(b.store.task(two.id).auto_merge).toBe(two.auto_merge);
    expect(JSON.parse((await b.project.order('disabled', null, [], null, false)).task.auto_merge).enabled).toBe(false);
  } finally { await a.close(); await b.close(); fs.rmSync(shared, { recursive: true, force: true }); }
}, 15000);

test('closing global authorization before a nested creation transaction deferred answer leaves the question open', async () => {
  const f = fixture(); f.project.kick = () => {};
  try {
    const enabled = configure(f, true);
    const notice = f.project.notice(task(f).id, 'close before deferred settlement');
    expect(savedNotice(f, notice).status).toBe('open');
    new DeviceAutomationSettings(f.config).save({ auto_select: { enabled: false } }, enabled.revision);
    await Promise.resolve();
    expect(savedNotice(f, notice)).toMatchObject({ status: 'open', answer_source: null });
    expect(automatic(f)).toBe(0);
  } finally { await f.close(); }
});

test('final locked policy read defeats a close between an earlier cached read and settlement', async () => {
  const f = fixture(); f.project.kick = () => {};
  try {
    const notice = f.project.notice(task(f).id, 'pending'); configure(f, true);
    const lock = f.project.deviceAutomation.withPolicy.bind(f.project.deviceAutomation);
    f.project.deviceAutomation.withPolicy = callback => {
      const settings = new DeviceAutomationSettings(f.config);
      settings.save({ auto_select: { enabled: false } }, settings.get().revision);
      return lock(callback);
    };
    expect(f.project.autoAnswerNotice(notice.id)).toBe(false);
    expect(savedNotice(f, notice).status).toBe('open');
  } finally { await f.close(); }
});

test('answer outer commit holds the device write lock; completed close prevents subsequent answers', async () => {
  const f = fixture(); f.project.kick = () => {};
  try {
    const notice = f.project.notice(task(f).id, 'pending'); configure(f, true);
    const other = new DeviceAutomationSettings(f.config), message = f.store.message.bind(f.store);
    f.store.message = (...args) => {
      expect(f.store.db.inTransaction).toBe(true);
      expect(() => other.save({ auto_select: { enabled: false } }, other.get().revision)).toThrow('busy');
      return message(...args);
    };
    expect(f.project.autoAnswerNotice(notice.id)).toBe(true);
    f.store.message = message;
    expect(savedNotice(f, notice).answer_source).toBe('lush');
    other.save({ auto_select: { enabled: false } }, other.get().revision);
    const next = f.project.notice(notice.task_id, 'after close');
    await Promise.resolve();
    expect(savedNotice(f, next).status).toBe('open');
    expect(automatic(f)).toBe(1);
  } finally { await f.close(); }
});

test('busy policy locks leave questions pending without failed receipts and can be retried after known non-execution', async () => {
  const f = fixture(); f.project.kick = () => {};
  try {
    const notice = f.project.notice(task(f).id, 'pending'); configure(f, true);
    f.project.deviceAutomation.withPolicy(() => {
      expect(f.project.autoAnswerNotice(notice.id)).toBe(false);
      expect(savedNotice(f, notice).status).toBe('open');
      expect(f.project.daemonHooks().mounts[0].last_execution).toBe(null);
    });
    f.project.refreshDeviceAutomation();
    expect(savedNotice(f, notice).answer_source).toBe('lush');
    expect(f.project.daemonHooks().mounts[0].last_execution.status).toBe('succeeded');
  } finally { await f.close(); }
});

test('failed legacy question receipts survive restart and monitors do not repeatedly retry unknown effects', async () => {
  const f = fixture(); f.project.kick = () => {}; let restarted;
  try {
    const owner = task(f);
    const inserted = f.store.run("INSERT INTO notices(task_id,title,body,kind) VALUES (?,?,?,'questionnaire')", owner.id, 'legacy', '{secret malformed');
    configure(f, true); f.project.refreshDeviceAutomation();
    const events = f.store.all("SELECT * FROM events WHERE type='hook.daemon_failed'");
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('secret malformed');
    for (let i = 0; i < 3; i++) f.project.refreshDeviceAutomation();
    expect(f.store.all("SELECT * FROM events WHERE type='hook.daemon_failed'")).toEqual(events);
    await f.project.shutdown();
    restarted = new Project(f.config, f.store); restarted.kick = () => {}; restarted.recover();
    expect(restarted.daemonHooks().mounts[0]).toMatchObject({ state: 'failed', last_execution: { status: 'failed' } });
    expect(f.store.get('SELECT status,answer_source FROM notices WHERE id=?', Number(inserted.lastInsertRowid))).toEqual({ status: 'open', answer_source: null });
    expect(f.store.all("SELECT * FROM events WHERE type='hook.daemon_failed'")).toEqual(events);
  } finally { await restarted?.shutdown(); await f.close(); }
});

test('manually settled failures release bounded receipt slots without automatically retrying the failed question', async () => {
  const f = fixture(); f.project.kick = () => {};
  try {
    const owner = task(f);
    const row = f.store.run("INSERT INTO notices(task_id,title,body,kind) VALUES (?,?,?,'questionnaire')", owner.id, 'malformed', '{invalid');
    configure(f, true); f.project.refreshDeviceAutomation();
    const noticeId = Number(row.lastInsertRowid);
    const receipts = () => JSON.parse(f.store.get("SELECT value FROM meta WHERE key='device_auto_select_receipts'").value);
    expect(receipts().blocked).toHaveLength(1);
    expect(f.store.get('SELECT status FROM notices WHERE id=?', noticeId).status).toBe('open');
    f.project.answer(noticeId, '', true);
    f.project.refreshDeviceAutomation();
    expect(receipts().blocked).toHaveLength(0);
    expect(f.store.get('SELECT status,answer_source FROM notices WHERE id=?', noticeId)).toEqual({ status: 'dismissed', answer_source: 'user' });
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE type='hook.daemon_failed'").n).toBe(1);
  } finally { await f.close(); }
});

test('corrupted device policy is fail-closed for answers and creation, while the original Notice is retained', async () => {
  const f = fixture(); f.project.kick = () => {};
  try {
    configure(f, true);
    const file = path.join(f.config.deviceHome, 'automation.json'), original = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, '{secret invalid policy');
    const notice = f.project.notice(task(f).id, 'original');
    expect(f.project.refreshDeviceAutomation()).toBe(false);
    expect(f.project.daemonHooks()).toMatchObject({ available: false, mounts: [{ enabled: false, editable: false }] });
    expect(JSON.stringify(f.project.daemonHooks())).not.toContain('secret invalid policy');
    expect(() => f.project.newOrderCompletionConfig()).toThrow('unavailable or invalid');
    await Promise.resolve(); expect(savedNotice(f, notice).status).toBe('open');
    fs.writeFileSync(file, original);
    f.project.refreshDeviceAutomation();
    expect(savedNotice(f, notice).answer_source).toBe('lush');
  } finally { await f.close(); }
});

test('monitor ownership is idempotent and shutdown cancels the interval and pending batch continuation', async () => {
  const f = fixture(); f.project.kick = () => {};
  const intervals = new Map(), timeouts = new Map(); let seq = 1;
  f.project.deviceAutomationOptions = {
    setInterval(callback, ms) { expect(ms).toBe(1000); const id = seq++; intervals.set(id, callback); return id; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(callback, ms) { expect(ms).toBe(0); const id = seq++; timeouts.set(id, callback); return id; },
    clearTimeout(id) { timeouts.delete(id); },
  };
  try {
    const owner = task(f);
    for (let i = 0; i < 40; i++) f.project.notice(owner.id, `pending ${i}`);
    configure(f, true);
    f.project.startDeviceAutomationMonitor(); f.project.startDeviceAutomationMonitor();
    expect(intervals.size).toBe(1); expect(timeouts.size).toBe(1); expect(automatic(f)).toBe(16);
    await f.project.shutdown();
    expect(intervals.size).toBe(0); expect(timeouts.size).toBe(0);
    expect(f.project.deviceAutomationMonitor).toBe(null);
    expect(f.project.deviceAutoSelectBatchTimer).toBe(null);
    expect(automatic(f)).toBe(16);
  } finally { await f.close(); }
});
