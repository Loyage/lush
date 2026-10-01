import { test, expect, afterAll } from 'bun:test';
import { installDom } from '../dom-stub.js';

const dom = installDom();
const document = dom.document, focusHandlers = [];
document.querySelectorAll = selector => document.body.querySelectorAll(selector);
document.addEventListener = globalThis.addEventListener;
document.removeEventListener = globalThis.removeEventListener;
dom.window.addEventListener = (type, handler) => { if (type === 'focus') focusHandlers.push(handler); };
for (const id of ['connection-status', 'connection-error', 'recent-connections', 'host-url', 'remote-form']) document.body.append(dom.node(id));
const local = document.createElement('button');
// The shared DOM stub lazily creates IDs; register the actual button for busy-state assertions.
dom.byId.set('open-local', local); document.body.append(local);
const remoteButton = document.createElement('button'); dom.byId.set('open-remote', remoteButton); document.body.append(remoteButton);
let recent = ['https://one.example.com/'], localCalls = 0, remoteCalls = [], error = null, gate = null;
dom.window.lushConnections = {
  list: async () => recent,
  openLocal: async () => { localCalls++; },
  openRemote: async url => { remoteCalls.push(url); if (gate) await gate; if (error) throw new Error(error); recent = [url]; },
  remove: async url => { recent = recent.filter(row => row !== url); },
};
await import('../../src/ui/desktop/connection.js');
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const fire = (node, type) => { for (const handler of node.listeners[type] || []) handler({ preventDefault() {} }); };
afterAll(() => dom.restore());

test('connection page renders safe recent shortcuts and opens local without affecting remote input', async () => {
  await flush();
  expect(dom.node('recent-connections').children[0].children[0].textContent).toBe('https://one.example.com/');
  dom.node('host-url').value = 'https://future.example.com/';
  fire(local, 'click'); await flush();
  expect(localCalls).toBe(1); expect(dom.node('host-url').value).toBe('https://future.example.com/');
  expect(dom.node('connection-status').textContent).toContain('独立工作窗口');
});

test('remote connection is single-flight, leaves typed address on failure and permits explicit retry', async () => {
  let release; gate = new Promise(resolve => { release = resolve; }); error = 'Host is offline';
  dom.node('host-url').value = 'https://offline.example.com/';
  fire(dom.node('remote-form'), 'submit'); fire(dom.node('remote-form'), 'submit');
  expect(remoteCalls).toEqual(['https://offline.example.com/']); expect(local.disabled).toBe(true);
  release(); await flush();
  expect(dom.node('connection-error').textContent).toBe('Host is offline');
  expect(dom.node('host-url').value).toBe('https://offline.example.com/'); expect(local.disabled).toBe(false);
  gate = null; error = null;
  fire(dom.node('remote-form'), 'submit'); await flush();
  expect(remoteCalls).toHaveLength(2); expect(dom.node('connection-error').textContent).toBe('');
});

test('forgetting a shortcut uses the narrow metadata IPC and help host, without reconnecting', async () => {
  const before = remoteCalls.length;
  const row = dom.node('recent-connections').children[0], host = row.children[1];
  expect(host.className).toBe('help-host'); expect(host.dataset.help).toContain('不停止远端服务');
  fire(host.children[0], 'click'); await flush();
  expect(recent).toEqual([]); expect(remoteCalls).toHaveLength(before);
  expect(dom.node('connection-status').textContent).toContain('已移除连接记录');
  expect(dom.node('recent-connections').children[0].textContent).toContain('暂无');
});
