import { afterAll, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import { installDom, deepText, findByText, dialogButton } from '../dom-stub.js';
import { until } from '../helpers.js';
import { makeWorld } from './dom-world.js';
import { openQuickExplanationPage } from '../../src/ui/web/assets/render-quick-explanation.js';
import { startQuickExplanation, openQuickExplanation, closeQuickExplanationPanel } from '../../src/ui/web/assets/quick-explanation.js';
import { ui, transcriptCache } from '../../src/ui/web/assets/state.js';
import { activateDetailView } from '../../src/ui/web/assets/sidebar-ui.js';
import { openTranscriptView, closeTranscriptView } from '../../src/ui/web/assets/transcript-view.js';
import { renderDiff } from '../../src/ui/web/assets/render-diff.js';

const world = makeWorld(), calls = [];
let intercept = null;
const dom = installDom({ fetch: async (url, options = {}) => {
  calls.push({ url: String(url), options });
  const value = intercept?.(String(url), options); return value || world.fetchImpl(url, options);
} });
const { boot } = await import('../../src/ui/web/assets/app.js');
const json = value => ({ ok: true, status: 200, json: async () => value });
const ready = () => Object.assign(world.state.quickExplanationConfig, { connection_id: world.state.agentConnections.connections[0].id,
  model: 'fixture-model', ready: true, reason: null });
const field = name => dom.node('detail').querySelector(`[data-quick-field="${name}"]`);
const panel = () => dom.document.body.querySelector('.quick-explanation-panel');
const row = (id, extra = {}) => ({ id, status: 'completed', quote: `原文 ${id}`, location: { view: 'docs' }, result: `解释 ${id}`, error: null,
  model: 'fixture-model', prompt: '当时的 Prompt', source: { label: '当时的 API', connection_id: 'old', provider: 'openai-compatible', endpoint: 'https://old.invalid/v1' },
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', ...extra });
beforeEach(async () => {
  intercept = null; closeQuickExplanationPanel(); closeTranscriptView(); dom.setSelection(''); dom.location.hash = '';
  world.state.quickExplanations.clear(); world.state.quickExplanationSeq = 0; world.state.actions.length = 0;
  Object.assign(world.state.quickExplanationConfig, { connection_id: null, model: '', prompt: '请简洁解释所选文字。', ready: false, reason: '请选择解释的模型来源与模型。' });
  world.state.agentConnections.connections = [{ id: '11111111-1111-4111-8111-111111111111', label: '测试 Lush API', provider: 'openai-compatible', auth_type: 'api_key',
    endpoint: 'https://models.invalid/v1', enabled: true, models: ['fixture-model', 'second-model'], credential: { status: 'configured' } }];
  await boot(); calls.length = 0;
});
afterAll(() => { closeQuickExplanationPanel(); closeTranscriptView(); dom.restore(); });

test('快捷解释独立导航和 hash 加载本地配置与全项目历史，不调用模型', async () => {
  await dom.node('quick-explain-open').onclick();
  expect(dom.location.hash).toBe('#quick-explain'); expect(ui.view.id).toBe('quick-explain');
  expect(dom.node('quick-explain-open').getAttribute('aria-current')).toBe('page');
  expect(dom.node('view-title').textContent).toBe('快捷解释');
  expect(calls.map(call => call.url)).toEqual(['/api/quick-explain/config', '/api/agent/connections', '/api/quick-explain/history?limit=30']);
  expect(world.state.actions).toHaveLength(0); expect(deepText(dom.node('detail'))).toContain('还没有解释记录');
  activateDetailView({ view: 'overview' }); dom.location.hash = '#quick-explain'; await dom.fire('hashchange');
  expect(ui.view.id).toBe('quick-explain'); expect(field('prompt').value).toBe('请简洁解释所选文字。');
});

test('来源只显示受支持的启用 API Key，模型候选保持手输并保存物理 ID 与自定义 Prompt', async () => {
  const first = world.state.agentConnections.connections[0];
  world.state.agentConnections.connections.push({ ...first, id: 'oauth', auth_type: 'oauth', provider: 'openai-codex' },
    { ...first, id: 'kimi', provider: 'kimi-coding' }, { ...first, id: 'disabled', enabled: false },
    { ...first, id: 'other', label: '另一 API', models: ['vendor/model'] });
  await openQuickExplanationPage();
  expect(field('connection_id').children.map(node => node.value)).toEqual(['', first.id, 'other']);
  field('connection_id').value = first.id; field('connection_id').onchange();
  expect(field('model_choice').children.map(node => node.value)).toEqual(['', 'fixture-model', 'second-model']);
  field('model_choice').value = 'second-model'; field('model_choice').onchange();
  expect(field('model').value).toBe('second-model');
  field('connection_id').value = 'other'; field('connection_id').onchange(); expect(field('model').value).toBe('second-model');
  expect(deepText(dom.node('detail'))).toContain('当前模型不在来源范围内');
  field('model').value = 'vendor/model'; field('model').oninput(); field('prompt').value = '用英文详细解释'; field('prompt').oninput();
  await findByText(dom.node('detail'), '保存解释设置').onclick();
  expect(world.state.actions).toEqual([{ method: 'quick_explain.configure', params: { config: { connection_id: 'other', model: 'vendor/model', prompt: '用英文详细解释' } } }]);
  expect(deepText(dom.node('detail'))).toContain('没有发起模型调用');
  findByText(dom.node('detail'), '恢复默认 Prompt').onclick(); expect(field('prompt').value).toBe('请简洁解释所选文字。');
  expect(world.state.actions).toHaveLength(1);
});

test('没有手填列表时只读本地目录，保留合法 slash 模型 ID，目录失败不阻止手输', async () => {
  world.state.agentConnections.connections[0].models = []; world.state.agentConnections.connections[0].provider = 'deepseek'; ready();
  intercept = url => url.startsWith('/api/agent/connections/models?') ? json({ version: 1, status: 'cached', models: [{ id: 'deepseek/vendor/chat' }] }) : null;
  await openQuickExplanationPage(); expect(field('model_choice').children.map(node => node.value)).toEqual(['', 'vendor/chat']);
  expect(field('model').value).toBe('fixture-model');
  field('model_choice').value = 'vendor/chat'; field('model_choice').onchange();
  expect(field('model').value).toBe('vendor/chat'); expect(world.state.actions).toHaveLength(0);
});

test('任意非语义选区右键解释直连新 API，保留引用、原页面与选区，无选区不调用', async () => {
  ready(); const target = dom.document.createElement('p'); target.textContent = '页面消息'; dom.node('detail').append(target);
  dom.setSelection('选中的原文\n第二行'); await dom.fire('contextmenu', { target, clientX: 1, clientY: 2, preventDefault() {} });
  const menu = dom.node('context-menu'), explain = findByText(menu, '解释');
  expect(explain.classList.contains('agent-call')).toBe(true); expect(explain.getAttribute('data-help')).toContain('会直连你配置的模型');
  expect(deepText(menu)).toContain('引用：所选文字');
  let preserved = false; menu.onmousedown({ preventDefault() { preserved = true; } }); expect(preserved).toBe(true);
  const view = ui.view; await explain.onclick(); await until(() => panel() && deepText(panel()).includes('快捷解释示例'));
  expect(ui.view).toBe(view); expect(dom.window.getSelection().toString()).toBe('选中的原文\n第二行');
  expect(world.state.actions.map(action => action.method)).toEqual(['quick_explain.start']);
  expect(world.state.actions[0].params.quote).toBe('选中的原文\n第二行');
  expect(world.state.actions[0].params.location.view).toBe('overview');
  dom.setSelection(''); await dom.fire('contextmenu', { target, preventDefault() {} }); expect(findByText(menu, '解释')).toBeNull();
});

test('父侧折叠改动概览展开后的文件选区仍可解释，不发送整块 diff 或创建 Worker', async () => {
  ready();
  const diff = renderDiff({ branch:'lush/demo',target_branch:'main',committed:true,
    base_commit:'a'.repeat(40),head_commit:'b'.repeat(40),files_total:1,pending_total:0,
    added:2,deleted:1,pending_added:0,pending_deleted:0,
    files:[{ path:'src/example.js',added:2,deleted:1 }],pending:[],commits:[] },7);
  dom.node('detail').append(diff);
  const disclosure = diff.querySelector('.diff-files'); expect(disclosure.open).not.toBe(true);
  disclosure.open = true; const target = disclosure.querySelector('.path');
  dom.setSelection('src/example.js'); await dom.fire('contextmenu',{ target,preventDefault() {} });
  const explain = findByText(dom.node('context-menu'),'解释'); expect(explain).toBeTruthy(); explain.onclick();
  await until(() => world.state.actions.some(action => action.method === 'quick_explain.start'));
  expect(world.state.actions).toHaveLength(1);
  expect(world.state.actions[0].params.quote).toBe('src/example.js');
  expect(world.state.actions[0].params).not.toHaveProperty('id');
});

test('超长选区和输入控件选区不发送；未配置显示设置入口不发模型请求', async () => {
  ready(); const target = dom.document.createElement('p'); target.textContent = '页面文字';
  dom.setSelection('x'.repeat(8193)); await dom.fire('contextmenu', { target, preventDefault() {} });
  findByText(dom.node('context-menu'), '解释').onclick(); await until(() => panel());
  expect(deepText(panel())).toContain('没有截断或发送'); expect(world.state.actions).toHaveLength(0);
  const input = dom.document.createElement('textarea'); input.textContent = '不可发出的输入';
  await dom.fire('contextmenu', { target: input, preventDefault() {} }); expect(dom.node('context-menu').hidden).toBe(true);
  world.state.quickExplanationConfig.ready = false;
  await startQuickExplanation('待解释', { view: 'settings' }); expect(deepText(panel())).toContain('选择快捷解释');
  expect(panel().querySelector('a').href).toBe('#quick-explain'); expect(world.state.actions).toHaveLength(0);
});

test('项目全历史有界分页，点击只读记录显示原文、结果及当时配置快照', async () => {
  for (let id = 1; id <= 35; id++) world.state.quickExplanations.set(id, row(id));
  await openQuickExplanationPage(); expect(dom.node('detail').querySelectorAll('.quick-explanation-history-row')).toHaveLength(30);
  expect(deepText(dom.node('detail'))).toContain('来源快照见详情');
  expect(deepText(dom.node('detail'))).not.toContain('历史来源未知');
  await findByText(dom.node('detail'), '加载更早解释').onclick();
  expect(dom.node('detail').querySelectorAll('.quick-explanation-history-row')).toHaveLength(35);
  expect(calls.at(-1).url).toContain('before=6');
  await dom.node('detail').querySelectorAll('.quick-explanation-history-open')[0].onclick();
  expect(deepText(panel())).toContain('原文 35'); expect(deepText(panel())).toContain('解释 35');
  expect(deepText(panel())).toContain('当时的 Prompt'); expect(deepText(panel())).toContain('当时的 API');
  expect(world.state.actions).toHaveLength(0);
});

test('历史记录可删除：先确认再发送 delete，运行中的记录禁用删除', async () => {
  world.state.quickExplanations.set(1, row(1));
  world.state.quickExplanations.set(2, row(2, { status: 'running', result: null }));
  await openQuickExplanationPage();
  const articles = [...dom.node('detail').querySelectorAll('.quick-explanation-history-row')];
  const running = articles.find(article => deepText(article).includes('解释中')).querySelector('button.danger');
  expect(running.disabled).toBe(true);
  expect(running.parentNode.getAttribute('data-help')).toContain('结束后才能删除');
  const remove = articles.find(article => deepText(article).includes('已完成')).querySelector('button.danger');
  expect(remove.getAttribute('data-help')).toContain('永久删除');
  const cancelled = remove.onclick();
  expect(deepText(dom.node('modal'))).toContain('删除解释 #1');
  await dialogButton(dom, '保留').onclick(); await cancelled;
  expect(world.state.actions).toHaveLength(0);
  expect(dom.node('detail').querySelectorAll('.quick-explanation-history-row')).toHaveLength(2);
  const confirmed = remove.onclick();
  await dialogButton(dom, '删除').onclick(); await confirmed;
  expect(world.state.actions).toEqual([{ method: 'quick_explain.delete', params: { id: 1 } }]);
  expect(world.state.quickExplanations.has(1)).toBe(false);
  expect(dom.node('detail').querySelectorAll('.quick-explanation-history-row')).toHaveLength(1);
});

test('配置与历史迟到响应不能覆盖别的页面；保存失败保留用户输入', async () => {
  let resolve; intercept = url => url === '/api/quick-explain/config' ? new Promise(done => { resolve = done; }) : null;
  const opening = openQuickExplanationPage(); activateDetailView({ view: 'settings' }); dom.node('detail').replaceChildren(dom.document.createElement('h1'));
  resolve(json(world.state.quickExplanationConfig)); await opening;
  expect(ui.view.id).toBe('settings'); expect(dom.node('detail').querySelector('.quick-explanation-form')).toBeNull();
  intercept = null; ready(); await openQuickExplanationPage(); field('prompt').value = '未保存 Prompt';
  intercept = (url, options) => url === '/api/action' ? Promise.reject(new Error('拒绝保存')) : null;
  await findByText(dom.node('detail'), '保存解释设置').onclick();
  expect(field('prompt').value).toBe('未保存 Prompt'); expect(deepText(dom.node('detail'))).toContain('保存失败');
});

test('关闭或导航作废在途结果，不取消后台模型；新请求不会被旧响应覆盖', async () => {
  ready(); let resolve;
  intercept = (url, options) => url === '/api/action' ? new Promise(done => { resolve = done; }) : null;
  const starting = startQuickExplanation('第一次', { view: 'docs' }); await until(() => resolve);
  closeQuickExplanationPanel(); resolve(json(row(99))); await starting; expect(panel()).toBeNull();
  expect(calls.some(call => call.options.body && String(call.options.body).includes('cancel'))).toBe(false);
  intercept = null; await startQuickExplanation('第二次', { view: 'settings' }); expect(deepText(panel())).toContain('第二次');
  activateDetailView({ view: 'settings' }); expect(panel()).toBeNull();
});

test('执行详情 dialog 内提供解释面板；Esc 只关解释，关闭详情清理轮询', async () => {
  ready(); transcriptCache.set(1, { files: ['x'], order: 'desc', steps: [{ seq: 1, kind: 'text', body: '执行消息', title: '回答', file: 'x' }], next: 1, oldest: 1 });
  await openTranscriptView(1); const dialog = ui.transcriptView.panel;
  await startQuickExplanation('执行消息', { view: 'task', task_id: 1 });
  expect(panel().parentNode).toBe(dialog);
  let stopped = false;
  await dom.fire('keydown', { key: 'Escape', target: dialog, preventDefault() {}, stopPropagation() { stopped = true; } });
  expect(stopped).toBe(true); expect(panel()).toBeNull(); expect(ui.transcriptView.panel).toBe(dialog);
  await startQuickExplanation('再次解释', { view: 'task', task_id: 1 }); closeTranscriptView(); expect(panel()).toBeNull();
});

test('running 读取计时器在关闭及 boot 清理；正文不变不重绘选区', async () => {
  const timers = new Map(); let seq = 0;
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  globalThis.setTimeout = fn => { timers.set(++seq, fn); return seq; }; globalThis.clearTimeout = id => timers.delete(id);
  world.state.quickExplanations.set(1, row(1, { status: 'running', result: null }));
  try {
    await openQuickExplanation(1); expect(timers.size).toBe(1);
    const before = panel().children[2].children[0];
    const [id, tick] = [...timers][0]; timers.delete(id); await tick();
    expect(panel().children[2].children[0]).toBe(before); expect(timers.size).toBe(1);
    closeQuickExplanationPanel(); expect(timers.size).toBe(0);
    await openQuickExplanation(1); expect(timers.size).toBe(1); await boot(); expect(timers.size).toBe(0); expect(panel()).toBeNull();
  } finally { closeQuickExplanationPanel(); globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; }
});

test('未选项目的全局工作台禁用快捷解释导航，不从菜单或调用读取项目 API', async () => {
  intercept = url => url === '/api/host' ? json({ mode: 'host', projects: [] }) : url === '/api/host/projects' ? json({ projects: [] }) : null;
  await boot(); calls.length = 0;
  expect(dom.node('quick-explain-open').disabled).toBe(true);
  const target = dom.document.createElement('p'); target.textContent = '全局文档'; dom.setSelection('选中文字');
  await dom.fire('contextmenu', { target, preventDefault() {} }); expect(findByText(dom.node('context-menu'), '解释')).toBeNull();
  await startQuickExplanation('选中文字', { view: 'docs' }); expect(deepText(panel())).toContain('请先打开'); expect(calls).toHaveLength(0);
});

test('历史刷新失败保留已有记录并允许重试；配置读取失败不阻断历史', async () => {
  world.state.quickExplanations.set(1, row(1));
  intercept = url => url === '/api/quick-explain/config' ? Promise.reject(new Error('配置暂不可用')) : null;
  await openQuickExplanationPage(); expect(deepText(dom.node('detail'))).toContain('配置读取失败');
  expect(dom.node('detail').querySelectorAll('.quick-explanation-history-row')).toHaveLength(1);
  intercept = url => url.startsWith('/api/quick-explain/history') ? Promise.reject(new Error('读取失败')) : null;
  await findByText(dom.node('detail'), '刷新历史').onclick();
  expect(dom.node('detail').querySelectorAll('.quick-explanation-history-row')).toHaveLength(1);
  expect(deepText(dom.node('detail'))).toContain('已加载记录保留');
  intercept = null; await findByText(dom.node('detail'), '重试读取配置').onclick(); expect(field('prompt')).toBeTruthy();
});

test('最终响应不替换面板内当前选区，放开选区后显示完成结果', async () => {
  const timers = new Map(); let seq = 0;
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout, getSelection = dom.window.getSelection;
  globalThis.setTimeout = fn => { timers.set(++seq, fn); return seq; }; globalThis.clearTimeout = id => timers.delete(id);
  world.state.quickExplanations.set(1, row(1, { status: 'running', result: null }));
  try {
    await openQuickExplanation(1); const content = panel().children[2], quote = content.children[2];
    dom.window.getSelection = () => ({ isCollapsed: false, anchorNode: quote, focusNode: quote, toString: () => '选区' });
    world.state.quickExplanations.set(1, row(1));
    let [id, tick] = [...timers][0]; timers.delete(id); await tick();
    expect(content.children[2]).toBe(quote); expect(deepText(panel())).toContain('正在调用'); expect(timers.size).toBe(1);
    dom.window.getSelection = getSelection;
    [id, tick] = [...timers][0]; timers.delete(id); await tick();
    expect(deepText(panel())).toContain('解释 1'); expect(timers.size).toBe(0);
  } finally { dom.window.getSelection = getSelection; closeQuickExplanationPanel(); globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; }
});

test('父侧保留的旧 running 历史没有调用快照，不被误报为活动请求或无限轮询', async () => {
  world.state.quickExplanations.set(1, row(1, { status: 'running', result: null, source: null, prompt: null }));
  const originalSet = globalThis.setTimeout; let timers = 0;
  globalThis.setTimeout = () => { timers++; return 1; };
  try {
    await openQuickExplanation(1);
    expect(deepText(panel())).toContain('历史状态：运行中（未恢复）');
    expect(deepText(panel())).toContain('不会自动重新执行'); expect(timers).toBe(0); expect(world.state.actions).toHaveLength(0);
  } finally { closeQuickExplanationPanel(); globalThis.setTimeout = originalSet; }
});

test('样式与主页面引用有双主题 token、窄屏布局与键盘焦点', () => {
  const css = fs.readFileSync(new URL('../../src/ui/web/assets/styles-quick-explanation.css', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../../src/ui/web/assets/index.html', import.meta.url), 'utf8');
  expect(css).toContain('var(--panel)'); expect(css).toContain(':focus-visible'); expect(css).toContain('@media');
  expect(html).toContain('/styles-quick-explanation.css'); expect(html).toContain('id="quick-explain-open"');
});
