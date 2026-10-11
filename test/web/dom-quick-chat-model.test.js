import { afterAll, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { until } from '../helpers.js';
import { makeWorld } from './dom-world.js';
import { renderChatModel } from '../../src/ui/web/assets/quick-chat-model.js';
import { ui } from '../../src/ui/web/assets/state.js';
import { activateDetailView } from '../../src/ui/web/assets/sidebar-ui.js';

const world = makeWorld(), calls = [];
let intercept = null;
const dom = installDom({ fetch: async (url, options = {}) => {
  calls.push({ url: String(url), options });
  return intercept?.(String(url), options) || world.fetchImpl(String(url), options);
} });
const { boot } = await import('../../src/ui/web/assets/app.js');
const field = name => dom.node('detail').querySelector(`[data-quick-field="${name}"]`);
const json = data => ({ ok: true, status: 200, json: async () => data });
function openModel() {
  const identity = activateDetailView({ view: 'quick-chat-settings' });
  return renderChatModel({ container: dom.node('detail'), ownsPage: () => ui.view === identity });
}
beforeEach(async () => {
  intercept = null; dom.location.pathname = '/p/aaaaaaaaaaaaaaaa/'; dom.location.hash = ''; dom.setSelection('');
  world.state.actions = [];
  world.state.agentConnections.connections = [{ id: '11111111-1111-4111-8111-111111111111', label: '测试 API', provider: 'openai-compatible', auth_type: 'api_key', enabled: true,
    models: ['fixture-model', 'vendor/chat'], endpoint: 'https://models.invalid/v1', credential: { status: 'configured' } }];
  Object.assign(world.state.quickExplanationConfig, { connection_id: world.state.agentConnections.connections[0].id, model: 'fixture-model', ready: true, reason: null });
  await boot(); calls.length = 0;
});
afterAll(() => dom.restore());

test('共用模型组件只读设备配置，无解释历史、Prompt 编辑或模型调用', async () => {
  await openModel();
  expect(calls.map(row => row.url)).toEqual(['/api/host/settings/quick-explain/config?scope=device', '/api/host/settings/agent/connections?scope=device']);
  expect(field('prompt')).toBeNull(); expect(dom.node('detail').querySelector('.quick-explanation-history')).toBeNull();
  expect(world.state.actions).toHaveLength(0);
  const sources = dom.node('detail').querySelector('a'); expect(sources.href).toBe('/#model-sources'); expect(sources.target).toBe('_blank'); expect(sources.rel).toBe('noopener');
});

test('来源仅支持启用 API Key，候选不覆盖手输，保存仅变更共用模型而不改项目 Prompt', async () => {
  const first = world.state.agentConnections.connections[0];
  world.state.agentConnections.connections.push({ ...first, id: 'oauth', auth_type: 'oauth' }, { ...first, id: 'disabled', enabled: false },
    { ...first, id: 'kimi', provider: 'kimi-coding' }, { ...first, id: 'other', label: '另一 API', models: ['physical/model'] });
  await openModel(); expect(field('connection_id').children.map(row => row.value)).toEqual(['', first.id, 'other']);
  const group = dom.node('detail').querySelector('.agent-connection-binding'), choice = group.querySelector('.model-choice-row');
  expect(choice.children[0].querySelector('select')).toBe(field('model_choice')); expect(choice.children[1].querySelector('input')).toBe(field('model'));
  expect(field('model_choice').value).toBe('fixture-model'); field('model').value = 'vendor/chat'; field('model').oninput(); expect(field('model_choice').value).toBe('vendor/chat');
  field('connection_id').value = 'other'; await field('connection_id').onchange(); expect(field('model').value).toBe('vendor/chat');
  expect(deepText(dom.node('detail'))).toContain('当前模型不在来源范围内'); await findByText(dom.node('detail'), '保存模型设置').onclick(); expect(world.state.actions).toHaveLength(0);
  field('model_choice').value = 'physical/model'; field('model_choice').onchange(); expect(field('model').value).toBe('physical/model');
  await findByText(dom.node('detail'), '保存模型设置').onclick();
  expect(world.state.actions).toEqual([{ method: 'quick_explain.configure', params: { scope: 'device', config: { connection_id: 'other', model: 'physical/model' } } }]);
  expect(deepText(dom.node('detail'))).toContain('没有发起模型调用');
});

test('模型保存失败及在途编辑保留，迟到读取和保存不能覆盖新页', async () => {
  await openModel(); intercept = url => url.endsWith('/settings/action') ? Promise.reject(new Error('配置失败')) : null;
  field('model').value = 'vendor/chat'; field('model').oninput(); await findByText(dom.node('detail'), '保存模型设置').onclick();
  expect(field('model').value).toBe('vendor/chat'); expect(deepText(dom.node('detail'))).toContain('保存失败');
  let resolve; intercept = url => url.endsWith('/settings/action') ? new Promise(done => { resolve = done; }) : null;
  const saving = findByText(dom.node('detail'), '保存模型设置').onclick(); await until(() => resolve);
  field('model').value = '新草稿'; field('model').oninput(); resolve(json(world.state.quickExplanationConfig)); await saving;
  expect(field('model').value).toBe('新草稿'); expect(deepText(dom.node('detail'))).toContain('未保存修改');
  intercept = url => url.includes('/quick-explain/config') ? new Promise(done => { resolve = done; }) : null; resolve = null;
  const loading = openModel(); await until(() => resolve); activateDetailView({ view: 'overview' }); dom.node('detail').replaceChildren();
  resolve(json(world.state.quickExplanationConfig)); await loading;
  expect(ui.view.id).toBe('overview'); expect(field('model')).toBeNull();
});

test('旧解释资源和导航彻底删除，对话导航仅在项目工作区', () => {
  const html = fs.readFileSync(new URL('../../src/ui/web/assets/index.html', import.meta.url), 'utf8');
  expect(html).not.toContain('旧解释历史'); expect(html).not.toContain('quick-explain-history-open'); expect(html).not.toContain('quick-explain-open');
  expect(html).toContain('/styles-quick-chat.css');
  for (const name of ['explanations.js', 'quick-explanation.js', 'render-quick-explanation.js', 'styles-quick-explanation.css'])
    expect(fs.existsSync(new URL(`../../src/ui/web/assets/${name}`, import.meta.url))).toBe(false);
  expect(dom.node('quick-chat-open').disabled).toBe(false); expect(dom.node('quick-chat-settings-open').disabled).toBe(false);
});
