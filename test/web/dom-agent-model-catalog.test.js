import { afterAll, expect, test } from 'bun:test';
import { deepText, installDom } from '../dom-stub.js';

const id = '12345678-1234-1234-1234-123456789abc';
const rows = [{ id, label: '官方账号', provider: 'openai-codex', endpoint: 'https://chatgpt.com/backend-api', enabled: true,
  models: ['gpt-5.4', 'gpt-5.4-mini'], credential: { status: 'configured' } }];
const json = data => ({ ok: true, json: async () => data });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let catalog = null, catalogIntercept = null;
const calls = [];
const dom = installDom({ fetch: (url) => {
  const target = String(url); calls.push(target);
  if (target.startsWith('/api/agent/connections/models')) {
    if (catalogIntercept) return catalogIntercept();
    return Promise.resolve(json(catalog ?? { version: 1, id, checked_at: null, status: 'unsupported', source: null, models: [] }));
  }
  return Promise.resolve(json({ version: 1, connections: rows }));
} });
const { createAgentConnectionPicker } = await import('../../src/ui/web/assets/agent-connection-picker.js');
afterAll(() => dom.restore());

const setup = (connectionId = '') => {
  let current = true;
  const backend = dom.document.createElement('select'); backend.value = 'pi';
  const model = dom.document.createElement('input'); model.value = '';
  const picker = createAgentConnectionPicker({ backend, model, connectionId, ownsPage: () => current });
  picker.sync();
  return { backend, model, picker, leave: () => { current = false; } };
};
const settled = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

test('已选来源完整展示手动列表，目录仅补充匹配元数据且不自动选中', async () => {
  calls.length = 0; catalogIntercept = null;
  catalog = { version: 1, id, checked_at: '2026-10-01T09:00:00.000Z', status: 'fresh', source: 'listing',
    models: [{ id: 'openai-codex/gpt-5.4', name: 'GPT-5.4', thinking_levels: ['minimal', 'medium', 'high'] },
      { id: 'openai-codex/gpt-5.4-mini', name: 'GPT-5.4 mini', thinking_levels: ['minimal', 'medium'] },
      // 目录里但不在用户手动范围：不得成为可选项（否则会以“模型范围”验证失败）。
      { id: 'openai-codex/gpt-4o', name: 'Out of range', thinking_levels: ['low'] }] };
  const { picker, model } = setup(id);
  await picker.load(); await settled();
  expect(calls.filter(url => url === '/api/agent/connections')).toHaveLength(1);
  expect(calls.filter(url => url === `/api/agent/connections/models?id=${id}`)).toHaveLength(1);
  expect(picker.models.children.map(node => node.value)).toEqual(['', 'openai-codex/gpt-5.4', 'openai-codex/gpt-5.4-mini']);
  expect(model.value).toBe('');
  expect(deepText(picker.node)).toContain('思考 minimal/medium/high');
  picker.models.value = 'openai-codex/gpt-5.4'; picker.models.onchange();
  expect(model.value).toBe('openai-codex/gpt-5.4');
  expect(picker.thinkingLevels()).toEqual(['minimal', 'medium', 'high']);
  expect(deepText(picker.node)).toContain('缓存目录已更新');
});

test('目录缺失或失败退回已保存范围，明确可手填且不返回思考等级', async () => {
  catalog = null;
  catalogIntercept = () => Promise.reject(new Error('目录不可用'));
  const { picker, model } = setup(id);
  await picker.load(); await settled();
  expect(picker.models.children.map(node => node.value)).toEqual(['', 'openai-codex/gpt-5.4', 'openai-codex/gpt-5.4-mini']);
  expect(deepText(picker.node)).toContain('模型目录读取失败');
  expect(deepText(picker.node)).toContain('可手填');
  model.value = 'openai-codex/gpt-5.4';
  expect(picker.thinkingLevels()).toBeNull();
  expect(picker.validate()).toBeNull();
  catalogIntercept = null;
});

test('部分目录不隐藏手动填写模型，不混入其他来源或范围外模型', async () => {
  catalogIntercept = null; calls.length = 0;
  catalog = { version: 1, id, status: 'cached', source: 'pi-local', models: [
    { id: 'openai-codex/gpt-5.4', name: 'GPT-5.4', thinking_levels: ['high'] },
    { id: 'openai-codex/outside', name: '范围外模型' },
    { id: 'deepseek/other', name: '其他来源' },
  ] };
  const { picker, model } = setup(id);
  model.value = 'openai-codex/gpt-5.4-mini';
  await picker.load(); await settled();
  expect(picker.models.children.map(node => node.value)).toEqual(['', 'openai-codex/gpt-5.4', 'openai-codex/gpt-5.4-mini']);
  expect(model.value).toBe('openai-codex/gpt-5.4-mini');
  expect(picker.models.hidden).toBe(false); expect(picker.models.disabled).toBe(false);
  expect(deepText(picker.node)).toContain('候选模型来自你在模型来源页填写的列表');
  expect(picker.thinkingLevels()).toBeNull();
  expect(picker.validate()).toBeNull();
  expect(calls.every(url => url === '/api/agent/connections' || url.startsWith('/api/agent/connections/models?id='))).toBe(true);
});

test('空列表引导来源页填写，保存后重读连接即可选择且不自动改草稿', async () => {
  const original = rows[0].models;
  catalog = null; catalogIntercept = null;
  try {
    rows[0].models = [];
    const { picker, model } = setup(id);
    await picker.load(); await settled();
    expect(picker.models.hidden).toBe(false); expect(picker.models.disabled).toBe(true);
    expect(deepText(picker.node)).toContain('填写并保存“模型列表”');
    expect(picker.node.querySelector('a').textContent).toBe('填写来源模型列表');
    expect(picker.node.querySelector('a').href).toBe(`/#model-source-${id}`);
    rows[0].models = ['my-codex-model'];
    await picker.load(); await settled();
    expect(picker.models.children.map(node => node.value)).toEqual(['', 'openai-codex/my-codex-model']);
    expect(picker.models.disabled).toBe(false); expect(model.value).toBe('');
    picker.models.value = 'openai-codex/my-codex-model'; picker.models.onchange();
    expect(model.value).toBe('openai-codex/my-codex-model'); expect(picker.validate()).toBeNull();
  } finally { rows[0].models = original; }
});

test('未填写范围时保留同来源的缓存候选，不混入其他服务商', async () => {
  const original = rows[0].models;
  catalogIntercept = null;
  catalog = { version: 1, id, status: 'cached', models: [
    { id: 'openai-codex/catalog-only', name: '目录模型' }, { id: 'deepseek/other', name: '其他来源' },
  ] };
  try {
    rows[0].models = [];
    const { picker, model } = setup(id); await picker.load(); await settled();
    expect(picker.models.children.map(node => node.value)).toEqual(['', 'openai-codex/catalog-only']);
    expect(picker.models.disabled).toBe(false); expect(model.value).toBe('');
  } finally { rows[0].models = original; }
});

test('未选来源不读取目录；只读本地缓存，不触发额度查询或刷新', async () => {
  calls.length = 0; catalogIntercept = null;
  const { picker } = setup('');
  await picker.load(); await settled();
  expect(calls.filter(url => url.startsWith('/api/agent/connections/models'))).toHaveLength(0);
  expect(calls.some(url => url.includes('history') || url.includes('selection/resources'))).toBe(false);
});

test('迟到目录响应不覆盖已离开页面的表单，也不静默替换已选模型', async () => {
  const pending = deferred();
  catalogIntercept = () => pending.promise;
  const { picker, model, leave } = setup(id);
  model.value = 'old/model';
  const loading = picker.load();
  leave();
  pending.resolve(json({ version: 1, id, checked_at: null, status: 'fresh', source: 'provider_list',
    models: [{ id: 'openai-codex/other', name: 'Other', thinking_levels: ['low'] }] }));
  await loading; await settled();
  catalogIntercept = null;
  expect(model.value).toBe('old/model');
  expect(picker.models.children.map(node => node.value)).not.toContain('openai-codex/other');
});
