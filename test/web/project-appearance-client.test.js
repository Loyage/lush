import { test, expect } from 'bun:test';
import { createAppearance } from '../../src/ui/web/assets/appearance.js';

const id = 'abcdef0123456789';
const appearance = (theme = 'dark', color = 'blue', revision = 'rev-1') => ({ id, appearance: { version: 1, theme, color, revision } });
const button = () => ({ disabled: false, attrs: {}, setAttribute(key, value) { this.attrs[key] = value; },
  getAttribute(key) { return this.attrs[key] ?? null; }, removeAttribute(key) { delete this.attrs[key]; } });
function fixture(request) {
  const root = { dataset: {} }, toggle = button(), timers = [];
  const controller = createAppearance({ root, toggle, media: { matches: false }, projectId: id, request,
    setInterval: fn => { timers.push(fn); return 1; }, clearInterval() {} });
  return { controller, root, toggle, tick: () => timers[0]() };
}

test('project appearance initializes only on explicit open, saves revision and does not use browser storage', async () => {
  const calls = [];
  const { controller, root, toggle } = fixture(async (url, options) => {
    calls.push({ url, options });
    if (!options) return { id, appearance: null };
    const body = JSON.parse(options.body);
    return body.initialize ? appearance() : appearance(body.theme, body.color, 'rev-2');
  });
  expect(toggle.disabled).toBe(true);
  await controller.load(true);
  expect(calls.map(call => call.options?.method || 'GET')).toEqual(['GET', 'POST']);
  expect(JSON.parse(calls[1].options.body)).toEqual({ initialize: true });
  expect(root.dataset).toEqual({ theme: 'dark', projectColor: 'blue' });
  await controller.save({ color: 'rose' });
  expect(JSON.parse(calls[2].options.body)).toEqual({ theme: 'dark', color: 'rose', expected_revision: 'rev-1' });
  expect(root.dataset.projectColor).toBe('rose');
  expect(controller.snapshot().appearance.revision).toBe('rev-2');
  controller.destroy();
});

test('background synchronization picks up another browser changes; failed reads retain known values', async () => {
  let result = appearance(), fail = false;
  const { controller, root, tick } = fixture(async () => { if (fail) throw new Error('offline'); return result; });
  await controller.load(true);
  result = appearance('light', 'teal', 'rev-2');
  await tick();
  expect(root.dataset).toEqual({ theme: 'light', projectColor: 'teal' });
  fail = true; await tick();
  expect(controller.snapshot().error).toBe('offline');
  expect(root.dataset.projectColor).toBe('teal');
  controller.destroy();
});

test('save conflict is visible, preserves persisted revision and serializes writes', async () => {
  let rejectSave;
  const { controller, root, toggle } = fixture(async (_url, options) => options
    ? await new Promise((_resolve, reject) => { rejectSave = reject; }) : appearance());
  await controller.load(true);
  const saving = controller.save({ theme: 'light' });
  expect(toggle.disabled).toBe(true);
  await expect(controller.save({ color: 'rose' })).rejects.toThrow('正在同步');
  rejectSave(new Error('revision conflict'));
  await expect(saving).rejects.toThrow('revision conflict');
  expect(root.dataset.theme).toBe('dark');
  expect(controller.snapshot().appearance.revision).toBe('rev-1');
  expect(controller.snapshot().error).toBe('revision conflict');
  expect(toggle.disabled).toBe(false);
  controller.destroy();
});

test('late response after destruction cannot repaint or initialize the old project', async () => {
  let resolve;
  const calls = [];
  const { controller, root } = fixture(async (_url, options) => {
    calls.push(options);
    return await new Promise(done => { resolve = done; });
  });
  const loading = controller.load(true);
  controller.destroy();
  resolve({ id, appearance: null });
  await loading;
  expect(calls).toHaveLength(1);
  expect(root.dataset.projectColor).toBeUndefined();
});

test('disabled sidebar theme button transfers help to a focusable outer host', async () => {
  const toggle = button(), host = button(); host.classList = { contains: name => name === 'help-host' }; toggle.parentNode = host;
  const controller = createAppearance({ root: { dataset: {} }, toggle, media: null, projectId: id,
    request: async () => appearance(), setInterval: null });
  expect(toggle.disabled).toBe(true);
  expect(host.attrs['data-help']).toContain('尚未加载');
  expect(host.attrs.tabindex).toBe('0');
  expect(toggle.attrs['data-help']).toBeUndefined();
  await controller.load(true);
  expect(host.attrs['data-help']).toBeUndefined();
  expect(host.attrs.tabindex).toBeUndefined();
  expect(toggle.attrs['data-help']).toContain('切换');
  controller.destroy();
});

test('wrong project, malformed metadata and uninitialized background reads cannot fall back to browser theme', async () => {
  let result = { ...appearance(), id: '0123456789abcdef' };
  const { controller, root, toggle } = fixture(async () => result);
  await controller.load(true);
  expect(controller.snapshot().error).toContain('响应无效');
  expect(toggle.disabled).toBe(true);
  expect(root.dataset.projectColor).toBeUndefined();
  expect(root.dataset.theme).toBe('light');
  result = { id, appearance: null };
  await controller.load(false);
  expect(controller.snapshot().appearance).toBeNull();
  controller.destroy();
});
