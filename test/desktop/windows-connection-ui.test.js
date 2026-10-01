import { test, expect, afterAll } from 'bun:test';
import { installDom } from '../dom-stub.js';

const dom = installDom(), document = dom.document, focusHandlers = [];
document.querySelectorAll = selector => document.body.querySelectorAll(selector);
document.addEventListener = globalThis.addEventListener;
document.removeEventListener = globalThis.removeEventListener;
dom.window.addEventListener = (type, handler) => { if (type === 'focus') focusHandlers.push(handler); };
for (const id of ['connection-status', 'connection-error', 'recent-connections', 'host-url', 'remote-form', 'local-help', 'local-help-host', 'connection-intro']) document.body.append(dom.node(id));
for (const id of ['open-local', 'open-remote']) {
  const button = document.createElement('button'); dom.byId.set(id, button); document.body.append(button);
}
let localCalls = 0, remoteCalls = 0, failure = true;
dom.window.lushConnections = {
  localSupported: false,
  list: async () => [],
  openLocal: async () => { localCalls++; },
  openRemote: async () => { remoteCalls++; if (failure) throw new Error('Host offline'); },
  remove: async () => {},
};
await import('../../src/ui/desktop/connection.js?windows-ui');
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const fire = (id, type) => { for (const handler of dom.node(id).listeners[type] || []) handler({ preventDefault() {} }); };
afterAll(() => dom.restore());

test('Windows explains remote-only support and blocks even synthetic local clicks', async () => {
  await flush();
  expect(dom.node('open-local').disabled).toBe(true);
  expect(dom.node('open-remote').disabled).toBe(false);
  expect(dom.node('local-help').textContent).toContain('不需要本机 Bun');
  expect(dom.node('local-help-host').dataset.help).toContain('不启动本地后台');
  expect(dom.node('connection-intro').textContent).toContain('远程 Host');
  fire('open-local', 'click'); await flush();
  expect(localCalls).toBe(0);
});

test('Windows local button stays disabled after remote failure, retry and focus refresh', async () => {
  dom.node('host-url').value = 'https://one.example.com/';
  fire('remote-form', 'submit'); await flush();
  expect(dom.node('connection-error').textContent).toBe('Host offline');
  expect(dom.node('host-url').value).toBe('https://one.example.com/');
  expect(dom.node('open-local').disabled).toBe(true);
  failure = false; fire('remote-form', 'submit'); await flush();
  expect(dom.node('connection-error').textContent).toBe('');
  expect(remoteCalls).toBe(2);
  for (const handler of focusHandlers) handler();
  await flush();
  expect(dom.node('open-local').disabled).toBe(true);
  expect(dom.node('open-remote').disabled).toBe(false);
  expect(localCalls).toBe(0);
});
