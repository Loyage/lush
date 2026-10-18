import { test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { repo, git, until, gate } from '../helpers.js';
import { fetch as httpFetch, setup } from './harness.js';
import { installDom, deepText, answerDialog, dialogButton } from '../dom-stub.js';

let fixture, hold = null, emitHold = null, emitFailure = false, readFailure = false, createFailure = false, restoreNavigation, relationLimit = null;
const requests = [], runs = [], sourceReads = [], sourceBlocks = new Map(), sourceFailures = new Set();
const dom = installDom({ fetch: async (url, options) => {
  if (options?.body) {
    const call = JSON.parse(options.body); requests.push(call);
    if (call.method === 'input.emit') {
      if (emitHold) await emitHold.promise;
      if (emitFailure) return { ok: false, json: async () => ({ error: 'input transport failure' }) };
    }
    if (call.method === 'worker.create') {
      if (hold) await hold.promise;
      if (createFailure) return { ok: false, json: async () => ({ error: 'creation rejected' }) };
    }
  }
  const route = relationLimit && String(url).includes('/relations?') ? String(url).replace('limit=100', `limit=${relationLimit}`) : url;
  const response = await httpFetch(fixture.url + route, options);
  const sourceRead = /^\/api\/worker\/(\d+)$/.exec(String(url));
  if (sourceRead) {
    const id = Number(sourceRead[1]); sourceReads.push(id);
    if (sourceBlocks.has(id)) await sourceBlocks.get(id).promise;
    if (sourceFailures.has(id)) return { ok: false, json: async () => ({ error: 'source detail unavailable' }) };
  }
  return response;
} });
const { resetUiState, ui } = await import('../../src/ui/web/assets/state.js');
const { initComposer, syncComposer } = await import('../../src/ui/web/assets/composer.js');
const { collapseComposer } = await import('../../src/ui/web/assets/composer-workspace.js');
const { openWorkerCreate } = await import('../../src/ui/web/assets/worker-create-form.js');
const { createEmissionConditions } = await import('../../src/ui/web/assets/emission-form.js');
const { loadDetail } = await import('../../src/ui/web/assets/detail.js');
const { openInputs } = await import('../../src/ui/web/assets/render-inputs.js');
const { action, api } = await import('../../src/ui/web/assets/api.js');
const { registerNavigation } = await import('../../src/ui/web/assets/navigate.js');
const { closeDialog } = await import('../../src/ui/web/assets/dialog.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const button = (root, text) => root.querySelectorAll('button').find(node => node.textContent === text);
const field = name => dom.node('modal').querySelector(`[data-create-field="${name}"]`);
const sourceStatus = () => dom.node('modal').querySelector('.worker-create-parent');
const readySource = () => until(() => sourceStatus()?.dataset.sourceState === 'ready');
const sourceNumber = () => dom.node('modal').querySelector('.emission-worker-picker').querySelector('input');
async function locateSource(source) {
  sourceNumber().value = source.worker_number;
  await button(dom.node('modal'), '按编号定位').onclick();
}
function checkpoint(source, invalid = false) {
  const file = path.join(fixture.config.home, 'sessions', `source-${source.id}.jsonl`); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, invalid ? 'not JSON' : [{ type: 'session', id: 'source-session' }, { type: 'message', id: 'entry', parentId: null, message: { role: 'user', content: 'source context' } }].map(JSON.stringify).join('\n') + '\n');
  fixture.store.run('INSERT OR REPLACE INTO commit_contexts(commit_hash,session_path,entry_id,task_id) VALUES (?,?,?,?)', source.base_commit, file, 'entry', source.id);
  return { session: file, entry: 'entry' };
}
beforeEach(async () => {
  fixture = await setup(); await repo(fixture.root); fixture.project.kick = () => {}; fixture.project.scheduleInputEmissions = () => {};
  fixture.project.provider = { async run(args) { runs.push(args); return 'controlled response'; } };
  relationLimit = null;
  resetUiState(); requests.length = runs.length = sourceReads.length = 0; sourceBlocks.clear(); sourceFailures.clear(); hold = emitHold = null; emitFailure = readFailure = createFailure = false;
  dom.node('input').value = ''; dom.node('input-parent').value = ''; dom.node('detail').replaceChildren(); dom.node('modal').replaceChildren(); dom.node('modal').hidden = true;
  ui.view = { id: 'overview' }; await initComposer();
  restoreNavigation = registerNavigation({ refresh: async () => { if (readFailure) throw Error('refresh unavailable'); }, detail: async id => { if (readFailure) throw Error('detail unavailable'); return loadDetail(id); } });
});
afterEach(async () => { closeDialog(); restoreNavigation(); await fixture.close(); });
afterAll(() => dom.restore());

async function submitFirst(task, content = 'first real user instruction') {
  await loadDetail(task.id);
  expect(button(dom.node('detail'), '开始')).toBeUndefined(); expect(button(dom.node('detail'), '继续')).toBeUndefined();
  const edit = button(dom.node('detail'), '输入工作指令'); expect(edit.classList.contains('agent-call')).toBe(false); await edit.onclick();
  expect(deepText(dom.node('composer-menu-append'))).toContain('输入工作指令');
  expect(dom.node('composer-mode-title').textContent).toBe('输入工作指令');
  expect(dom.node('composer-target-status').textContent).not.toContain('需开始');
  expect(dom.node('draft-commit').classList.contains('agent-call')).toBe(true);
  const input = dom.node('input'); input.value = content; input.oninput();
  await input.onkeydown({ key: 'Enter', ctrlKey: true, preventDefault() {} });
  const request = requests.findLast(call => call.method === 'input.emit');
  expect(request.params).toMatchObject({ mode: 'append', target_id: task.id, content });
  await action('input.emit', request.params, { refresh: false }); // reliable retry, identical authorization
  await fixture.project.drainInputEmissions();
  const draftId = fixture.store.all('SELECT * FROM drafts').at(-1).id;
  return { receipt: fixture.project.inputGet('draft', draftId), draftId };
}

test('real UI spawn -> waiting -> first Input/O -> draft receipt -> history; later append is Message/A, normal paused semantics unchanged', async () => {
  // Allocate an empty Worker first, deliberately decoupling W from O.
  const empty = (await fixture.project.createWorker({ mode: 'spawn' })).task; await loadDetail(empty.id);
  expect(button(dom.node('detail'), '空白创建')).toBeUndefined();
  expect(button(dom.node('detail'), '创建子 Worker')).toBeUndefined(); // empty parent cannot create descendants before its first input
  const pending = openWorkerCreate(); await until(() => field('title')); field('title').value = '空白标题';
  expect(dom.node('modal').querySelector('.worker-create-advanced').open).not.toBe(true);
  expect(dialogButton(dom, '创建 Worker').classList.contains('agent-call')).toBe(false);
  await answerDialog(dom, '创建 Worker'); await pending; const made = fixture.project.inspect(fixture.store.tasks().find(task => task.display_title === '空白标题').id);
  expect(made).toMatchObject({ status: 'paused', input_id: null, display_title: '空白标题', creation: { waiting_first_input: true } });
  expect(fixture.store.all('SELECT * FROM inputs')).toHaveLength(0); expect(runs).toHaveLength(0);
  expect(deepText(dom.node('detail'))).toContain('等待首条输入 · 尚未调用 Agent');
  const { receipt, draftId } = await submitFirst(made);
  expect(receipt.dispatch).toMatchObject({ state: 'succeeded', input_id: 1, worker_id: made.id });
  expect(receipt.dispatch.message_id).toBeUndefined(); expect(receipt.dispatch.append_number).toBeUndefined();
  expect(fixture.store.all('SELECT * FROM inputs')).toHaveLength(1); expect(fixture.store.all('SELECT * FROM messages')).toHaveLength(0);
  expect(fixture.project.inspect(made.id).worker_number).not.toBe('W1');
  await openInputs({ section: 'drafts', item: { kind: 'draft', id: draftId } });
  expect(deepText(dom.node('detail'))).toContain('首条工作指令已创建原始输入 O1');
  await button(dom.node('detail'), '查看已创建原文 O1').onclick();
  expect(dom.location.hash).toBe('#input-input-1'); expect(deepText(dom.node('detail'))).toContain('first real user instruction');
  const original = await api('/api/input/input/1');
  const sourceLink = button(dom.node('detail'), '查看提交草稿 · 条件与独占');
  // The append-first association now has exact backend proof; follow it back to the original receipt.
  expect(original.source_draft_id).toBe(draftId);
  expect(sourceLink).toBeDefined();
  await sourceLink.onclick();
  expect(dom.location.hash).toBe(`#input-draft-${draftId}`);
  expect(deepText(dom.node('detail'))).toContain('first real user instruction');
  expect(button(dom.node('detail'), '查看已创建原文 O1')).toBeDefined();
  fixture.project.pump(); await until(() => !fixture.project.running.size && runs.length === 1);
  expect(runs[0].task.input_id).toBe(1); expect(runs[0].forkPointer).toBeNull();
  fixture.project.interrupt(made.id);
  await loadDetail(made.id); await button(dom.node('detail'), '追加输入').onclick();
  expect(dom.node('composer-target-status').textContent).toContain('需开始 / 继续');
  const input = dom.node('input'); input.value = 'later real append'; input.oninput();
  await input.onkeydown({ key: 'Enter', ctrlKey: true, preventDefault() {} }); await fixture.project.drainInputEmissions();
  const later = fixture.project.inputGet('draft', fixture.store.all('SELECT * FROM drafts').at(-1).id);
  expect(later.dispatch.message_id).toBeNumber(); expect(later.dispatch.append_number).toMatch(/^A/); expect(later.dispatch.input_id).toBeUndefined();
  expect(fixture.project.inspect(made.id).status).toBe('paused');
  await openInputs({ section: 'drafts', item: { kind: 'draft', id: later.id } });
  expect(button(dom.node('detail'), '查看已入箱追加原文')).toBeDefined(); expect(button(dom.node('detail'), '查看已创建原文 O1')).toBeUndefined();
});

test('real non-null Input source_draft_id returns to its exact persisted submission receipt without Agent calls', async () => {
  // Keep the ordinary order-draft source proof alongside the append-first roundtrip above.
  const emission = await action('input.emit', { content: 'source receipt roundtrip', branch: 'main', client_request_id: 'source-receipt-roundtrip' }, { refresh: false });
  await fixture.project.drainInputEmissions();
  const receipt = await api(`/api/input/draft/${emission.draft_id}`);
  expect(receipt.dispatch.state).toBe('succeeded'); expect(receipt.dispatch.input_id).toBeNumber();
  const original = await api(`/api/input/input/${receipt.dispatch.input_id}`);
  expect(original.source_draft_id).toBe(emission.draft_id);
  await openInputs({ section: 'drafts', item: { kind: 'draft', id: emission.draft_id } });
  await button(dom.node('detail'), `查看已创建原文 O${original.id}`).onclick();
  expect(dom.location.hash).toBe(`#input-input-${original.id}`);
  const sourceLink = button(dom.node('detail'), '查看提交草稿 · 条件与独占');
  expect(sourceLink).toBeDefined(); expect(sourceLink.classList.contains('agent-call')).toBe(false);
  await sourceLink.onclick();
  expect(dom.location.hash).toBe(`#input-draft-${emission.draft_id}`);
  expect(deepText(dom.node('detail'))).toContain('source receipt roundtrip');
  expect(button(dom.node('detail'), `查看已创建原文 O${original.id}`)).toBeDefined();
  expect(runs).toHaveLength(0);
});

test('first-input failure retains body/retry key, single flight and late authorization cannot hijack navigation', async () => {
  const task = (await fixture.project.createWorker({ mode: 'spawn' })).task;
  await loadDetail(task.id); await button(dom.node('detail'), '输入工作指令').onclick();
  const input = dom.node('input'); input.value = 'first retry protected'; input.oninput();
  const event = { key: 'Enter', ctrlKey: true, preventDefault() {} };
  emitFailure = true; emitHold = gate(); const failed = input.onkeydown(event); await input.onkeydown(event);
  expect(requests.filter(call => call.method === 'input.emit')).toHaveLength(1);
  emitHold.resolve(); await failed; expect(input.value).toBe('first retry protected');
  expect(fixture.store.all('SELECT * FROM inputs')).toHaveLength(0); expect(fixture.project.inspect(task.id).creation.waiting_first_input).toBe(true);
  emitFailure = false; emitHold = gate(); const retry = input.onkeydown(event); activateDetailView({ view: 'settings' }); const view = ui.view;
  emitHold.resolve(); await retry;
  expect(ui.view).toBe(view); expect(input.value).toBe(''); expect(dom.node('error').textContent).toContain('首条工作指令');
  const attempts = requests.filter(call => call.method === 'input.emit'); expect(attempts).toHaveLength(2);
  expect(attempts[0].params.client_request_id).toBe(attempts[1].params.client_request_id);
  await fixture.project.drainInputEmissions(); expect(fixture.store.all('SELECT * FROM inputs WHERE task_id=?', task.id)).toHaveLength(1);
});

test('real fork UI fixes sibling delivery parent, preserves source effective profile, pins checkpoint through first invocation', async () => {
  const parent = (await fixture.project.order('delivery parent', 'main', [], null, false)).task;
  const source = (await fixture.project.order('source', parent.branch, [], null, false)).task;
  fixture.project.configureTask(source.id, { agent: 'pi', model: 'deepseek/deepseek-chat', append_prompt: 'source-specific' });
  const pointer = checkpoint(source); await loadDetail(source.id);
  const pending = openWorkerCreate({ source }); await until(() => field('mode'));
  await readySource();
  expect(field('mode').value).toBe('fork'); expect(deepText(dom.node('modal'))).toContain('固定为来源的直接父');
  await answerDialog(dom, '创建 Worker'); await pending; const made = fixture.project.inspect(fixture.store.tasks().at(-1).id);
  expect(requests.find(call => call.method === 'worker.create').params).toEqual({ mode: 'fork', source: source.id });
  expect(made.parent_id).toBe(parent.id); expect(made.parent_id).not.toBe(source.id);
  expect(made.creation).toMatchObject({ source_id: source.id, session_inherited: true, commit: source.base_commit });
  expect(fixture.store.task(made.id).retry_profile).toBe(fixture.store.task(source.id).retry_profile);
  await submitFirst(made, 'fork first input'); fixture.project.pump(); await until(() => !fixture.project.running.size && runs.length === 1);
  expect(runs[0].forkPointer).toEqual(pointer); expect(fixture.store.task(source.id).calls).toBe(0);
});

test('spawn panel -> fork -> real W lookup hydrates source detail and fixes the verified sibling delivery parent', async () => {
  const parent = (await fixture.project.order('lookup delivery parent', 'main', [], null, false)).task;
  const source = (await fixture.project.order('lookup source', parent.branch, [], null, false)).task;
  fixture.project.configureTask(source.id, { agent: 'pi', model: 'deepseek/deepseek-chat', append_prompt: 'lookup-source-profile' }); checkpoint(source);
  expect(await api(`/api/worker-lookup?number=${source.worker_number}`)).toEqual({ id: source.id, worker_number: source.worker_number });
  const block = gate(); sourceBlocks.set(source.id, block);
  const pending = openWorkerCreate(); field('title').value = 'lookup title'; field('mode').value = 'fork'; field('mode').onchange();
  expect(dialogButton(dom, '创建 Worker').disabled).toBe(true);
  await locateSource(source); await until(() => sourceReads.includes(source.id));
  expect(sourceStatus().dataset.sourceState).toBe('loading'); expect(sourceStatus().textContent).toContain('核验交付父');
  expect(sourceStatus().textContent).not.toContain('#undefined'); expect(dialogButton(dom, '创建 Worker').disabled).toBe(true);
  await answerDialog(dom, '创建 Worker'); expect(requests.filter(call => call.method === 'worker.create')).toHaveLength(0);
  block.resolve(); await readySource(); expect(sourceStatus().textContent).toContain(`交付父：${parent.worker_number}`);
  expect(field('source').children.find(option => option.value === String(source.id)).textContent).toContain('lookup source');
  expect(dialogButton(dom, '创建 Worker').disabled).toBe(false); expect(field('title').value).toBe('lookup title');
  await answerDialog(dom, '创建 Worker'); const made = await pending;
  expect(made.parent_id).toBe(parent.id); expect(made.creation.source_id).toBe(source.id);
  expect(requests.find(call => call.method === 'worker.create').params).toEqual({ mode: 'fork', source: source.id, title: 'lookup title' });
  expect(fixture.store.task(made.id).retry_profile).toBe(fixture.store.task(source.id).retry_profile); expect(runs).toHaveLength(0);
});

test('fork source detail failure preserves fields, disables creation and supports explicit lookup retry', async () => {
  const source = (await fixture.project.order('failed detail source', 'main', [], null, false)).task;
  sourceFailures.add(source.id);
  const pending = openWorkerCreate(); field('mode').value = 'fork'; field('mode').onchange(); field('title').value = 'retained source failure';
  await locateSource(source); await until(() => sourceStatus().dataset.sourceState === 'failed');
  expect(sourceStatus().textContent).toContain('source detail unavailable'); expect(sourceStatus().textContent).toContain('不能复制创建');
  expect(field('source').value).toBe(String(source.id)); expect(field('title').value).toBe('retained source failure');
  expect(dialogButton(dom, '创建 Worker').disabled).toBe(true); await answerDialog(dom, '创建 Worker');
  expect(requests.filter(call => call.method === 'worker.create')).toHaveLength(0);
  sourceFailures.delete(source.id); await locateSource(source); await readySource();
  expect(dialogButton(dom, '创建 Worker').disabled).toBe(false); expect(field('title').value).toBe('retained source failure');
  await answerDialog(dom, '取消'); await pending;
});

test('changing selected fork source invalidates its in-flight real detail and cannot overwrite the new verified parent', async () => {
  const oldSource = (await fixture.project.order('old source', 'main', [], null, false)).task;
  const parent = (await fixture.project.order('new parent', 'main', [], null, false)).task;
  const source = (await fixture.project.order('new source', parent.branch, [], null, false)).task;
  const pending = openWorkerCreate(); field('mode').value = 'fork'; field('mode').onchange();
  await locateSource(oldSource); await readySource(); await locateSource(source); await readySource();
  const block = gate(); sourceBlocks.set(oldSource.id, block); sourceReads.length = 0;
  field('source').value = String(oldSource.id); const late = field('source').onchange(); await until(() => sourceReads.includes(oldSource.id));
  field('source').value = String(source.id); await field('source').onchange(); await readySource();
  expect(sourceStatus().textContent).toContain(`交付父：${parent.worker_number}`);
  block.resolve(); await late;
  expect(field('source').value).toBe(String(source.id)); expect(sourceStatus().textContent).toContain(`交付父：${parent.worker_number}`);
  expect(field('source').children.find(option => option.value === String(source.id)).textContent).toContain('new source');
  expect(dialogButton(dom, '创建 Worker').disabled).toBe(false); await answerDialog(dom, '取消'); await pending;
});

for (const departure of ['page', 'project']) test(`late source detail after ${departure} change cannot resolve another context's creation gate`, async () => {
  const source = (await fixture.project.order('late source', 'main', [], null, false)).task;
  const pending = openWorkerCreate(); field('mode').value = 'fork'; field('mode').onchange(); await locateSource(source); await readySource();
  const block = gate(); sourceBlocks.set(source.id, block); sourceReads.length = 0;
  field('source').value = String(source.id); const late = field('source').onchange(); await until(() => sourceReads.includes(source.id));
  const oldPath = dom.location.pathname;
  let replacement;
  if (departure === 'page') { activateDetailView({ view: 'settings' }); await pending; replacement = openWorkerCreate(); }
  else dom.location.pathname = '/p/aaaaaaaaaaaaaaaa/';
  block.resolve(); await late;
  if (departure === 'page') { expect(field('mode').value).toBe('spawn'); expect(sourceStatus().dataset.sourceState).toBe('empty'); }
  else { expect(sourceStatus().dataset.sourceState).toBe('loading'); expect(dialogButton(dom, '创建 Worker').disabled).toBe(true); }
  dom.location.pathname = oldPath; await answerDialog(dom, '取消'); await (replacement || pending);
  expect(requests.filter(call => call.method === 'worker.create')).toHaveLength(0);
});

test('spawn explicit delivery parent and inline advanced profile preserve source parameters without nested dialogs or implicit overrides', async () => {
  const parent = (await fixture.project.order('chosen delivery parent', 'main', [], null, false)).task;
  const source = (await fixture.project.order('fork source', parent.branch, [], null, false)).task;
  fixture.project.configureTask(source.id, { agent: 'pi', model: 'deepseek/deepseek-chat', append_prompt: 'source-only-prompt' });
  const pending = openWorkerCreate({ source }); field('title').value = 'source edits retained';
  field('override').checked = true; field('override').onchange();
  await until(() => dom.node('modal').querySelector('[data-retry-field="append-prompt"]'));
  expect(dom.node('modal').querySelector('[data-retry-field="append-prompt"]').value).toBe('source-only-prompt');
  expect(field('title').value).toBe('source edits retained');
  expect(dom.node('modal').querySelectorAll('[role="dialog"]')).toHaveLength(1);
  // Explicitly reverting to inheritance omits profile entirely, even if the advanced form was read/edited.
  field('override').checked = false; field('override').onchange(); field('mode').value = 'spawn'; field('mode').onchange();
  await until(() => field('parent').children.some(node => node.value === String(parent.id)));
  field('parent').value = String(parent.id); await answerDialog(dom, '创建 Worker'); const made = await pending;
  expect(requests.find(call => call.method === 'worker.create').params).toEqual({ mode: 'spawn', parent: parent.id, title: 'source edits retained' });
  expect(made.parent_id).toBe(parent.id); expect(made.creation).toMatchObject({ mode: 'spawn', session_inherited: false, source_id: null });
});

test('real fork strict errors retain mode/source/title, create nothing and never silently downgrade', async () => {
  const source = (await fixture.project.order('source', 'main', [], null, false)).task;
  const count = fixture.store.tasks().length, refs = await git(fixture.root, 'for-each-ref', '--format=%(refname)');
  const pending = openWorkerCreate({ source }); field('title').value = '保留此标题'; await readySource();
  for (const profile of [{ agent: 'pi', config_mode: 'pi' }, { agent: 'codex' }, { agent: 'pi', model: 'deepseek/deepseek-chat' }]) {
    fixture.project.configureTask(source.id, profile); await answerDialog(dom, '创建 Worker');
    expect(dom.node('modal').hidden).toBe(false); expect(field('mode').value).toBe('fork'); expect(field('title').value).toBe('保留此标题');
    expect(deepText(dom.node('modal'))).toContain('fork 无法继承会话');
  }
  checkpoint(source, true); await answerDialog(dom, '创建 Worker'); expect(deepText(dom.node('modal'))).toContain('检查点无效');
  expect(fixture.store.tasks()).toHaveLength(count); expect(await git(fixture.root, 'for-each-ref', '--format=%(refname)')).toBe(refs);
  expect(runs).toHaveLength(0); await answerDialog(dom, '取消'); expect(await pending).toBeNull();
});

test('Worker detail has one child-create entry; blank is default, parent fixed, creation alone never invokes Agent', async () => {
  const parent = (await fixture.project.order('current parent', 'main', [], null, false)).task;
  await loadDetail(parent.id);
  expect(button(dom.node('detail'), '空白创建')).toBeUndefined(); expect(button(dom.node('detail'), '复制创建')).toBeUndefined();
  expect(dom.node('detail').querySelectorAll('.worker-create-entry')).toHaveLength(1);
  const pending = button(dom.node('detail'), '创建子 Worker').onclick(); await until(() => field('mode'));
  expect(field('mode').value).toBe('spawn'); expect(field('parent').parentNode.hidden).toBe(true);
  expect(sourceStatus().textContent).toContain(`父 Worker：${parent.worker_number}`);
  expect(dom.node('modal').querySelector('.worker-child-source').hidden).toBe(true);
  expect(dom.node('modal').querySelector('.emission-worker-picker')).toBeNull();
  expect(dialogButton(dom, '创建子 Worker').classList.contains('agent-call')).toBe(false);
  await answerDialog(dom, '创建子 Worker'); await pending;
  const made = fixture.project.inspect(fixture.store.tasks().at(-1).id);
  expect(made.parent_id).toBe(parent.id); expect(made.target_branch).toBe(parent.branch);
  expect(requests.find(call => call.method === 'worker.create').params).toEqual({ mode: 'spawn', parent: parent.id });
  expect(fixture.store.all('SELECT * FROM inputs')).toHaveLength(1); expect(runs).toHaveLength(0);
});

test('unfinished child first instruction survives reload and resumes its exact parent-bound target without authorizing on open', async () => {
  dom.localStorage.clear();
  const parent = (await fixture.project.order('current parent', 'main', [], null, false)).task;
  const pending = openWorkerCreate({ parent }); await answerDialog(dom, '创建子 Worker'); const made = await pending;
  expect(made.parent_id).toBe(parent.id); expect(made.creation.waiting_first_input).toBe(true);
  await button(dom.node('detail'), '输入工作指令').onclick();
  const input = dom.node('input'); input.value = '保留的新子 Worker 首条指令'; input.oninput(); collapseComposer();
  resetUiState(); input.value = ''; dom.node('input-parent').value = ''; await initComposer();
  dom.node('composer-launcher').click();
  const row = dom.node('composer-pending-append').querySelectorAll('button').find(node => node.dataset.editKey === `append:${made.id}`);
  expect(row.getAttribute('aria-label')).toContain(made.worker_number);
  requests.length = sourceReads.length = 0; row.click();
  await until(() => sourceReads.includes(made.id) && !input.disabled);
  expect(dom.node('composer-mode-title').textContent).toBe('输入工作指令');
  expect(dom.node('composer-mode-target').textContent).toContain(made.worker_number);
  expect(deepText(dom.node('composer-menu-append'))).toContain('输入工作指令');
  expect(input.value).toBe('保留的新子 Worker 首条指令'); expect(requests).toHaveLength(0); expect(runs).toHaveLength(0);
  await input.onkeydown({ key: 'Enter', ctrlKey: true, preventDefault() {} });
  expect(requests[0].params).toMatchObject({ mode: 'append', target_id: made.id, content: '保留的新子 Worker 首条指令' });
  await fixture.project.drainInputEmissions();
  const after = fixture.project.inspect(made.id); expect(after.parent_id).toBe(parent.id); expect(after.target_branch).toBe(parent.branch);
  expect(after.input_id).toBeNumber(); expect(fixture.store.all('SELECT * FROM messages WHERE task_id=?', made.id)).toHaveLength(0);
  expect(runs).toHaveLength(0);
});

test('child panel fork defaults to self and creates a real child with first O and inherited checkpoint', async () => {
  const parent = (await fixture.project.order('copy myself', 'main', [], null, false)).task;
  fixture.project.configureTask(parent.id, { agent: 'pi', model: 'deepseek/deepseek-chat' });
  const pointer = checkpoint(parent); await loadDetail(parent.id);
  const pending = button(dom.node('detail'), '创建子 Worker').onclick(); await until(() => field('mode'));
  field('mode').value = 'fork'; await field('mode').onchange(); await readySource();
  expect(field('source').value).toBe(String(parent.id)); expect(field('source').children[0].textContent).toContain('当前 Worker（默认）');
  expect(sourceStatus().textContent).toContain(`父 Worker：${parent.worker_number}`);
  await answerDialog(dom, '创建子 Worker'); await pending;
  const made = fixture.project.inspect(fixture.store.tasks().at(-1).id);
  expect(requests.find(call => call.method === 'worker.create').params).toEqual({ mode: 'fork', parent: parent.id, source: parent.id });
  expect(made.parent_id).toBe(parent.id); expect(made.creation.source_id).toBe(parent.id);
  expect(made.input_id).toBeNull(); expect(runs).toHaveLength(0);
  const { receipt } = await submitFirst(made, 'new child first instruction');
  expect(receipt.dispatch.input_id).toBeNumber(); fixture.project.pump(); await until(() => !fixture.project.running.size && runs.length === 1);
  expect(runs[0].forkPointer).toEqual(pointer); expect(runs[0].task.parent_id).toBe(parent.id);
});

test('child copy sources paginate only real direct children; selecting one still fixes current Worker as parent', async () => {
  const parent = (await fixture.project.order('current', 'main', [], null, false)).task;
  const a = (await fixture.project.order('first direct', parent.branch, [], null, false)).task;
  const b = (await fixture.project.order('second direct', parent.branch, [], null, false)).task;
  const grandchild = (await fixture.project.order('grandchild', b.branch, [], null, false)).task;
  const unrelated = (await fixture.project.order('unrelated', 'main', [], null, false)).task;
  fixture.project.configureTask(b.id, { agent: 'pi', model: 'deepseek/deepseek-chat' }); checkpoint(b); relationLimit = 1;
  const pending = openWorkerCreate({ parent }); field('mode').value = 'fork'; field('mode').onchange(); await readySource();
  await button(dom.node('modal'), '加载直接子 Worker').onclick();
  expect(field('source').children.map(option => option.value)).toEqual([String(parent.id), String(a.id)]);
  await button(dom.node('modal'), '加载更多直接子 Worker').onclick();
  expect(field('source').children.map(option => option.value)).toEqual([String(parent.id), String(a.id), String(b.id)]);
  expect(field('source').children.some(option => [String(grandchild.id), String(unrelated.id)].includes(option.value))).toBe(false);
  field('source').value = String(b.id); await field('source').onchange(); await readySource();
  await answerDialog(dom, '创建子 Worker'); const made = await pending;
  expect(made.parent_id).toBe(parent.id); expect(made.creation.source_id).toBe(b.id); expect(made.target_branch).toBe(parent.branch);
  expect(runs).toHaveLength(0);
});

test('child source verification blocks moved children and stale details cannot override a newer self selection', async () => {
  const parent = (await fixture.project.order('current', 'main', [], null, false)).task;
  const child = (await fixture.project.order('direct', parent.branch, [], null, false)).task;
  const pending = openWorkerCreate({ parent }); field('mode').value = 'fork'; field('mode').onchange(); await readySource();
  await button(dom.node('modal'), '加载直接子 Worker').onclick();
  const block = gate(); sourceBlocks.set(child.id, block); sourceReads.length = 0;
  field('source').value = String(child.id); const late = field('source').onchange(); await until(() => sourceReads.includes(child.id));
  field('source').value = String(parent.id); await field('source').onchange(); await readySource(); block.resolve(); await late;
  expect(field('source').value).toBe(String(parent.id)); expect(sourceStatus().textContent).toContain(`复制来源：${parent.worker_number}`);
  sourceBlocks.delete(child.id); fixture.store.run('UPDATE tasks SET parent_id=? WHERE id=?', parent.parent_id, child.id);
  field('source').value = String(child.id); await field('source').onchange(); await until(() => sourceStatus().dataset.sourceState === 'failed');
  expect(sourceStatus().textContent).toContain('不再是当前 Worker 的直接子'); expect(dialogButton(dom, '创建子 Worker').disabled).toBe(true);
  await answerDialog(dom, '创建子 Worker'); expect(requests.filter(call => call.method === 'worker.create')).toHaveLength(0);
  await answerDialog(dom, '取消'); await pending;
});

test('append advanced quiet control explains empty/paused self-wait without changing submitted conditions', async () => {
  const conditions = createEmissionConditions({ mode: 'append', conditions: [{ kind: 'parent_quiet' }] });
  const limit = conditions.node.querySelector('.emission-quiet-limit'); expect(limit).toBeTruthy();
  expect(limit.textContent).toContain('等待首条输入的空 Worker 或暂停 Worker');
  expect(limit.textContent).toContain('静息条件不会满足'); expect(limit.textContent).toContain('需取消静息条件提交');
  await button(conditions.node, '展开高级设置：静息等待').onclick();
  expect(conditions.node.querySelector('.emission-advanced-body').hidden).toBe(false);
  expect(conditions.collect()).toEqual({ conditions: [{ kind: 'parent_quiet' }], exclusive: false });
  expect(createEmissionConditions({ mode: 'order' }).node.querySelector('.emission-quiet-limit')).toBeNull(); expect(runs).toHaveLength(0);
});

test('failed/cancelled empty Worker never offers an Agent retry or resume entry', async () => {
  const task = (await fixture.project.createWorker({ mode: 'spawn' })).task;
  for (const status of ['failed', 'cancelled']) {
    fixture.store.update(task.id, { status }); await loadDetail(task.id);
    expect(button(dom.node('detail'), '检查后重试')).toBeUndefined(); expect(button(dom.node('detail'), '开始')).toBeUndefined(); expect(button(dom.node('detail'), '继续')).toBeUndefined();
  }
  expect(runs).toHaveLength(0);
});

test('create single flight, failed form retention and successful-write/read-failure separation', async () => {
  const pending = openWorkerCreate(); field('title').value = '保留字段'; createFailure = true;
  await answerDialog(dom, '创建 Worker'); expect(field('title').value).toBe('保留字段'); expect(dialogButton(dom, '创建 Worker').disabled).toBe(false);
  createFailure = false; readFailure = true; hold = gate();
  const first = answerDialog(dom, '创建 Worker'); await answerDialog(dom, '创建 Worker');
  expect(requests.filter(call => call.method === 'worker.create')).toHaveLength(2); // one rejected attempt + one in flight
  hold.resolve(); await first; const made = await pending;
  expect(made.id).toBeNumber(); expect(dom.node('modal').hidden).toBe(true);
  expect(dom.node('error').textContent).toContain('已创建'); expect(requests.filter(call => call.method === 'worker.create')).toHaveLength(2);
});

for (const dismiss of ['navigation', 'cancel']) test(`late successful creation after ${dismiss} reports actual creation without navigation hijack`, async () => {
  hold = gate(); const pending = openWorkerCreate(); const submit = answerDialog(dom, '创建 Worker');
  if (dismiss === 'navigation') activateDetailView({ view: 'settings' }); else closeDialog();
  await pending; const view = ui.view; hold.resolve(); await submit;
  expect(ui.view).toBe(view); expect(fixture.store.tasks().filter(task => task.task_kind === 'order')).toHaveLength(1);
  expect(dom.node('error').textContent).toContain('已创建'); expect(runs).toHaveLength(0);
});
