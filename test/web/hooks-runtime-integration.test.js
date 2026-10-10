import { test, expect, setDefaultTimeout } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { repo, git } from '../helpers.js';
import { retiredHook } from '../hook-assertions.js';
import { setup, fetch } from './harness.js';
setDefaultTimeout(20000);
const post = (f, method, params) => fetch(f.url + '/api/action', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }),
});
async function action(f, method, params) {
  const response = await post(f, method, params), value = await response.json();
  expect(response.status).toBe(200); return value;
}
const get = async (f, suffix) => (await fetch(f.url + suffix)).json();

test('real HTTP/RPC/Runtime defers a frozen draft, preserves private settings and creates once at the current tip', async () => {
  const f = await setup(); f.project.kick = () => {};
  try {
    await repo(f.root);
    const source = await action(f, 'order.submit', { content: 'hold main', branch: 'main', start: false });
    const mainId = source.task.parent_id;
    f.store.update(source.task.id, { reservation: JSON.stringify({ version: 1, kind: 'merge', status: 'requested', commit: source.task.base_commit }) });
    const draft = await action(f, 'draft.add', { content: 'deferred HTTP job', branch: 'main', references: [{ kind: 'text', label: 'context', quote: 'saved quotation' }] });
    const profile = { agent: 'pi', model: 'test/frozen-model', thinking: 'high', append_prompt: 'PRIVATE_HOOK_PROMPT', env: { SECRET_KEY: 'PRIVATE_HOOK_VALUE' } };
    const deferred = await action(f, 'order.submit', { draft_id: draft.id, expected_revision: draft.revision, start: false, defer: true, profile });
    expect(deferred).toMatchObject({ deferred: true, parent_id: mainId });
    expect(deferred.task).toBeUndefined();
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(1);
    expect(f.store.draft(draft.id).input_id).toBeNull();
    for (const suffix of [`/api/worker/${mainId}`, `/api/worker/${mainId}/hooks`, '/api/snapshot']) {
      const data = JSON.stringify(await get(f, suffix));
      expect(data).not.toContain('PRIVATE_HOOK_PROMPT'); expect(data).not.toContain('PRIVATE_HOOK_VALUE'); expect(data).not.toContain('SECRET_KEY');
    }
    expect((await post(f, 'order.submit', { draft_id: draft.id, expected_revision: draft.revision, start: false, defer: true })).status).toBe(400);
    expect((await post(f, 'draft.update', { id: draft.id, expected_revision: draft.revision, content: 'overwrite' })).status).toBe(400);
    const mounted = await get(f, `/api/input/draft/${draft.id}`);
    expect(mounted.hook_mount).toMatchObject({ hook_id: deferred.hook_id, parent_id: mainId });
    fs.writeFileSync(path.join(f.root, 'new-baseline.txt'), 'advance before release');
    await git(f.root, 'add', '.'); await git(f.root, 'commit', '-m', 'advance main');
    const tip = await git(f.root, 'rev-parse', 'main');
    await action(f, 'worker.unreserve', { id: source.task.id });
    await f.project.runParentReadyHooks(mainId);
    const hooks = await get(f, `/api/worker/${mainId}/hooks`), mount = hooks.mounts.find(item => item.id === deferred.hook_id);
    expect(mount).toBeUndefined();
    const receipt = retiredHook(f.project, mainId, deferred.hook_id);
    const created = await get(f, `/api/worker/${receipt.worker_id}`);
    expect(created).toMatchObject({ base_commit: tip, status: 'paused', parent_id: mainId, goal: 'deferred HTTP job', worker_number: `W${created.input_id}` });
    expect(f.project.draftHookMount(draft.id)).toBeNull();
    expect(f.store.lookupWorker(created.worker_number)).toEqual({ id: created.id, worker_number: created.worker_number });
    expect(created.retry_profile).toBeUndefined();
    expect(JSON.parse(f.store.task(created.id).retry_profile).env).toEqual(profile.env);
    expect(f.store.inputReferences(created.input_id)[0].quote).toBe('saved quotation');
    expect(f.store.draft(draft.id).input_id).toBe(created.input_id);
    await f.project.runParentReadyHooks(mainId);
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(2);
  } finally { await f.close(); }
});

test('real template metadata edits and identity mounts retain private run coverage, and stale revisions are rejected', async () => {
  const f = await setup(); f.project.stopping = true;
  try {
    await repo(f.root); const main = await f.project.ensureMainTask();
    const profile = { agent: 'pi', model: 'test/template-model', append_prompt: 'PRIVATE_TEMPLATE_PROMPT', env: { KEY: 'PRIVATE_TEMPLATE_VALUE' } };
    let catalogue = await get(f, '/api/hooks');
    catalogue = await action(f, 'hooks.save', { expected_revision: catalogue.revision, template: {
      name: 'configured creation', trigger: 'worker.parent_ready', mode: 'once', enabled: true,
      actions: [{ type: 'create_worker', content: 'template job', start: false, profile }],
    } });
    const previousRevision = catalogue.revision;
    const edited = { ...catalogue.templates[0], name: 'renamed', actions: catalogue.templates[0].actions.map(({ model_selection, ...item }) => item) };
    catalogue = await action(f, 'hooks.save', { expected_revision: previousRevision, template: edited });
    expect(JSON.stringify(catalogue)).not.toContain('PRIVATE_TEMPLATE');
    expect(catalogue.templates[0].actions[0].model_selection.model).toBe('test/template-model');
    expect((await post(f, 'hooks.save', { expected_revision: previousRevision, template: edited })).status).toBe(400);
    let hooks = await get(f, `/api/worker/${main.id}/hooks`);
    hooks = await action(f, 'worker.hook_attach', { id: main.id, expected_revision: hooks.revision, hook: { template_id: edited.id } });
    expect(hooks.mounts.at(-1).model_selection.model).toBe('test/template-model');
    expect(JSON.parse(f.store.task(main.id).hooks).mounts.at(-1).actions[0].profile.env).toEqual(profile.env);
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(0);
  } finally { await f.close(); }
});

test('Hook message read labels use persisted numbers while definitions and dispatch keep integer identities', async () => {
  const f = await setup(); f.project.stopping = true; f.project.kick = () => {};
  try {
    await repo(f.root);
    const parent = await f.project.order('numbered parent', 'main', [], null, false);
    const child = await f.project.spawn(parent.task.id, 'numbered child', undefined, [], 'hook-number-child');
    let hooks = await get(f, `/api/worker/${parent.task.id}/hooks`);
    hooks = await action(f, 'worker.hook_attach', { id: parent.task.id, expected_revision: hooks.revision, hook: {
      name: 'message a child', trigger: 'agent.failed', mode: 'once', enabled: true,
      actions: [{ type: 'message', target_id: child.id, body: 'inspect the failure' }],
    } });
    const target = hooks.mounts.at(-1).actions[0];
    expect(target).toMatchObject({ target_id: child.id, target_worker_number: child.worker_number });
    expect(child.worker_number).toBe(`${parent.task.worker_number}-1`);
    expect(JSON.parse(f.store.task(parent.task.id).hooks).mounts.at(-1).actions[0]).not.toHaveProperty('target_worker_number');
    f.project.stopping = false;
    f.project.emitTaskHook(parent.task.id, 'agent.failed'); await f.project.hookQueue;
    expect(f.store.unread(child.id).some(item => item.body === 'inspect the failure')).toBe(true);
  } finally { await f.close(); }
});

test('cancelled parents cannot strand reserved drafts: remove remains a safe release path without reviving work', async () => {
  const f = await setup(); f.project.kick = () => {};
  try {
    await repo(f.root);
    const parent = await f.project.order('parent', 'main', [], null, false);
    const blocker = await f.project.order('block parent', parent.task.branch, [], null, false);
    f.store.update(blocker.task.id, { reservation: JSON.stringify({ version: 1, kind: 'merge', status: 'requested', commit: blocker.task.base_commit }) });
    const draft = await f.project.addBufferedDraft('keep this idea', [], parent.task.branch);
    const deferred = await action(f, 'order.submit', { draft_id: draft.id, expected_revision: draft.revision, start: false, defer: true });
    await action(f, 'worker.cancel', { id: parent.task.id });
    let hooks = await get(f, `/api/worker/${parent.task.id}/hooks`);
    const mount = hooks.mounts.find(item => item.id === deferred.hook_id);
    expect(mount.editable).toBe(false); expect(mount.removable).toBe(true);
    await action(f, 'worker.hook_remove', { id: parent.task.id, hook_id: mount.id, expected_revision: hooks.revision });
    const released = await get(f, `/api/input/draft/${draft.id}`); expect(released.hook_mount).toBeNull();
    await action(f, 'draft.update', { id: draft.id, expected_revision: draft.revision, content: 'recovered idea' });
    expect(f.store.task(parent.task.id).status).toBe('cancelled');
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(2);
  } finally { await f.close(); }
});
