import { test, expect, afterAll } from 'bun:test';
import { repo, until } from '../helpers.js';
import { fetch as httpFetch, setup } from './harness.js';
import { installDom, deepText } from '../dom-stub.js';

// Drive the actual UI modules against the real temporary HTTP/RPC/SQLite/Git stack, not a permissive API mock.
let fixture;
const dom = installDom({ fetch: (url, options) => httpFetch(fixture.url + url, options) });
const { ui, resetUiState } = await import('../../src/ui/web/assets/state.js');
const { initComposer } = await import('../../src/ui/web/assets/composer.js');
const { loadDetail } = await import('../../src/ui/web/assets/detail.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const { openInputs } = await import('../../src/ui/web/assets/render-inputs.js');
const { registerNavigation } = await import('../../src/ui/web/assets/navigate.js');
const { setComposerReferences } = await import('../../src/ui/web/assets/context-references.js');
const { renderNoticeBanner } = await import('../../src/ui/web/assets/notice-banner.js');
const { renderNotices } = await import('../../src/ui/web/assets/render-notices.js');
afterAll(() => dom.restore());
const root = () => dom.node('detail');
const btn = (label, host = root()) => [...host.querySelectorAll('button'), ...host.querySelectorAll('a')].find(node => node.textContent === label || node.getAttribute('aria-label')?.endsWith(`：${label}`));

test('真实 API：详情默认新建，显式追加 Enter 仅发消息，ACK自动恢复独立创建', async () => {
  fixture = await setup(); fixture.project.stopping = true; await repo(fixture.root);
  const restore = registerNavigation({ refresh: async () => {}, detail: loadDetail });
  try {
    resetUiState(); dom.node('input').value = ''; dom.node('input-parent').value = '';
    await initComposer();
    const { task } = await fixture.project.order('初始要求', 'main', [], null, false);
    await loadDetail(task.id);
    const before = ['tasks', 'inputs', 'drafts'].map(table => fixture.store.all(`SELECT * FROM ${table}`).length);
    const input = dom.node('input'); expect(dom.node('input-form').dataset.mode).toBe('create');
    expect(input.placeholder).toContain('在 main 下创建子 Worker');
    btn('向该 Worker 追加输入').onclick();
    expect(input.placeholder).toContain(`追加给 Worker ${task.worker_number ?? `#${task.id}`}`);
    expect(input.placeholder).toContain('需开始 / 继续');
    input.value = '后续要求'; input.oninput(); await input.onkeydown({ key: 'Enter', preventDefault() {} });
    expect(input.value).toBe(''); expect(fixture.store.task(task.id).status).toBe('paused');
    expect(fixture.store.all('SELECT * FROM messages WHERE task_id = ? AND sender_id IS NULL', task.id).at(-1).body).toBe('后续要求');
    expect(['tasks', 'inputs', 'drafts'].map(table => fixture.store.all(`SELECT * FROM ${table}`).length)).toEqual(before);
    expect(dom.node('input-form').dataset.mode).toBe('create');
    expect(dom.node('composer-reset').hidden).toBe(true);
    input.value = '详情中独立新建'; input.oninput();
    await input.onkeydown({ key: 'Enter', ctrlKey: true, preventDefault() {} });
    const independent = fixture.store.all("SELECT * FROM tasks WHERE goal='详情中独立新建'")[0];
    expect(independent.parent_id).toBe(task.parent_id);
    expect(independent.parent_id).not.toBe(task.id);
    expect(independent.status).toBe('paused');
    expect(fixture.store.all('SELECT * FROM messages WHERE task_id = ? AND sender_id IS NULL', task.id)).toHaveLength(1);
    expect(dom.node('input-form').dataset.mode).toBe('create');
    activateDetailView({ view: 'overview' }); expect(input.placeholder).toContain('在 main 下创建子 Worker');
  } finally { restore(); await fixture.close(); }
});

test('真实 API：输入框创建后原页告知，主动查看才跳转且不会开始 Agent', async () => {
  fixture = await setup(); fixture.project.stopping = true; await repo(fixture.root);
  let details = 0;
  const restore = registerNavigation({ refresh: async () => {
    const response = await httpFetch(fixture.url + '/api/snapshot');
    ui.lastSnapshot = await response.json(); renderNotices(ui.lastSnapshot); renderNoticeBanner(ui.lastSnapshot);
  }, detail: id => { details++; return loadDetail(id); } });
  try {
    resetUiState(); dom.node('input').value = ''; dom.node('input-parent').value = ''; await initComposer();
    const view = activateDetailView({ view: 'overview' }), hash = dom.location.hash;
    const input = dom.node('input'); input.value = '留在原页的真实创建'; input.oninput(); input.focus();
    await dom.node('input-form').onsubmit({ preventDefault() {} });
    await until(() => dom.node('notice-banner').querySelector('.notice-banner-info'));
    const task = fixture.store.all("SELECT * FROM tasks WHERE task_kind='order'")[0];
    expect(deepText(dom.node('notice-banner'))).toContain(`Worker ${task.worker_number} 待开始`);
    expect(ui.view).toBe(view); expect(dom.location.hash).toBe(hash); expect(details).toBe(0);
    expect(input.value).toBe(''); expect(document.activeElement).toBe(input);
    const [notice] = fixture.store.all('SELECT * FROM notices WHERE task_id=?', task.id);
    expect(notice.read_at).toBeNull();
    await dom.node('notice-banner').querySelector('.notice-banner-info').onclick();
    await until(() => ui.lastSnapshot.notices.find(row => row.id === notice.id)?.read_at);
    expect(details).toBe(1); expect(ui.selected).toBe(task.id); expect(dom.location.hash).toBe(`#worker-${task.id}`);
    expect(fixture.store.task(task.id)).toMatchObject({ status: 'paused', calls: 0, agent_wakes: 0 });
    expect(fixture.store.get('SELECT read_at FROM notices WHERE id=?', notice.id).read_at).toBeTruthy();
  } finally { restore(); await fixture.close(); }
});

test('真实 API：默认只读暂存，手动切换才显示已提交历史', async () => {
  fixture = await setup(); fixture.project.stopping = true; await repo(fixture.root);
  try {
    resetUiState();
    const draft = await fixture.project.addBufferedDraft('待执行想法', [], 'main');
    await fixture.project.order('已提交指令', 'main', [], null, false);
    await openInputs();
    expect(root().querySelectorAll('.input-record').map(card => card.dataset.input)).toEqual([`draft:${draft.id}`]);
    const status = root().querySelector('.inputs-filters').querySelector('select');
    expect(status.value).toBe('draft');
    status.value = 'created'; await status.onchange();
    expect(root().querySelectorAll('.input-record')).toHaveLength(1);
    expect(root().querySelector('.input-record').dataset.input).toMatch(/^input:/);
    status.value = ''; await status.onchange();
    expect(root().querySelectorAll('.input-record')).toHaveLength(2);
  } finally { await fixture.close(); }
});

test('真实 API 串联：Enter 暂存、空筛选/正文检索、保存修订与仅创建、原文引用只读', async () => {
  fixture = await setup(); fixture.project.stopping = true; await repo(fixture.root);
  const restore = registerNavigation({ refresh: async () => {} });
  try {
    resetUiState(); dom.node('input').value = ''; dom.node('input-parent').value = '';
    await initComposer();
    const input = dom.node('input'); input.value = '真实接口想法 <img src=x>\n第二行'; input.oninput();
    setComposerReferences([{ version: 1, kind: 'text', target: {}, label: '引用快照', quote: '捕获时所见', location: {}, captured_at: '2026-10-02T00:00:00Z' }]);
    await input.onkeydown({ key: 'Enter', preventDefault() {} });
    expect(input.value).toBe('');
    expect(fixture.store.all("SELECT * FROM tasks WHERE task_kind='order'")).toHaveLength(0);
    await openInputs(); expect(root().querySelectorAll('.input-record')).toHaveLength(1);
    const form = root().querySelector('.inputs-filters');
    // Default to drafts; choosing all sends no enum restriction, not invalid status='' / integration=''.
    expect(form.querySelector('select').value).toBe('draft');
    await form.onsubmit({ preventDefault() {} });
    expect(deepText(root())).not.toContain('读取失败');
    form.querySelector('input').value = '第二行'; await form.onsubmit({ preventDefault() {} });
    expect(root().querySelectorAll('.input-record')).toHaveLength(1);
    const selects = form.querySelectorAll('select'); selects[0].value = 'draft'; await selects[0].onchange();
    expect(deepText(root())).not.toContain('读取失败');
    selects[0].value = ''; form.querySelector('input').value = ''; await form.onsubmit({ preventDefault() {} });
    await btn('编辑与发射').onclick();
    const panel = root().querySelector('.input-detail');
    expect(panel.querySelector('textarea').value).toContain('第二行');
    panel.querySelector('textarea').value = '已保存的最终输入';
    await btn('保存', panel).onclick(); expect(deepText(panel)).toContain('已保存。');
    const saved = fixture.store.all('SELECT * FROM drafts')[0]; expect(saved.revision).toBe(2);
    await btn('仅创建', panel).onclick(); expect(deepText(panel)).toContain('已创建·待开始');
    expect(fixture.store.all("SELECT * FROM tasks WHERE task_kind='order'")).toHaveLength(1);
    expect(fixture.store.all("SELECT * FROM tasks WHERE task_kind='order'")[0].status).toBe('paused');
    expect(root().querySelectorAll('.input-record')).toHaveLength(1);
    expect(root().querySelector('.input-record').dataset.input).toMatch(/^input:/);
    await btn('← 返回历史输入').onclick();
    await btn('查看原文').onclick();
    expect(panel.querySelector('textarea')).toBe(null); expect(deepText(panel)).toContain('已保存的最终输入');
    expect(deepText(panel)).toContain('引用快照'); expect(deepText(panel)).toContain('捕获时所见');
    expect(root().querySelector('img')).toBe(null);
    expect(ui.composerSubmitting).toBe(false);
  } finally { restore(); await fixture.close(); }
});
