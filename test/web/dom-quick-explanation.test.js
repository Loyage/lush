import { afterAll, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import { installDom, deepText, findByText, dialogButton } from '../dom-stub.js';
import { until } from '../helpers.js';
import { makeWorld } from './dom-world.js';
import { openQuickExplanationPage, openQuickExplanationHistory } from '../../src/ui/web/assets/render-quick-explanation.js';
import { startQuickExplanation, openQuickExplanation, closeQuickExplanationPanel } from '../../src/ui/web/assets/quick-explanation.js';
import { ui, transcriptCache } from '../../src/ui/web/assets/state.js';
import { activateDetailView } from '../../src/ui/web/assets/sidebar-ui.js';
import { openTranscriptView, closeTranscriptView } from '../../src/ui/web/assets/transcript-view.js';
import { renderDiff } from '../../src/ui/web/assets/render-diff.js';

const world = makeWorld(), calls = [];
let intercept = null;
const dom = installDom({ fetch: async (url, options = {}) => {
  // Keep app-wide read-only policy/inbox traffic separate from explanation calls.
  if (!/^\/api\/host\/(preferences|automation|inbox)(?:[/?]|$)/.test(String(url))) calls.push({ url: String(url), options });
  const logical = String(url).replace('/api/host/settings/', '/api/').replace(/^\/p\/[a-f0-9]{16}\/api\//, '/api/').replace(/\?scope=device$/, '');
  const value = intercept?.(logical, options); return value || world.fetchImpl(String(url).replace(/^\/p\/[a-f0-9]{16}\/api\//, '/api/'), options);
} });
const { boot } = await import('../../src/ui/web/assets/app.js');
const json = value => ({ ok: true, status: 200, json: async () => value && Object.hasOwn(value, 'ready') ? { ...value, configuration_scope: { selected: 'device', source: 'device', project_override: false } } : value });
const ready = () => Object.assign(world.state.quickExplanationConfig, { connection_id: world.state.agentConnections.connections[0].id,
  model: 'fixture-model', ready: true, reason: null });
const field = name => dom.node('detail').querySelector(`[data-quick-field="${name}"]`);
const panel = () => dom.document.body.querySelector('.quick-explanation-panel');
const row = (id, extra = {}) => ({ id, status: 'completed', quote: `原文 ${id}`, location: { view: 'docs' }, result: `解释 ${id}`, error: null,
  model: 'fixture-model', prompt: '当时的 Prompt', source: { label: '当时的 API', connection_id: 'old', provider: 'openai-compatible', endpoint: 'https://old.invalid/v1' },
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', ...extra });
beforeEach(async () => {
  intercept = null; closeQuickExplanationPanel(); closeTranscriptView(); dom.setSelection(''); dom.location.pathname = '/p/aaaaaaaaaaaaaaaa/'; dom.location.hash = '';
  world.state.quickExplanations.clear(); world.state.quickExplanationSeq = 0; world.state.actions.length = 0;
  Object.assign(world.state.quickExplanationConfig, { connection_id: null, model: '', prompt: '请简洁解释所选文字。', ready: false, reason: '请选择解释的模型来源与模型。' });
  world.state.agentConnections.connections = [{ id: '11111111-1111-4111-8111-111111111111', label: '测试 Lush API', provider: 'openai-compatible', auth_type: 'api_key',
    endpoint: 'https://models.invalid/v1', enabled: true, models: ['fixture-model', 'second-model'], credential: { status: 'configured' } }];
  await boot(); calls.length = 0;
});
afterAll(() => { closeQuickExplanationPanel(); closeTranscriptView(); dom.restore(); });

test('根快捷解释导航只加载设备配置；项目历史入口独立，不调用模型', async () => {
  dom.location.pathname = '/'; dom.location.hash = ''; await boot(); calls.length = 0;
  await dom.node('quick-explain-open').onclick();
  expect(dom.location.hash).toBe('#quick-explain'); expect(ui.view.id).toBe('quick-explain');
  expect(dom.node('quick-explain-open').getAttribute('aria-current')).toBe('page');
  expect(dom.node('view-title').textContent).toBe('快捷解释配置');
  expect(calls.map(call => call.url)).toEqual(['/api/host/settings/quick-explain/config?scope=device', '/api/host/settings/agent/connections?scope=device']);
  expect(world.state.actions).toHaveLength(0); expect(deepText(dom.node('detail'))).not.toContain('还没有解释记录');
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
  expect(world.state.actions).toEqual([{ method: 'quick_explain.configure', params: { scope: 'device', config: { connection_id: 'other', model: 'vendor/model', prompt: '用英文详细解释' } } }]);
  expect(deepText(dom.node('detail'))).toContain('没有发起模型调用');
  findByText(dom.node('detail'), '恢复默认 Prompt').onclick(); expect(field('prompt').value).toBe('请简洁解释所选文字。');
  expect(world.state.actions).toHaveLength(1);
});

test('解释设置把候选和名称紧邻分组，手输同步候选且仍保存物理模型ID', async () => {
  const source = world.state.agentConnections.connections[0]; source.models.push('vendor/chat'); ready();
  await openQuickExplanationPage();
  const group = dom.node('detail').querySelector('.agent-connection-binding');
  const row = group.querySelector('.model-choice-row');
  expect(group.tagName).toBe('FIELDSET');
  expect(row.children[0].querySelector('select')).toBe(field('model_choice'));
  expect(row.children[1].querySelector('input')).toBe(field('model'));
  expect(group.children.indexOf(row)).toBeLessThan(group.children.indexOf(group.querySelector('.model-source-actions')));
  expect(field('model_choice').value).toBe('fixture-model');
  field('model').value = 'vendor/chat'; field('model').oninput(); expect(field('model_choice').value).toBe('vendor/chat');
  field('model').value = 'typed/model'; field('model').oninput(); expect(field('model_choice').value).toBe('');
  field('model_choice').value = 'vendor/chat'; field('model_choice').onchange(); expect(field('model_choice').value).toBe(field('model').value);
  await findByText(dom.node('detail'), '保存解释设置').onclick();
  expect(world.state.actions.at(-1).params.config.model).toBe('vendor/chat');
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
  expect(panel().querySelector('a').href).toBe('/#quick-explain'); expect(panel().querySelector('a').target).toBe('_blank'); expect(world.state.actions).toHaveLength(0);
});

test('项目全历史有界分页，点击只读记录显示原文、结果及当时配置快照', async () => {
  for (let id = 1; id <= 35; id++) world.state.quickExplanations.set(id, row(id));
  await openQuickExplanationHistory(); expect(dom.node('detail').querySelectorAll('.quick-explanation-history-row')).toHaveLength(30);
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
  await openQuickExplanationHistory();
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
    await openQuickExplanation(1); expect(timers.size).toBe(1); const explanationTimer = [...timers.keys()][0];
    await boot(); expect(timers.has(explanationTimer)).toBe(false); expect(panel()).toBeNull(); // global inbox owns its separate timer
  } finally { closeQuickExplanationPanel(); globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; }
});

test('未选项目可管理快捷解释配置，但菜单或模型调用仍不读取项目 API', async () => {
  intercept = url => url === '/api/host' ? json({ mode: 'host', projects: [] }) : url === '/api/host/projects' ? json({ projects: [] }) : null;
  dom.location.pathname = '/'; dom.location.hash = ''; await boot(); calls.length = 0;
  expect(dom.node('quick-explain-open').disabled).toBe(false);
  const target = dom.document.createElement('p'); target.textContent = '全局文档'; dom.setSelection('选中文字');
  await dom.fire('contextmenu', { target, preventDefault() {} }); expect(findByText(dom.node('context-menu'), '解释')).toBeNull();
  await startQuickExplanation('选中文字', { view: 'docs' }); expect(deepText(panel())).toContain('请先打开'); expect(calls).toHaveLength(0);
});

test('历史刷新失败保留已有记录并允许重试；配置读取失败不阻断历史', async () => {
  world.state.quickExplanations.set(1, row(1));
  intercept = url => url === '/api/quick-explain/config' ? Promise.reject(new Error('配置暂不可用')) : null;
  await openQuickExplanationPage(); expect(deepText(dom.node('detail'))).toContain('配置读取失败');
  expect(dom.node('detail').querySelectorAll('.quick-explanation-history-row')).toHaveLength(0);
  await openQuickExplanationHistory();
  expect(dom.node('detail').querySelectorAll('.quick-explanation-history-row')).toHaveLength(1);
  intercept = url => url.startsWith('/api/quick-explain/history') ? Promise.reject(new Error('读取失败')) : null;
  await findByText(dom.node('detail'), '刷新历史').onclick();
  expect(dom.node('detail').querySelectorAll('.quick-explanation-history-row')).toHaveLength(1);
  expect(deepText(dom.node('detail'))).toContain('已加载记录保留');
  intercept = null; await findByText(dom.node('detail'), '刷新历史').onclick(); await openQuickExplanationPage(); expect(field('prompt')).toBeTruthy();
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

test('完成的解释提供追问输入：发送 action 并渲染问答，空问题不发送', async () => {
  world.state.quickExplanations.set(1, row(1));
  await openQuickExplanation(1);
  const form = panel().querySelector('.quick-explanation-followup-form');
  expect(form).toBeTruthy();
  const send = findByText(form, '发送追问');
  expect(send.classList.contains('agent-call')).toBe(true);
  expect(send.getAttribute('data-help')).toContain('会直连你配置的模型');
  await form.onsubmit({ preventDefault() {} });
  expect(world.state.actions).toHaveLength(0);
  expect(deepText(panel())).toContain('请输入追问内容');
  form.querySelector('textarea').value = '为什么会这样？';
  await form.onsubmit({ preventDefault() {} });
  expect(world.state.actions).toEqual([{ method: 'quick_explain.followup', params: { id: 1, question: '为什么会这样？' } }]);
  expect(deepText(panel())).toContain('为什么会这样？');
  expect(deepText(panel())).toContain('这是对追问的示例回答');
});

test('旧解释没有来源快照和未完成解释都不显示追问表单', async () => {
  world.state.quickExplanations.set(1, row(1, { source: null, prompt: null }));
  await openQuickExplanation(1);
  expect(panel().querySelector('.quick-explanation-followup-form')).toBeNull();
  expect(deepText(panel())).toContain('没有来源快照');
  closeQuickExplanationPanel();
  world.state.quickExplanations.set(2, row(2, { status: 'running', result: null }));
  await openQuickExplanation(2);
  expect(panel().querySelector('.quick-explanation-followup-form')).toBeNull();
  closeQuickExplanationPanel();
});

test('追问轮次展示截断提示，运行中的追问禁用发送并持续轮询到完成', async () => {
  world.state.quickExplanations.set(1, row(1, { followups: [
    { id: 1, question: '早先的追问', answer: '旧回答', status: 'completed', error: null, truncated: true, created_at: 't1', updated_at: 't1' },
  ] }));
  await openQuickExplanation(1);
  expect(deepText(panel())).toContain('早先的追问');
  expect(deepText(panel())).toContain('更早的追问已超出上下文上限');
  intercept = (url, options) => {
    if (url !== '/api/action') return null;
    const body = JSON.parse(options.body);
    if (body.method !== 'quick_explain.followup') return null;
    const turn = { id: 2, question: body.params.question, answer: null, status: 'running', error: null, truncated: false, created_at: 't2', updated_at: 't2' };
    const record = row(1, { followups: [...world.state.quickExplanations.get(1).followups, turn] });
    world.state.quickExplanations.set(1, record);
    return json(record);
  };
  const form = panel().querySelector('.quick-explanation-followup-form');
  form.querySelector('textarea').value = '新的追问';
  await form.onsubmit({ preventDefault() {} });
  expect(deepText(panel())).toContain('正在生成回答');
  expect(panel().querySelector('.quick-explanation-followup-form').querySelector('textarea').disabled).toBe(true);
  world.state.quickExplanations.set(1, row(1, { followups: [
    { id: 1, question: '早先的追问', answer: '旧回答', status: 'completed', error: null, truncated: true, created_at: 't1', updated_at: 't1' },
    { id: 2, question: '新的追问', answer: '完成回答', status: 'completed', error: null, truncated: false, created_at: 't2', updated_at: 't3' },
  ] }));
  intercept = null;
  await until(() => deepText(panel()).includes('完成回答'));
  expect(panel().querySelector('.quick-explanation-followup-form').querySelector('textarea').disabled).toBe(false);
});

test('历史摘要显示追问轮数', async () => {
  world.state.quickExplanations.set(1, row(1, { followups: [
    { id: 1, question: 'q', answer: 'a', status: 'completed', error: null, truncated: false, created_at: 't', updated_at: 't' },
  ] }));
  await openQuickExplanationHistory();
  expect(deepText(dom.node('detail'))).toContain('追问 1 轮');
});
