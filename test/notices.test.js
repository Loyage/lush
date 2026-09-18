import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { TOOL_DEFINITIONS } from '../src/agent/tools.js';
import { ROOT } from '../src/cli/tree/index.js';
import { formatNotice, formatNoticeList } from '../src/cli/format/notice.js';
import { RPCClient } from '../src/rpc/client.js';
import { Dispatcher } from '../src/rpc/protocol.js';
import { RPCServer } from '../src/rpc/server.js';
import { createSignal } from '../src/signal.js';
import { UIClient } from '../src/ui/client.js';
import { WebUIServer } from '../src/ui/web.js';
import { cleanup, expectRejection, permissiveRoot, system, tmpdir } from './helpers.js';

const FORM = [
  { name: 'plan', label: '方案', type: 'choice', options: ['blue-green', 'canary'], required: true },
  { name: 'note', label: '补充说明', type: 'textarea' },
  { name: 'approve', label: '是否批准', type: 'boolean', default: false },
];

describe('notices (core)', () => {
  let dir;
  let db;
  let manager;
  let runtime;

  beforeEach(() => {
    dir = tmpdir('lush-notice-');
    ({ database: db, manager, runtime } = system(dir));
    permissiveRoot(manager);
  });

  afterEach(async () => {
    await runtime.shutdown();
    db.close();
    cleanup(dir);
  });

  /** A task that exists but never runs its agent, so a notice can be posted directly. */
  function idleTask(template = 'generic-task', name = 'worker') {
    const sid = manager.spawn(0, template, name).sid;
    return manager.spawnTask(null, sid, 'idle goal', false);
  }

  test('a notice records the reporter, what it asks and how it is settled', () => {
    const task = idleTask();
    const posted = manager.postNotice({
      taskId: task.id,
      kind: 'decision',
      title: '选择发布策略',
      body: '两个方案各有取舍。',
      fields: FORM,
      wait: true,
    });
    expect(posted).toMatchObject({
      sid: manager.repository.getTask(task.id).sid,
      task_id: task.id,
      kind: 'decision',
      title: '选择发布策略',
      status: 'open',
      wait: true,
    });

    const shown = manager.noticeInspect(posted.id);
    expect(shown).toMatchObject({
      sid: task.sid,
      task_id: task.id,
      service_name: 'worker',
      task_goal: 'idle goal',
      body: '两个方案各有取舍。',
      answer: null,
      note: null,
    });
    // Defaults are filled in once, at post time, so every reader sees the same form.
    expect(shown.fields).toEqual([
      { name: 'plan', label: '方案', type: 'choice', required: true, options: ['blue-green', 'canary'] },
      { name: 'note', label: '补充说明', type: 'textarea', required: false },
      { name: 'approve', label: '是否批准', type: 'boolean', required: false, default: false },
    ]);
    // The task's own event stream says a report went out.
    expect(manager.repository.taskEvents(task.id)[0]).toMatchObject({
      kind: 'notice', data: { notice_id: posted.id, kind: 'decision', wait: true },
    });
  });

  test('posting rejects a bad reporter, kind, title or form', () => {
    const task = idleTask();
    const post = (patch) => () => manager.postNotice({ taskId: task.id, title: 'ok', ...patch });
    expect(post({ taskId: 999 })).toThrow(/task not found/);
    expect(post({ kind: 'urgent' })).toThrow(/kind must be one of/);
    expect(post({ title: '   ' })).toThrow(/title must be a non-empty string/);
    expect(post({ body: 42 })).toThrow(/body must be a string/);
    expect(post({ wait: 'yes' })).toThrow(/wait must be a boolean/);
    expect(post({ fields: 'plan' })).toThrow(/fields must be an array/);
    expect(post({ fields: [{ name: '方案' }] })).toThrow(/field.name must match/);
    expect(post({ fields: [{ name: 'a' }, { name: 'a' }] })).toThrow(/duplicate field name/);
    expect(post({ fields: [{ name: 'a', type: 'slider' }] })).toThrow(/type must be one of/);
    expect(post({ fields: [{ name: 'a', type: 'choice' }] })).toThrow(/needs a non-empty options array/);
    expect(post({ fields: [{ name: 'a', options: ['x'] }] })).toThrow(/only allowed on a choice field/);
    expect(post({ fields: [{ name: 'a', required: 'yes' }] })).toThrow(/required must be a boolean/);
    expect(post({ fields: [{ name: 'a', type: 'boolean', default: 'maybe' }] })).toThrow(/expected a boolean/);
    expect(post({ body: 'x'.repeat(20_001) })).toThrow(/body must be a string/);
  });

  test('an answer is checked against the declared form', () => {
    const task = idleTask();
    const notice = manager.postNotice({ taskId: task.id, title: '批准发布', fields: FORM });
    const answer = (value) => () => manager.noticeAnswer(notice.id, value);
    expect(answer({ plan: 'canary', note: 'ok' })).not.toThrow();
    // A settled notice cannot be answered twice.
    expect(answer({ plan: 'canary', note: 'ok' })).toThrow(/is answered/);

    const second = manager.postNotice({ taskId: task.id, title: '批准发布', fields: FORM });
    expect(() => manager.noticeAnswer(second.id, { plan: 'purple' })).toThrow(/is not one of blue-green, canary/);
    expect(() => manager.noticeAnswer(second.id, {})).toThrow(/missing required field 'plan'/);
    expect(() => manager.noticeAnswer(second.id, { plan: 'canary', extra: 1 })).toThrow(/undeclared field 'extra'/);
    expect(() => manager.noticeAnswer(second.id, 'yes')).toThrow(/answer must be a JSON object/);
    // The CLI hands booleans over as strings; they are normalized rather than rejected.
    const settled = manager.noticeAnswer(second.id, { plan: 'blue-green', approve: 'true' });
    expect(settled.answer).toEqual({ plan: 'blue-green', approve: true });
  });

  test('an optional field with a default is filled in for the reporter', () => {
    const task = idleTask();
    const notice = manager.postNotice({ taskId: task.id, title: 'r', fields: FORM });
    expect(manager.noticeAnswer(notice.id, { plan: 'canary' }).answer).toEqual({
      plan: 'canary', approve: false,
    });
  });

  test('a notice with no form accepts a free-form answer', () => {
    const task = idleTask();
    const notice = manager.postNotice({ taskId: task.id, kind: 'blocked', title: '卡住了' });
    expect(manager.noticeAnswer(notice.id, { text: '数据库连不上' }).answer).toEqual({ text: '数据库连不上' });

    const other = manager.postNotice({ taskId: task.id, title: 'r' });
    expect(manager.noticeAnswer(other.id, { anything: 'goes' }).answer).toEqual({ anything: 'goes' });

    const third = manager.postNotice({ taskId: task.id, title: 'r2' });
    expect(() => manager.noticeAnswer(third.id, { bad: { nested: true } })).toThrow(/must be a string, number or boolean/);
  });

  test('waiting on a notice blocks the reporter and the answer wakes it with the values', async () => {
    const sid = manager.spawn(0, 'generic-task', 'worker').sid;
    const running = manager.call(sid, `/tool notice ${JSON.stringify({
      kind: 'decision', title: '选一个', fields: [{ name: 'plan', type: 'choice', options: ['A', 'B'], required: true }],
    })}`);
    await Bun.sleep(20);
    const [task] = manager.taskList();
    expect(task.status).toBe('waiting');
    expect(manager.openNoticeCount()).toBe(1);

    const notice = manager.noticeList('open')[0];
    manager.noticeAnswer(notice.id, { plan: 'B' });
    const settled = await running;
    expect(settled.status).toBe('completed');
    expect(settled.result).toContain('"plan":"B"');
    expect(manager.noticeInspect(notice.id)).toMatchObject({ status: 'answered', answer: { plan: 'B' } });
    expect(manager.openNoticeCount()).toBe(0);
  });

  test('wait=false reports without parking the task', async () => {
    const sid = manager.spawn(0, 'generic-task', 'worker').sid;
    const task = await manager.call(sid, '/tool notice {"title":"只是汇报","wait":false}');
    expect(task.status).toBe('completed');
    expect(manager.noticeList('open')).toHaveLength(1);
    expect(manager.noticeList('open')[0]).toMatchObject({ kind: 'report', wait: false, status: 'open' });
  });

  test('cancelling the reporter dismisses the notices nobody can answer any more', async () => {
    const sid = manager.spawn(0, 'generic-task', 'worker').sid;
    const running = manager.call(sid, '/tool notice {"title":"等我","fields":[{"name":"x"}]}');
    await Bun.sleep(20);
    const notice = manager.noticeList('open')[0];
    expect(manager.taskInspect(notice.task_id).status).toBe('waiting');
    manager.cancelTask(notice.task_id);
    await running;
    expect(manager.noticeInspect(notice.id)).toMatchObject({
      status: 'dismissed', note: `task ${notice.task_id} cancelled`,
    });
    expect(manager.openNoticeCount()).toBe(0);
  });

  test('a task may only wait on a notice it reported itself', () => {
    const mine = idleTask('generic-task', 'mine');
    const theirs = idleTask('generic-task', 'theirs');
    const notice = manager.postNotice({ taskId: theirs.id, title: 'not yours' });
    expect(() => { manager.waitForNotice(notice.id, mine.id); }).toThrow(/may only wait on its own notices/);
    expect(() => { manager.waitForNotice(notice.id, theirs.id); }).not.toThrow();
    expect(() => manager.waitForNotice(9999)).toThrow(/notice not found/);
  });

  test('list filters, orders newest first and validates its arguments', () => {
    const first = idleTask('generic-task', 'one');
    const second = idleTask('generic-task', 'two');
    const a = manager.postNotice({ taskId: first.id, title: 'a' });
    manager.postNotice({ taskId: first.id, title: 'b', wait: false });
    const c = manager.postNotice({ taskId: second.id, title: 'c' });
    manager.noticeDismiss(c.id, 'noise');

    expect(manager.noticeList().map((row) => row.title)).toEqual(['c', 'b', 'a']);
    expect(manager.noticeList('open').map((row) => row.title)).toEqual(['b', 'a']);
    expect(manager.noticeList('dismissed').map((row) => row.title)).toEqual(['c']);
    expect(manager.noticeList(null, first.id).map((row) => row.title)).toEqual(['b', 'a']);
    expect(manager.noticeList(null, null, second.sid).map((row) => row.title)).toEqual(['c']);
    expect(manager.noticeList(null, null, null, 1)).toHaveLength(1);

    expect(() => manager.noticeList('pending')).toThrow(/status must be one of/);
    expect(() => manager.noticeList(null, null, null, 0)).toThrow(/limit must be an integer/);
    expect(() => manager.noticeInspect(999)).toThrow(/notice not found/);
    expect(() => manager.noticeDismiss(c.id)).toThrow(/can no longer be dismissed/);
  });

  test('hard deletion takes notices with the service, and detaches them from a deleted task', () => {
    const sid = manager.spawn(0, 'generic-task', 'doomed').sid;
    const task = manager.spawnTask(null, sid, 'g', false);
    const notice = manager.postNotice({ taskId: task.id, title: 'keep me' });

    manager.completeTask(task.id, 'done');
    manager.taskDelete(task.id);
    // The notice survives its task, reporting only the service it came from.
    expect(manager.noticeInspect(notice.id)).toMatchObject({ task_id: null, service_name: 'doomed' });

    manager.stop(sid);
    manager.delete(sid);
    expect(() => manager.noticeInspect(notice.id)).toThrow(/notice not found/);
  });
});

describe('notices over RPC, the CLI surface and the web UI', () => {
  let dir;
  let database;
  let manager;
  let runtime;
  let rpcServer;
  let web;
  let client;

  beforeEach(async () => {
    dir = tmpdir('lush-notice-wire-');
    ({ database, manager, runtime } = system(dir));
    permissiveRoot(manager);
    const socket = path.join(dir, 'lush.sock');
    rpcServer = new RPCServer(socket, new Dispatcher(manager, createSignal()));
    await rpcServer.start();
    client = new RPCClient(socket, 2);
    web = new WebUIServer(new UIClient(client), { port: 0 });
    await web.start();
  });

  afterEach(async () => {
    await web.stop();
    await rpcServer.close();
    await runtime.shutdown();
    database.close();
    cleanup(dir);
  });

  function request(route, options = {}) {
    return web.fetch(new Request(new URL(route, web.url), options));
  }

  /** One open notice with a declared plan field, created the same way the tool does. */
  function seedNotice() {
    const sid = manager.spawn(0, 'generic-task', 'worker').sid;
    const task = manager.spawnTask(null, sid, 'ship it', false);
    return manager.postNotice({
      taskId: task.id,
      kind: 'decision',
      title: '选一个方案',
      body: '两个都能用。',
      fields: [{ name: 'plan', label: '方案', type: 'choice', options: ['A', 'B'], required: true }],
      wait: true,
    });
  }

  test('system.status counts the notices still waiting for a user', async () => {
    expect((await client.request('system.status')).notices_open).toBe(0);
    seedNotice();
    expect((await client.request('system.status')).notices_open).toBe(1);
  });

  test('notice.list / inspect / answer / dismiss travel over the wire', async () => {
    const notice = seedNotice();
    const rows = await client.request('notice.list', { status: 'open' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: notice.id, kind: 'decision', status: 'open', wait: true, service_name: 'worker', task_goal: 'ship it',
    });
    expect((await client.request('notice.inspect', { notice_id: notice.id })).fields).toHaveLength(1);

    const answered = await client.request('notice.answer', { notice_id: notice.id, answer: { plan: 'B' } });
    expect(answered).toMatchObject({ status: 'answered', answer: { plan: 'B' } });
    expect(await client.request('notice.list', { status: 'open' })).toEqual([]);

    const other = seedNotice();
    expect(await client.request('notice.dismiss', { notice_id: other.id, reason: '已知' }))
      .toMatchObject({ status: 'dismissed', note: '已知' });

    expect((await expectRejection(client.request('notice.answer', { notice_id: other.id, answer: { plan: 'A' } }))).code)
      .toBe(-32010);
    expect((await expectRejection(client.request('notice.list', { status: 'nope' }))).code).toBe(-32602);
    expect((await expectRejection(client.request('notice.inspect', { notice_id: notice.id, extra: 1 }))).code).toBe(-32602);
  });

  test('the web UI lists, shows, answers and dismisses notices', async () => {
    const notice = seedNotice();

    const list = await request('/api/notices?status=open');
    expect((await list.json()).notices).toHaveLength(1);

    const show = await request(`/api/notices/${notice.id}`);
    expect((await show.json()).notice).toMatchObject({ id: notice.id, title: '选一个方案', kind: 'decision' });

    const bad = await request(`/api/notices/${notice.id}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer: { plan: 'Z' } }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.message).toContain('not one of A, B');

    const answered = await request(`/api/notices/${notice.id}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer: { plan: 'A' } }),
    });
    expect(answered.status).toBe(200);
    expect((await answered.json()).notice.answer).toEqual({ plan: 'A' });

    const other = seedNotice();
    const dismissed = await request(`/api/notices/${other.id}/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect((await dismissed.json()).notice.status).toBe('dismissed');

    expect((await request('/api/notices')).status).toBe(200);
    expect((await request('/api/notices?bogus=1')).status).toBe(400);
    expect((await request('/api/notices/999999')).status).toBe(404);
    const shell = await request('/');
    expect(await shell.text()).toContain('Notice');
  });

  test('notice.post lets an external agent report and block for the answer', async () => {
    const sid = manager.spawn(0, 'generic-task', 'worker').sid;
    const task = manager.spawnTask(null, sid, 'ship it', false);

    // wait=false only registers.
    const reported = await client.request('notice.post', {
      task_id: task.id, kind: 'report', title: '只是汇报', body: '一切正常', wait: false,
    });
    expect(reported).toMatchObject({ status: 'open', wait: false, task_id: task.id, title: '只是汇报' });

    // wait=true keeps the RPC open until the user settles it.
    const pending = client.request('notice.post', {
      task_id: task.id,
      kind: 'decision',
      title: '选一个',
      fields: [{ name: 'plan', type: 'choice', options: ['A', 'B'], required: true }],
    });
    await Bun.sleep(20);
    const open = await client.request('notice.list', { status: 'open', task_id: task.id });
    const blocking = open.find((row) => row.title === '选一个');
    expect(blocking).toMatchObject({ wait: true, task_id: task.id });
    await client.request('notice.answer', { notice_id: blocking.id, answer: { plan: 'B' } });
    const settled = await pending;
    expect(settled).toMatchObject({ id: blocking.id, status: 'answered', answer: { plan: 'B' } });

    expect((await expectRejection(client.request('notice.post', { task_id: task.id }))).code).toBe(-32602);
    expect((await expectRejection(client.request('notice.post', { task_id: 999, title: 'x' }))).code).toBe(-32004);
  });

  test('the CLI declares the notice group and the agent tool advertises it', () => {
    const group = ROOT.children.notice;
    expect(group.summary).toContain('Notice');
    expect(Object.keys(group.children)).toEqual(['list', 'post', 'show', 'answer', 'dismiss']);

    const post = group.children.post;
    const posted = post.parse([]);
    post.options['--title'].apply(posted, '选一个');
    post.options['--kind'].apply(posted, 'decision');
    post.options['--task'].apply(posted, '7');
    post.options['--fields'].apply(posted, '[{"name":"plan","type":"choice","options":["A"]}]');
    expect(posted).toMatchObject({ task_id: 7, title: '选一个', kind: 'decision', wait: true });
    expect(posted.fields).toEqual([{ name: 'plan', type: 'choice', options: ['A'] }]);
    const noTask = post.parse([]);
    post.options['--title'].apply(noTask, 'x');
    if (!Object.hasOwn(noTask, 'task_id')) {
      expect(() => post.check(noTask)).toThrow(/LUSH_TASK_ID/);
    }

    const answer = group.children.answer;
    const parsed = answer.parse(['7']);
    const sets = [];
    answer.options['--set'].apply(parsed, 'plan=canary');
    sets.push(parsed.set);
    answer.options['--set'].apply(parsed, 'note=hi');
    answer.check(parsed);
    expect(parsed).toMatchObject({ notice_id: 7, answer: { plan: 'canary', note: 'hi' } });
    expect(parsed.set).toBeUndefined();
    expect(() => answer.options['--set'].apply({ set: [] }, 'plan')).toThrow(/KEY=VALUE/);

    const notice = seedNotice();
    const shown = formatNotice(manager.noticeInspect(notice.id));
    expect(shown).toContain('选一个方案');
    expect(shown).toContain('plan <choice> (A | B)');
    expect(shown).toContain(`lush notice answer ${notice.id} --set plan=...`);
    expect(formatNoticeList(manager.noticeList())).toContain(`#${notice.id} [decision/open]`);

    const tool = TOOL_DEFINITIONS.find((definition) => definition.function.name === 'notice');
    expect(tool.function.parameters.required).toEqual(['title']);
    expect(tool.function.parameters.properties.kind.enum).toEqual(['report', 'decision', 'blocked']);
    expect(tool.function.parameters.properties.fields.items.properties.type.enum)
      .toEqual(['text', 'textarea', 'choice', 'boolean']);
  });
});
