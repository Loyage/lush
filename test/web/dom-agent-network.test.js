import { afterAll, beforeEach, expect, test } from 'bun:test';
import { deepText, installDom } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';

const world = makeWorld(), requests = [];
const json = value => ({ ok: true, status: 200, json: async () => ({ ...value, configuration_scope: { selected: 'device', source: 'device' } }) });
const failure = error => ({ ok: false, status: 400, json: async () => ({ error }) });
const model = (extra = {}) => ({ version: 1, mode: 'inherit', proxy_url: null, no_proxy: [], has_proxy_auth: false, ...extra });
let response = model(), intercept = null, current = true, sequence = 0;
const dom = installDom({ fetch: async (url, options) => {
  requests.push({ url: String(url), options });
  const logical = String(url).replace('/api/host/settings/', '/api/').replace(/\?scope=device$/, '');
  const custom = intercept?.(logical, options); if (custom !== undefined) return custom;
  if (logical === '/api/agent/network') return json(response);
  if (logical === '/api/action' && JSON.parse(options.body).method === 'agent.network.configure') {
    const value = JSON.parse(options.body).params.config;
    response = { ...value, has_proxy_auth: value.proxy_auth === null ? false : Boolean(value.proxy_auth) || response.has_proxy_auth };
    delete response.proxy_auth; return json(response);
  }
  return world.fetchImpl(url, options);
} });
const { renderNetworkSettings } = await import('../../src/ui/web/assets/agent-network-settings.js');
const { renderAgentSettings } = await import('../../src/ui/web/assets/render-settings.js');
afterAll(() => dom.restore());
beforeEach(async () => { sequence++; dom.location.pathname = `/p/${String(sequence).padStart(16, '0')}/`; requests.length = 0; response = model(); intercept = null; current = true; await load(panel()); requests.length = 0; });
const field = (root, key) => root.querySelector(`[data-network-field="${key}"]`);
const button = (root, label) => root.querySelectorAll('button').find(node => node.textContent === label);
const panel = () => renderNetworkSettings({ ownsPage: () => current });
const load = async root => (button(root, '读取网络设置') || button(root, '重新读取网络设置')).onclick();
const input = (root, key, value) => { const node = field(root, key); node.value = value; node.oninput?.(); return node; };
const choose = (root, key, value) => { const node = field(root, key); node.value = value; node.onchange?.(); };
const config = () => JSON.parse(requests.filter(entry => entry.options?.method === 'POST').at(-1).options.body).params.config;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('Agent配置不再承载网络设置，独立网络面板仍按需读取且不发起测试调用', () => {
  const agent = renderAgentSettings(world.state.agentConfig, () => {}, { ownsPage: () => current });
  expect(agent.querySelector('.agent-network-block')).toBeNull();
  expect(agent.querySelector('.agent-env-block')).toBeTruthy();
  const root = panel();
  expect(root.classList.contains('agent-network-block')).toBe(true);
  expect(requests.filter(entry => entry.url.endsWith('/api/agent/network'))).toHaveLength(0);
  expect(deepText(root)).toContain('不是模型端点'); expect(deepText(root)).toContain('SSH 远端'); expect(deepText(root)).toContain('不支持 SOCKS-only');
  expect(root.querySelectorAll('.agent-call')).toHaveLength(0);
  expect(button(root, '重新读取网络设置').getAttribute('data-help')).toContain('不联网测试');
  expect(button(root, '重新读取网络设置').parentNode.classList.contains('help-host')).toBe(true);
});

test('三种模式写完整安全配置，代理NO_PROXY分行/逗号解析，继承不读取启动环境', async () => {
  const root = panel(); await load(root); expect(field(root, 'mode').value).toBe('inherit');
  expect(requests[0].url).toBe('/api/host/settings/agent/network?scope=device');
  choose(root, 'mode', 'proxy'); input(root, 'proxy_url', 'http://127.0.0.1:7897/'); input(root, 'no_proxy', 'example.com, .local\n[::1]:8080');
  await button(root, '保存网络设置').onclick();
  expect(config()).toEqual({ version: 1, mode: 'proxy', proxy_url: 'http://127.0.0.1:7897', no_proxy: ['example.com', '.local', '[::1]:8080'] });
  expect(deepText(root)).toContain('后续请求 / Agent 调用生效');
  choose(root, 'mode', 'direct'); await button(root, '保存网络设置').onclick(); expect(config()).toEqual({ version: 1, mode: 'direct', proxy_url: null, no_proxy: [] });
  choose(root, 'mode', 'inherit'); await button(root, '保存网络设置').onclick(); expect(config()).toEqual({ version: 1, mode: 'inherit', proxy_url: null, no_proxy: [] });
  expect(requests.every(entry => entry.url === '/api/host/settings/agent/network?scope=device' || entry.url === '/api/host/settings/action')).toBe(true);
});

test('认证只写，提交立即清空、不回填、不localStorage持久化，保留/清除明确', async () => {
  response = model({ mode: 'proxy', proxy_url: 'http://proxy.invalid:8080', has_proxy_auth: true });
  const root = panel(); await load(root);
  expect(field(root, 'username').value).toBe(''); expect(field(root, 'password').type).toBe('password'); expect(field(root, 'password').value).toBe('');
  await button(root, '保存网络设置').onclick(); expect(config()).not.toHaveProperty('proxy_auth');
  choose(root, 'auth', 'set'); const user = input(root, 'username', 'PRIVATE-USER'), pass = input(root, 'password', 'PRIVATE-PASS');
  const pending = deferred(); intercept = () => pending.promise;
  const writes = [], originalSetItem = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = (...args) => { writes.push(args); originalSetItem(...args); };
  const saving = button(root, '保存网络设置').onclick();
  expect(user.value).toBe(''); expect(pass.value).toBe(''); expect(config().proxy_auth).toEqual({ username: 'PRIVATE-USER', password: 'PRIVATE-PASS' });
  pending.resolve(json(model({ mode: 'proxy', proxy_url: 'http://proxy.invalid:8080', has_proxy_auth: true }))); await saving;
  expect(field(root, 'password').value).toBe(''); expect(deepText(root)).not.toContain('PRIVATE-');
  expect(writes).toHaveLength(0); globalThis.localStorage.setItem = originalSetItem;
  expect(globalThis.localStorage.getItem('PRIVATE-PASS')).toBeNull();
  intercept = null; choose(root, 'auth', 'clear'); await button(root, '保存网络设置').onclick(); expect(config().proxy_auth).toBeNull();
  expect(deepText(root)).toContain('尚未保存代理认证');
});

test('失败丢弃认证且只显示固定本地提示，不回显上游错误', async () => {
  response = model({ mode: 'proxy', proxy_url: 'http://proxy.invalid' }); const root = panel(); await load(root);
  choose(root, 'auth', 'set'); const password = input(root, 'password', 'PRIVATE-PASS'); input(root, 'username', 'PRIVATE-USER');
  intercept = () => failure('PRIVATE-PASS PRIVATE-USER remote response');
  await button(root, '保存网络设置').onclick();
  expect(password.value).toBe(''); expect(field(root, 'password').value).toBe(''); expect(deepText(root)).toContain('无法确认网络设置保存结果'); expect(deepText(root)).not.toContain('PRIVATE-');
  expect(button(root, '保存网络设置').disabled).toBe(false);
});

test('嵌入认证、SOCKS和非origin地址在提交前拒绝，不修改旧配置', async () => {
  const root = panel(); await load(root); choose(root, 'mode', 'proxy');
  for (const value of ['http://secret:password@proxy.invalid', 'socks5://127.0.0.1:7897', 'https://proxy.invalid/path', 'https://proxy.invalid?secret=key', 'https://proxy.invalid#secret']) {
    input(root, 'proxy_url', value); choose(root, 'auth', 'set'); const secret = input(root, 'password', 'PRIVATE-PASS');
    await button(root, '保存网络设置').onclick();
    expect(secret.value).toBe(''); expect(deepText(root)).toContain('代理地址必须'); expect(deepText(root)).not.toContain(value);
  }
  expect(requests).toHaveLength(1);
});

test('旧Host或daemon不支持只影响网络面板，读取可重试，其他草稿不重画', async () => {
  const root = dom.document.createElement('div');
  const existing = dom.document.createElement('input'); existing.dataset.agentField = 'model'; existing.value = 'unsaved-model'; root.append(existing, panel());
  intercept = () => failure('unknown method: agent.network');
  await load(root); expect(deepText(root)).toContain('更新界面服务'); expect(existing.value).toBe('unsaved-model'); expect(root.querySelector('[data-agent-field="model"]')).toBe(existing);
  intercept = null; await load(root); choose(root, 'mode', 'direct'); await button(root, '保存网络设置').onclick();
  expect(existing.value).toBe('unsaved-model'); expect(root.querySelector('[data-agent-field="model"]')).toBe(existing);
});

test('设备网络草稿跨项目路由共用；只有离页所有权失效才拒绝迟到读取', async () => {
  const root = panel(), pending = deferred(); intercept = () => pending.promise;
  const reading = load(root), before = deepText(root); current = false; dom.location.pathname = '/p/aaaaaaaaaaaaaaaa/';
  pending.resolve(json(model({ mode: 'proxy', proxy_url: 'http://private.invalid' }))); await reading;
  expect(deepText(root)).toBe(before);
  current = true; intercept = null; const other = panel(); await load(other); choose(other, 'mode', 'proxy'); input(other, 'proxy_url', 'http://device-draft.invalid');
  dom.location.pathname = '/'; expect(field(panel(), 'proxy_url').value).toBe('http://device-draft.invalid');
  expect(requests.every(entry => entry.url.startsWith('/api/host/settings/'))).toBe(true);
});

test('离页和跨项目旧按钮不能保存，新读取丢弃草稿并清空认证', async () => {
  response = model({ mode: 'proxy', proxy_url: 'http://proxy.invalid' }); const root = panel(); await load(root);
  input(root, 'proxy_url', 'http://unsaved.invalid'); choose(root, 'auth', 'set'); input(root, 'password', 'PRIVATE-PASS');
  await button(root, '重新读取网络设置').onclick(); expect(field(root, 'proxy_url').value).toBe('http://proxy.invalid'); expect(field(root, 'password').value).toBe('');
  current = false; await button(root, '保存网络设置').onclick(); dom.location.pathname = '/p/ffffffffffffffff/'; await button(root, '保存网络设置').onclick();
  expect(requests.filter(entry => entry.options?.method === 'POST')).toHaveLength(0);
});

for (const result of ['success', 'failure']) {
  for (const leaving of ['page', 'project']) {
    test(`迟到保存${result}在离开${leaving}后不更新新面板，旧认证DOM立即清空`, async () => {
      response = model({ mode: 'proxy', proxy_url: 'http://source.invalid' });
      const root = panel(); await load(root); choose(root, 'auth', 'set');
      const oldUser = input(root, 'username', 'PRIVATE-USER'), oldPassword = input(root, 'password', 'PRIVATE-PASS');
      const pending = deferred(); intercept = (url, options) => options?.method === 'POST' ? pending.promise : undefined;
      const saving = button(root, '保存网络设置').onclick();
      expect(oldUser.value).toBe(''); expect(oldPassword.value).toBe('');
      current = false;
      if (leaving === 'project') dom.location.pathname = `/p/${String(sequence + 100).padStart(16, '0')}/`;
      const other = renderNetworkSettings({ ownsPage: () => true });
      if (leaving === 'project') {
        response = model({ mode: 'proxy', proxy_url: 'http://target.invalid' }); await load(other);
        input(other, 'proxy_url', 'http://target-draft.invalid');
      }
      const before = deepText(other), oldFeedback = deepText(root);
      pending.resolve(result === 'success'
        ? json(model({ mode: 'proxy', proxy_url: 'http://late-result.invalid', has_proxy_auth: true }))
        : failure('PRIVATE-PASS private upstream error'));
      await saving;
      expect(deepText(other)).toBe(before); expect(deepText(root)).toBe(oldFeedback);
      expect(oldUser.value).toBe(''); expect(oldPassword.value).toBe('');
      expect(deepText(other)).not.toContain('PRIVATE-'); expect(deepText(other)).not.toContain('网络设置已保存');
      const fresh = renderNetworkSettings({ ownsPage: () => true });
      expect(field(fresh, 'proxy_url').value).toBe(leaving === 'project' ? 'http://target-draft.invalid' : 'http://source.invalid');
      expect(field(fresh, 'password').value).toBe(''); expect(button(fresh, '保存网络设置').disabled).toBe(false);
    });
  }
}

for (const result of ['success', 'failure']) {
  test(`离页迟到读取${result}不更新同项目的新页面`, async () => {
    const root = panel(), pending = deferred(); intercept = () => pending.promise;
    const reading = load(root); current = false;
    const other = renderNetworkSettings({ ownsPage: () => true }), before = deepText(other);
    pending.resolve(result === 'success' ? json(model({ mode: 'proxy', proxy_url: 'http://late.invalid' })) : failure('PRIVATE-PASS'));
    await reading;
    expect(deepText(other)).toBe(before); expect(field(other, 'mode').value).toBe('inherit');
    const fresh = renderNetworkSettings({ ownsPage: () => true });
    expect(field(fresh, 'mode').value).toBe('inherit'); expect(button(fresh, '重新读取网络设置').disabled).toBe(false);
    expect(deepText(fresh)).not.toContain('PRIVATE-');
  });
}

test('恶意响应中的认证URL不能进入读模型或页面', async () => {
  response = model({ mode: 'proxy', proxy_url: 'http://PRIVATE-USER:PRIVATE-PASS@proxy.invalid' }); const root = panel(); await load(root);
  expect(field(root, 'mode').value).toBe('inherit'); expect(deepText(root)).toContain('无法安全读取'); expect(deepText(root)).not.toContain('PRIVATE-');
});
