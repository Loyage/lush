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
const rowKeys = () => root().querySelectorAll('.input-record').map(card => card.dataset.input);
const btn = (label, host = root()) => [...host.querySelectorAll('button'), ...host.querySelectorAll('a')].find(node => node.textContent === label || node.getAttribute('aria-label')?.endsWith(`：${label}`));

test('真实 API：详情默认新建，显式追加 Ctrl+Enter 可靠挂载且 ACK 恢复新建', async () => {
  fixture = await setup(); fixture.project.stopping = true; await repo(fixture.root);
  const restore = registerNavigation({ refresh: async () => {}, detail: loadDetail });
  try {
    resetUiState(); dom.node('input').value = ''; dom.node('input-parent').value = '';
    await initComposer();
    const { task } = await fixture.project.order('初始要求', 'main', [], null, false);
    await loadDetail(task.id);
    const before = ['tasks', 'inputs', 'drafts'].map(table => fixture.store.all(`SELECT * FROM ${table}`).length);
    const input = dom.node('input'); expect(dom.node('input-form').dataset.mode).toBe('create');
    expect(input.placeholder).toBe('描述你希望新 Worker 完成的工作…');
    expect(dom.node('composer-mode-target').textContent).toBe('去向：新 Worker · 基于 main');
    btn('追加输入').onclick();
    expect(input.placeholder).toBe('补充要求、提供反馈，或说明需要调整的地方…');
    expect(dom.node('composer-mode-target').textContent).toContain(`去向：Worker ${task.worker_number ?? `#${task.id}`}`);
    expect(dom.node('composer-mode-behavior').textContent).toContain('需开始 / 继续');
    input.value = '后续要求'; input.oninput(); await input.onkeydown({ key: 'Enter', ctrlKey: true, preventDefault() {} });
    expect(input.value).toBe(''); expect(fixture.store.task(task.id).status).toBe('paused');
    // Stopped fixture runtime cannot dispatch: ACK is only a durable mount, not an Agent delivery.
    expect(fixture.store.all('SELECT * FROM messages WHERE task_id = ? AND sender_id IS NULL', task.id)).toHaveLength(0);
    expect(['tasks', 'inputs', 'drafts'].map(table => fixture.store.all(`SELECT * FROM ${table}`).length)).toEqual([before[0], before[1], before[2] + 1]);
    expect(dom.node('input-form').dataset.mode).toBe('create');
    expect(dom.node('composer-reset').hidden).toBe(true);
    input.value = '详情中独立新建'; input.oninput();
    await input.onkeydown({ key: 'Enter', ctrlKey: true, preventDefault() {} });
    expect(fixture.store.all("SELECT * FROM tasks WHERE goal='详情中独立新建'")).toHaveLength(0);
    expect(fixture.store.all('SELECT * FROM drafts')).toHaveLength(before[2] + 2);
    expect(fixture.store.all('SELECT * FROM messages WHERE task_id = ? AND sender_id IS NULL', task.id)).toHaveLength(0);
    expect(dom.node('input-form').dataset.mode).toBe('create');
    activateDetailView({ view: 'overview' }); expect(input.placeholder).toBe('描述你希望新 Worker 完成的工作…');
  } finally { restore(); await fixture.close(); }
});

test('真实 API：发射确认留在原页，不伪造已创建告知或 Agent 调用', async () => {
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
    expect(fixture.store.all("SELECT * FROM tasks WHERE task_kind='order'")).toHaveLength(0);
    expect(fixture.store.all('SELECT * FROM drafts')).toHaveLength(1);
    expect(dom.node('error').textContent).toContain('尚不代表 Worker 已创建');
    expect(ui.view).toBe(view); expect(dom.location.hash).toBe(hash); expect(details).toBe(0);
    expect(input.value).toBe(''); expect(document.activeElement).toBe(input);
    expect(fixture.store.all("SELECT * FROM notices WHERE title LIKE '%待开始%'")).toHaveLength(0);
    expect(fixture.store.all('SELECT * FROM agent_runs')).toHaveLength(0);
  } finally { restore(); await fixture.close(); }
});

test('真实 API：历史只含已发送三模式，草稿分工作和追加暂存，条件默认展开', async () => {
  fixture = await setup(); fixture.project.stopping = true; await repo(fixture.root);
  try {
    resetUiState();
    const draft = await fixture.project.addBufferedDraft('待执行想法', [], 'main');
    const order = await fixture.project.order('已提交指令', 'main', [], null, false);
    fixture.project.message(order.task.id, '直接追加真实正文');
    const message = fixture.store.get('SELECT * FROM messages WHERE task_id=? AND append_number IS NOT NULL', order.task.id);
    const manager = fixture.project.submitManagementInstruction({ instruction: '真实管理输入' });
    await openInputs();
    expect(root().querySelectorAll('.input-record')).toHaveLength(3);
    expect(root().querySelector(`[data-input="draft:${draft.id}"]`)).toBeNull();
    expect(root().querySelector('.input-advanced-filters').open).not.toBe(true);
    const form = root().querySelector('.inputs-filters'), mode = value => form.querySelector(`[data-mode="${value}"]`);
    expect([...form.querySelectorAll('.input-mode-toggle')].every(node => node.getAttribute('aria-pressed') === 'true')).toBe(true);
    await mode('order').onclick(); await mode('management').onclick();
    expect(root().querySelectorAll('.input-record').map(card => card.dataset.input)).toEqual([`message:${message.id}`]);
    await btn('查看原文').onclick(); expect(deepText(root().querySelector('.input-detail'))).toContain('直接追加真实正文');
    expect(root().querySelector('.input-detail').querySelector('textarea')).toBeNull();
    await btn('← 返回历史输入').onclick(); await mode('append').onclick(); await mode('management').onclick();
    expect(root().querySelectorAll('.input-record').map(card => card.dataset.input)).toEqual([`management:${manager.task.id}`]);
    await btn('查看原文').onclick(); expect(deepText(root().querySelector('.input-detail'))).toContain('真实管理输入');
    expect(deepText(root().querySelector('.input-detail'))).not.toContain(`O${manager.task.id}`);
    await btn('← 返回历史输入').onclick(); await mode('append').onclick(); await mode('order').onclick();
    const status = form.querySelector('select');
    expect(status.value).toBe('');
    expect([...status.children].some(option => option.value === 'draft')).toBe(false);
    status.value = 'created'; await status.onchange();
    expect(root().querySelectorAll('.input-record')).toHaveLength(2);
    expect(root().querySelectorAll('.input-record').some(card => card.dataset.input.startsWith('input:'))).toBe(true);
    status.value = ''; await status.onchange();
    expect(root().querySelectorAll('.input-record')).toHaveLength(3);
    await fixture.project.addBufferedDraft('追加暂存正文', [], 'main', { mode: 'append', target_id: order.task.id });
    await openInputs({ section: 'drafts' });
    expect(ui.view.id).toBe('drafts'); expect(dom.location.hash).toBe('#drafts');
    expect(root().querySelectorAll('.input-record').map(card => card.dataset.input)).toEqual([`draft:${draft.id}`]);
    expect(deepText(root())).toContain('父 main · 条件：未设置');
    expect(root().querySelector('[data-mode="management"]')).toBeNull();
    await root().querySelector('[data-mode="append"]').onclick();
    expect(root().querySelectorAll('.input-record')).toHaveLength(1);
    expect(deepText(root())).toContain('追加暂存正文');
    await btn('查看草稿与提交状态').onclick();
    expect(root().querySelector('.emission-conditions').hidden).toBe(false);
    expect(deepText(root())).toContain('追加目标 Worker');
    await btn('← 返回草稿').onclick();
    expect(root().querySelector('[data-mode="append"]').getAttribute('aria-pressed')).toBe('true');
  } finally { await fixture.close(); }
});

test('真实 API 归档：实际创建和追加入箱后才入历史，真实原文与源条件收据往返', async () => {
  fixture = await setup(); fixture.project.stopping = true; fixture.project.kick = () => {};
  fixture.project.scheduleInputEmissions = () => {}; await repo(fixture.root);
  const read = async suffix => (await httpFetch(fixture.url + suffix)).json();
  try {
    resetUiState();
    const draft = await fixture.project.addBufferedDraft('稍后创建的原始批示', [], 'main');
    await openInputs({ section: 'drafts' });
    expect(rowKeys()).toEqual([`draft:${draft.id}`]);
    await btn('查看草稿与提交状态').onclick();
    expect(root().querySelector('.emission-conditions').hidden).toBe(false);
    await btn('提交指令').onclick();
    expect(deepText(root())).toContain('等待准入');
    expect((await read('/api/inputs')).items).toHaveLength(0);
    expect((await read('/api/inputs?view=drafts')).items).toHaveLength(1);
    fixture.project.stopping = false; await fixture.project.drainInputEmissions(); fixture.project.stopping = true;
    const receipt = await read(`/api/input/draft/${draft.id}`);
    expect(receipt.dispatch.state).toBe('succeeded');
    expect((await read('/api/inputs?view=drafts')).items).toHaveLength(0);
    await openInputs();
    expect(rowKeys()).toEqual([`input:${receipt.input_id}`]);
    await btn('查看原文').onclick();
    expect(root().querySelector('.input-detail textarea')).toBeNull();
    expect(deepText(root())).toContain('稍后创建的原始批示');
    await btn(`查看提交草稿 #${draft.id} · 条件与独占`).onclick();
    expect(ui.view.id).toBe('drafts'); expect(deepText(root())).toContain('已投递');
    expect(root().querySelector('.input-detail textarea')).toBeNull();
    const append = await fixture.project.addBufferedDraft('后来追加的批示', [], 'main', { mode: 'append', target_id: receipt.dispatch.worker_id });
    await openInputs({ item: { kind: 'draft', id: append.id } });
    await btn('提交追加').onclick();
    expect((await read('/api/inputs?modes=%5B%22append%22%5D')).items).toHaveLength(0);
    expect((await read('/api/inputs?view=drafts&modes=%5B%22append%22%5D')).items).toHaveLength(1);
    fixture.project.stopping = false; await fixture.project.drainInputEmissions(); fixture.project.stopping = true;
    const sent = await read(`/api/input/draft/${append.id}`);
    expect(sent.dispatch.state).toBe('succeeded');
    await openInputs();
    expect(new Set(rowKeys())).toEqual(new Set([`message:${sent.dispatch.message_id}`, `input:${receipt.input_id}`]));
    expect(rowKeys().some(key => key.startsWith('draft:'))).toBe(false);
    await openInputs({ item: { kind: 'message', id: sent.dispatch.message_id } });
    expect(deepText(root())).toContain('后来追加的批示');
    expect(deepText(root())).toContain(sent.dispatch.append_number);
    expect(root().querySelector('.input-detail textarea')).toBeNull();
    await btn(`查看提交草稿 #${append.id} · 条件与独占`).onclick();
    expect(ui.view.id).toBe('drafts'); expect(deepText(root())).toContain('追加消息 #');
    expect(fixture.store.all('SELECT * FROM agent_runs')).toHaveLength(0);
    expect(fixture.store.all('SELECT * FROM inputs')).toHaveLength(1);
    expect(fixture.store.all('SELECT * FROM messages')).toHaveLength(1);
    expect((await read('/api/inputs?view=drafts')).items).toHaveLength(0);
  } finally { await fixture.close(); }
});

test('真实 API 串联：Enter 暂存、全库检索、保存修订与挂载、保留待准入原文', async () => {
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
    await openInputs(); expect(root().querySelectorAll('.input-record')).toHaveLength(0);
    await openInputs({ section: 'drafts' }); expect(root().querySelectorAll('.input-record')).toHaveLength(1);
    const form = root().querySelector('.inputs-filters');
    // Default to all; empty selects send no enum restriction, not invalid status='' / integration=''.
    expect(form.querySelector('select').value).toBe('');
    await form.onsubmit({ preventDefault() {} });
    expect(deepText(root())).not.toContain('读取失败');
    form.querySelector('input').value = '第二行'; await form.onsubmit({ preventDefault() {} });
    expect(root().querySelectorAll('.input-record')).toHaveLength(1);
    const selects = form.querySelectorAll('select'); selects[0].value = 'draft'; await selects[0].onchange();
    expect(deepText(root())).not.toContain('读取失败');
    selects[0].value = ''; form.querySelector('input').value = ''; await form.onsubmit({ preventDefault() {} });
    await btn('查看草稿与提交状态').onclick();
    const panel = root().querySelector('.input-detail');
    expect(panel.querySelector('textarea').value).toContain('第二行');
    panel.querySelector('textarea').value = '已保存的最终输入';
    await btn('保存', panel).onclick(); expect(deepText(panel)).toContain('已保存。');
    const saved = fixture.store.all('SELECT * FROM drafts')[0]; expect(saved.revision).toBe(2);
    await btn('提交指令', panel).onclick(); expect(deepText(panel)).toContain('等待准入');
    expect(dom.location.hash).toMatch(/^#input-draft-\d+$/);
    expect(panel.querySelector('textarea')).toBe(null); expect(deepText(panel)).toContain('已保存的最终输入');
    expect(deepText(panel)).toContain('引用快照'); expect(deepText(panel)).toContain('捕获时所见');
    expect(fixture.store.all("SELECT * FROM tasks WHERE task_kind='order'")).toHaveLength(0);
    expect(fixture.store.all('SELECT * FROM agent_runs')).toHaveLength(0);
    expect(root().querySelectorAll('.input-record')).toHaveLength(1);
    expect(root().querySelector('.input-record').dataset.input).toMatch(/^draft:/);
    await btn('← 返回草稿').onclick();
    await btn('查看草稿与提交状态').onclick();
    expect(panel.querySelector('textarea')).toBe(null); expect(deepText(panel)).toContain('已保存的最终输入');
    expect(deepText(panel)).toContain('引用快照'); expect(deepText(panel)).toContain('捕获时所见');
    expect(root().querySelector('img')).toBe(null);
    expect(ui.composerSubmitting).toBe(false);
  } finally { restore(); await fixture.close(); }
});
