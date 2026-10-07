import { afterAll, expect, test } from 'bun:test';
import { deepText, installDom } from '../dom-stub.js';

const first = '44444444-4444-4444-8444-444444444444';
const second = '55555555-5555-4555-8555-555555555555';
const third = '66666666-6666-4666-8666-666666666666';
const rows = [
  { id: first, provider: 'deepseek', models: ['deepseek-flash'], default_model: 'deepseek-flash' },
  { id: second, provider: 'openai-compatible', models: ['vendor/model', 'alternative'], default_model: 'vendor/model', default_thinking: 'high' },
  { id: third, provider: 'openai-compatible', models: ['third-model'], default_model: '' },
].map(row => ({ ...row, label: row.id, endpoint: 'https://models.example/v1', enabled: true, auth_type: 'api_key', credential: { status: 'configured' } }));
const json = data => ({ ok: true, json: async () => data });
const calls = [];
let catalogIntercept = null;
const dom = installDom({ fetch: async url => {
  const target = String(url); calls.push(target);
  if (target === '/api/agent/connections') return json({ version: 1, connections: rows });
  if (target.startsWith('/api/agent/connections/models?id=')) return catalogIntercept ? catalogIntercept(target) : json({ version: 1, status: 'unknown', models: [] });
  throw new Error(`unexpected request ${target}`);
} });
const { createAgentConnectionPicker } = await import('../../src/ui/web/assets/agent-connection-picker.js');
afterAll(() => dom.restore());
const setup = (applyDefaultModelOnChange = true) => {
  let current = true;
  const backend = dom.document.createElement('select'); backend.value = 'pi';
  const model = dom.document.createElement('input'); model.value = 'deepseek/deepseek-flash';
  const picker = createAgentConnectionPicker({ backend, model, connectionId: first, applyDefaultModelOnChange, ownsPage: () => current });
  return { backend, model, picker, leave: () => { current = false; } };
};
const choose = (picker, id) => { picker.connection.value = id; picker.connection.onchange(); };
const settled = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('Worker 主动切换来源填入默认模型，保留物理 ID 的斜杠，不依赖目录', async () => {
  calls.length = 0;
  const { model, picker } = setup(); await picker.load();
  expect(model.value).toBe('deepseek/deepseek-flash');
  choose(picker, second);
  expect(model.value).toBe('openai-compatible/vendor/model');
  expect(picker.validate()).toBeNull();
  expect(deepText(picker.node)).toContain('思考深度不变');
  model.value = 'openai-compatible/alternative';
  await picker.load(); await settled(); picker.sync();
  expect(model.value).toBe('openai-compatible/alternative');
  choose(picker, second); // Same selection is not a source switch.
  expect(model.value).toBe('openai-compatible/alternative');
  expect(calls.every(url => url === '/api/agent/connections' || url.startsWith('/api/agent/connections/models?id='))).toBe(true);
});

test('无默认模型保留旧值并提示，跨来源不匹配仍拒绝保存，不猜选首项', async () => {
  const { model, picker } = setup(); await picker.load(); choose(picker, third);
  expect(model.value).toBe('deepseek/deepseek-flash');
  expect(deepText(picker.node)).toContain('此来源未设置默认模型，已保留当前模型');
  expect(picker.validate()).toContain('模型范围');
  picker.models.value = 'openai-compatible/third-model'; picker.models.onchange();
  expect(model.value).toBe('openai-compatible/third-model'); expect(picker.validate()).toBeNull();
});

test('项目和新建指令的选择器默认关闭自动填入，已有默认也保留模型草稿', async () => {
  const { model, picker } = setup(false); await picker.load(); choose(picker, second); await settled();
  expect(model.value).toBe('deepseek/deepseek-flash');
  expect(deepText(picker.node)).toContain('当前模型与此来源不匹配');
});

test('重置、取消来源选择、切换执行后端与离页均不自动填入默认模型', async () => {
  const { model, picker, backend, leave } = setup(); await picker.load();
  model.value = 'draft/model'; picker.reset(second); await settled();
  expect(model.value).toBe('draft/model');
  choose(picker, ''); expect(model.value).toBe('draft/model');
  backend.value = 'codex'; choose(picker, second); expect(model.value).toBe('draft/model');
  backend.value = 'pi'; picker.sync(); expect(model.value).toBe('draft/model');
  leave(); choose(picker, first); expect(model.value).toBe('draft/model');
});

test('迟到目录不覆盖换源后手改的模型，也不应用旧来源的默认模型', async () => {
  const pending = new Map();
  catalogIntercept = target => new Promise(resolve => pending.set(target.split('id=')[1], resolve));
  try {
    const { model, picker } = setup(); await picker.load();
    choose(picker, second); expect(model.value).toBe('openai-compatible/vendor/model');
    model.value = 'openai-compatible/alternative';
    for (const id of [first, second]) pending.get(id)(json({ version: 1, status: 'fresh', models: [{ id: `${rows.find(row => row.id === id).provider}/catalog-only` }] }));
    await settled();
    expect(model.value).toBe('openai-compatible/alternative');
    expect(picker.value()).toBe(second);
  } finally { catalogIntercept = null; }
});
