import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { until } from '../helpers.js';
const calls = [], reads = [];
let records, failure, deferred, release, deferredRead, readFailure;
const json = value => ({ ok: true, json: async () => structuredClone(value) });
const draft = (id, fields = {}) => ({ kind: 'draft', id, mode: 'order', content: `正文 ${id}`, parent_id: 1, branch: 'main', revision: 3, references: [], status: 'draft', ...fields });
const worker = id => ({ id, worker_number: `W${id}`, task_kind: 'order', status: 'running', branch: `work/${id}`, workspace: `/tmp/${id}`, goal: `目标 ${id}` });
const dom = installDom({ fetch: async (url, options = {}) => {
  const path = new URL(url, 'http://fixture'); path.pathname = path.pathname.replace(/^\/p\/[a-f0-9]{16}/, ''); reads.push(path.pathname + path.search);
  if (path.pathname === '/api/input-parents') return json({ items: [{ id: 1, branch: 'main' }, { id: 7, branch: 'work/7', goal: '另一个父' }] });
  if (path.pathname === '/api/inputs') {
    if (readFailure) throw Error('查询失败');
    if (deferredRead) await new Promise(resolve => { release = resolve; });
    const cursor = path.searchParams.get('cursor');
    return json(cursor ? { items: records.slice(1), next_cursor: null } : { items: records.slice(0, 1), next_cursor: records.length > 1 ? 'next' : null });
  }
  if (path.pathname.startsWith('/api/input/draft/')) return json(records.find(row => row.id === Number(path.pathname.split('/').at(-1))));
  if (path.pathname === '/api/action') {
    const call = JSON.parse(options.body); calls.push(call);
    if (deferred) await new Promise(resolve => { release = resolve; });
    if (failure) return { ok: false, json: async () => ({ error: failure }) };
    if (call.method === 'draft.update') {
      const row = records.find(row => row.id === call.params.id); Object.assign(row, call.params, { revision: row.revision + 1 }); return json(row);
    }
    if (call.method === 'draft.add') return json(draft(50, { ...call.params, revision: 1 }));
    if (call.method === 'management.submit') return json({ management: true, task: { id: 55 } });
    return json({ emitted: true, draft_id: call.params.draft_id || 50, revision: 5, dispatch: { state: 'queued' } });
  }
  throw Error(`Unexpected ${url}`);
} });
const { initComposer, appendToWorker, buffer } = await import('../../src/ui/web/assets/composer.js');
const { selectComposerMode, collapseComposer, resumeComposerDraft, currentEdit } = await import('../../src/ui/web/assets/composer-workspace.js');
const { appendInputBlocker, inputQueueText, inputWaitReason } = await import('../../src/ui/web/assets/worker-input.js');
const { addComposerReference, composerReferences } = await import('../../src/ui/web/assets/context-references.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const { resetUiState, ui } = await import('../../src/ui/web/assets/state.js');
const { registerNavigation } = await import('../../src/ui/web/assets/navigate.js');
const restore = registerNavigation({ refresh: async () => {} });
const type = value => { dom.node('input').value = value; dom.node('input').oninput(); };
const submit = () => dom.node('input').onkeydown({ key: 'Enter', ctrlKey: true, preventDefault() {} });
const reference = { version: 1, kind: 'text', target: {}, label: '引用', quote: '看到的文字' };
const reloadComposer = async () => { resetUiState(); dom.node('input').value = ''; dom.node('input-parent').value = ''; await initComposer(); };
beforeEach(async () => {
  resetUiState(); dom.localStorage.clear(); dom.location.pathname = '/'; calls.length = reads.length = 0; records = []; failure = deferred = deferredRead = readFailure = false; release = null;
  dom.node('input').value = ''; dom.node('input-parent').value = ''; await initComposer();
});
afterAll(() => { restore(); dom.restore(); });

test('every closed entry opens the category menu; collapse auto-saves references/settings/scroll and blurs', () => {
  expect(dom.node('input-form').hidden).toBe(true);
  dom.node('composer-launcher').click(); expect(dom.node('composer-menu').hidden).toBe(false);
  expect(dom.node('composer-menu-append').hidden).toBe(true); expect(calls).toHaveLength(0);
  dom.node('composer-menu-order').click(); expect(dom.node('input-form').hidden).toBe(false);
  type('新工作'); addComposerReference(reference); ui.composerProfile = { config_mode: 'pi' }; dom.node('input').scrollTop = 50;
  dom.node('composer-launcher').click(); expect(dom.node('input-form').hidden).toBe(true); expect(document.activeElement).toBe(dom.node('composer-launcher'));
  expect(dom.node('composer-launcher').dataset.pending).toBe('true');
  dom.node('composer-launcher').click(); expect(dom.node('composer-menu').hidden).toBe(false);
  dom.node('composer-menu-order').click(); expect(dom.node('input-form').hidden).toBe(false);
  expect(calls).toHaveLength(0);
  expect(dom.node('input').value).toBe('新工作'); expect(composerReferences()).toEqual([reference]); expect(ui.composerProfile).toEqual({ config_mode: 'pi' }); expect(dom.node('input').scrollTop).toBe(50);
});

test('compact admission summary exposes blockers and real waiting facts without disabling legal frozen input', () => {
  const status = dom.node('composer-target-status'), input = dom.node('input');
  for (const change of [{ archived: true }, { status: 'completed' }, { workspace_state: 'missing' }]) {
    const task = { ...worker(8), ...change }; selectComposerMode('append', task);
    expect(dom.node('input-form').dataset.expanded).toBe('false'); expect(status.hidden).toBe(false);
    expect(status.textContent).toBe(appendInputBlocker(task)); expect(input.disabled).toBe(true);
  }
  const frozen = { ...worker(8), freeze: { reason: '固定交付进行中' } };
  selectComposerMode('append', frozen); type('等待安全投递');
  expect(status.hidden).toBe(false); expect(status.textContent).toBe(inputWaitReason(frozen));
  expect(input.disabled).toBe(false); expect(dom.node('draft-commit').disabled).toBe(false);
  const queued = { ...frozen, input_queue: { buffered: 2, reason: '等待交付结束' } };
  selectComposerMode('append', queued); expect(status.textContent).toBe(inputQueueText(queued));
  expect(status.textContent).not.toContain('Ctrl'); expect(input.disabled).toBe(false);
  selectComposerMode('append', { ...worker(8), status: 'paused' }); expect(status.textContent).toContain('需开始 / 继续');
  selectComposerMode('order'); ui.composerParents[0].freeze = { reason: '父分支冻结' }; ui.syncComposer();
  expect(status.textContent).toBe('父分支冻结'); expect(input.disabled).toBe(false);
  selectComposerMode('management'); expect(status.hidden).toBe(true); expect(status.textContent).toBe('');
});

test('Escape returns focus to the launcher without changing text or stealing focus on later closed navigation', () => {
  selectComposerMode('order'); type('保留文字'); dom.node('input').focus();
  dom.node('input').onkeydown({ key: 'Escape', preventDefault() {} });
  expect(document.activeElement).toBe(dom.node('composer-launcher')); expect(dom.node('input-form').hidden).toBe(true); expect(dom.node('input').value).toBe('保留文字');
  dom.node('detail').focus(); collapseComposer(); expect(document.activeElement).toBe(dom.node('detail'));
});

test('mode and target changes isolate bodies, references and settings; new always defaults main', () => {
  selectComposerMode('order'); type('main 文本'); addComposerReference(reference);
  selectComposerMode('order', null, 'work/7'); expect(dom.node('input').value).toBe(''); type('父7的文本');
  selectComposerMode('management'); expect(dom.node('input').value).toBe(''); expect(composerReferences()).toEqual([]); type('管理文本');
  expect(() => addComposerReference(reference)).toThrow('暂不支持引用');
  selectComposerMode('append', worker(8)); type('追加8'); selectComposerMode('append', worker(9)); expect(dom.node('input').value).toBe(''); type('追加9');
  selectComposerMode('append', worker(8)); expect(dom.node('input').value).toBe('追加8');
  selectComposerMode('order'); expect(dom.node('input').value).toBe('main 文本'); expect(composerReferences()).toEqual([reference]); expect(dom.node('input-parent').value).toBe('');
  selectComposerMode('management'); expect(dom.node('input').value).toBe('管理文本'); expect(dom.node('input-buffer').hidden).toBe(true);
});

test('navigation and unrelated detail reads cannot change a pinned append target', async () => {
  ui.view = { id: 'task' }; ui.selected = 8; ui.composerTask = worker(8); appendToWorker(worker(8)); type('只给8');
  activateDetailView({ view: 'task', key: 'task-9' }); ui.selected = 9; ui.composerTask = worker(9); ui.syncComposer();
  expect(dom.node('input-form').hidden).toBe(true); expect(ui.composerAppendTarget.id).toBe(8);
  selectComposerMode('append', worker(8)); expect(dom.node('composer-mode-target').textContent).toContain('W8'); expect(dom.node('composer-mode-target').textContent).not.toContain('目标 9');
  ui.composerTask = null; ui.composerError = '另一个详情读取失败'; ui.syncComposer(); expect(dom.node('input').disabled).toBe(false);
  await submit(); expect(calls.at(-1).params.target_id).toBe(8);
});

test('resume scans all pages, skips unauthorized-to-edit states and restores full draft metadata', async () => {
  records = [draft(1, { parent_id: 7, branch: 'work/7' }), draft(2, { dispatch: { state: 'unknown' } }), draft(3, { dispatch: { state: 'queued' } }), draft(4, { input_id: 80 }), draft(5, { references: [reference], conditions: [{ kind: 'parent_quiet' }], exclusive: true })];
  selectComposerMode('order'); await resumeComposerDraft();
  expect(reads.some(url => url.includes('cursor=next'))).toBe(true); expect(currentEdit().saved.id).toBe(5); expect(composerReferences()).toEqual([reference]);
  expect(dom.node('draft-commit').textContent).toBe('按条件提交'); expect(dom.node('composer-condition-summary').textContent).toContain('父 Worker 静息');
  expect(dom.node('input-parent').disabled).toBe(true); type('完整修改'); await buffer();
  expect(calls).toHaveLength(1); expect(calls[0]).toMatchObject({ method: 'draft.update', params: { id: 5, expected_revision: 3, conditions: [{ kind: 'parent_quiet' }], exclusive: true } });
  expect(dom.node('input').value).toBe(''); expect(currentEdit().saved).toBeNull();
  selectComposerMode('order'); expect(dom.node('input').value).toBe('');
  await resumeComposerDraft(); expect(dom.node('input').value).toBe('完整修改'); await submit();
  expect(calls.at(-1)).toMatchObject({ method: 'input.emit', params: { draft_id: 5, expected_revision: 4 } }); expect(calls.some(call => call.method === 'draft.add')).toBe(false);
});

test('switching drafts keeps the previous local content; version conflicts do not fetch or overwrite it', async () => {
  records = [draft(1), draft(2)]; selectComposerMode('order'); type('未暂存');
  await resumeComposerDraft(false); await dom.node('composer-draft-list').querySelectorAll('button').find(node => node.textContent.startsWith('草稿 #1')).click();
  type('草稿1本地修改'); await resumeComposerDraft(false); await dom.node('composer-draft-list').querySelectorAll('button').find(node => node.textContent.startsWith('草稿 #2')).click();
  expect(dom.node('input').value).toBe('正文 2'); await resumeComposerDraft(false);
  dom.node('composer-draft-list').querySelectorAll('button').find(node => node.textContent.includes('本页未完成 · 草稿 #1')).click(); expect(dom.node('input').value).toBe('草稿1本地修改');
  failure = 'revision conflict'; const readCount = reads.filter(url => url.startsWith('/api/input/draft/')).length; await buffer();
  expect(dom.node('input').value).toBe('草稿1本地修改'); expect(currentEdit().saved.revision).toBe(3); expect(dom.node('error').textContent).toContain('revision conflict');
  expect(reads.filter(url => url.startsWith('/api/input/draft/')).length).toBe(readCount);
});

test('late draft reads do not replace typing, navigation, or a changed target', async () => {
  records = [draft(1)]; selectComposerMode('order'); deferredRead = true;
  const pending = resumeComposerDraft(); await until(() => release); type('请求中输入'); release(); await pending; expect(dom.node('input').value).toBe('请求中输入'); expect(currentEdit().saved).toBeUndefined();
  release = null; const other = resumeComposerDraft(); await until(() => release); selectComposerMode('management'); type('管理'); release(); await other; expect(dom.node('input').value).toBe('管理');
});

test('single flight, IME, failure retry identity and in-flight new edits are protected', async () => {
  selectComposerMode('order'); type('工作'); const input = dom.node('input');
  await input.onkeydown({ key: 'Enter', isComposing: true, ctrlKey: true, preventDefault() {} }); expect(calls).toHaveLength(0);
  deferred = true; const pending = submit(); await submit(); expect(calls).toHaveLength(1); type('新文字'); selectComposerMode('management'); expect(ui.composerManagement).toBe(false);
  release(); await pending; expect(input.value).toBe('新文字');
  deferred = false; failure = 'unknown transport'; await submit(); const key = calls.at(-1).params.client_request_id;
  selectComposerMode('management'); selectComposerMode('order'); await submit(); expect(calls.at(-1).params.client_request_id).toBe(key); expect(input.value).toBe('新文字');
});

test('append recovery matches Worker, and new edits after draft emit detach from the authorized identity', async () => {
  records = [draft(1, { mode: 'append', target_id: 9 }), draft(2, { mode: 'append', target_id: 8, conditions: [{ kind: 'worker_settled', worker_id: 7 }] })];
  selectComposerMode('append', worker(8)); await resumeComposerDraft(); expect(currentEdit().saved.id).toBe(2);
  deferred = true; const pending = submit(); await until(() => release); type('另一条追加'); release(); await pending;
  expect(dom.node('input').value).toBe('另一条追加'); expect(currentEdit().saved).toBeNull(); expect(dom.node('draft-commit').textContent).toBe('按条件提交');
  deferred = false; await buffer(); expect(calls.at(-1)).toMatchObject({ method: 'draft.add', params: { target_id: 8, content: '另一条追加', conditions: [{ kind: 'worker_settled', worker_id: 7 }] } });
});

test('management is an explicit independent destination: no project drafts/references and exact failed-request retry', async () => {
  selectComposerMode('order'); type('开发文本'); selectComposerMode('management'); type('管理文本'); failure = 'management unavailable';
  await submit(); expect(calls.at(-1).method).toBe('management.submit'); const request = calls.at(-1).params.client_request_id;
  expect(dom.node('input').value).toBe('管理文本'); expect(dom.node('composer-resume').hidden).toBe(true); expect(dom.node('composer-choose-draft').hidden).toBe(true);
  await buffer(); expect(calls).toHaveLength(1); selectComposerMode('order'); expect(dom.node('input').value).toBe('开发文本'); selectComposerMode('management');
  failure = false; await submit(); expect(calls.at(-1).params.client_request_id).toBe(request); expect(dom.node('input').value).toBe('');
});

test('late append ACK never reopens a panel collapsed by navigation; new settings protect in-flight edits', async () => {
  selectComposerMode('append', worker(8)); type('发给8'); deferred = true; const pending = submit();
  activateDetailView({ view: 'overview' }); release(); await pending; expect(dom.node('input-form').hidden).toBe(true);
  selectComposerMode('order'); type('新工作'); release = null; const next = submit(); ui.composerProfile = { config_mode: 'pi' }; release(); await next;
  expect(dom.node('input').value).toBe('新工作'); expect(ui.composerProfile).toEqual({ config_mode: 'pi' });
});

test('an interrupted history query is not reported as no drafts', async () => {
  records = [draft(1, { parent_id: 7 })]; selectComposerMode('order'); await resumeComposerDraft(); expect(deepText(dom.node('composer-draft-list'))).toContain('已查完');
  readFailure = true; await resumeComposerDraft(); expect(deepText(dom.node('composer-draft-list'))).toContain('未能确认'); expect(deepText(dom.node('composer-draft-list'))).not.toContain('已查完');
  collapseComposer(); expect(dom.node('composer-launcher').classList.contains('agent-call')).toBe(false);
});

test('browser auto-save survives reload for all modes and exact targets, without creating project drafts', async () => {
  selectComposerMode('order'); type('main 自动保存'); addComposerReference(reference);
  ui.composerProfile = { config_mode: 'pi' }; dom.node('input').scrollTop = 42;
  selectComposerMode('order', null, 'work/7'); type('父7');
  selectComposerMode('append', worker(8)); type('追加8');
  selectComposerMode('append', worker(9)); type('追加9');
  selectComposerMode('management'); type('管理自动保存'); collapseComposer();
  await reloadComposer();
  expect(dom.node('input-form').hidden).toBe(true);
  selectComposerMode('management'); expect(dom.node('input').value).toBe('管理自动保存');
  selectComposerMode('append', worker(8)); expect(dom.node('input').value).toBe('追加8');
  selectComposerMode('append', worker(9)); expect(dom.node('input').value).toBe('追加9');
  selectComposerMode('order', null, 'work/7'); expect(dom.node('input').value).toBe('父7');
  selectComposerMode('order'); expect(dom.node('input').value).toBe('main 自动保存');
  expect(composerReferences()).toEqual([reference]); expect(ui.composerProfile).toEqual({ config_mode: 'pi' }); expect(dom.node('input').scrollTop).toBe(42);
  type(''); dom.node('input').oninput();
  selectComposerMode('management'); type(''); collapseComposer(); await reloadComposer(); selectComposerMode('management'); expect(dom.node('input').value).toBe('');
  expect(calls).toHaveLength(0);
});

test('automatic browser edits are isolated by project identity', async () => {
  dom.location.pathname = '/p/aaaaaaaaaaaaaaaa/'; await reloadComposer(); selectComposerMode('order'); type('项目A'); collapseComposer();
  dom.location.pathname = '/p/bbbbbbbbbbbbbbbb/'; await reloadComposer(); selectComposerMode('order'); expect(dom.node('input').value).toBe(''); type('项目B'); collapseComposer();
  dom.location.pathname = '/p/aaaaaaaaaaaaaaaa/'; await reloadComposer(); selectComposerMode('order'); expect(dom.node('input').value).toBe('项目A');
  expect(calls).toHaveLength(0);
});

test('explicit button or new-work Enter stash clears automatic recovery, including resumed drafts; append Enter still emits', async () => {
  selectComposerMode('order'); type('Enter 暂存'); collapseComposer(); selectComposerMode('order');
  await dom.node('input').onkeydown({ key: 'Enter', preventDefault() {} });
  expect(calls.at(-1).method).toBe('draft.add'); expect(dom.node('input').value).toBe('');
  await reloadComposer(); selectComposerMode('order'); expect(dom.node('input').value).toBe('');
  records = [draft(6)]; await resumeComposerDraft(); type('更新原草稿'); collapseComposer(); await reloadComposer(); selectComposerMode('order');
  expect(currentEdit().saved.id).toBe(6); expect(dom.node('input').value).toBe('更新原草稿');
  await buffer(); expect(calls.at(-1)).toMatchObject({ method: 'draft.update', params: { id: 6, expected_revision: 3 } });
  await reloadComposer(); selectComposerMode('order'); expect(dom.node('input').value).toBe(''); expect(currentEdit().saved).toBeUndefined();
  selectComposerMode('append', worker(8)); type('直接提交追加'); collapseComposer(); selectComposerMode('append', worker(8));
  await dom.node('input').onkeydown({ key: 'Enter', preventDefault() {} });
  expect(calls.at(-1)).toMatchObject({ method: 'input.emit', params: { target_id: 8, mode: 'append' } });
  await reloadComposer(); selectComposerMode('append', worker(8)); expect(dom.node('input').value).toBe('');
});

test('failed stash and in-flight edits stay recoverable; late success clears only its acknowledged snapshot', async () => {
  selectComposerMode('order'); type('保存失败仍保留'); failure = '暂存失败'; await buffer(); collapseComposer();
  await reloadComposer(); selectComposerMode('order'); expect(dom.node('input').value).toBe('保存失败仍保留');
  failure = false; deferred = true; const pending = buffer(); type('请求中的新编辑'); collapseComposer(); release(); await pending;
  expect(currentEdit().saved.id).toBe(50);
  await reloadComposer(); selectComposerMode('order'); expect(dom.node('input').value).toBe('请求中的新编辑'); expect(currentEdit().saved.id).toBe(50);
  deferred = false; records = [draft(50, { content: '保存失败仍保留', revision: 1 })]; await buffer();
  await reloadComposer(); selectComposerMode('order'); expect(dom.node('input').value).toBe('');
});

test('browser storage failures are visible and never discard the active text', () => {
  selectComposerMode('order'); type('不能丢失');
  const set = dom.localStorage.setItem; dom.localStorage.setItem = () => { throw Error('quota exceeded'); };
  try { collapseComposer(); expect(dom.node('input').value).toBe('不能丢失'); expect(dom.node('error').textContent).toContain('自动保存失败'); }
  finally { dom.localStorage.setItem = set; collapseComposer(); }
});
