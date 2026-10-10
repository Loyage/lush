import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp, repo, env } from '../helpers.js';
import { cli } from './harness.js';
import { fetch } from '../web/harness.js';
import { Config } from '../../src/config.js';
import { UIClient } from '../../src/ui/client.js';
import { startWeb } from '../../src/ui/web/server.js';
import { projectRouteId, writeLauncherState, removeLauncherProject } from '../../src/host/registry.js';

// Actual independent lushd processes, production Host services and HTTP/RPC. All
// projects, device configuration and Agent execution are isolated temporary mocks.
async function workspace() {
  const roots = [temp(), temp()], device = temp();
  const extra = { LUSH_GLOBAL_CONFIG: device }, environment = env(extra);
  const configs = roots.map(project => Config.fromEnv(environment, project));
  const clients = configs.map(config => new UIClient(config));
  let web;
  const startHost = bound => {
    web = startWeb(bound ? configs[0] : null, 0, { env: environment,
      userServiceOptions: { inboxOptions: { backoffMs: 0 } } });
    return `http://127.0.0.1:${web.port}`;
  };
  const close = async () => {
    const stopped = await Promise.allSettled([
      Promise.resolve().then(() => web?.stop(true)),
      ...roots.map(root => cli(root, ['stop'], extra)),
    ]);
    const failures = stopped.filter(result => result.status === 'rejected').map(result => result.reason);
    // Never erase a temporary daemon's scene if orderly shutdown was not confirmed.
    if (failures.length) throw new AggregateError(failures, `temporary workspace cleanup failed; retained ${[...roots, device].join(', ')}`);
    for (const root of [...roots, device]) fs.rmSync(root, { recursive: true, force: true });
  };
  try {
    await Promise.all(roots.map(root => repo(root)));
    const started = await Promise.all(roots.map(root => cli(root, ['start'], extra)));
    expect(started[0].pid).not.toBe(started[1].pid);
    for (const root of roots) writeLauncherState(root, environment);
    return { roots, device, extra, environment, configs, clients, startHost, close,
      async stopHost() { await web.stop(true); web = null; } };
  } catch (error) { await close(); throw error; }
}
async function get(base, route) {
  const response = await fetch(base + route);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return response.json();
}
async function post(base, route, body, expected = 200) {
  const response = await fetch(base + route, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body) });
  expect(response.status).toBe(expected);
  return response.json();
}
async function order(client, content) {
  return (await client.request('order.submit', { content, start: false })).task;
}
async function pending(client, task, title) {
  return client.request('notice.post', { task: task.id, title, body: 'temporary integration question' });
}
async function record(client, id) {
  return (await client.request('notice.page', { before: id + 1, limit: 1 })).notices.find(row => row.id === id);
}
async function answered(client, id) {
  // Bounded observation within an integration test, never a live-project wait.
  const end = Date.now() + 6000;
  while (Date.now() < end) {
    const row = await record(client, id);
    if (row?.status === 'answered') return row;
    await Bun.sleep(25);
  }
  throw new Error('temporary daemon did not apply the device authorization');
}

test('real dual daemons and Host preserve global settings, source-only actions and offline/removal boundaries', async () => {
  const f = await workspace();
  const [a, b] = f.clients, [rootA, rootB] = f.roots;
  const idA = projectRouteId(rootA), idB = projectRouteId(rootB);
  try {
    const base = f.startHost(false);
    const tasks = await Promise.all([order(a, 'A deferred'), order(b, 'B deferred')]);
    const backends = await get(base, '/api/host/projects');
    expect(backends.projects.every(row => row.running && Number.isSafeInteger(row.summary.pid) && row.summary.pid > 0)).toBe(true);
    expect(new Set(backends.projects.map(row => row.summary.pid)).size).toBe(2);
    for (const [index, id] of [idA, idB].entries()) {
      const summary = backends.projects.find(row => row.id === id).summary;
      expect(summary.development).toMatchObject({ workers_total: 2, active: 1, agents_running: 0 });
      expect(summary.development.recent_workers).toEqual([expect.objectContaining({ id: tasks[index].id,
        worker_number: tasks[index].worker_number, goal: index ? 'B deferred' : 'A deferred', status: 'paused' })]);
    }
    const [one, two] = await Promise.all([pending(a, tasks[0], 'A question'), pending(b, tasks[1], 'B question')]);
    expect(one.id).toBe(two.id);
    expect(one.sync_identity).not.toBe(two.sync_identity);
    const beforeA = (await a.request('input.history', { limit: 100 })).items.map(row => row.id);
    const createdB = await post(base, `/p/${idB}/api/action`, { method: 'order.submit',
      params: { content: 'independent B instruction from global overview', branch: 'main', start: false } });
    expect(createdB.task).toMatchObject({ parent_id: tasks[1].parent_id, target_branch: 'main', task_kind: 'order', status: 'paused' });
    expect(createdB.task.id).not.toBe(tasks[1].id);
    const refreshed = await get(base, '/api/host/projects');
    expect(refreshed.projects.find(row => row.id === idA).summary.development.workers_total).toBe(2);
    expect(refreshed.projects.find(row => row.id === idB).summary.development.workers_total).toBe(3);
    expect(refreshed.projects.find(row => row.id === idB).summary.development.recent_workers[0].id).toBe(createdB.task.id);
    expect((await a.request('input.history', { limit: 100 })).items.map(row => row.id)).toEqual(beforeA);
    await post(base, `/p/${'0'.repeat(16)}/api/action`, { method: 'order.submit', params: { content: 'unknown source', branch: 'main', start: false } }, 400);
    const inbox = await get(base, '/api/host/inbox?status=open');
    expect(inbox.complete).toBe(true);
    expect(inbox.items.map(item => item.project_id).sort()).toEqual([idA, idB].sort());
    const seen = inbox.items.find(item => item.project_id === idB);
    const action = { project_id: idB, id: two.id, method: 'notice.answer', answer: 'B only',
      expected_identity: seen.notice.sync_identity };
    await post(base, '/api/host/inbox/action', { ...action, expected_identity: one.sync_identity }, 400);
    expect((await record(b, two.id)).status).toBe('open');
    const ack = await post(base, '/api/host/inbox/action', action);
    expect(ack.project_id).toBe(idB);
    expect(ack.notice).toMatchObject({ status: 'answered', answer: 'B only', answer_source: 'user' });
    expect((await record(a, one.id)).status).toBe('open');
    const noticeA = (await get(base, `/p/${idA}/api/notices?status=open`)).notices;
    expect(noticeA.some(row => row.id === one.id && row.status === 'open')).toBe(true);

    const preferences = await get(base, '/api/host/preferences');
    const saved = await post(base, '/api/host/preferences', { patch: { theme: 'dark', markdown: false },
      expected_revision: preferences.revision });
    expect(saved.values).toMatchObject({ theme: 'dark', markdown: false });
    await post(base, '/api/host/settings/action', { method: 'system.configure',
      params: { settings: { concurrency: 3 }, scope: 'device' } });
    for (const client of [a, b]) expect((await client.request('system.settings')).concurrency)
      .toMatchObject({ value: 3, source: 'device' });
    for (const root of f.roots) expect(fs.existsSync(path.join(root, '.lush', 'settings.json'))).toBe(false);

    await cli(rootB, ['stop'], f.extra);
    const offline = await get(base, '/api/host/inbox?status=all');
    expect(offline.complete).toBe(false);
    expect(offline.projects.find(row => row.id === idB).online).toBe(false);
    expect(offline.items.find(item => item.project_id === idB && item.notice.id === two.id).online).toBe(false);
    await post(base, '/api/host/inbox/action', action, 400);
    const unavailableBackends = await get(base, '/api/host/projects');
    expect(unavailableBackends.projects.find(row => row.id === idB).running).toBe(false);
    expect(unavailableBackends.projects.find(row => row.id === idB).summary).toBeUndefined();
    const offlineSend = await fetch(`${base}/p/${idB}/api/action`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ method: 'order.submit',
        params: { content: 'must not restart B', branch: 'main', start: false } }) });
    expect(offlineSend.status).toBeGreaterThanOrEqual(400);
    await get(base, '/api/host/preferences');
    await get(base, '/api/host/settings/agent/config');
    expect(fs.existsSync(f.configs[1].socket)).toBe(false);
    expect((await a.request('system.summary')).project).toBe(rootA);
    removeLauncherProject(rootB, f.environment);
    const removed = await get(base, '/api/host/inbox');
    expect(removed.items.every(item => item.project_id === idA)).toBe(true);
    expect(removed.projects.some(row => row.id === idB)).toBe(false);
    const unknown = await fetch(`${base}/api/host/inbox/notice?project_id=${idB}&id=${two.id}`);
    expect(unknown.status).toBe(400);

    await f.stopHost();
    const bound = f.startHost(true);
    expect((await get(bound, '/api/host/preferences')).values.theme).toBe('dark');
    expect((await get(bound, '/api/host/inbox')).projects.map(row => row.id)).toEqual([idA]);
    expect((await fetch(`${bound}/p/${idA}/`)).status).toBe(200);
    expect((await fetch(bound + '/')).status).toBe(200);
  } finally { await f.close(); }
}, 30000);

test('device policy survives Host shutdown and reaches stopped daemons only on explicit restart; defaults remain future-only', async () => {
  const f = await workspace();
  const [a, b] = f.clients;
  try {
    let base = f.startHost(false);
    const old = await Promise.all([order(a, 'A existing'), order(b, 'B existing')]);
    const first = await Promise.all([pending(a, old[0], 'A backlog'), pending(b, old[1], 'B backlog')]);
    let policy = await get(base, '/api/host/automation');
    expect(policy.auto_select.enabled).toBe(false);
    policy = await post(base, '/api/host/automation', { patch: { auto_select: { enabled: true } }, expected_revision: policy.revision });
    await f.stopHost();
    const settled = await Promise.all(first.map((row, index) => answered(f.clients[index], row.id)));
    expect(settled.every(row => row.answer_source === 'lush')).toBe(true);
    expect((await a.request('system.summary')).auto_select).toMatchObject({ scope: 'device', enabled: true,
      policy_revision: policy.revision, available: true });
    expect((await b.request('system.summary')).auto_select.policy_revision).toBe(policy.revision);

    base = f.startHost(false);
    policy = await post(base, '/api/host/automation', { patch: { auto_select: { enabled: false } }, expected_revision: policy.revision });
    const closed = await pending(a, old[0], 'after close');
    expect((await record(a, closed.id)).status).toBe('open');
    const deferredB = await order(b, 'restart backlog');
    const restartQuestion = await pending(b, deferredB, 'stopped B backlog');
    await cli(f.roots[1], ['stop'], f.extra);
    policy = await post(base, '/api/host/automation', { patch: { auto_select: { enabled: true } }, expected_revision: policy.revision });
    const offline = await get(base, '/api/host/inbox?status=open');
    expect(offline.projects.find(row => row.id === projectRouteId(f.roots[1])).online).toBe(false);
    expect(fs.existsSync(f.configs[1].socket)).toBe(false);
    await cli(f.roots[1], ['start'], f.extra);
    expect((await answered(b, restartQuestion.id)).answer_source).toBe('lush');
    expect((await answered(a, closed.id)).answer_source).toBe('lush');
    policy = await post(base, '/api/host/automation', { patch: { auto_select: { enabled: false },
      completion_defaults: { enabled: true, level: 'merge' } }, expected_revision: policy.revision });
    for (const [client, task] of [[a, old[0]], [b, old[1]]])
      expect((await client.request('worker.hooks', { id: task.id })).completion.level).toBe('off');
    const fresh = await Promise.all([order(a, 'A future'), order(b, 'B future')]);
    for (const [client, task] of [[a, fresh[0]], [b, fresh[1]]])
      expect((await client.request('worker.hooks', { id: task.id })).completion.level).toBe('merge');
    expect(fs.existsSync(path.join(f.device, 'shared', 'automation.json'))).toBe(true);
    await f.stopHost();
    for (const client of [a, b]) expect((await client.request('hooks.list')).completion_defaults)
      .toMatchObject({ enabled: true, level: 'merge', revision: policy.revision });
  } finally { await f.close(); }
}, 30000);
