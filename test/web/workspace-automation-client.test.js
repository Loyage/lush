import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installDom } from '../dom-stub.js';
import * as automation from '../../src/ui/web/assets/workspace-automation.js';
let dom, model, calls, handle;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const deferred = () => { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve }; };
beforeEach(() => {
  model = { version: 1, revision: 'r1', auto_select: { enabled: false }, completion_defaults: { enabled: false, level: 'merge' } };
  calls = []; handle = null;
  dom = installDom({ fetch: async (path, options) => {
    calls.push({ path: String(path), options });
    if (handle) return handle(String(path), options);
    if (options?.method === 'POST') {
      const { patch, expected_revision } = JSON.parse(options.body);
      if (expected_revision !== model.revision) return json({ error: '版本冲突' }, 409);
      model = { ...model, ...patch, revision: 'r2' };
    }
    return json(model);
  } });
});
afterEach(() => dom.restore());

test('root automation transport is independent of project availability', async () => {
  dom.location.pathname = '/p/1111111111111111/';
  const read = await automation.refreshDeviceAutomation();
  await automation.saveDeviceAutomation({ auto_select: { enabled: true } }, read.revision);
  expect(calls.every(call => call.path === '/api/host/automation')).toBe(true);
  expect(JSON.parse(calls[1].options.body)).toEqual({ patch: { auto_select: { enabled: true } }, expected_revision: 'r1' });
  expect(automation.deviceAutomationStatus().model.auto_select.enabled).toBe(true);
});

test('stale in-flight GET cannot re-enable a policy after its close ACK', async () => {
  model.auto_select.enabled = true; await automation.refreshDeviceAutomation();
  const old = structuredClone(model), gate = deferred();
  handle = (_path, options) => options ? json({ ...model, revision: 'closed', auto_select: { enabled: false } }) : gate.promise;
  const read = automation.refreshDeviceAutomation();
  await automation.saveDeviceAutomation({ auto_select: { enabled: false } }, 'r1');
  gate.resolve(json(old)); await read;
  expect(automation.deviceAutomationStatus().model.auto_select.enabled).toBe(false);
});

test('opaque content revisions may legitimately repeat when policy returns to an earlier value', async () => {
  await automation.refreshDeviceAutomation();
  handle = (_path, options) => {
    const patch = JSON.parse(options.body).patch;
    model = { ...model, ...patch, revision: patch.auto_select.enabled ? 'enabled-hash' : 'r1' }; return json(model);
  };
  await automation.saveDeviceAutomation({ auto_select: { enabled: true } }, 'r1');
  await automation.saveDeviceAutomation({ auto_select: { enabled: false } }, 'enabled-hash');
  expect(automation.deviceAutomationStatus().model.revision).toBe('r1');
  expect(automation.deviceAutomationStatus().model.auto_select.enabled).toBe(false);
});

test('conflict or malformed ACK is not silently retried', async () => {
  await automation.refreshDeviceAutomation();
  handle = () => json({ error: '版本冲突' }, 409);
  await expect(automation.saveDeviceAutomation({ auto_select: { enabled: true } }, 'r1')).rejects.toThrow('版本冲突');
  expect(automation.deviceAutomationStatus().model.auto_select.enabled).toBe(false);
  handle = () => json({ version: 1, revision: 'broken' });
  await expect(automation.saveDeviceAutomation({ auto_select: { enabled: true } }, 'r1')).rejects.toThrow('响应无效');
  expect(calls.filter(call => call.options?.method === 'POST')).toHaveLength(2);
});

test('read errors preserve known policy with an explicit offline flag', async () => {
  model.auto_select.enabled = true; await automation.refreshDeviceAutomation();
  handle = () => { throw Error('offline'); };
  await expect(automation.refreshDeviceAutomation()).rejects.toThrow('offline');
  const status = automation.deviceAutomationStatus(); expect(status.offline).toBe(true); expect(status.model.auto_select.enabled).toBe(true);
});

test('observer disposal stops reads and never starts project work or asks notification permission', async () => {
  const dispose = automation.startDeviceAutomationObserver({ interval: 100000 });
  await automation.refreshDeviceAutomation(); dispose();
  const count = calls.length; await dom.fire('focus'); dom.intervalFor(100000)();
  expect(calls).toHaveLength(count); expect(dom.listeners.focus).toHaveLength(0);
  expect(calls.every(call => !call.options)).toBe(true);
});
