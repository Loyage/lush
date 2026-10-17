import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { repo, git, until } from '../helpers.js';
import { RPCClient } from '../../src/rpc/client.js';
import { setup, fetch } from './harness.js';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';
import { initNoticeRecords, openNotice, renderNotices } from '../../src/ui/web/assets/render-notices.js';
import { registerNavigation } from '../../src/ui/web/assets/navigate.js';
import { createEmissionConditions } from '../../src/ui/web/assets/emission-form.js';

async function action(f, method, params) {
  const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
  const result = await response.json(); expect(response.status).toBe(200); return result;
}
async function prepare() {
  const f = await setup(); f.project.stopping = true; f.project.kick = () => {};
  // Model and dispatch admission are controlled independently, using real RPC,
  // SQLite, Git, lifecycle and delivery engines, not a mocked emission method.
  f.project.scheduleInputEmissions = () => {};
  await repo(f.root); await f.project.ensureMainTask();
  return f;
}
async function drain(f) { f.project.stopping = false; await f.project.drainInputEmissions(); }
const get = async (f, suffix) => (await fetch(f.url + suffix)).json();

test('HTTP default emission durably mounts without a Worker, uses latest baseline, then actually invokes once', async () => {
  const f = await prepare(); const calls = [];
  try {
    f.project.provider = { async run(args) { calls.push(args.task.id); return 'controlled development result'; } };
    const definition = { content: 'future development', branch: 'main', client_request_id: 'http-once',
      references: [{ kind: 'text', label: 'saved context', quote: 'original selected text' }] };
    const emitted = await action(f, 'input.emit', definition);
    expect(emitted).toMatchObject({ emitted: true, mode: 'order', dispatch: { state: 'queued' } });
    expect(emitted.task).toBeUndefined(); expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(0); expect(calls).toEqual([]);
    expect((await action(f, 'input.emit', definition)).draft_id).toBe(emitted.draft_id);
    await git(f.root, 'commit', '--allow-empty', '-m', 'advance before actual creation');
    const latest = await git(f.root, 'rev-parse', 'HEAD');
    await drain(f);
    const record = await get(f, `/api/input/draft/${emitted.draft_id}`);
    expect(record.dispatch.state).toBe('succeeded');
    const worker = f.store.task(record.dispatch.worker_id);
    expect(worker.base_commit).toBe(latest); expect(worker.status).toBe('queued'); expect(calls).toEqual([]);
    expect((await get(f, `/api/input/input/${record.input_id}`)).references[0].quote).toBe('original selected text');
    f.project.pump(); await until(() => !f.project.running.has(worker.id) && f.store.task(worker.id).calls === 1);
    expect(calls).toEqual([worker.id]);
    expect((await action(f, 'input.emit', definition)).dispatch.worker_id).toBe(worker.id);
    await drain(f); f.project.pump(); expect(calls).toEqual([worker.id]);
    // The legacy named public endpoint has the same default mount semantics.
    f.project.stopping = true;
    const legacyName = await action(f, 'order.submit', { content: 'public order is emission' });
    expect(legacyName).toMatchObject({ emitted: true, dispatch: { state: 'queued' } }); expect(legacyName.task).toBeUndefined();
  } finally { await f.close(); }
});

test('HTTP versioned append draft preserves a Message receipt and A number without creating another original Input', async () => {
  const f = await prepare();
  try {
    const original = await action(f, 'order.submit', { content: 'original target', start: false });
    const draft = await action(f, 'draft.add', { content: 'append later', mode: 'append', target_id: original.task.id, conditions: [] });
    const edited = await action(f, 'draft.update', { id: draft.id, content: 'exact final append', expected_revision: draft.revision,
      mode: 'append', target_id: original.task.id, conditions: [] });
    const sent = await action(f, 'input.emit', { draft_id: edited.id, expected_revision: edited.revision, client_request_id: 'append-once' });
    expect(sent.task).toBeUndefined(); expect(f.store.all('SELECT * FROM messages')).toHaveLength(0);
    await drain(f);
    const stored = await get(f, `/api/input/draft/${draft.id}`);
    expect(stored).toMatchObject({ kind: 'draft', mode: 'append', status: 'sent', dispatch: { state: 'succeeded', worker_id: original.task.id } });
    expect(stored.dispatch.append_number).toBe(`A${original.id}-1`);
    expect(stored.dispatch.input_id).toBeUndefined(); expect(f.store.all('SELECT * FROM inputs')).toHaveLength(1);
    expect(f.store.all('SELECT body FROM messages WHERE id=?', stored.dispatch.message_id)).toEqual([{ body: 'exact final append' }]);
    await action(f, 'input.emit', { draft_id: edited.id, expected_revision: edited.revision, client_request_id: 'append-once' }); await drain(f);
    expect(f.store.all('SELECT * FROM messages')).toHaveLength(1);
    const history = (await get(f, '/api/inputs?modes=%5B%22append%22%5D')).items;
    expect(history).toMatchObject([{ kind: 'message', id: stored.dispatch.message_id, source_draft_id: draft.id }]);
    expect((await get(f, '/api/inputs?view=drafts')).items).toHaveLength(0);
  } finally { await f.close(); }
});

test('HTTP exclusive emission queues siblings until explicit release using its same-origin revision', async () => {
  const f = await prepare();
  try {
    const exclusive = await action(f, 'input.emit', { content: 'wide project change', exclusive: true });
    const sibling = await action(f, 'input.emit', { content: 'separate later change' });
    await drain(f);
    const leased = await get(f, `/api/input/draft/${exclusive.draft_id}`);
    expect(leased.dispatch).toMatchObject({ state: 'succeeded', exclusive_active: true, can_release_exclusive: true });
    expect(f.project.inputEmissionResult(sibling.draft_id).dispatch).toMatchObject({ state: 'queued' });
    expect(f.store.all('SELECT * FROM inputs')).toHaveLength(1);
    const released = await action(f, 'input.exclusive_release', { draft_id: exclusive.draft_id, expected_revision: leased.revision });
    expect(released.dispatch).toMatchObject({ state: 'succeeded', exclusive_active: false, can_release_exclusive: false });
    await drain(f); expect(f.project.inputEmissionResult(sibling.draft_id).dispatch.state).toBe('succeeded');
    expect(f.store.all('SELECT * FROM inputs')).toHaveLength(2);
    expect(f.store.task(leased.dispatch.worker_id).status).toBe('queued'); // Releasing does not cancel the work.
  } finally { await f.close(); }
});

test('standalone Decision approval through DOM/HTTP keeps real management authorization and runtime ownership', async () => {
  const f = await prepare(); const rpc = new RPCClient(f.config.socket); let receipt; let managerCalls = 0;
  let dom, navigation;
  try {
    const target = await action(f, 'order.submit', { content: 'cancel only after explicit authorization', start: false });
    f.project.provider = { async run(args) {
      expect(args.task.role).toBe('manager'); managerCalls++;
      receipt = await rpc.request('manager.call', { method: 'worker.cancel', params: { id: target.task.id }, request_id: 'fixed-cancellation', _token: args.token });
      return 'waiting for user authorization';
    } };
    const manager = await action(f, 'management.submit', { instruction: '取消指定开发任务' });
    f.project.stopping = false; f.project.pump();
    await until(() => !f.project.running.has(manager.task.id) && f.store.task(manager.task.id).status === 'awaiting');
    expect(receipt.status).toBe('pending_confirmation'); expect(f.store.task(target.task.id).status).toBe('paused');
    f.project.setDaemonAutoSelect(true, f.project.daemonHooks().revision);
    expect(f.project.autoAnswerNotice(receipt.notice_id)).toBe(false);
    expect(f.store.get('SELECT status,answer_source FROM notices WHERE id=?', receipt.notice_id)).toEqual({ status: 'open', answer_source: null });
    dom = installDom({ fetch: (url, options) => fetch(f.url + url, options) });
    resetUiState(); initNoticeRecords();
    navigation = registerNavigation({ refresh: async () => renderNotices(await get(f, '/api/notices')), detail: async () => { throw new Error('approval must stay on its Decision'); } });
    await openNotice(receipt.notice_id, { record: true });
    const panel = dom.node('detail').querySelector('.notice');
    expect(ui.view.id).toBe('notice'); expect(dom.location.hash).toBe(`#notices-${receipt.notice_id}`);
    expect(deepText(panel)).toContain('worker.cancel'); expect(deepText(panel)).toContain('批准上述精确操作');
    expect(f.store.get('SELECT status FROM notices WHERE id=?', receipt.notice_id).status).toBe('open');
    await panel.querySelectorAll('.decision-option')[1].click();
    expect(f.store.task(target.task.id).status).toBe('paused'); // Selecting is not authorization.
    await findByText(panel, '确认全部选择并继续 Worker').click();
    await until(() => f.store.task(target.task.id).status === 'cancelled' && f.store.task(manager.task.id).status === 'completed');
    expect(managerCalls).toBe(1); expect(f.store.task(manager.task.id).calls).toBe(1);
    expect(f.store.get('SELECT answer_source FROM notices WHERE id=?', receipt.notice_id).answer_source).toBe('user');
    expect(JSON.parse(f.store.task(manager.task.id).management).control_calls[0].status).toBe('succeeded');
    expect(ui.view.id).toBe('notice'); expect(ui.noticePage.id).toBe(receipt.notice_id);
    expect(deepText(dom.node('detail'))).toContain('用户答复');
  } finally { navigation?.(); if (dom) { resetUiState(); dom.restore(); } await f.close(); }
});

test('shortcut DOM reads real main relations, saves and mounts exact conditions, then actual main delivery unlocks input', async () => {
  const f = await prepare(); let dom; const requests = [], providerCalls = [];
  try {
    const prerequisite = await action(f, 'order.submit', { content: 'shortcut prerequisite', start: false });
    const main = f.store.task(prerequisite.task.parent_id), autoMerge = f.store.task(prerequisite.task.id).auto_merge;
    const merged = f.store.create({ parent_id: main.id, goal: 'already merged', role: 'agent', task_kind: 'order', input_id: null });
    f.store.update(merged.id, { status: 'awaiting_acceptance', integration: 'merged' });
    const grandchild = f.store.create({ parent_id: prerequisite.task.id, goal: 'not a direct child', role: 'agent', task_kind: 'child', input_id: null });
    f.store.update(grandchild.id, { status: 'cancelled' });
    const valet = f.store.create({ parent_id: main.id, goal: 'not development', role: 'manager', task_kind: 'management', input_id: null });
    f.store.update(valet.id, { status: 'completed' });
    // Automatic no-code delivery genuinely settles without a Squash receipt;
    // waiting for its nonexistent merge would block the follow-up forever.
    const noCode = await action(f, 'order.submit', { content: 'no code answer', start: false });
    f.store.update(noCode.task.id, { auto_merge: JSON.stringify({ version: 1, enabled: true, locked: false }) });
    f.project.provider = { async run() { return 'answer without changes'; } };
    f.project.stopping = false;
    await action(f, 'worker.resume', { id: noCode.task.id }); f.project.pump();
    await until(() => f.store.task(noCode.task.id).status === 'awaiting_acceptance');
    f.project.stopping = true;
    expect(f.store.task(noCode.task.id).integration).toBe('none');
    const draft = await action(f, 'draft.add', { content: 'shortcut followup', branch: 'main' });
    dom = installDom({ fetch: (url, options) => { requests.push({ url, options }); return fetch(f.url + url, options); } });
    resetUiState();
    const form = createEmissionConditions();
    await findByText(form.node, '等当前所有Worker开发完').click();
    expect(form.collect()).toEqual({ conditions: [{ kind: 'worker_merged', worker_id: prerequisite.task.id }], exclusive: false });
    expect(requests.every(request => !request.options?.method || request.options.method === 'GET')).toBe(true);
    expect(requests.some(request => request.url.includes(`/api/worker/${main.id}/relations`))).toBe(true);
    expect(f.store.task(prerequisite.task.id)).toMatchObject({ integration: 'none', auto_merge: autoMerge });
    expect(f.project.inputGet('draft', draft.id).conditions).toEqual([]); // Import alone does not persist or authorize.
    const saved = await action(f, 'draft.update', { id: draft.id, content: draft.content, expected_revision: draft.revision, ...form.collect() });
    const mounted = await action(f, 'input.emit', { draft_id: saved.id, expected_revision: saved.revision });
    await drain(f); expect(f.project.inputEmissionResult(mounted.draft_id).dispatch.state).toBe('waiting_conditions');
    expect(providerCalls).toEqual([]);
    f.project.provider = { async run(args) {
      providerCalls.push(args.task.id);
      fs.writeFileSync(path.join(args.cwd, 'shortcut.txt'), 'actual main prerequisite\n');
      await git(args.cwd, 'add', '.'); await git(args.cwd, 'commit', '-m', 'shortcut prerequisite');
      return 'controlled prerequisite complete';
    } };
    await action(f, 'worker.resume', { id: prerequisite.task.id }); f.project.pump();
    await until(() => !f.project.running.has(prerequisite.task.id) && f.store.task(prerequisite.task.id).status === 'waiting');
    await drain(f); expect(f.project.inputEmissionResult(mounted.draft_id).dispatch.state).toBe('waiting_conditions');
    await action(f, 'worker.reserve', { id: prerequisite.task.id, kind: 'merge' });
    await until(() => f.store.task(prerequisite.task.id).integration === 'merged', 10000);
    await drain(f);
    const result = f.project.inputEmissionResult(mounted.draft_id);
    expect(result.dispatch.state).toBe('succeeded'); expect(providerCalls).toEqual([prerequisite.task.id]);
    const followup = f.store.task(result.dispatch.worker_id);
    expect(followup.base_commit).toBe(await git(f.root, 'rev-parse', 'main'));
    expect(fs.readFileSync(path.join(followup.workspace, 'shortcut.txt'), 'utf8')).toBe('actual main prerequisite\n');
  } finally { if (dom) { resetUiState(); dom.restore(); } await f.close(); }
});

test('real manager RPC creates a conditional draft, then actual development delivery unlocks it on main', async () => {
  const f = await prepare(); const rpc = new RPCClient(f.config.socket); let mounted, catalog;
  try {
    const prerequisite = await action(f, 'order.submit', { content: 'panel refactor', start: false });
    f.project.provider = { async run(args) {
      if (args.task.role === 'manager') {
        const request = (method, params = {}) => rpc.request(method, { ...params, _token: args.token });
        catalog = await request('manager.catalog');
        const saved = await request('manager.call', { method: 'draft.add', params: { content: 'panel followup', branch: 'main',
          conditions: [{ kind: 'worker_merged', worker_id: prerequisite.task.id }] }, request_id: 'conditional-idea' });
        const read = await request('manager.call', { method: 'input.get', params: { kind: 'draft', id: saved.result.id } });
        mounted = await request('manager.call', { method: 'input.emit', params: { draft_id: saved.result.id, expected_revision: read.result.revision }, request_id: 'mount-idea' });
        return 'conditional management receipt';
      }
      fs.writeFileSync(path.join(args.cwd, 'panel-refactor.txt'), 'new panel architecture\n');
      await git(args.cwd, 'add', '.'); await git(args.cwd, 'commit', '-m', 'controlled panel refactor');
      return 'panel refactor complete';
    } };
    const management = await action(f, 'management.submit', { instruction: '合到 main 后继续面板开发', client_request_id: 'manager-http-once' });
    expect(management.task).toMatchObject({ task_kind: 'management', branch: null, input_id: null });
    f.project.stopping = false; f.project.pump();
    await until(() => !f.project.running.has(management.task.id) && f.store.task(management.task.id).status === 'completed');
    expect(catalog.methods.find(method => method.method === 'input.emit').access).toBe('automatic');
    expect(mounted).toMatchObject({ status: 'succeeded', result: { emitted: true } });
    await drain(f); expect(f.project.inputEmissionResult(mounted.result.draft_id).dispatch.state).toBe('waiting_conditions');
    expect(f.store.all('SELECT * FROM inputs')).toHaveLength(1);
    await action(f, 'worker.resume', { id: prerequisite.task.id }); f.project.pump();
    await until(() => !f.project.running.has(prerequisite.task.id) && f.store.task(prerequisite.task.id).status === 'waiting');
    await drain(f); expect(f.project.inputEmissionResult(mounted.result.draft_id).dispatch.state).toBe('waiting_conditions');
    await action(f, 'worker.reserve', { id: prerequisite.task.id, kind: 'merge' });
    await until(() => f.store.task(prerequisite.task.id).integration === 'merged', 10000);
    await drain(f);
    const followup = f.project.inputEmissionResult(mounted.result.draft_id);
    expect(followup.dispatch.state).toBe('succeeded');
    const worker = f.store.task(followup.dispatch.worker_id);
    expect(worker.goal).toBe('panel followup'); expect(worker.base_commit).toBe(await git(f.root, 'rev-parse', 'main'));
    expect(fs.existsSync(path.join(worker.workspace, 'panel-refactor.txt'))).toBe(true);
    expect(f.store.all('SELECT * FROM inputs')).toHaveLength(2);
  } finally { await f.close(); }
});
