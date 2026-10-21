import { test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { repo, until } from '../helpers.js';
import { fetch as httpFetch, setup } from './harness.js';
import { installDom, deepText, answerDialog, dialogButton } from '../dom-stub.js';

let fixture, restoreNavigation;
const requests = [], runs = [];
const dom = installDom({ fetch: (url, options) => {
  if (options?.body) requests.push(JSON.parse(options.body));
  return httpFetch(fixture.url + url, options);
} });
const { resetUiState, ui } = await import('../../src/ui/web/assets/state.js');
const { initComposer } = await import('../../src/ui/web/assets/composer.js');
const { openWorkerCreate } = await import('../../src/ui/web/assets/worker-create-form.js');
const { loadDetail } = await import('../../src/ui/web/assets/detail.js');
const { openInputs } = await import('../../src/ui/web/assets/render-inputs.js');
const { api } = await import('../../src/ui/web/assets/api.js');
const { registerNavigation } = await import('../../src/ui/web/assets/navigate.js');
const { closeDialog } = await import('../../src/ui/web/assets/dialog.js');
const button = (root, text) => root.querySelectorAll('button').find(node => node.textContent === text);
const field = name => dom.node('modal').querySelector(`[data-create-field="${name}"]`);
const sourceStatus = () => dom.node('modal').querySelector('.worker-create-parent');
const readySource = () => until(() => sourceStatus()?.dataset.sourceState === 'ready');
function checkpoint(source) {
  const file = path.join(fixture.config.home, 'sessions', `source-${source.id}.jsonl`); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [{ type: 'session', id: 'source-session' }, { type: 'message', id: 'entry', parentId: null, message: { role: 'user', content: 'source context' } }].map(JSON.stringify).join('\n') + '\n');
  fixture.store.run('INSERT OR REPLACE INTO commit_contexts(commit_hash,session_path,entry_id,task_id) VALUES (?,?,?,?)', source.base_commit, file, 'entry', source.id);
  return { session: file, entry: 'entry' };
}
beforeEach(async () => {
  fixture = await setup(); await repo(fixture.root); fixture.project.kick = () => {}; fixture.project.scheduleInputEmissions = () => {};
  fixture.project.provider = { async run(args) { runs.push(args); return 'controlled response'; } };
  resetUiState(); requests.length = runs.length = 0;
  dom.node('input').value = ''; dom.node('input-parent').value = ''; dom.node('detail').replaceChildren(); dom.node('modal').replaceChildren(); dom.node('modal').hidden = true;
  ui.view = { id: 'overview' }; await initComposer();
  restoreNavigation = registerNavigation({ refresh: async () => {}, detail: loadDetail });
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
  expect(request.params).toMatchObject({ draft_id: expect.any(Number), expected_revision: 1 });
  expect(requests.findLast(call => call.method === 'draft.add').params).toMatchObject({ mode: 'append', target_id: task.id, content });
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
