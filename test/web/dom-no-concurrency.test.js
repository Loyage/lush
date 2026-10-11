import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';

const world = makeWorld(), calls = [];
// Simulate a retained old frontend/backend settings response. Removed fields must never be rendered or written back.
world.state.runtimeSettings.concurrency = { value: 99, default: 8, overridden: true };
world.state.runtimeSettings.control_concurrency = { value: 77, default: 2, overridden: true };
const dom = installDom({ fetch: async (url, options) => {
  calls.push({ url: String(url), options });
  if (String(url) === '/api/host/slots') throw new Error('removed resource API must not be requested');
  return world.fetchImpl(String(url).replace(/^\/p\/[a-f0-9]{16}(?=\/api\/)/, ''), options);
} });
const { ui, resetUiState } = await import('../../src/ui/web/assets/state.js');
const { renderOverview } = await import('../../src/ui/web/assets/render-overview.js');
const { renderTree } = await import('../../src/ui/web/assets/render-tree.js');
const { openSettings } = await import('../../src/ui/web/assets/render-settings.js');
const { boot } = await import('../../src/ui/web/assets/app.js');
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const system = async () => {
  await openSettings(); await dom.node('detail').querySelector('[data-settings-tab="system"]').onclick(); await flush();
};
afterAll(() => dom.restore());

test('root and project boot have no slot observer or gauge even with old response fields', async () => {
  const html = await Bun.file(new URL('../../src/ui/web/assets/index.html', import.meta.url)).text();
  const css = await Bun.file(new URL('../../src/ui/web/assets/styles.css', import.meta.url)).text();
  expect(html).not.toContain('id="agents"'); expect(css).not.toContain('#agents'); expect(css).not.toContain('.slot-count');
  for (const pathname of ['/', '/p/aaaaaaaaaaaaaaaa/', '/']) {
    dom.location.pathname = pathname; await boot(); await flush();
    expect(calls.some(row => row.url === '/api/host/slots')).toBe(false);
    expect(deepText(dom.node('detail'))).not.toContain('并发槽');
    expect(deepText(dom.node('detail'))).not.toContain('槽占用');
  }
});

test('old cached concurrency fields remain invisible; saves and resets only send active limit keys', async () => {
  dom.location.pathname = '/'; await boot(); await system();
  const panel = dom.node('detail');
  expect(panel.querySelector('[data-runtime-input="concurrency"]')).toBeNull();
  expect(panel.querySelector('[data-runtime-input="control_concurrency"]')).toBeNull();
  expect(deepText(panel)).not.toContain('并发额度'); expect(deepText(panel)).not.toContain('执行通道');
  panel.querySelector('[data-runtime-input="call_timeout"]').value = '600';
  await panel.querySelector('[data-runtime-action="save"]').onclick();
  expect(world.state.actions.at(-1)).toEqual({ method: 'system.configure', params: { scope: 'device',
    settings: { call_timeout: 600, task_call_limit: 24, max_depth: 8 } } });
  await panel.querySelector('[data-runtime-action="reset"]').onclick();
  expect(world.state.actions.at(-1)).toEqual({ method: 'system.configure', params: { scope: 'device',
    settings: { call_timeout: null, task_call_limit: null, max_depth: null } } });
  expect(world.state.runtimeSettings.concurrency.value).toBe(99);
  expect(world.state.runtimeSettings.control_concurrency.value).toBe(77);
});

test('new responses without concurrency or slots retain active editors and true project Agent counts', async () => {
  delete world.state.runtimeSettings.concurrency; delete world.state.runtimeSettings.control_concurrency;
  await boot(); await system();
  expect(dom.node('detail').querySelector('[data-runtime-input="call_timeout"]')).toBeTruthy();
  dom.location.pathname = '/p/aaaaaaaaaaaaaaaa/'; resetUiState();
  const data = { tasks: [], notices: [], status: { agents: [{ task_id: 42 }] } };
  renderOverview(data);
  expect(deepText(dom.node('detail'))).toContain('本项目运行中的 Agent 1');
  const agents = [...dom.node('detail').querySelectorAll('.block')].find(node => node.querySelector('h2')?.textContent === '本项目运行中的 Agent');
  expect(deepText(agents.querySelector('.section-title'))).not.toContain('/');
  expect(deepText(dom.node('detail'))).not.toContain('槽');
  renderOverview({ ...data, status: { agents: [{ task_id: 42 }, { task_id: 43 }], concurrency: 1,
    control_concurrency: 1, slots: { available: true, execution: { used: 999, limit: 1 } } } });
  expect(deepText(dom.node('detail'))).toContain('本项目运行中的 Agent 2');
  expect(deepText(dom.node('detail'))).not.toContain('999'); expect(deepText(dom.node('detail'))).not.toContain('额度');
});

test('queued workers wait for known dependencies or safe admission, never infer a missing slot', () => {
  resetUiState();
  const queued = { id: 42, role: 'agent', task_kind: 'order', goal: 'queued', status: 'queued', deps: [] };
  renderTree({ tasks: [queued], notices: [], status: {} });
  expect(deepText(dom.node('tasks'))).toContain('等待运行准入或安全边界');
  expect(deepText(dom.node('tasks'))).not.toContain('槽');
  renderTree({ tasks: [{ ...queued, deps: [{ id: 7, kind: 'order', status: 'running' }] }], notices: [], status: {} });
  expect(deepText(dom.node('tasks'))).toContain('等 #7 结束');
  renderTree({ tasks: [{ ...queued, interrupt_state: 'resuming' }], notices: [], status: {} });
  expect(deepText(dom.node('tasks'))).toContain('旧调用');
  expect(deepText(dom.node('tasks'))).not.toContain('等待运行准入');
  renderTree({ tasks: [{ ...queued, status: 'running' }], notices: [], status: {} });
  expect(deepText(dom.node('tasks'))).not.toContain('槽');
});
