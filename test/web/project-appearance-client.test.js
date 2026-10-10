import { test, expect } from 'bun:test';
import { createAppearance } from '../../src/ui/web/assets/appearance.js';
import { setPref } from '../../src/ui/web/assets/prefs.js';

const id = 'abcdef0123456789';
const appearance = (theme = 'dark', color = 'blue', revision = 'rev-1') => ({ id, appearance: { version: 1, theme, color, revision } });
const button = () => ({ disabled: false, attrs: {}, setAttribute(key, value) { this.attrs[key] = value; },
  getAttribute(key) { return this.attrs[key] ?? null; }, removeAttribute(key) { delete this.attrs[key]; } });
function fixture(request) {
  setPref('theme', 'light');
  const root = { dataset: {} }, toggle = button(), timers = [];
  const controller = createAppearance({ root, toggle, media: { matches: false }, projectId: id, request,
    persist: async value => setPref('theme', value),
    setInterval: fn => { timers.push(fn); return 1; }, clearInterval() {} });
  return { controller, root, toggle, tick: () => timers[0]() };
}

test('project color initializes only on explicit open; updates send revision without legacy theme', async () => {
  const calls = [];
  const { controller, root, toggle } = fixture(async (url, options) => {
    calls.push({ url, options });
    if (!options) return { id, appearance: null };
    const body = JSON.parse(options.body);
    return body.initialize ? appearance() : appearance('dark', body.color, 'rev-2');
  });
  await controller.load(true);
  expect(calls.map(call => call.options?.method || 'GET')).toEqual(['GET', 'POST']);
  expect(JSON.parse(calls[1].options.body)).toEqual({ initialize: true });
  expect(root.dataset).toEqual({ theme: 'light', projectColor: 'blue' });
  await controller.save({ color: 'rose' });
  expect(JSON.parse(calls[2].options.body)).toEqual({ color: 'rose', expected_revision: 'rev-1' });
  expect(root.dataset).toEqual({ theme: 'light', projectColor: 'rose' });
  expect(controller.snapshot().appearance).toMatchObject({ theme: 'dark', revision: 'rev-2' });
  await toggle.onclick(); expect(root.dataset.theme).toBe('dark'); expect(calls).toHaveLength(3);
  controller.destroy();
});

test('background color synchronization ignores legacy themes and retains known color on failure', async () => {
  let result = appearance(), fail = false;
  const { controller, root, tick } = fixture(async () => { if (fail) throw new Error('offline'); return result; });
  await controller.load(true);
  result = appearance('light', 'teal', 'rev-2'); await tick();
  expect(root.dataset).toEqual({ theme: 'light', projectColor: 'teal' });
  setPref('theme', 'dark'); controller.paint(); await tick();
  expect(root.dataset).toEqual({ theme: 'dark', projectColor: 'teal' });
  fail = true; await tick();
  expect(controller.snapshot().error).toBe('offline');
  expect(root.dataset).toEqual({ theme: 'dark', projectColor: 'teal' });
  controller.destroy();
});

test('color conflict preserves revision and serializes writes without blocking device theme', async () => {
  let rejectSave;
  const { controller, root, toggle } = fixture(async (_url, options) => options
    ? await new Promise((_resolve, reject) => { rejectSave = reject; }) : appearance());
  await controller.load(true);
  const saving = controller.save({ color: 'teal' });
  expect(controller.snapshot().busy).toBe(true); expect(toggle.disabled).toBe(false);
  await expect(controller.save({ color: 'rose' })).rejects.toThrow('正在同步');
  rejectSave(new Error('revision conflict')); await expect(saving).rejects.toThrow('revision conflict');
  expect(root.dataset).toEqual({ theme: 'light', projectColor: 'blue' });
  expect(controller.snapshot().appearance.revision).toBe('rev-1');
  expect(controller.snapshot().error).toBe('revision conflict');
  await expect(controller.save({ theme: 'dark' })).rejects.toThrow('主题请使用设备偏好');
  controller.destroy();
});

test('late response after destruction cannot repaint or initialize the old project', async () => {
  let resolve;
  const calls = [];
  const { controller, root } = fixture(async (_url, options) => {
    calls.push(options); return await new Promise(done => { resolve = done; });
  });
  const loading = controller.load(true); controller.destroy(); resolve({ id, appearance: null }); await loading;
  expect(calls).toHaveLength(1); expect(root.dataset.projectColor).toBeUndefined();
});

test('disabled theme help depends on device authority, never on project color availability', async () => {
  const toggle = button(), host = button(); host.classList = { contains: name => name === 'help-host' }; toggle.parentNode = host;
  const controller = createAppearance({ root: { dataset: {} }, toggle, media: null, projectId: id,
    request: async () => appearance(), setInterval: null });
  expect(toggle.disabled).toBe(true); expect(host.attrs['data-help']).toContain('设备偏好尚不可用');
  expect(host.attrs.tabindex).toBe('0'); expect(toggle.attrs['data-help']).toBeUndefined();
  await controller.load(true);
  expect(toggle.disabled).toBe(true); expect(host.attrs['data-help']).toContain('设备偏好尚不可用');
  controller.destroy();
});

test('wrong project, malformed metadata and uninitialized reads cannot replace device theme', async () => {
  let result = { ...appearance(), id: '0123456789abcdef' };
  const { controller, root, toggle } = fixture(async () => result);
  await controller.load(true);
  expect(controller.snapshot().error).toContain('响应无效'); expect(toggle.disabled).toBe(false);
  expect(root.dataset.projectColor).toBeUndefined(); expect(root.dataset.theme).toBe('light');
  result = { id, appearance: null }; await controller.load(false);
  expect(controller.snapshot().appearance).toBeNull(); controller.destroy();
});
