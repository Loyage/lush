import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import { installDom } from '../dom-stub.js';

const dom = installDom(), document = dom.document;
document.querySelectorAll = selector => document.body.querySelectorAll(selector);
document.addEventListener = globalThis.addEventListener;
document.removeEventListener = globalThis.removeEventListener;
const windowHandlers = {};
dom.window.addEventListener = (type, handler) => { (windowHandlers[type] ||= []).push(handler); };
for (const id of ['connection-status', 'connection-error', 'recent-connections', 'host-url', 'remote-form',
  'local-help', 'local-help-host', 'connection-intro', 'ssh-form', 'ssh-alias', 'ssh-plan', 'ssh-target',
  'ssh-plan-details', 'ssh-warnings', 'ssh-connections']) document.body.append(dom.node(id));
for (const id of ['open-local', 'open-remote', 'ssh-inspect', 'ssh-confirm', 'ssh-cancel']) {
  const button = document.createElement('button'); dom.byId.set(id, button); document.body.append(button);
}
const state = { records: [], inspected: [], connected: [], disconnected: [], canceled: 0, locals: 0,
  requiresInstall: true, notReady: false, inspectGate: null, connectGate: null, inspectFailure: null, connectFailure: null, remoteCalls: 0 };
const stableId = '0123456789abcdef0123456789abcdef';
dom.window.lushConnections = {
  localSupported: false,
  list: async () => [],
  openLocal: async () => { state.locals++; },
  openRemote: async () => { state.remoteCalls++; },
  remove: async () => {},
  sshList: async () => state.records,
  sshInspect: async profile => {
    state.inspected.push(profile);
    if (state.inspectGate) await state.inspectGate;
    if (state.inspectFailure) throw new Error(state.inspectFailure);
    return { profile: { ...profile, id: profile.id ?? stableId }, confirmation: state.notReady ? null : 'opaque-confirmation',
      ready: !state.requiresInstall && !state.notReady, requiresInstall: state.requiresInstall,
      plan: { install_dir: '/home/server/.local/share/lush', bun: 'private', target: 'linux-arm64', note: '<img src=x onerror=bad()>' },
      warnings: ['Git and Agent authentication must be prepared remotely'] };
  },
  sshConnect: async confirmation => {
    state.connected.push(confirmation);
    if (state.connectGate) await state.connectGate;
    if (state.connectFailure) throw new Error(state.connectFailure);
    state.records = [{ id: stableId, alias: dom.node('ssh-alias').value, connected: true }];
    return { url: 'http://127.0.0.1:14318/', profile: state.records[0] };
  },
  sshCancel: async () => { state.canceled++; },
  sshDisconnect: async id => { state.disconnected.push(id); state.records = state.records.map(row => ({ ...row, connected: false })); },
};
await import('../../src/ui/desktop/connection.js?ssh-ui');
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
const fire = (id, type) => { for (const handler of dom.node(id).listeners[type] || []) handler({ preventDefault() {} }); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
afterAll(() => dom.restore());

test('SSH preflight displays safe target, plan and warnings before explicit installation authorization', async () => {
  await flush(); dom.node('ssh-alias').value = 'my-server';
  fire('ssh-form', 'submit'); await flush();
  expect(state.inspected).toEqual([{ alias: 'my-server' }]);
  expect(state.connected).toEqual([]);
  expect(dom.node('ssh-plan').hidden).toBe(false);
  expect(dom.node('ssh-target').textContent).toContain('my-server');
  expect(dom.node('ssh-plan-details').textContent).toContain('/home/server/.local/share/lush');
  expect(dom.node('ssh-plan-details').textContent).toContain('安装目录：');
  expect(dom.node('ssh-plan-details').textContent).toContain('私有 Bun：');
  expect(dom.node('ssh-plan-details').textContent).toContain('<img src=x onerror=bad()>');
  expect(dom.node('ssh-plan-details').children).toHaveLength(0);
  expect(dom.node('ssh-warnings').children[0].textContent).toContain('Agent authentication');
  expect(dom.node('ssh-confirm').textContent).toBe('确认安装并连接');
  expect(dom.node('ssh-confirm').disabled).toBe(false);
  fire('ssh-confirm', 'click'); fire('ssh-confirm', 'click'); await flush();
  expect(state.connected).toEqual([{ confirmation: 'opaque-confirmation', install: true }]);
  expect(dom.node('connection-status').textContent).toContain('Agent 已认证');
  expect(dom.node('ssh-plan').hidden).toBe(true);
  expect(dom.node('recent-connections').children[0].textContent).toContain('暂无');
  expect(dom.node('ssh-connections').children[0].children[0].textContent).toBe('my-server');
  expect(dom.node('open-local').disabled).toBe(true); expect(state.locals).toBe(0);
});

test('saved SSH records preflight by profile id and disconnect only their managed tunnel', async () => {
  const row = dom.node('ssh-connections').children[0];
  const disconnect = row.children[2];
  expect(disconnect.className).toBe('help-host'); expect(disconnect.dataset.help).toContain('不停止远端');
  for (const handler of disconnect.children[0].listeners.click) handler();
  await flush();
  expect(state.disconnected).toEqual([stableId]);
  expect(dom.node('connection-status').textContent).toContain('远端开发继续运行');
  state.requiresInstall = false;
  for (const handler of dom.node('ssh-connections').children[0].children[0].listeners.click) handler();
  await flush();
  expect(state.inspected.at(-1)).toEqual({ id: stableId, alias: 'my-server' });
  expect(dom.node('ssh-confirm').textContent).toBe('确认连接');
  const before = state.connected.length;
  fire('ssh-cancel', 'click'); await flush();
  fire('ssh-confirm', 'click'); await flush();
  expect(state.connected).toHaveLength(before);
  expect(dom.node('ssh-plan').hidden).toBe(true);
});

test('editing the alias cancels a single-flight inspection and discards its late plan', async () => {
  const gate = deferred(); state.inspectGate = gate.promise;
  dom.node('ssh-alias').value = 'old-server';
  fire('ssh-form', 'submit'); fire('ssh-form', 'submit');
  expect(state.inspected.filter(row => row.alias === 'old-server')).toHaveLength(1);
  expect(dom.node('ssh-inspect').disabled).toBe(true);
  expect(dom.node('ssh-cancel').disabled).toBe(false);
  const cancels = state.canceled;
  dom.node('ssh-alias').value = 'new-server'; fire('ssh-alias', 'input'); await flush();
  expect(state.canceled).toBe(cancels + 1);
  expect(dom.node('connection-status').textContent).toContain('服务器已更改');
  gate.resolve(); await flush(); state.inspectGate = null;
  expect(dom.node('ssh-plan').hidden).toBe(true);
  expect(dom.node('ssh-confirm').disabled).toBe(true);
  expect(dom.node('connection-error').textContent).toBe('');
  expect(dom.node('ssh-alias').value).toBe('new-server');
  fire('ssh-form', 'submit'); await flush();
  expect(state.inspected.at(-1)).toEqual({ alias: 'new-server' });
  expect(dom.node('ssh-target').textContent).toContain('new-server');
  fire('ssh-cancel', 'click'); await flush();
});

test('SSH errors preserve the alias and require a fresh preflight before retrying installation', async () => {
  state.inspectFailure = 'SSH unavailable: prepare host trust and keys in a terminal';
  dom.node('ssh-alias').value = 'offline-server'; fire('ssh-form', 'submit'); await flush();
  expect(dom.node('connection-error').textContent).toContain('host trust');
  expect(dom.node('ssh-alias').value).toBe('offline-server');
  expect(dom.node('ssh-confirm').disabled).toBe(true);
  expect(dom.node('open-local').disabled).toBe(true);
  state.inspectFailure = null; state.requiresInstall = true;
  fire('ssh-form', 'submit'); await flush();
  state.connectFailure = 'Missing platform payload';
  fire('ssh-confirm', 'click'); await flush();
  expect(dom.node('connection-error').textContent).toBe('Missing platform payload');
  expect(dom.node('ssh-alias').value).toBe('offline-server');
  const before = state.connected.length;
  fire('ssh-confirm', 'click'); await flush(); expect(state.connected).toHaveLength(before);
  state.connectFailure = null;
  fire('ssh-form', 'submit'); await flush();
  expect(dom.node('ssh-confirm').disabled).toBe(false);
  fire('ssh-cancel', 'click'); await flush();
});

test('cancellation during SSH connect remains available and late success cannot overwrite cancellation feedback', async () => {
  const gate = deferred(); state.connectGate = gate.promise;
  dom.node('ssh-alias').value = 'pending-server'; fire('ssh-form', 'submit'); await flush();
  fire('ssh-confirm', 'click');
  expect(dom.node('ssh-cancel').disabled).toBe(false);
  fire('ssh-cancel', 'click'); await flush();
  expect(dom.node('connection-status').textContent).toContain('已取消本次操作');
  gate.resolve(); await flush(); state.connectGate = null;
  expect(dom.node('connection-status').textContent).toContain('已取消本次操作');
  expect(dom.node('ssh-plan').hidden).toBe(true);
  expect(dom.node('open-local').disabled).toBe(true);
  const before = state.canceled;
  for (const handler of windowHandlers.pagehide) handler();
  await flush(); expect(state.canceled).toBe(before + 1);
});

test('editing an already inspected alias or switching to HTTPS revokes its unused installation plan', async () => {
  dom.node('ssh-alias').value = 'inspected-server'; fire('ssh-form', 'submit'); await flush();
  expect(dom.node('ssh-plan').hidden).toBe(false);
  const before = state.canceled;
  dom.node('ssh-alias').value = 'replacement-server'; fire('ssh-alias', 'input'); await flush();
  expect(state.canceled).toBe(before + 1); expect(dom.node('ssh-confirm').disabled).toBe(true);
  fire('ssh-form', 'submit'); await flush();
  dom.node('host-url').value = 'https://another.example.com/'; fire('remote-form', 'submit'); await flush();
  expect(state.remoteCalls).toBe(1); expect(state.canceled).toBe(before + 2);
  expect(dom.node('ssh-plan').hidden).toBe(true);
});

test('a non-ready inspection gives repair guidance and never enables confirmation', async () => {
  state.notReady = true; state.requiresInstall = false;
  dom.node('ssh-alias').value = 'unsupported-server'; fire('ssh-form', 'submit'); await flush();
  expect(dom.node('connection-status').textContent).toContain('尚未就绪');
  expect(dom.node('ssh-confirm').disabled).toBe(true);
  const before = state.connected.length; fire('ssh-confirm', 'click'); await flush();
  expect(state.connected).toHaveLength(before);
  fire('ssh-cancel', 'click'); await flush(); state.notReady = false;
});

test('SSH entry explains installation boundaries without model-call styling or credential fields', () => {
  const html = fs.readFileSync(new URL('../../src/ui/desktop/connection.html', import.meta.url), 'utf8');
  const source = fs.readFileSync(new URL('../../src/ui/desktop/connection.js', import.meta.url), 'utf8');
  expect(html).toContain('私有 Bun'); expect(html).toContain('不使用 sudo');
  expect(html).toContain('不停止远端 Host、daemon 或 Worker');
  expect(html).not.toContain('type="password"'); expect(html).not.toContain('agent-call');
  expect(source).not.toContain('innerHTML'); expect(source).not.toContain('window.confirm');
  expect(html).toContain('data-help="只通过 SSH 检查');
});
