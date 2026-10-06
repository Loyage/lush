import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';
import { until } from '../helpers.js';

const world = makeWorld(), json = value => ({ ok: true, json: async () => structuredClone(value) });
const freeze = { branch: 'main', kind: 'delivery', task_id: 9, reason: '父队列执行中' };
let failing = false, release = null;
const calls = [];
const dom = installDom({ fetch: (url, options = {}) => {
  const path = String(url); const body = options.body ? JSON.parse(options.body) : null;
  if (path.endsWith('/api/input-parents')) return json({ items: [{ id: 100, branch: 'main', goal: 'main', freeze }] });
  if (body?.method === 'order.submit') {
    calls.push(body);
    if (release === false) return new Promise(done => { release = () => done(json({ deferred: true, parent_id: 100, hook_id: 'queued-create' })); });
    return failing ? { ok: false, json: async () => ({ error: '配置无效' }) } : json({ deferred: true, parent_id: 100, hook_id: 'queued-create' });
  }
  return world.fetchImpl(url, options);
} });
const { boot } = await import('../../src/ui/web/assets/app.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
const { overview } = await import('../../src/ui/web/assets/navigate.js');
const { syncComposer } = await import('../../src/ui/web/assets/composer.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const { setComposerReferences } = await import('../../src/ui/web/assets/context-references.js');
await boot();
afterAll(() => dom.restore());
const input = () => dom.node('input');
const submit = () => dom.node('input-form').onsubmit({ preventDefault() {} });
const reference = { version: 1, kind: 'text', target: {}, label: '引用', quote: '原始所见', location: {}, captured_at: '2026-01-01T00:00:00Z' };

test('frozen valid main retains editable composer and complete run settings; primary action explicitly authorizes deferred start', async () => {
  await overview(); calls.length = 0;
  ui.composerProfile = { agent: 'pi', config_mode: 'pi' };
  input().value = '新的独立工作'; setComposerReferences([reference]); syncComposer();
  expect(input().disabled).toBe(false); expect(dom.node('draft-commit').textContent).toBe('预约发射 Worker');
  expect(dom.node('draft-commit').classList.contains('hook-button')).toBe(true);
  expect(dom.node('input-send-help').getAttribute('data-help')).toContain('不创建 Worker 或调用 Agent');
  await submit(); await until(() => !ui.composerSubmitting);
  expect(calls[0]).toEqual({ method: 'order.submit', params: { content: '新的独立工作', references: [reference], branch: 'main', start: true, defer: true, profile: { agent: 'pi', config_mode: 'pi' } } });
  // Deferred returns no task: acknowledgement must not dereference or claim a Worker was created.
  expect(input().value).toBe(''); expect(ui.composerProfile).toBeNull();
});

test('failed deferred request preserves text, references and profile without choosing another parent', async () => {
  await overview(); failing = true; ui.composerProfile = { agent: 'pi', config_mode: 'pi' };
  input().value = '失败仍保留'; setComposerReferences([reference]); syncComposer();
  await submit(); await until(() => !ui.composerSubmitting);
  expect(input().value).toBe('失败仍保留'); expect(ui.composerProfile).toEqual({ agent: 'pi', config_mode: 'pi' });
  expect(ui.composerReferences).toEqual([reference]); expect(dom.node('error').textContent).toContain('配置无效'); failing = false;
});

test('keyboard only-create stays explicit; input typed during flight is not cleared by a deferred response', async () => {
  await overview(); ui.composerProfile = null; setComposerReferences([]); input().value = '只创建'; syncComposer();
  const event = { key: 'Enter', ctrlKey: true, preventDefault() {} };
  await input().onkeydown(event); expect(calls.at(-1).params).toMatchObject({ start: false, defer: true });
  await overview(); release = false; input().value = '前一条'; syncComposer();
  const pending = submit(); await until(() => typeof release === 'function');
  input().value = '新写的文字'; input().oninput({}); release(); await pending;
  expect(input().value).toBe('新写的文字'); release = null;
});

test('frozen main detail can mount a creation Hook, but archived roots and frozen code Worker inboxes remain blocked', () => {
  const root = { id: 100, task_kind: 'main', status: 'waiting', branch: 'main', freeze };
  activateDetailView({ view: 'task', key: 'task-100' }); ui.selected = 100; ui.composerTask = root; input().value = '目标'; syncComposer();
  expect(input().disabled).toBe(false); expect(dom.node('draft-commit').textContent).toBe('预约发射 Worker');
  ui.composerTask = { ...root, branch_archive: { archived: true } }; syncComposer(); expect(input().disabled).toBe(true);
  ui.composerTask = { ...root, task_kind: 'order', branch: 'feature', workspace: '/tmp/feature' }; syncComposer();
  expect(input().disabled).toBe(true); expect(deepText(dom.node('composer-shell'))).not.toContain('改投');
});
