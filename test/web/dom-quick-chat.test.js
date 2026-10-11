import { afterAll, beforeEach, expect, test } from 'bun:test';
import { installDom, deepText, findByText, dialogButton } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';
import { until } from '../helpers.js';
import { ui } from '../../src/ui/web/assets/state.js';
import { openComposerChat, resetComposerMode, appendToWorker, toggleComposerDetails } from '../../src/ui/web/assets/composer.js';
import { addComposerReference, composerReferences, setComposerReferences } from '../../src/ui/web/assets/context-references.js';
import { openQuickChatPage, openQuickChatConversation, openQuickChatSettings } from '../../src/ui/web/assets/render-quick-chat.js';
import { activateDetailView } from '../../src/ui/web/assets/sidebar-ui.js';

const world = makeWorld(), calls = [], tabs = [];
let intercept = null;
const dom = installDom({ fetch: async (url, options = {}) => {
  calls.push({ url: String(url), options });
  return intercept?.(String(url), options) || world.fetchImpl(String(url).replace(/^\/p\/[a-f0-9]{16}\/api\//, '/api/'), options);
} });
const { boot } = await import('../../src/ui/web/assets/app.js');
const field = name => dom.node('detail').querySelector(`[data-chat-field="${name}"]`);
const ref = () => ({ version: 1, kind: 'text', target: {}, quote: '引用内容\n第二行', label: '所选文字', location: { view: 'docs' }, captured_at: '2026-10-01T00:00:00Z' });
const json = data => ({ ok: true, status: 200, json: async () => data });
const actionCalls = () => calls.filter(call => call.url === '/p/aaaaaaaaaaaaaaaa/api/quick-chat/action').map(call => JSON.parse(call.options.body));
const record = (id = 1, extra = {}) => ({ id, number: `C${id}`, status: 'completed', content: '初次问题', references: [ref()],
  prompt: { id: 'explain', name: '当时的 Prompt', prompt: '原 Prompt 正文' }, model: 'original-model', source: { label: '原来源', endpoint: 'https://old.invalid' },
  turns: [{ id: 1, content: '初次问题', result: '模型回答\n第二行', status: 'completed', truncated: false }], ...extra });
function fakeOpen() {
  dom.window.open = (url, target) => {
    const tab = { url, target, closed: false, opener: 'original', document: { body: {} }, location: { replace(href) { tab.href = href; } }, close() { tab.closed = true; } };
    tabs.push(tab); return tab;
  };
}
beforeEach(async () => {
  intercept = null; ui.disposeQuickChatPage?.(); tabs.length = 0; dom.setSelection(''); dom.location.pathname = '/p/aaaaaaaaaaaaaaaa/'; dom.location.hash = '';
  world.state.quickChats.clear(); world.state.quickChatSeq = 0; world.state.quickChatActions = []; world.state.actions = [];
  world.state.quickChatRevision = 'revision-1'; world.state.quickChatPrompts = [
    { id: 'explain', name: '快速解释', prompt: '解释这段内容', context_menu: true, builtin: true },
    { id: 'notes', name: '速记整理', prompt: '整理为记录', context_menu: true, builtin: false },
    { id: 'saved', name: '仅保存', prompt: '保存备用', context_menu: false, builtin: false },
  ];
  Object.assign(world.state.quickExplanationConfig, { ready: true, reason: null, connection_id: 'api', model: 'fixture-model' });
  fakeOpen(); await boot(); calls.length = 0;
});
afterAll(() => { ui.disposeQuickChatPage?.(); dom.restore(); });

test('引用后切换第三输入模式，选择 Prompt 不调用模型；仅引用发送新标签 C 对话', async () => {
  addComposerReference(ref()); const oldView = ui.view, oldPath = dom.location.pathname;
  await openComposerChat(); expect(dom.node('input-form').dataset.mode).toBe('chat'); expect(world.state.quickChatActions).toHaveLength(0);
  expect(dom.node('composer-chat-prompt').children.map(node => node.value)).toEqual(['explain', 'notes', 'saved']);
  expect(dom.node('input-buffer').hidden).toBe(true); expect(dom.node('input-start').hidden).toBe(true);
  expect(dom.node('draft-commit').classList.contains('agent-call')).toBe(true);
  expect(dom.node('draft-commit').getAttribute('data-help')).toContain('会直连你配置的模型');
  expect(dom.node('draft-commit').getAttribute('data-help')).not.toContain('会调用 Agent');
  dom.node('composer-chat-prompt').value = 'saved'; dom.node('composer-chat-prompt').onchange();
  expect(dom.node('draft-commit').disabled).toBe(false);
  await dom.node('input-form').onsubmit({ preventDefault() {} });
  expect(actionCalls()).toEqual([{ method: 'start', params: { prompt_id: 'saved', content: '', references: [{ ...ref(), project_id: 'aaaaaaaaaaaaaaaa' }] } }]);
  expect(world.state.actions).toHaveLength(0); expect(tabs).toHaveLength(1); expect(tabs[0].opener).toBeNull(); expect(tabs[0].href).toBe('/p/aaaaaaaaaaaaaaaa/#quick-chat-C1');
  expect(dom.location.pathname).toBe(oldPath); expect(ui.view).toBe(oldView); expect(composerReferences()).toHaveLength(0);
});

test('模式切换保留正文引用，追加与快速对话互斥，导航退出临时对话模式', async () => {
  dom.node('input').value = '原文'; dom.node('input').oninput(); addComposerReference(ref()); await openComposerChat();
  resetComposerMode(); expect(dom.node('input-form').dataset.mode).toBe('create'); expect(dom.node('input').value).toBe('原文'); expect(composerReferences()).toHaveLength(1);
  await openComposerChat(); activateDetailView({ view: 'task', key: 'task-1' }); ui.selected = 1;
  appendToWorker({ id: 1, status: 'waiting', task_kind: 'order' }); expect(ui.composerChatMode).toBeNull(); expect(dom.node('input-form').dataset.mode).toBe('append');
  await openComposerChat(); expect(ui.composerAppendTarget).toBeNull(); activateDetailView({ view: 'overview' }); expect(ui.composerChatMode).toBeNull(); expect(dom.node('input').value).toBe('原文');
});

test('第三模式保留手机展开状态投影，不显示父 Worker 或运行设置', async () => {
  await openComposerChat();
  expect(dom.node('input-form').dataset.expanded).toBe('false');
  await toggleComposerDetails(true);
  expect(dom.node('input-form').dataset.expanded).toBe('true');
  expect(dom.node('composer-editor-tools').hidden).toBe(false);
  expect(dom.node('composer-details').hidden).toBe(true);
  expect(dom.node('composer-shortcuts').hidden).toBe(true);
  expect(dom.node('composer-shell').querySelector('.composer-run-settings').hidden).toBe(true);
  expect(dom.node('composer-expand').getAttribute('data-help')).toContain('收起');
  await toggleComposerDetails(false);
  expect(dom.node('input-form').dataset.expanded).toBe('false');
  expect(dom.node('composer-expand').getAttribute('data-help')).toContain('不改变快速对话 Prompt');
  expect(dom.node('input-form').dataset.mode).toBe('chat');
  expect(actionCalls()).toHaveLength(0);
});

test('快速对话双击单飞，预开标签在请求前；迟到 ACK 不清掉在途新输入引用', async () => {
  await openComposerChat(); dom.node('input').value = '已发送'; dom.node('input').oninput();
  let done; intercept = (url, options) => url.endsWith('/quick-chat/action') ? new Promise(resolve => { expect(tabs).toHaveLength(1); done = resolve; }) : null;
  const sending = dom.node('input-form').onsubmit({ preventDefault() {} }); await until(() => done);
  await dom.node('input-form').onsubmit({ preventDefault() {} }); expect(actionCalls()).toHaveLength(1);
  dom.node('input').value = '新文字'; dom.node('input').oninput(); addComposerReference(ref());
  done(json(record(8))); await sending;
  expect(dom.node('input').value).toBe('新文字'); expect(composerReferences()).toHaveLength(1); expect(tabs[0].href).toBe('/p/aaaaaaaaaaaaaaaa/#quick-chat-C8');
});

test('快速对话请求失败保留原文引用并关闭占位页，标签拦截仍提供可见链接不重发', async () => {
  await openComposerChat(); dom.node('input').value = '保留我'; dom.node('input').oninput(); addComposerReference(ref());
  intercept = url => url.endsWith('/quick-chat/action') ? Promise.reject(new Error('来源不可用')) : null;
  await dom.node('input-form').onsubmit({ preventDefault() {} }); expect(dom.node('input').value).toBe('保留我'); expect(composerReferences()).toHaveLength(1); expect(tabs[0].closed).toBe(true);
  expect(dom.node('error').textContent).toContain('先核对项目对话历史');
  intercept = null; dom.window.open = () => null;
  await dom.node('input-form').onsubmit({ preventDefault() {} });
  expect(dom.node('quick-chat-open-result').hidden).toBe(false); expect(dom.node('quick-chat-open-result').querySelector('a').href).toBe('/p/aaaaaaaaaaaaaaaa/#quick-chat-C1');
  expect(actionCalls()).toHaveLength(2);
});

test('中文输入法、触屏回车与 Shift+Enter 不误发，桌面 Enter 仅发送快速对话', async () => {
  await openComposerChat(); const input = dom.node('input'); input.value = '消息'; input.oninput();
  await input.onkeydown({ key: 'Enter', isComposing: true }); await input.onkeydown({ key: 'Enter', shiftKey: true });
  input.oncompositionstart(); await input.onkeydown({ key: 'Enter' }); input.oncompositionend();
  dom.window.matchMedia = () => ({ matches: true }); await input.onkeydown({ key: 'Enter' }); delete dom.window.matchMedia;
  expect(actionCalls()).toHaveLength(0); await input.onkeydown({ key: 'Enter', preventDefault() {} });
  expect(actionCalls()[0].method).toBe('start'); expect(world.state.actions).toHaveLength(0);
});

test('根选区无模型入口，已登记离线项目仍使用本项目 Prompt，只注册开启项', async () => {
  dom.location.pathname = '/'; dom.location.hash = ''; await boot(); calls.length = 0;
  const target = dom.document.createElement('p'); target.textContent = '页面文字'; dom.setSelection('原选区\n第二行');
  await dom.fire('contextmenu', { target, preventDefault() {} }); const menu = dom.node('context-menu');
  expect(findByText(menu, '快速解释')).toBeNull(); expect(calls.some(call => call.url.includes('quick-chat'))).toBe(false);
  dom.location.pathname = '/p/aaaaaaaaaaaaaaaa/'; intercept = url => url === '/api/host' ? json({ mode: 'host', projects: [{ id: 'aaaaaaaaaaaaaaaa', running: false }] }) : null; await boot(); calls.length = 0;
  await dom.fire('contextmenu', { target, preventDefault() {} });
  expect(findByText(menu, '快速解释')).toBeTruthy(); expect(findByText(menu, '速记整理')).toBeTruthy(); expect(findByText(menu, '仅保存')).toBeNull();
  await findByText(menu, '速记整理').onclick(); expect(actionCalls()).toHaveLength(1); expect(actionCalls()[0].params.references[0].quote).toBe('原选区\n第二行'); expect(tabs[0].href).toBe('/p/aaaaaaaaaaaaaaaa/#quick-chat-C1');
  expect(calls.filter(call => call.url.includes('quick-chat')).every(call => call.url.startsWith('/p/aaaaaaaaaaaaaaaa/api/quick-chat/'))).toBe(true);
  world.state.quickChatPrompts[0].context_menu = false;
  await dom.fire('contextmenu', { target, preventDefault() {} }); expect(findByText(menu, '快速解释')).toBeNull();
  dom.setSelection(''); await dom.fire('contextmenu', { target, preventDefault() {} }); expect(findByText(menu, '速记整理')).toBeNull();
  expect(actionCalls()).toHaveLength(1);
});

test('超长选区拒绝原文发送而非截断；菜单迟到配置不能重开已关闭菜单', async () => {
  const target = dom.document.createElement('p'); target.textContent = '内容'; dom.setSelection('x'.repeat(8193));
  await dom.fire('contextmenu', { target, preventDefault() {} }); await findByText(dom.node('context-menu'), '快速解释').onclick();
  expect(actionCalls()).toHaveLength(0); expect(tabs).toHaveLength(0); expect(dom.node('error').textContent).toContain('没有截断或发送');
  let resolve; intercept = url => url.endsWith('/quick-chat/config') ? new Promise(done => { resolve = done; }) : null;
  dom.setSelection('短选区'); const opening = dom.fire('contextmenu', { target, preventDefault() {} }); await until(() => resolve);
  await dom.fire('keydown', { key: 'Escape' }); resolve(json({ prompts: world.state.quickChatPrompts, model: { ready: true } })); await opening;
  expect(dom.node('context-menu').hidden).toBe(true);
});

test('项目历史有界分页和 C 编号，详情与设置深链接不跳全局', async () => {
  for (let id = 1; id <= 35; id++) world.state.quickChats.set(id, record(id));
  await openQuickChatPage(); expect(dom.node('detail').querySelectorAll('.quick-chat-history-row')).toHaveLength(30);
  await findByText(dom.node('detail'), '加载更早对话').onclick(); expect(dom.node('detail').querySelectorAll('.quick-chat-history-row')).toHaveLength(35);
  expect(dom.node('detail').querySelector('.quick-chat-history-row').querySelector('a').href).toBe('/p/aaaaaaaaaaaaaaaa/#quick-chat-C35');
  dom.location.hash = '#quick-chat-C35'; await dom.fire('hashchange'); expect(ui.view.key).toBe('quick-chat-C35'); expect(deepText(dom.node('detail'))).toContain('快速对话 C35');
  dom.location.hash = '#quick-chat-settings'; await dom.fire('hashchange'); expect(ui.view.id).toBe('quick-chat-settings'); expect(deepText(dom.node('detail'))).toContain('Prompt 库');
});

test('独立对话显示来源、Prompt、引用和完整轮次；追问留在 C 编号且在途编辑保留', async () => {
  world.state.quickChats.set(1, record()); await openQuickChatConversation(1);
  expect(deepText(dom.node('detail'))).toContain('原 Prompt 正文'); expect(deepText(dom.node('detail'))).toContain('原来源'); expect(deepText(dom.node('detail'))).toContain('引用内容\n第二行'); expect(deepText(dom.node('detail'))).toContain('模型回答\n第二行');
  field('reply').value = '追问'; field('reply').oninput(); let resolve;
  intercept = url => url.endsWith('/quick-chat/action') ? new Promise(done => { resolve = done; }) : null;
  const send = findByText(dom.node('detail'), '发送'); const sending = send.onclick(); await until(() => resolve); await send.onclick();
  field('reply').value = '下一轮草稿'; field('reply').oninput();
  resolve(json(record(1, { status: 'failed', turns: [...record().turns, { id: 2, content: '追问', status: 'failed', error: '调用失败', truncated: true }] }))); await sending;
  expect(actionCalls()).toEqual([{ method: 'send', params: { id: 1, content: '追问' } }]); expect(field('reply').value).toBe('下一轮草稿');
  expect(deepText(dom.node('detail'))).toContain('最早的历史问答未发送'); expect(send.disabled).toBe(false); expect(ui.view.key).toBe('quick-chat-C1');
});

test('回复中不能发送或删除，导航/boot 清理轮询并不取消后台；迟到读取不覆盖页面', async () => {
  world.state.quickChats.set(1, record(1, { status: 'running' }));
  await openQuickChatConversation(1); const state = ui.quickChatPage;
  expect(findByText(dom.node('detail'), '发送').disabled).toBe(true); expect(findByText(dom.node('detail'), '删除对话').disabled).toBe(true); expect(state.timer).not.toBeNull();
  activateDetailView({ view: 'overview' }); expect(state.disposed).toBe(true); expect(state.controller.signal.aborted).toBe(true);
  let resolve; intercept = url => url.endsWith('/quick-chat/1') ? new Promise(done => { resolve = done; }) : null;
  const opening = openQuickChatConversation(1); await until(() => resolve); activateDetailView({ view: 'settings' }); dom.node('detail').replaceChildren();
  resolve(json(record())); await opening; expect(ui.view.id).toBe('settings'); expect(dom.node('detail').querySelector('.quick-chat-thread')).toBeNull();
  expect(actionCalls()).toHaveLength(0);
});

test('对话轮询不重绘相同正文，选区中的新结果延后到释放选区再显示', async () => {
  world.state.quickChats.set(1, record()); await openQuickChatConversation(1);
  const old = dom.node('detail').querySelector('.quick-chat-content'), selection = dom.window.getSelection;
  await findByText(dom.node('detail'), '刷新对话').onclick(); expect(dom.node('detail').querySelector('.quick-chat-content')).toBe(old);
  dom.window.getSelection = () => ({ isCollapsed: false, anchorNode: old, focusNode: old });
  try {
    world.state.quickChats.set(1, record(1, { turns: [...record().turns, { id: 2, content: '新的消息', result: '新结果', status: 'completed' }] }));
    await findByText(dom.node('detail'), '刷新对话').onclick(); expect(dom.node('detail').querySelector('.quick-chat-content')).toBe(old); expect(deepText(dom.node('detail'))).not.toContain('新结果');
    dom.window.getSelection = selection; await findByText(dom.node('detail'), '刷新对话').onclick(); expect(deepText(dom.node('detail'))).toContain('新结果');
  } finally { dom.window.getSelection = selection; }
});

test('旧刷新响应不能覆盖新消息确认，对话仍按确认后的状态继续读取', async () => {
  world.state.quickChats.set(1, record()); await openQuickChatConversation(1);
  let resolve; intercept = url => url.endsWith('/quick-chat/1') ? new Promise(done => { resolve = done; }) : null;
  const reading = findByText(dom.node('detail'), '刷新对话').onclick(); await until(() => resolve);
  field('reply').value = '新消息'; field('reply').oninput(); await findByText(dom.node('detail'), '发送').onclick();
  resolve(json(record())); await reading;
  expect(deepText(dom.node('detail'))).toContain('新消息'); expect(deepText(dom.node('detail'))).toContain('继续对话示例');
});

test('对话删除先确认，取消不发请求，成功返回项目历史', async () => {
  world.state.quickChats.set(1, record()); await openQuickChatConversation(1);
  let deleting = findByText(dom.node('detail'), '删除对话').onclick(); await dialogButton(dom, '保留').onclick(); await deleting; expect(actionCalls()).toHaveLength(0);
  deleting = findByText(dom.node('detail'), '删除对话').onclick(); await dialogButton(dom, '删除').onclick(); await deleting;
  expect(actionCalls()).toEqual([{ method: 'delete', params: { id: 1 } }]); expect(ui.view.id).toBe('quick-chat');
});

test('Prompt 库显示仅保存/右键状态，关闭内置示例和新建均带 revision，保存不调用模型', async () => {
  await openQuickChatSettings(); field('edit_prompt').value = 'explain'; field('edit_prompt').onchange();
  expect(findByText(dom.node('detail'), '删除 Prompt').disabled).toBe(true); field('context_menu').checked = false; field('context_menu').onchange();
  await findByText(dom.node('detail'), '保存 Prompt').onclick(); expect(actionCalls()[0]).toEqual({ method: 'prompt_save', params: { expected_revision: 'revision-1', prompt: { id: 'explain', name: '快速解释', prompt: '解释这段内容', context_menu: false } } });
  field('edit_prompt').value = ''; field('edit_prompt').onchange(); field('name').value = '自定义'; field('name').oninput(); field('prompt').value = '记录要点'; field('prompt').oninput();
  await findByText(dom.node('detail'), '保存 Prompt').onclick(); expect(actionCalls()[1].params.expected_revision).toBe('revision-1-next'); expect(actionCalls()[1].params.prompt.context_menu).toBe(false);
  expect(actionCalls().every(call => call.method === 'prompt_save')).toBe(true); expect(world.state.actions).toHaveLength(0);
});

test('Prompt 版本冲突保留编辑，保存 ACK 保留在途新编辑，共用模型保存不修改 Prompt', async () => {
  await openQuickChatSettings(); field('edit_prompt').value = 'notes'; field('edit_prompt').onchange(); field('prompt').value = '未保存'; field('prompt').oninput();
  intercept = url => url.endsWith('/quick-chat/action') ? Promise.reject(new Error('revision conflict')) : null;
  await findByText(dom.node('detail'), '保存 Prompt').onclick(); expect(field('prompt').value).toBe('未保存'); expect(deepText(dom.node('detail'))).toContain('版本冲突');
  let resolve; intercept = url => url.endsWith('/quick-chat/action') ? new Promise(done => { resolve = done; }) : null;
  const pending = findByText(dom.node('detail'), '保存 Prompt').onclick(); await until(() => resolve); field('prompt').value = '在途新内容'; field('prompt').oninput();
  resolve(json({ version: 1, revision: 'new-revision', prompts: world.state.quickChatPrompts, model: { ready: true } })); await pending;
  expect(field('prompt').value).toBe('在途新内容'); expect(deepText(dom.node('detail'))).toContain('未保存修改');
  intercept = null; const model = dom.node('detail').querySelector('[data-quick-field="model"]'); model.value = 'fixture-model';
  const source = dom.node('detail').querySelector('[data-quick-field="connection_id"]'); source.value = world.state.agentConnections.connections[0].id; source.onchange();
  await findByText(dom.node('detail'), '保存模型设置').onclick(); expect(world.state.actions.at(-1).params.config).not.toHaveProperty('prompt');
});

test('项目新建对话接收引用；在途新编辑不被详情跳转吞掉', async () => {
  await openQuickChatPage(); addComposerReference(ref()); expect(findByText(dom.node('detail'), '开始对话').disabled).toBe(false);
  let resolve; intercept = url => url.endsWith('/quick-chat/action') ? new Promise(done => { resolve = done; }) : null;
  const pending = findByText(dom.node('detail'), '开始对话').onclick(); await until(() => resolve);
  field('content').value = '下一段'; field('content').oninput(); resolve(json(record(7))); await pending;
  expect(ui.view.id).toBe('quick-chat'); expect(field('content').value).toBe('下一段'); expect(composerReferences()).toHaveLength(1); expect(deepText(dom.node('detail'))).toContain('打开已创建的对话 C7');
});

test('Prompt 初次慢读取保留在途输入与右键开关，只更新配置和版本', async () => {
  let resolve; intercept = url => url.endsWith('/quick-chat/config') ? new Promise(done => { resolve = done; }) : null;
  const opening = openQuickChatSettings(); await until(() => resolve);
  field('name').value = '新建速记'; field('name').oninput(); field('prompt').value = '我在读取期间写的 Prompt'; field('prompt').oninput();
  field('context_menu').checked = true; field('context_menu').onchange();
  resolve(json({ revision: 'loaded-revision', prompts: world.state.quickChatPrompts, model: { ready: true } })); await opening;
  expect(field('name').value).toBe('新建速记'); expect(field('prompt').value).toBe('我在读取期间写的 Prompt'); expect(field('context_menu').checked).toBe(true);
  expect(field('edit_prompt').value).toBe(''); expect(deepText(dom.node('detail'))).toContain('未保存修改'); expect(actionCalls()).toHaveLength(0);
  intercept = null; await findByText(dom.node('detail'), '保存 Prompt').onclick();
  expect(actionCalls()[0]).toEqual({ method: 'prompt_save', params: { expected_revision: 'loaded-revision', prompt: {
    name: '新建速记', prompt: '我在读取期间写的 Prompt', context_menu: true } } });
});

test('Prompt 显式重读期间切换选择和编辑不被迟到配置覆盖，后续保存用新版本', async () => {
  await openQuickChatSettings(); field('edit_prompt').value = 'notes'; field('edit_prompt').onchange();
  let resolve; intercept = url => url.endsWith('/quick-chat/config') ? new Promise(done => { resolve = done; }) : null;
  const loading = findByText(dom.node('detail'), '重新读取 Prompt 库').onclick(); await dialogButton(dom, '重新读取').onclick(); await until(() => resolve);
  field('edit_prompt').value = 'saved'; field('edit_prompt').onchange(); field('name').value = '重读时编辑'; field('name').oninput();
  field('prompt').value = '新的未保存正文'; field('prompt').oninput(); field('context_menu').checked = true; field('context_menu').onchange();
  resolve(json({ revision: 'new-read-revision', prompts: world.state.quickChatPrompts, model: { ready: true } })); await loading;
  expect(field('edit_prompt').value).toBe('saved'); expect(field('name').value).toBe('重读时编辑'); expect(field('prompt').value).toBe('新的未保存正文'); expect(field('context_menu').checked).toBe(true);
  expect(deepText(dom.node('detail'))).toContain('未保存修改'); intercept = null; await findByText(dom.node('detail'), '保存 Prompt').onclick();
  expect(actionCalls()[0].params).toMatchObject({ expected_revision: 'new-read-revision', prompt: { id: 'saved', name: '重读时编辑', prompt: '新的未保存正文', context_menu: true } });
});

test('项目新建引用可逐项移除，数量/字节上限可补救；历史引用保持只读', async () => {
  await openQuickChatPage(); const send = findByText(dom.node('detail'), '开始对话');
  expect(send.disabled).toBe(true); addComposerReference(ref()); expect(send.disabled).toBe(false);
  const remove = findByText(dom.node('detail'), '移除引用'); expect(remove.getAttribute('data-help')).toContain('不调用模型'); expect(remove.classList.contains('agent-call')).toBe(false);
  await remove.onclick(); expect(composerReferences()).toHaveLength(0); expect(send.disabled).toBe(true); expect(actionCalls()).toHaveLength(0);
  for (let index = 0; index < 12; index++) addComposerReference({ ...ref(), quote: `材料 ${index}` });
  expect(() => addComposerReference({ ...ref(), quote: '第十三项' })).toThrow('最多引用 12 项');
  await findByText(dom.node('detail'), '移除引用').onclick(); addComposerReference({ ...ref(), quote: '替换引用' }); expect(composerReferences()).toHaveLength(12);
  while (composerReferences().length) await findByText(dom.node('detail'), '移除引用').onclick(); expect(send.disabled).toBe(true);
  addComposerReference({ ...ref(), quote: '文'.repeat(8192) });
  expect(() => addComposerReference({ ...ref(), quote: '字'.repeat(8192) })).toThrow('48 KiB');
  await findByText(dom.node('detail'), '移除引用').onclick(); addComposerReference({ ...ref(), quote: '字'.repeat(8192) }); expect(send.disabled).toBe(false);
  expect(actionCalls()).toHaveLength(0); world.state.quickChats.set(1, record()); await openQuickChatConversation(1);
  expect(findByText(dom.node('detail'), '移除引用')).toBeNull(); expect(deepText(dom.node('detail'))).toContain('引用内容');
});

test('执行详情选区调用被弹窗拦截时，顶层内有可见链接且关闭清理宿主，不重发', async () => {
  const { openTranscriptView, closeTranscriptView } = await import('../../src/ui/web/assets/transcript-view.js');
  const outer = dom.node('quick-chat-open-result'); dom.document.body.append(outer);
  dom.node('input').value = '原项目输入'; dom.node('input').oninput(); dom.node('detail').scrollTop = 240;
  ui.selected = 1; const originalView = ui.view; await openTranscriptView(1);
  try {
    const panel = ui.transcriptView.panel, target = panel.querySelector('.step'); expect(target).toBeTruthy();
    const viewport = panel.querySelector('.transcript-viewport'); viewport.scrollTop = 120;
    dom.window.open = () => null; dom.setSelection('执行详情中的选区');
    await dom.fire('contextmenu', { target, preventDefault() {} }); await findByText(dom.node('context-menu'), '快速解释').onclick();
    const local = panel.querySelector('[data-chat-result="true"]'); expect(local).toBeTruthy(); expect(local.hidden).toBe(false);
    expect(local.querySelector('a').href).toBe('/p/aaaaaaaaaaaaaaaa/#quick-chat-C1'); expect(local.querySelector('a').target).toBe('_blank'); expect(local.querySelector('a').rel).toBe('noopener');
    expect(outer.querySelector('a').href).toBe('/p/aaaaaaaaaaaaaaaa/#quick-chat-C1'); expect(actionCalls()).toHaveLength(1);
    expect(ui.view).toBe(originalView); expect(viewport.scrollTop).toBe(120); expect(dom.node('input').value).toBe('原项目输入'); expect(dom.window.getSelection().toString()).toBe('执行详情中的选区');
    closeTranscriptView(); expect(dom.document.body.querySelector('[data-chat-result="true"]')).toBeNull(); expect(ui.transcriptView).toBeNull();
    expect(outer.parentNode).toBe(dom.document.body); expect(outer.hidden).toBe(false); expect(dom.node('detail').scrollTop).toBe(240); expect(actionCalls()).toHaveLength(1);
  } finally { closeTranscriptView(); outer.remove(); }
});
