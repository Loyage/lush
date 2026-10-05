import { afterAll, expect, test } from 'bun:test';
import { deepText, installDom } from '../dom-stub.js';

const id = '12345678-1234-1234-1234-123456789abc';
const rows = [{ id, label: '我的中转 API', provider: 'openai-compatible', endpoint: 'https://proxy.invalid/v1', enabled: true,
  models: ['model-a', 'model-b'], credential: { status: 'configured' } },
  { id: '87654321-4321-4321-4321-cba987654321', label: '官方账号', provider: 'deepseek', endpoint: 'https://api.deepseek.com', enabled: true,
    models: ['flash'], credential: { status: 'configured' } }];
let intercept = null, calls = [];
const json = data => ({ ok: true, json: async () => data });
const dom = installDom({ fetch: (url, options) => { calls.push({ url: String(url), options }); return intercept?.() ?? Promise.resolve(json({ version: 1, connections: rows })); } });
const { createAgentConnectionPicker } = await import('../../src/ui/web/assets/agent-connection-picker.js');
afterAll(() => dom.restore());
const setup = (connectionId = '') => {
  let current = true;
  const backend = dom.document.createElement('select'); backend.value = 'pi';
  const model = dom.document.createElement('input'); model.value = 'old/model';
  const picker = createAgentConnectionPicker({ backend, model, connectionId, ownsPage: () => current }); picker.sync();
  return { backend, model, picker, leave: () => { current = false; } };
};
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('来源列表只读本地，不自动选择来源或模型；来源模型与其他CLI目录隔离', async () => {
  const { picker, model } = setup(); calls = [];
  await picker.load(); expect(calls).toEqual([{ url: '/api/agent/connections', options: undefined }]);
  expect(picker.value()).toBe(''); expect(model.value).toBe('old/model');
  expect(picker.connection.children[0].textContent).toBe('请选择 Lush 模型来源');
  expect(picker.validate()).toContain('Pi 未选择来源时无法启动');
  picker.connection.value = id; picker.connection.onchange();
  expect(picker.models.children.map(node => node.value)).toEqual(['', 'openai-compatible/model-a', 'openai-compatible/model-b']);
  expect(model.value).toBe('old/model'); expect(deepText(picker.node)).toContain('当前模型与此来源不匹配'); expect(picker.validate()).toContain('模型范围');
  picker.models.value = 'openai-compatible/model-b'; picker.models.onchange();
  expect(model.value).toBe('openai-compatible/model-b'); expect(picker.validate()).toBeNull();
  expect(picker.node.querySelector('a').href).toBe(`#model-source-${id}`);
});

test('读取期间用户改模型与来源保持不变，重复读取单飞', async () => {
  const pending = deferred(); intercept = () => pending.promise; calls = [];
  const { picker, model } = setup(id);
  const first = picker.load(), second = picker.load();
  model.value = 'openai-compatible/model-b';
  pending.resolve(json({ version: 1, connections: rows })); await Promise.all([first, second]); intercept = null;
  expect(calls).toHaveLength(1); expect(picker.value()).toBe(id); expect(model.value).toBe('openai-compatible/model-b');
  expect(picker.validate()).toBeNull(); expect(deepText(picker.node)).toContain('我的中转 API');
});

test('连接读取失败不改草稿，离页迟到读取不改旧DOM', async () => {
  const { picker, model } = setup(id); intercept = () => Promise.reject(new Error('fail'));
  await picker.load(); intercept = null;
  expect(picker.value()).toBe(id); expect(model.value).toBe('old/model'); expect(deepText(picker.node)).toContain('连接列表读取失败');
  const pending = deferred(); intercept = () => pending.promise;
  const other = setup(id), reading = other.picker.load(); other.leave();
  const content = deepText(other.picker.node); pending.resolve(json({ version: 1, connections: rows })); await reading; intercept = null;
  expect(deepText(other.picker.node)).toBe(content); expect(other.model.value).toBe('old/model');
});

test('Codex CLI如实禁用托管来源，切回Pi保留选择；Pi不允许空来源', async () => {
  const { picker, backend, model } = setup(id); await picker.load();
  backend.value = 'codex'; picker.sync();
  expect(picker.connection.disabled).toBe(true); expect(picker.value()).toBe(''); expect(deepText(picker.node)).toContain('Codex CLI 沿用原认证');
  expect(picker.validate()).toBeNull();
  backend.value = 'pi'; picker.sync(); expect(picker.value()).toBe(id);
  picker.reset(''); expect(model.value).toBe('old/model'); expect(picker.validate()).toContain('请选择 Lush 模型来源');
  expect(picker.node.querySelector('a').href).toBe('#model-sources');
});

test('Pi必须确认来源并选择明确模型，缺项与凭证失败保留草稿', async () => {
  const { picker, model } = setup(id); model.value = 'openai-compatible/model-a';
  expect(picker.validate()).toContain('请先读取项目连接');
  await picker.load(); model.value = ''; expect(picker.validate()).toContain('请选择来源内模型');
  model.value = 'openai-compatible/model-a';
  const original = rows[0].credential;
  try {
    for (const status of ['unconfigured', 'unknown', 'expired']) {
      rows[0].credential = { status }; await picker.load();
      expect(picker.validate()).toContain('凭证不可用'); expect(model.value).toBe('openai-compatible/model-a');
    }
  } finally { rows[0].credential = original; }
  await picker.load(); expect(picker.validate()).toBeNull();
});

test('托管Codex OAuth过期可交受信runtime刷新，不误称为认证缺失', async () => {
  const oauth = { ...rows[0], provider: 'openai-codex', auth_type: 'oauth', models: ['gpt-test'], credential: { status: 'expired' } };
  intercept = () => Promise.resolve(json({ version: 1, connections: [oauth] }));
  try {
    const { picker, model } = setup(id); model.value = 'openai-codex/gpt-test'; await picker.load();
    expect(picker.validate()).toBeNull();
  } finally { intercept = null; }
});
