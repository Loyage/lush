import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { until } from '../helpers.js';
const calls = [], reads = [];
let records, failure, deferred, release, deferredRead, readFailure, deferredWorker, workerReadFailure, returnedWorker;
const json = value => ({ ok: true, json: async () => structuredClone(value) });
const draft = (id, fields = {}) => ({ kind: 'draft', id, draft_number: id + 100, mode: 'order', content: `正文 ${id}`, parent_id: 1, branch: 'main', revision: 3, references: [], status: 'draft', ...fields });
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
  if (path.pathname.startsWith('/api/worker/')) {
    if (deferredWorker) await new Promise(resolve => { release = resolve; });
    if (workerReadFailure) throw Error('目标读取失败');
    return json(returnedWorker || worker(Number(path.pathname.split('/').at(-1))));
  }
  if (path.pathname === '/api/action') {
    const call = JSON.parse(options.body); calls.push(call);
    if (deferred) await new Promise(resolve => { release = resolve; });
    if (failure) return { ok: false, json: async () => ({ error: failure }) };
    if (call.method === 'draft.update') {
      const row = records.find(row => row.id === call.params.id); Object.assign(row, call.params, { revision: row.revision + 1 }); return json(row);
    }
    if (call.method === 'draft.remove') { records = records.filter(row => row.id !== call.params.id); return json({ id: call.params.id }); }
    if (call.method === 'draft.add') return json(draft(50, { ...call.params, revision: 1 }));
    if (call.method === 'management.submit') return json({ management: true, task: { id: 55 } });
    return json({ emitted: true, draft_id: call.params.draft_id || 50, revision: 5, dispatch: { state: 'queued' } });
  }
  throw Error(`Unexpected ${url}`);
} });
const { initComposer, appendToWorker, buffer } = await import('../../src/ui/web/assets/composer.js');
const { selectComposerMode, collapseComposer, resumeComposerDraft, currentEdit, removeComposerDraft } = await import('../../src/ui/web/assets/composer-workspace.js');
const { appendInputBlocker, inputQueueText, inputWaitReason } = await import('../../src/ui/web/assets/worker-input.js');
const { addComposerReference, composerReferences } = await import('../../src/ui/web/assets/context-references.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const { resetUiState, ui } = await import('../../src/ui/web/assets/state.js');
const { registerNavigation } = await import('../../src/ui/web/assets/navigate.js');
const restore = registerNavigation({ refresh: async () => {} });
const type = value => { dom.node('input').value = value; dom.node('input').oninput(); };
const submit = () => dom.node('input').onkeydown({ key: 'Enter', ctrlKey: true, preventDefault() {} });
const arrow = async (key = 'ArrowUp', fields = {}) => {
  let prevented = false;
  await dom.node('input').onkeydown({ key, ...fields, preventDefault() { prevented = true; } });
  return prevented;
};
const confirmRemoval = async (accepted = true) => {
  const pending = removeComposerDraft();
  await until(() => dom.node('modal').querySelector('.modal-confirm'));
  await dom.node('modal').querySelector(accepted ? '.modal-confirm' : '.modal-cancel').click();
  await pending;
};
const reference = { version: 1, kind: 'text', target: {}, label: '引用', quote: '看到的文字' };
const reloadComposer = async () => { resetUiState(); dom.node('input').value = ''; dom.node('input-parent').value = ''; await initComposer(); };
const pendingRows = mode => dom.node(`composer-pending-${mode}`).querySelectorAll('button');
const openMenu = () => { collapseComposer(); dom.node('composer-launcher').click(); };
const { scopedKey, readPref, writePref, PREF_DEFS } = await import('../../src/ui/web/assets/prefs.js');
beforeEach(async () => {
  resetUiState(); dom.localStorage.clear(); dom.location.pathname = '/'; calls.length = reads.length = 0; records = []; failure = deferred = deferredRead = readFailure = false; release = null;
  deferredWorker = workerReadFailure = false; returnedWorker = null;
  dom.node('input').value = ''; dom.node('input-parent').value = ''; await initComposer();
});
afterAll(() => { restore(); dom.restore(); });

test('input height drag/keyboard survives collapse, mode changes and reboot without affecting drafts', async () => {
  const input = dom.node('input'), handle = dom.node('composer-resize');
  const emit = (type, fields = {}) => { for (const handler of [...(handle.listeners[type] || [])]) handler({ pointerId: 1, button: 0, clientY: 300, preventDefault() {}, ...fields }); };
  input.getBoundingClientRect = () => ({ height: parseFloat(input.style['--composer-input-height']) || 252 });
  let captured = null;
  handle.setPointerCapture = id => { captured = id; }; handle.hasPointerCapture = id => captured === id;
  handle.releasePointerCapture = () => { captured = null; };
  try {
    selectComposerMode('order');
    emit('pointerdown', { button: 2 }); emit('pointermove', { clientY: 220 }); expect(readPref('composerHeight')).toBeNull();
    emit('pointerdown'); emit('pointermove', { pointerId: 2, clientY: 100 }); expect(input.style['--composer-input-height']).toBe('');
    emit('pointermove', { clientY: 220 }); expect(input.style['--composer-input-height']).toBe('332px');
    expect(readPref('composerHeight')).toBeNull(); emit('pointerup'); expect(readPref('composerHeight')).toBe(332); expect(captured).toBeNull();
    collapseComposer(); selectComposerMode('management'); selectComposerMode('order');
    expect(input.style['--composer-input-height']).toBe('332px');
    await reloadComposer(); expect(input.style['--composer-input-height']).toBe('332px');
    expect(handle.listeners.pointerdown).toHaveLength(1);
    emit('pointerdown'); emit('pointermove', { clientY: 900 }); expect(input.style['--composer-input-height']).toBe('64px');
    emit('pointercancel'); expect(input.style['--composer-input-height']).toBe('332px'); expect(readPref('composerHeight')).toBe(332);
    emit('keydown', { key: 'ArrowUp' }); expect(readPref('composerHeight')).toBe(348);
    emit('keydown', { key: 'ArrowDown', shiftKey: true }); expect(readPref('composerHeight')).toBe(284);
    emit('keydown', { key: 'Home' }); expect(readPref('composerHeight')).toBe(64);
    emit('keydown', { key: 'End' }); expect(readPref('composerHeight')).toBe(450);
    emit('pointerdown'); emit('pointermove', { clientY: -9000 }); emit('pointerup'); expect(readPref('composerHeight')).toBe(450);
    expect(calls).toHaveLength(0); expect(dom.node('composer-launcher').dataset.pending).toBe('false');
  } finally {
    delete input.getBoundingClientRect; delete handle.setPointerCapture; delete handle.hasPointerCapture; delete handle.releasePointerCapture;
  }
});

test('input height uses validated project-local preferences and tolerates unavailable storage', () => {
  for (const raw of ['', 'NaN', 'Infinity', '-1', '63', '4097', '{}']) expect(PREF_DEFS.composerHeight.parse(raw)).toBeNull();
  dom.location.pathname = '/p/aaaaaaaaaaaaaaaa/'; writePref('composerHeight', 240);
  dom.location.pathname = '/p/bbbbbbbbbbbbbbbb/'; expect(readPref('composerHeight')).toBeNull();
  writePref('composerHeight', 180);
  dom.location.pathname = '/p/aaaaaaaaaaaaaaaa/'; expect(readPref('composerHeight')).toBe(240);
  const original = dom.localStorage.setItem;
  try {
    dom.localStorage.setItem = () => { throw Error('blocked'); };
    expect(() => writePref('composerHeight', 300)).not.toThrow();
  } finally { dom.localStorage.setItem = original; writePref('composerHeight', 300); }
  expect(readPref('composerHeight')).toBe(300);
});

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

test('empty-editor arrows traverse all matching editable drafts and return to the original empty editor', async () => {
  records = [draft(10, { branch: 'work/7', parent_id: 7 }), draft(9, { dispatch: { state: 'queued' } }),
    draft(8, { references: [reference], conditions: [{ kind: 'parent_quiet' }], exclusive: true }), draft(7)];
  selectComposerMode('order'); ui.composerProfile = { config_mode: 'pi' };
  expect(dom.node('input-buffer').textContent).toBe('暂存为草稿');
  expect(await arrow('ArrowDown')).toBe(true); expect(reads.filter(url => url.startsWith('/api/inputs'))).toHaveLength(0);
  await arrow(); expect(currentEdit().saved.id).toBe(8); expect(composerReferences()).toEqual([reference]);
  expect(dom.node('input-buffer').textContent).toBe('保存草稿'); expect(dom.node('draft-commit').textContent).toBe('按条件提交');
  expect(reads.some(url => url.includes('cursor=next'))).toBe(true);
  expect(dom.node('composer-draft-status').textContent).toContain('草稿 #108');
  expect(dom.node('composer-draft-status').textContent).not.toContain('草稿 #8');
  await arrow(); expect(currentEdit().saved.id).toBe(7);
  await arrow(); expect(currentEdit().saved.id).toBe(7); // Oldest boundary does not wrap.
  await arrow('ArrowDown'); expect(currentEdit().saved.id).toBe(8);
  await arrow('ArrowDown'); expect(dom.node('input').value).toBe(''); expect(currentEdit().saved).toBeUndefined();
  expect(composerReferences()).toEqual([]); expect(ui.composerProfile).toEqual({ config_mode: 'pi' });
  await arrow(); expect(currentEdit().saved.id).toBe(8); expect(calls).toHaveLength(0);
});

test('draft arrows leave edited text, IME, modifiers, management and attachments alone', async () => {
  records = [draft(1)]; selectComposerMode('order');
  for (const fields of [{ isComposing: true }, { keyCode: 229 }, { shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }])
    expect(await arrow('ArrowUp', fields)).toBe(false);
  dom.node('input').oncompositionstart(); expect(await arrow()).toBe(false); dom.node('input').oncompositionend();
  ui.composerSubmitting = true; expect(await arrow()).toBe(false); ui.composerSubmitting = false;
  addComposerReference(reference); expect(await arrow()).toBe(false);
  selectComposerMode('management'); expect(await arrow()).toBe(false);
  selectComposerMode('order', null, 'work/7'); type('普通多行\n正文'); expect(await arrow()).toBe(false);
  type(''); await arrow(); expect(dom.node('input').value).toBe(''); // No matching drafts.
  selectComposerMode('append', { ...worker(8), archived: true }); expect(await arrow()).toBe(false);
  selectComposerMode('append', worker(8)); records = [draft(2, { mode: 'append', target_id: 8 }), draft(3, { mode: 'append', target_id: 9 })];
  await arrow(); expect(currentEdit().saved.id).toBe(2);
  type('编辑后的草稿'); expect(await arrow('ArrowDown')).toBe(false); expect(await arrow()).toBe(false);
  expect(dom.node('input').value).toBe('编辑后的草稿'); expect(calls).toHaveLength(0);
});

test('arrow recall is single-flight and late responses cannot replace typing, navigation or another target', async () => {
  records = [draft(1)]; selectComposerMode('order'); deferredRead = true;
  const pending = arrow(); await until(() => release); const repeated = arrow(); // The second handler shares the pending read.
  deferredRead = false; release(); await Promise.all([pending, repeated]);
  expect(currentEdit().saved.id).toBe(1);
  await arrow('ArrowDown'); release = null; deferredRead = true;
  // A fresh destination starts a fresh query rather than reusing another destination cursor.
  selectComposerMode('order', null, 'work/7'); records = [draft(2, { parent_id: 7, branch: 'work/7' })];
  const late = arrow(); await until(() => release); type('在途新文字'); deferredRead = false; release(); await late;
  expect(dom.node('input').value).toBe('在途新文字'); expect(currentEdit().saved).toBeUndefined();
  type(''); release = null; deferredRead = true;
  const collapsed = arrow(); await until(() => release); collapseComposer(); deferredRead = false; release(); await collapsed;
  expect(dom.node('input-form').hidden).toBe(true); expect(dom.node('input').value).toBe('');
  selectComposerMode('order', null, 'work/7'); release = null; deferredRead = true;
  const changed = arrow(); await until(() => release); selectComposerMode('management'); deferredRead = false; release(); await changed;
  expect(ui.composerManagement).toBe(true); expect(currentEdit().saved).toBeUndefined();
});

test('arrow recall rechecks cached draft eligibility and reports read errors without discarding the current draft', async () => {
  records = [draft(1), draft(2)]; selectComposerMode('order'); await arrow(); await arrow();
  records[0].dispatch = { state: 'queued' }; await arrow('ArrowDown');
  expect(currentEdit().saved.id).toBe(2); expect(dom.node('input').value).toBe('正文 2'); expect(dom.node('error').textContent).toContain('已授权');
  selectComposerMode('order', null, 'work/7'); readFailure = true; await arrow();
  expect(dom.node('input').value).toBe(''); expect(dom.node('error').textContent).toContain('草稿读取失败');
  readFailure = false; records = [draft(3, { parent_id: 7, branch: 'work/7' })]; await arrow(); expect(currentEdit().saved.id).toBe(3);
});

test('composer delete confirms the display number but removes the exact internal identity and clears browser recovery only on success', async () => {
  expect(dom.node('composer-remove-draft').hidden).toBe(true);
  records = [draft(1, { references: [reference], conditions: [{ kind: 'parent_quiet' }], exclusive: true }), draft(2)];
  selectComposerMode('order'); await arrow(); type('尚未保存的修改'); collapseComposer(); selectComposerMode('order');
  expect(dom.node('composer-remove-draft').hidden).toBe(false);
  expect(dom.node('composer-remove-draft').classList.contains('agent-call')).toBe(false);
  await confirmRemoval(false); expect(calls).toHaveLength(0); expect(dom.node('input').value).toBe('尚未保存的修改');
  const pending = dom.node('composer-remove-draft').onclick(); await until(() => dom.node('modal').querySelector('.modal-confirm'));
  expect(deepText(dom.node('modal'))).toContain('删除草稿 #101？');
  expect(dom.node('composer-remove-draft').disabled).toBe(true);
  await dom.node('modal').querySelector('.modal-confirm').click(); await pending;
  expect(calls).toEqual([{ method: 'draft.remove', params: { id: 1, expected_revision: 3 } }]);
  expect(dom.node('input').value).toBe(''); expect(currentEdit().saved).toBeNull(); expect(composerReferences()).toEqual([]);
  expect(dom.node('composer-remove-draft').hidden).toBe(true); expect(dom.node('composer-condition-summary').hidden).toBe(true);
  await reloadComposer(); selectComposerMode('order'); expect(dom.node('input').value).toBe(''); expect(currentEdit().saved).toBeUndefined();
  await arrow(); expect(currentEdit().saved.id).toBe(2); // The deleted draft is not kept in a stale keyboard cursor.
});

test('v2 continuation menu keeps numbered sibling edits and removes only the deleted draft across reload', async () => {
  records = [draft(1), draft(2)]; selectComposerMode('order');
  await resumeComposerDraft(false); await dom.node('composer-draft-list').querySelectorAll('button').find(row => row.textContent.startsWith('草稿 #102')).click();
  type('另一条草稿的本地修改');
  await resumeComposerDraft(); openMenu();
  expect(pendingRows('order')).toHaveLength(2);
  expect(deepText(dom.node('composer-pending-order'))).toContain('项目已暂存 · 草稿 #101');
  expect(deepText(dom.node('composer-pending-order'))).toContain('有本地修改 · 草稿 #102');
  pendingRows('order').find(row => row.dataset.editKey === 'draft:1').click(); await confirmRemoval(); openMenu();
  expect(pendingRows('order')).toHaveLength(1); expect(pendingRows('order')[0].dataset.editKey).toBe('draft:2');
  expect(dom.node('composer-launcher').dataset.pending).toBe('true');
  await reloadComposer(); openMenu(); expect(pendingRows('order')).toHaveLength(1);
  pendingRows('order')[0].click(); expect(currentEdit().saved.id).toBe(2); expect(dom.node('input').value).toBe('另一条草稿的本地修改');
  await confirmRemoval(); openMenu(); expect(pendingRows('order')).toHaveLength(0); expect(dom.node('composer-launcher').dataset.pending).toBe('false');
  await reloadComposer(); openMenu(); expect(pendingRows('order')).toHaveLength(0);
});

test('successful deletion reports a browser-cache failure rather than claiming the old recovery was cleared', async () => {
  records = [draft(1)]; selectComposerMode('order'); await arrow(); collapseComposer(); selectComposerMode('order');
  const set = dom.localStorage.setItem; dom.localStorage.setItem = () => { throw Error('quota exceeded'); };
  try {
    await confirmRemoval(); expect(records).toEqual([]); expect(dom.node('input').value).toBe(''); expect(currentEdit().saved).toBeNull();
    expect(dom.node('error').textContent).toContain('旧缓存可能仍存在');
    expect(dom.node('error').textContent).not.toContain('浏览器恢复内容已清空');
  } finally { dom.localStorage.setItem = set; }
});

test('delete failure keeps draft version, unsaved body and browser recovery; confirmation follows neither navigation nor a new target', async () => {
  records = [draft(1)]; selectComposerMode('order'); await arrow(); type('不能丢'); failure = 'revision conflict';
  await confirmRemoval(); expect(currentEdit().saved.revision).toBe(3); expect(dom.node('input').value).toBe('不能丢');
  expect(dom.node('error').textContent).toContain('revision conflict'); expect(ui.composerSubmitting).toBe(false);
  collapseComposer(); await reloadComposer(); selectComposerMode('order'); expect(dom.node('input').value).toBe('不能丢');
  failure = false; calls.length = 0;
  const pending = removeComposerDraft(); await until(() => dom.node('modal').querySelector('.modal-confirm'));
  activateDetailView({ view: 'overview' });
  await dom.node('modal').querySelector('.modal-confirm').click(); await pending;
  expect(calls).toHaveLength(0); expect(dom.node('input-form').hidden).toBe(true); expect(currentEdit().saved.id).toBe(1);
  selectComposerMode('management'); await removeComposerDraft(); expect(dom.node('composer-remove-draft').hidden).toBe(true);
});

test('delete is single-flight and preserves new edits as a detached input without reopening navigation', async () => {
  records = [draft(1, { mode: 'append', target_id: 8, conditions: [{ kind: 'parent_quiet' }], exclusive: true })];
  selectComposerMode('append', worker(8)); await arrow(); deferred = true;
  const pending = removeComposerDraft(); await until(() => dom.node('modal').querySelector('.modal-confirm'));
  type('确认期间的新输入'); await removeComposerDraft(); // No second dialog or request.
  await dom.node('modal').querySelector('.modal-confirm').click(); await until(() => release);
  type('删除请求期间的新输入'); await submit(); selectComposerMode('management'); expect(ui.composerManagement).toBe(false);
  activateDetailView({ view: 'overview' }); release(); await pending;
  expect(calls).toHaveLength(1); expect(currentEdit().saved).toBeNull(); expect(dom.node('input').value).toBe('删除请求期间的新输入');
  expect(dom.node('input-form').hidden).toBe(true); expect(ui.composerSubmitting).toBe(false);
  await reloadComposer(); selectComposerMode('append', worker(8)); expect(dom.node('input').value).toBe('删除请求期间的新输入');
  expect(currentEdit().saved).toBeNull(); deferred = false; await buffer();
  expect(calls.at(-1)).toMatchObject({ method: 'draft.add', params: { target_id: 8, content: '删除请求期间的新输入', conditions: [{ kind: 'parent_quiet' }], exclusive: true } });
});

test('switching drafts keeps the previous local content; version conflicts do not fetch or overwrite it', async () => {
  records = [draft(1), draft(2)]; selectComposerMode('order'); type('未暂存');
  await resumeComposerDraft(false); await dom.node('composer-draft-list').querySelectorAll('button').find(node => node.textContent.startsWith('草稿 #101')).click();
  type('草稿1本地修改'); await resumeComposerDraft(false); await dom.node('composer-draft-list').querySelectorAll('button').find(node => node.textContent.startsWith('草稿 #102')).click();
  expect(dom.node('input').value).toBe('正文 2'); await resumeComposerDraft(false);
  dom.node('composer-draft-list').querySelectorAll('button').find(node => node.textContent.includes('本页未完成 · 草稿 #101')).click(); expect(dom.node('input').value).toBe('草稿1本地修改');
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

test('legacy draft labels remain explicit record ids, not new display numbers', async () => {
  records = [draft(42, { draft_number: null })]; selectComposerMode('order'); await resumeComposerDraft(false);
  const choice = dom.node('composer-draft-list').querySelectorAll('button').find(node => node.textContent.startsWith('草稿记录 #42'));
  expect(choice).toBeDefined(); await choice.click();
  expect(currentEdit().saved.id).toBe(42); expect(dom.node('composer-draft-status').textContent).toContain('草稿记录 #42');
  type('修改旧草稿'); await buffer(); expect(calls.at(-1).params.id).toBe(42);
  expect(dom.node('error').textContent).toContain('草稿记录 #42');
});

test('browser storage failures are visible and never discard the active text', () => {
  selectComposerMode('order'); type('不能丢失');
  const set = dom.localStorage.setItem; dom.localStorage.setItem = () => { throw Error('quota exceeded'); };
  try { collapseComposer(); expect(dom.node('input').value).toBe('不能丢失'); expect(dom.node('error').textContent).toContain('自动保存失败'); }
  finally { dom.localStorage.setItem = set; collapseComposer(); }
});

test('unfinished indicators follow live content, not expansion/settings, and show each category with an exact continuation', async () => {
  selectComposerMode('order'); ui.composerExpanded = true; ui.composerProfile = { config_mode: 'pi' }; ui.syncComposer(); openMenu();
  expect(dom.node('composer-launcher').dataset.pending).toBe('false'); expect(pendingRows('order')).toHaveLength(0);
  selectComposerMode('order'); type('只有正文'); expect(dom.node('composer-launcher').dataset.pending).toBe('true');
  expect(dom.node('composer-launcher').getAttribute('aria-label')).toContain('1 条未完成输入');
  type(''); expect(dom.node('composer-launcher').dataset.pending).toBe('false');
  addComposerReference(reference); expect(dom.node('composer-launcher').dataset.pending).toBe('true');
  selectComposerMode('order', null, 'work/7'); type('父7的工作');
  selectComposerMode('append', worker(8)); type('给8'); selectComposerMode('append', worker(9)); type('给9');
  selectComposerMode('management'); type('管理需求'); openMenu();
  for (const [mode, count] of [['order', 2], ['append', 2], ['management', 1]]) {
    expect(dom.node(`composer-menu-${mode}`).dataset.pending).toBe('true'); expect(pendingRows(mode)).toHaveLength(count);
    expect(dom.node(`composer-menu-${mode}`).getAttribute('aria-label')).toContain(`${count} 条未完成`);
  }
  expect(deepText(dom.node('composer-pending-order'))).toContain('1 条引用');
  expect(deepText(dom.node('composer-pending-management'))).toContain('已保留在本浏览器');
  pendingRows('append').find(row => row.dataset.editKey === 'append:8').click();
  expect(dom.node('input').value).toBe('给8'); expect(ui.composerAppendTarget.id).toBe(8); expect(dom.node('input-form').hidden).toBe(false);
  openMenu(); expect(dom.node('composer-launcher').dataset.pending).toBe('true'); // Merely viewing is not acknowledgment.
  pendingRows('order').find(row => row.dataset.editKey === 'order:work/7').click();
  expect(dom.node('input').value).toBe('父7的工作'); expect(dom.node('input-parent').value).toBe('work/7'); expect(calls).toHaveLength(0);
});

test('reload discovers all targets and multiple same-target drafts, while restoration rechecks cached Worker metadata', async () => {
  records = [draft(1), draft(2)]; selectComposerMode('order'); type('独立本地编辑');
  await resumeComposerDraft(false); await dom.node('composer-draft-list').querySelectorAll('button').find(node => node.textContent.startsWith('草稿 #101')).click(); type('草稿1修改');
  await resumeComposerDraft(false); await dom.node('composer-draft-list').querySelectorAll('button').find(node => node.textContent.startsWith('草稿 #102')).click();
  selectComposerMode('append', { ...worker(8), worker_number: 'W88-2', auto_title: '明确的编号' }); type('原目标8');
  selectComposerMode('append', worker(9)); type('原目标9'); selectComposerMode('management'); type('管理'); collapseComposer();
  await reloadComposer(); dom.node('composer-launcher').click();
  expect(pendingRows('order')).toHaveLength(3); expect(pendingRows('append')).toHaveLength(2); expect(pendingRows('management')).toHaveLength(1);
  expect(dom.node('composer-menu-append').hidden).toBe(true); expect(dom.node('composer-pending-append-summary').hidden).toBe(false);
  expect(deepText(dom.node('composer-pending-order'))).toContain('项目已暂存 · 草稿 #102');
  expect(deepText(dom.node('composer-pending-order'))).toContain('有本地修改 · 草稿 #101');
  const row = pendingRows('append').find(row => row.dataset.editKey === 'append:8'); expect(row.getAttribute('aria-label')).toContain('W88-2');
  deferredWorker = true; row.click(); await until(() => release);
  expect(dom.node('input').value).toBe('原目标8'); expect(dom.node('input').disabled).toBe(true); expect(dom.node('draft-commit').disabled).toBe(true);
  returnedWorker = { ...worker(8), worker_number: 'W88-2', archived: true }; release();
  await until(() => dom.node('composer-target-status').textContent.includes('分支已归档'));
  expect(dom.node('input').disabled).toBe(true); expect(ui.composerAppendTarget.id).toBe(8);
  openMenu(); pendingRows('order').find(row => row.dataset.editKey === 'draft:1').click();
  expect(dom.node('input').value).toBe('草稿1修改'); expect(currentEdit().saved.id).toBe(1); expect(currentEdit().saved.revision).toBe(3);
  expect(calls).toHaveLength(0);
});

test('late or failed cached-target reads never replace another destination or enable an unverified target', async () => {
  selectComposerMode('append', worker(8)); type('目标8'); selectComposerMode('management'); type('管理'); collapseComposer();
  await reloadComposer(); openMenu(); deferredWorker = true;
  pendingRows('append')[0].click(); await until(() => release); selectComposerMode('management'); release();
  await Promise.resolve(); await Promise.resolve(); expect(ui.composerManagement).toBe(true); expect(dom.node('input').value).toBe('管理');
  deferredWorker = false; workerReadFailure = true; openMenu(); pendingRows('append')[0].click();
  await until(() => dom.node('composer-target-status').textContent.includes('原目标读取失败'));
  expect(dom.node('input').value).toBe('目标8'); expect(dom.node('input').disabled).toBe(true); expect(calls).toHaveLength(0);
  workerReadFailure = false; returnedWorker = worker(9); openMenu(); pendingRows('append')[0].click();
  await until(() => dom.node('composer-target-status').textContent.includes('身份不匹配')); expect(ui.composerAppendTarget.id).toBe(8);
  returnedWorker = worker(8); openMenu(); pendingRows('append')[0].click(); await until(() => !dom.node('input').disabled);
  expect(dom.node('input').value).toBe('目标8'); expect(calls).toHaveLength(0);
});

test('legacy browser snapshots are discovered by exact project scope and consumed edits never resurrect them', async () => {
  dom.location.pathname = '/p/aaaaaaaaaaaaaaaa/';
  const legacy = (destination, content) => dom.localStorage.setItem(scopedKey(`lush.composer.edit.v1:${encodeURIComponent(destination)}`), JSON.stringify({ version: 1, content, references: [] }));
  legacy('order:work/7', '旧父7'); legacy('append:8', '旧追加8'); legacy('management', '旧管理');
  dom.localStorage.setItem('lush.composer.edit.v1:management:bbbbbbbbbbbbbbbb', JSON.stringify({ version: 1, content: '另一个项目', references: [] }));
  await reloadComposer(); openMenu();
  expect(pendingRows('order')).toHaveLength(1); expect(pendingRows('append')).toHaveLength(1); expect(pendingRows('management')).toHaveLength(1);
  expect(deepText(dom.node('composer-pending-management'))).not.toContain('另一个项目');
  pendingRows('order')[0].click(); expect(dom.node('input').value).toBe('旧父7'); await buffer(); collapseComposer();
  await reloadComposer(); openMenu(); expect(pendingRows('order')).toHaveLength(0); expect(pendingRows('append')).toHaveLength(1);
  dom.location.pathname = '/p/bbbbbbbbbbbbbbbb/'; await reloadComposer(); openMenu();
  expect(pendingRows('append')).toHaveLength(0); expect(deepText(dom.node('composer-pending-management'))).toContain('另一个项目');
});

test('failed persistence is explicit on continuation rows and successful stash clears only its own indicator', async () => {
  selectComposerMode('management'); type('保留管理'); selectComposerMode('order'); type('要暂存的工作');
  const set = dom.localStorage.setItem; dom.localStorage.setItem = () => { throw Error('quota'); };
  try {
    openMenu(); expect(pendingRows('order')[0].getAttribute('aria-label')).toContain('自动保存失败');
    expect(dom.node('composer-launcher').dataset.pending).toBe('true');
  } finally { dom.localStorage.setItem = set; }
  pendingRows('order')[0].click(); await buffer(); openMenu();
  expect(dom.node('composer-menu-order').dataset.pending).toBe('false'); expect(pendingRows('order')).toHaveLength(0);
  expect(dom.node('composer-menu-management').dataset.pending).toBe('true'); expect(pendingRows('management')).toHaveLength(1);
  pendingRows('management')[0].click(); type(''); openMenu(); expect(dom.node('composer-launcher').dataset.pending).toBe('false');
});
