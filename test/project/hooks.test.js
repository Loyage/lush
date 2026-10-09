import { test, expect, setDefaultTimeout } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until, gate } from '../helpers.js';
import { normalizeHook, publicHookDefinition } from '../../src/core/hooks.js';
setDefaultTimeout(20000);
const notifyRule = (trigger = 'agent.returned', mode = 'once') => ({ name: '告知', trigger, mode, enabled: true, conditions: {},
  actions: [{ type: 'notify', title: 'hook-test', body: 'done' }] });
const attach = (f, task, hook) => f.project.attachTaskHook(task.id, hook, f.project.taskHooks(task.id).revision);
async function frozenFixture(extra = {}) {
  const f = fixture(undefined, extra); f.project.kick = () => {}; await repo(f.root);
  const order = await f.project.order('freeze source', 'main', [], null, false);
  f.store.update(order.task.id, { reservation: JSON.stringify({ version: 1, kind: 'merge', status: 'requested', commit: order.task.base_commit }) });
  return { ...f, source: order.task, main: f.store.task(order.task.parent_id) };
}

test('Hook definitions reject scripts, unknown fields, invalid trigger/actions and recursive persistent messages', () => {
  expect(() => normalizeHook({ ...notifyRule(), script: 'danger' })).toThrow('invalid hook fields');
  expect(() => normalizeHook({ ...notifyRule(), trigger: 'bad' })).toThrow('unknown hook trigger');
  expect(() => normalizeHook({ ...notifyRule(), actions: [{ type: 'request_merge' }] })).toThrow('not allowed');
  expect(() => normalizeHook({ ...notifyRule(), mode: 'persistent', actions: [{ type: 'message', target_id: 1, body: 'again' }] })).toThrow('must be once');
  expect(() => normalizeHook({ ...notifyRule('worker.parent_ready','persistent'), actions: [{ type: 'create_worker', content: 'job' }] })).toThrow('must be once');
  expect(() => normalizeHook({ ...notifyRule(), conditions: { integrations: ['invented'] } })).toThrow('invalid hook integrations');
});

test('templates are revision checked and copied at mount, not mutable global rules', async () => {
  const f = fixture(); f.project.kick = () => {}; await repo(f.root);
  try {
    const order = await f.project.order('job', 'main', [], null, false);
    const initial = f.project.hooksList();
    const saved = f.project.saveHookTemplate(notifyRule(), initial.revision), template = saved.templates[0];
    expect(() => f.project.saveHookTemplate(notifyRule(), initial.revision)).toThrow('revision changed');
    const view = attach(f, order.task, { template_id: template.id });
    expect(view.mounts.at(-1).name).toBe('告知');
    f.project.saveHookTemplate({ ...notifyRule(), id: template.id, name: 'changed' }, saved.revision);
    expect(f.project.taskHooks(order.task.id).mounts.at(-1).name).toBe('告知');
    expect(() => f.project.attachTaskHook(order.task.id, notifyRule(), 'stale')).toThrow('revision changed');
    expect(() => f.project.removeTaskHook(order.task.id, 'auto-merge', f.project.taskHooks(order.task.id).revision)).toThrow('cannot be removed');
  } finally { await f.close(); }
});

test('persistent notifications dedupe the same source event and evaluate conditions', async () => {
  const f = fixture(); f.project.kick = () => {}; await repo(f.root);
  try {
    const order = await f.project.order('job', 'main', [], null, false);
    attach(f, order.task, { ...notifyRule('agent.returned', 'persistent'), conditions: { statuses: ['paused'] } });
    const source = f.store.event(order.task.id, 'test.returned', {});
    f.project.emitTaskHook(order.task.id, 'agent.returned', source); await f.project.hookQueue;
    f.project.emitTaskHook(order.task.id, 'agent.returned', source); await f.project.hookQueue;
    expect(f.store.get("SELECT count(*) AS n FROM notices WHERE title='hook-test'").n).toBe(1);
    f.store.update(order.task.id, { status: 'waiting' });
    f.project.emitTaskHook(order.task.id, 'agent.returned'); await f.project.hookQueue;
    expect(f.store.get("SELECT count(*) AS n FROM notices WHERE title='hook-test'").n).toBe(1);
    f.store.update(order.task.id, { status: 'paused' });
    f.project.emitTaskHook(order.task.id, 'agent.returned'); await f.project.hookQueue;
    expect(f.store.get("SELECT count(*) AS n FROM notices WHERE title='hook-test'").n).toBe(2);
  } finally { await f.close(); }
});

test('deferred frozen creation preserves full parameters, creates only once at current parent tip and hides secrets', async () => {
  const f = await frozenFixture();
  try {
    const profile = { agent: 'pi', config_mode: 'lush', model: 'test/model', thinking: 'high', append_prompt: 'PRIVATE_PROMPT', env: { PRIVATE_KEY: 'PRIVATE_VALUE' } };
    const refs = [{ kind: 'text', quote: 'context', label: 'quote' }];
    const queued = await f.project.order('deferred job', 'main', refs, null, false, undefined, profile, true);
    expect(queued).toMatchObject({ deferred: true, parent_id: f.main.id });
    expect(f.store.all('SELECT * FROM notices WHERE task_id=?', f.main.id)).toHaveLength(0);
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(1);
    expect(fs.readdirSync(path.join(f.config.home, 'worktrees'))).toHaveLength(1);
    const repeated = await f.project.order('deferred job', 'main', refs, null, false, undefined, profile, true);
    expect(repeated.hook_id).toBe(queued.hook_id);
    const publicText = JSON.stringify([f.project.taskHooks(f.main.id), f.project.inspect(f.main.id)]);
    expect(publicText).not.toContain('PRIVATE_PROMPT'); expect(publicText).not.toContain('PRIVATE_VALUE');
    expect(publicText).not.toContain('PRIVATE_KEY');
    fs.writeFileSync(path.join(f.root, 'new.txt'), 'new baseline'); await git(f.root, 'add', '.'); await git(f.root, 'commit', '-m', 'parent advanced');
    const current = await git(f.root, 'rev-parse', 'main');
    f.store.update(f.source.id, { reservation: null });
    await f.project.runParentReadyHooks(f.main.id);
    const completed = f.project.taskHooks(f.main.id).mounts.find(m => m.id === queued.hook_id);
    expect(completed).toMatchObject({ state: 'succeeded', enabled: false });
    const child = f.store.task(completed.last_execution.worker_id);
    expect(child).toMatchObject({ parent_id: f.main.id, base_commit: current, status: 'paused', goal: 'deferred job' });
    expect(JSON.parse(child.retry_profile)).toEqual(f.project.agentSettings.retryProfile('agent', profile));
    expect(f.store.inputReferences(child.input_id)[0].quote).toBe('context');
    await f.project.runParentReadyHooks(f.main.id); await f.project.runParentReadyHooks(f.main.id);
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(2);
    const [notice] = f.store.all('SELECT * FROM notices WHERE task_id=?', child.id);
    expect(notice.title).toContain(`Worker ${child.worker_number} 待开始`);
    expect(notice.body).toContain('尚未调用 Agent');
    expect(f.store.all('SELECT * FROM notices WHERE task_id=?', child.id)).toHaveLength(1);
  } finally { await f.close(); }
});

test('a default run profile is snapshotted at mount, not reread when frozen parent becomes ready', async () => {
  const f = await frozenFixture({ LUSH_PROVIDER: 'pi' });
  try {
    f.project.agentSettings.save({ default: { agent: 'pi', config_mode: 'pi' }, roles: {} });
    const queued = await f.project.order('default snapshot', 'main', [], null, false, undefined, null, true);
    f.project.agentSettings.save({ default: { agent: 'codex', model: 'changed', thinking: 'medium' }, roles: {} });
    f.store.update(f.source.id, { reservation: null }); await f.project.runParentReadyHooks(f.main.id);
    const mount = f.project.taskHooks(f.main.id).mounts.find(m => m.id === queued.hook_id);
    expect(mount.model_selection).toMatchObject({ agent: 'pi', config_mode: 'pi' });
    expect(JSON.parse(f.store.task(mount.last_execution.worker_id).retry_profile)).toMatchObject({ agent: 'pi', config_mode: 'pi' });
  } finally { await f.close(); }
});

test('mounted drafts are protected against edit/delete/refire and are linked only after real creation', async () => {
  const f = await frozenFixture();
  try {
    const draft = await f.project.addBufferedDraft('draft job', [], 'main');
    const result = await f.project.submitBufferedDraft(draft.id, draft.revision, false, true, { agent: 'pi', config_mode: 'pi' });
    expect(result.deferred).toBe(true); expect(f.store.draft(draft.id).input_id).toBeNull();
    expect(f.project.inputGet('draft', draft.id).hook_mount).toMatchObject({ hook_id: result.hook_id });
    await expect(f.project.updateBufferedDraft(draft.id, 'changed', undefined, undefined, draft.revision)).rejects.toThrow('mounted');
    expect(() => f.project.removeBufferedDraft(draft.id, draft.revision)).toThrow('mounted');
    await expect(f.project.submitBufferedDraft(draft.id, draft.revision, false, true)).rejects.toThrow('mounted');
    f.store.update(f.source.id, { reservation: null }); await f.project.runParentReadyHooks(f.main.id);
    const mount = f.project.taskHooks(f.main.id).mounts.find(m => m.id === result.hook_id);
    expect(f.store.draft(draft.id).input_id).toBe(mount.last_execution.input_id);
    expect(JSON.parse(f.store.task(mount.last_execution.worker_id).retry_profile).config_mode).toBe('pi');
  } finally { await f.close(); }
});

test('removing or disabling a pending deferred hook never creates a Worker and releases draft ownership', async () => {
  const f = await frozenFixture();
  try {
    const draft = await f.project.addBufferedDraft('draft', [], 'main');
    const result = await f.project.submitBufferedDraft(draft.id, draft.revision, false, true);
    f.project.removeTaskHook(f.main.id, result.hook_id, f.project.taskHooks(f.main.id).revision);
    expect(f.project.draftHookMount(draft.id)).toBeNull();
    const next = await f.project.order('disabled job', 'main', [], null, false, undefined, null, true);
    await f.project.updateTaskHook(f.main.id, next.hook_id, false, f.project.taskHooks(f.main.id).revision);
    f.store.update(f.source.id, { reservation: null }); await f.project.runParentReadyHooks(f.main.id);
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(1);
    const edited = await f.project.updateBufferedDraft(draft.id, 'new draft', undefined, undefined, draft.revision);
    expect(edited.content).toBe('new draft');
  } finally { await f.close(); }
});

test('frozen and unfrozen hooks track complete state transitions, not individual request removal', async () => {
  const f = await frozenFixture();
  try {
    attach(f, f.main, notifyRule('worker.frozen', 'persistent'));
    attach(f, f.main, { ...notifyRule('worker.unfrozen', 'persistent'), actions: [{ type: 'notify', title: 'unfrozen', body: '' }] });
    f.project.observeTaskHooks(); await f.project.hookQueue;
    expect(f.store.get("SELECT count(*) AS n FROM notices WHERE title='hook-test'").n).toBe(1);
    f.project.observeTaskHooks(); await f.project.hookQueue;
    expect(f.store.get("SELECT count(*) AS n FROM notices WHERE title='hook-test'").n).toBe(1);
    f.store.update(f.source.id, { reservation: null }); f.project.observeTaskHooks(); await f.project.hookQueue;
    expect(f.store.get("SELECT count(*) AS n FROM notices WHERE title='unfrozen'").n).toBe(1);
  } finally { await f.close(); }
});

test('recovery never replays an unknown started effect, but reconciles exact creation receipts', async () => {
  const f = await frozenFixture();
  try {
    const queued = await f.project.order('create', 'main', [], null, false, undefined, null, true);
    const data = JSON.parse(f.store.task(f.main.id).hooks), mount = data.mounts.find(m => m.id === queued.hook_id);
    mount.state = 'running'; mount.last_execution = { id: 9876, trigger: mount.trigger, status: 'running', created_at: new Date().toISOString() };
    f.store.update(f.main.id, { hooks: JSON.stringify(data) });
    f.project.recoverTaskHooks();
    expect(f.project.taskHooks(f.main.id).mounts.find(m => m.id === queued.hook_id).state).toBe('unknown');
    f.store.update(f.source.id, { reservation: null }); await f.project.runParentReadyHooks(f.main.id);
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(1);
    await expect(f.project.updateTaskHook(f.main.id, queued.hook_id, true, f.project.taskHooks(f.main.id).revision)).rejects.toThrow('require inspection');
    const next = attach(f, f.main, { name: 'exact', trigger: 'worker.parent_ready', mode: 'once', enabled: true, actions: [{ type: 'create_worker', content: 'exact', start: false }] }).mounts.at(-1);
    await f.project.runParentReadyHooks(f.main.id);
    const raw = JSON.parse(f.store.task(f.main.id).hooks), exact = raw.mounts.find(m => m.id === next.id);
    exact.state = 'running'; exact.enabled = true; exact.last_execution.status = 'running';
    f.store.update(f.main.id, { hooks: JSON.stringify(raw) }); f.project.recoverTaskHooks();
    expect(f.project.taskHooks(f.main.id).mounts.find(m => m.id === next.id).state).toBe('succeeded');
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(2);
  } finally { await f.close(); }
});

test('message hooks restrict relationships and fail safely when target lifecycle changes', async () => {
  const f = fixture(); f.project.kick = () => {}; await repo(f.root);
  try {
    const one = await f.project.order('one','main',[],null,false), two = await f.project.order('two','main',[],null,false);
    const hook = { ...notifyRule(), actions: [{ type: 'message', target_id: two.task.id, body: 'new work' }] };
    expect(() => attach(f, one.task, hook)).toThrow('direct parent/child');
    const mounted = attach(f, one.task, { ...hook, actions: [{ type: 'message', target_id: one.task.id, body: 'one-time input' }] }).mounts.at(-1);
    f.store.update(one.task.id, { status: 'completed' }); f.project.emitTaskHook(one.task.id, 'agent.returned'); await f.project.hookQueue;
    const result = f.project.taskHooks(one.task.id).mounts.find(m => m.id === mounted.id);
    expect(result.state).toBe('failed'); expect(result.last_execution.error).toBe('消息未通过目标身份或生命周期检查。');
    expect(f.store.get('SELECT count(*) AS n FROM messages WHERE task_id=?', one.task.id).n).toBe(0);
  } finally { await f.close(); }
});

test('normal return is emitted after release and does not turn a child wait into delivery ready', async () => {
  const hold = gate(); let parentId;
  const f = fixture({ async run({ task, api }) {
    if (task.id === parentId) { await api.spawn(task.id, 'child'); return 'waiting for child'; }
    await hold.promise; return 'child result';
  } }); await repo(f.root);
  try {
    const order = await f.project.order('parent','main',[],null,false); parentId = order.task.id;
    attach(f, order.task, notifyRule('agent.returned'));
    attach(f, order.task, { ...notifyRule('worker.delivery_ready'), actions: [{ type: 'notify', title: 'ready', body: '' }] });
    f.project.resumeTask(parentId);
    await until(() => f.store.get("SELECT id FROM notices WHERE title='hook-test'"));
    expect(f.project.running.has(parentId)).toBe(false);
    expect(f.store.get("SELECT id FROM notices WHERE title='ready'")).toBeNull();
    hold.resolve();
    await until(() => f.store.children(parentId)[0]?.status === 'awaiting_acceptance');
  } finally { hold.resolve(); await f.close(); }
});

test('private profile never appears in public template and Worker projections', () => {
  const value = normalizeHook({ name: 'create', trigger: 'worker.parent_ready', mode: 'once', enabled: true,
    actions: [{ type: 'create_worker', content: 'job', profile: { agent: 'pi', env: { KEY: 'secret' }, append_prompt: 'prompt' } }] });
  const result = publicHookDefinition(value);
  expect(JSON.stringify(result)).not.toContain('secret'); expect(JSON.stringify(result)).not.toContain('prompt');
  expect(result.actions[0].model_selection.agent).toBe('pi');
});
