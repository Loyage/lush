import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';

const requests = [];
const model = {
  execution: { hostname: 'web-host', username: 'lush-user', scope: 'host' },
  ssh: { supported: true, hosts: [{ alias: 'prod' }], warnings: [], connections: [] },
};
const dom = installDom({ fetch: async (url, options = {}) => {
  const path = String(url);
  requests.push({ path, options });
  if (path === '/api/environments') return Response.json(model);
  if (path === '/api/environments/ssh/inspect') return Response.json({ profile: { alias: 'prod' }, ready: true,
    requiresInstall: false, plan: {}, warnings: [], confirmation: 'once' });
  if (path === '/api/environments/ssh/connect') return Response.json({ id: 'ssh-1', href: '/e/ssh-1/' });
  return Response.json({ error: 'not mocked' }, { status: 404 });
} });
afterAll(() => dom.restore());

const { normalizeDirectHost, openEnvironments } = await import('../../src/ui/web/assets/environments.js');

test('HTTPS 直连只接受无凭证的 Host 根地址，HTTP 仅限回环', () => {
  expect(normalizeDirectHost('lush.example.com')).toBe('https://lush.example.com/');
  expect(normalizeDirectHost('https://lush.example.com:8443/')).toBe('https://lush.example.com:8443/');
  expect(normalizeDirectHost('http://127.0.0.1:9000')).toBe('http://127.0.0.1:9000/');
  expect(() => normalizeDirectHost('http://lush.example.com')).toThrow('必须使用 HTTPS');
  expect(() => normalizeDirectHost('https://user:secret@lush.example.com')).toThrow('不能包含用户名或密码');
  expect(() => normalizeDirectHost('https://lush.example.com/path?q=1')).toThrow('不要包含路径');
});

test('环境页说明 SSH 执行身份，ready 预检可直接连接并给独立环境链接', async () => {
  await openEnvironments({ push: false });
  const panel = dom.node('detail');
  expect(panel.dataset.view).toBe('environments');
  expect(deepText(panel)).toContain('lush-user@web-host');
  const form = panel.querySelector('.environment-ssh').querySelector('form.environment-form');
  const input = form.querySelector('input'); input.value = 'prod';
  form.onsubmit({ preventDefault() {} });
  await Bun.sleep(0); await Bun.sleep(0);
  const inspect = requests.find(entry => entry.path === '/api/environments/ssh/inspect');
  const connect = requests.find(entry => entry.path === '/api/environments/ssh/connect');
  expect(JSON.parse(inspect.options.body)).toEqual({ alias: 'prod' });
  expect(JSON.parse(connect.options.body)).toEqual({ confirmation: 'once', install: false });
  const link = panel.querySelector('.environment-status').querySelector('a.environment-open');
  expect(link.href).toBe('/e/ssh-1/');
  expect(link.target).toBe('_blank');
});
