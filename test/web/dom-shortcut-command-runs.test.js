import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom, deepText, dialogButton } from '../dom-stub.js';
import { until } from '../helpers.js';

const uuid = n => `c8c8c8c8-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (patch = {}) => ({ event_id: 100, id: uuid(1), command_name: '运行时名称', command_version: 3,
  worker_id: 44, worker_number: 'W8-1', source: 'hook', status: 'running', created_at: '2026-10-10T00:00:00Z', finished_at: null, ...patch });
const page = (items = [], extra = {}) => ({ version: 1, items, has_more: false, next_before: null, ...extra });
const json = value => ({ ok: true, json: async () => structuredClone(value) });
let requests, intercept, defaultPage, component, owned, busy, timers;
const dom = installDom({ fetch: async (url, options = {}) => {
  const path = String(url), body = options.body ? JSON.parse(options.body) : null; requests.push({ path, body, signal: options.signal });
  const custom = intercept?.(path, body); if (custom) return custom;
  if (path.includes('/api/hooks/commands/executions')) return json(defaultPage);
  throw new Error(`Unexpected request ${path} ${body?.method}`);
} });
const { createShortcutRuns } = await import('../../src/ui/web/assets/shortcut-command-runs.js');
const { closeDialog } = await import('../../src/ui/web/assets/dialog.js');
const root = () => dom.node('detail');
const btn = label => root().querySelectorAll('button').find(item => item.textContent === label);
const writes = () => requests.filter(item => item.body);
beforeEach(() => { component?.dispose(); closeDialog(); requests = []; intercept = null; defaultPage = page(); owned = true; busy = false; timers = new Map(); root().replaceChildren(); });
afterAll(() => { component?.dispose(); closeDialog(); dom.restore(); });
async function mount() {
  let timerId = 0;
  component = createShortcutRuns({ ownsPage: () => owned, busy: () => busy, setBusy: value => { busy = value; },
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); } });
  root().replaceChildren(component.history); await until(() => !btn('刷新运行记录').disabled);
}
async function tick() { const [id, fn] = [...timers][0] || []; expect(fn).toBeTruthy(); timers.delete(id); await fn(); }

test('history-only component has no execution/Worker directory entry or mutation, even without a command catalogue', async () => {
  await mount(); expect(component.node).toBeUndefined(); expect(root().querySelector('select')).toBeNull();
  for (const label of ['手动执行', '创建并启动 Agent', '确认执行一次']) expect(btn(label)).toBeUndefined(); expect(writes()).toHaveLength(0);
  expect(requests.every(item => item.path.includes('/commands/executions'))).toBe(true);
});

test('poll follows exact UUID, confirms final state and does not leak raw output', async () => {
  defaultPage = page([row()]); await mount(); intercept = path => path.includes('execution_id=') ? json(page([row({ status: 'succeeded', command_result: { exit_code: 0, stdout: 'SECRET' } })])) : null;
  await tick(); expect(requests.at(-1).path).toContain(`execution_id=${uuid(1)}`); expect(deepText(root())).toContain('执行成功'); expect(deepText(root())).toContain('退出码 0'); expect(deepText(root())).not.toContain('SECRET'); expect(timers.size).toBe(0); expect(writes()).toHaveLength(0);
});

test('pagination retains historical names, versions, sources and Worker identities without definitions', async () => {
  defaultPage = page([row({ status: 'succeeded' })], { has_more: true, next_before: 100 }); await mount();
  intercept = path => path.includes('before=100') ? json(page([row({ id: uuid(2), event_id: 20, command_name: '<script>旧名字</script>', command_version: 1, source: 'manual', status: 'failed', command_result: { exit_code: 5, reason: 'output_limit', stderr: 'SECRET' } })])) : null;
  await btn('更早运行记录').onclick(); expect(root().querySelectorAll('.shortcut-execution')).toHaveLength(2); expect(root().querySelector('script')).toBeNull();
  for (const text of ['<script>旧名字</script>', '历史手动运行', 'v1', 'W8-1', '退出码 5', '输出超限']) expect(deepText(root())).toContain(text);
  expect(deepText(root())).not.toContain('SECRET'); expect(btn('更早运行记录').hidden).toBe(true); expect(writes()).toHaveLength(0);
});

test('reopening unknown records keeps fallback internal identity and never replays', async () => {
  defaultPage = page([row({ status: 'unknown', command_name: null, source: 'unknown', worker_number: null })]); await mount(); component.dispose(); await mount();
  for (const text of ['结果未知', '名称未保存', '#44']) expect(deepText(root())).toContain(text); expect(timers.size).toBe(0); expect(writes()).toHaveLength(0);
});

test('poll disconnection retains pending facts, stops automatic reads and recovers on explicit refresh', async () => {
  defaultPage = page([row()]); await mount(); intercept = path => path.includes('execution_id=') ? Promise.reject(new Error('SECRET offline')) : null;
  await tick(); expect(deepText(root())).toContain('执行中'); expect(deepText(root())).toContain('结果未确认'); expect(deepText(root())).not.toContain('SECRET'); expect(timers.size).toBe(0);
  intercept = null; defaultPage = page([row({ status: 'succeeded' })]); await btn('刷新运行记录').onclick(); expect(deepText(root())).toContain('执行成功');
});

test('navigation aborts inflight reads, ignores their result and stops next scheduled read', async () => {
  defaultPage = page([row()]); await mount(); const count = requests.length; owned = false; await tick(); expect(requests).toHaveLength(count);
  owned = true; await mount(); let resolve; intercept = path => path.includes('execution_id=') ? new Promise(done => { resolve = done; }) : null;
  const polling = tick(); await until(() => resolve); const signal = requests.at(-1).signal; owned = false; component.dispose(); const next = document.createElement('p'); root().replaceChildren(next);
  expect(signal.aborted).toBe(true); resolve(json(page([row({ status: 'failed' })]))); await polling; expect(root().children).toEqual([next]); expect(timers.size).toBe(0);
});

test('subpage suspension stops reads and preserves loaded history, rejecting late responses', async () => {
  defaultPage = page([row()]); await mount(); let resolve; intercept = path => path.includes('execution_id=') ? new Promise(done => { resolve = done; }) : null;
  const polling = tick(); await until(() => resolve); component.setActive(false); expect(requests.at(-1).signal.aborted).toBe(true);
  resolve(json(page([row({ status: 'failed' })]))); await polling; expect(deepText(root())).toContain('执行中'); expect(timers.size).toBe(0);
  intercept = null; component.setActive(true); expect(timers.size).toBe(1); expect(root().querySelectorAll('.shortcut-execution')).toHaveLength(1);
});

test('old service missing history disables safe deletion with accessible refusal, no execution fallback', async () => {
  intercept = () => Promise.resolve({ ok: false, json: async () => ({ error: 'not found' }) }); await mount(); const clear = btn('清空已结束记录');
  expect(clear.disabled).toBe(true); expect(clear.parentNode.tabIndex).toBe(0); expect(deepText(root())).toContain('更新后台与界面服务'); await clear.onclick(); expect(writes()).toHaveLength(0);
  expect(deepText(root())).not.toContain('尚无运行记录');
});

test('wrong UUID response is rejected, never accepted as a final result', async () => {
  defaultPage = page([row()]); await mount(); intercept = path => path.includes('execution_id=') ? json(page([row({ id: uuid(2), status: 'succeeded' })])) : null;
  await tick(); expect(deepText(root())).toContain('执行中'); expect(deepText(root())).not.toContain('命令结果：执行成功'); expect(timers.size).toBe(0);
});

test('refresh invalidates earlier exact-result polls', async () => {
  defaultPage = page([row()]); await mount(); let resolve; intercept = path => path.includes('execution_id=') ? new Promise(done => { resolve = done; }) : null;
  const polling = tick(); await until(() => resolve); defaultPage = page([row({ status: 'succeeded', command_result: { exit_code: 0 } })]); await btn('刷新运行记录').onclick();
  resolve(json(page([row({ status: 'failed', command_result: { exit_code: 9 } })]))); await polling; expect(deepText(root())).toContain('执行成功'); expect(deepText(root())).not.toContain('退出码 9');
});

for (const status of ['pending', 'running', 'unknown']) test(`${status} records refuse deletion`, async () => {
  defaultPage = page([row({ status })]); await mount(); const remove = btn('删除运行记录'); expect(remove.disabled).toBe(true); expect(remove.parentNode.tabIndex).toBe(0); expect(remove.parentNode.getAttribute('data-help')).toContain('不可删除'); await remove.onclick(); expect(writes()).toHaveLength(0);
});

test('safe deletion confirms scope, rereads and prevents stale snapshots resurrecting deleted UUID', async () => {
  defaultPage = page([row({ status: 'succeeded' })]); await mount(); intercept = (_path, body) => body?.method === 'hooks.command_history_remove' ? json({ removed_count: 1 }) : null;
  const removing = btn('删除运行记录').onclick(); expect(writes()).toHaveLength(0); expect(deepText(dom.node('modal'))).toContain('保留安全审计'); await dialogButton(dom, '删除记录').onclick(); await removing;
  expect(writes().map(item => item.body)).toEqual([{ method: 'hooks.command_history_remove', params: { execution_id: uuid(1) } }]); expect(root().querySelector('.shortcut-execution')).toBeNull(); await btn('刷新运行记录').onclick(); expect(root().querySelector('.shortcut-execution')).toBeNull();
});

test('clear includes unloaded ended rows but preserves active and unknown records', async () => {
  defaultPage = page([row({ status: 'succeeded' }), row({ id: uuid(2), event_id: 99, status: 'failed' }), row({ id: uuid(3), event_id: 98, status: 'unknown' }), row({ id: uuid(4), event_id: 97, status: 'pending' })]); await mount();
  intercept = (_path, body) => body?.method === 'hooks.command_history_remove' ? json({ removed_count: 2 }) : null; const clearing = btn('清空已结束记录').onclick(); expect(deepText(dom.node('modal'))).toContain('尚未加载'); await dialogButton(dom, '清空已结束').onclick(); await clearing;
  expect(writes()[0].body.params).toEqual({ clear: true }); expect(root().querySelectorAll('.shortcut-execution')).toHaveLength(2); expect(deepText(root())).toContain('结果未知'); expect(deepText(root())).toContain('已提交，等待执行');
});

for (const exit of ['cancel', 'navigation', 'subpage']) test(`deletion ${exit} during confirmation does not post`, async () => {
  defaultPage = page([row({ status: 'failed' })]); await mount(); const removing = btn('删除运行记录').onclick();
  if (exit === 'cancel') closeDialog(); else { if (exit === 'navigation') owned = false; else component.setActive(false); await dialogButton(dom, '删除记录').onclick(); }
  await removing; expect(writes()).toHaveLength(0);
});

for (const response of [() => Promise.reject(new Error('offline SECRET')), () => json({ removed_count: '1' })]) test('unconfirmed removal keeps records and blocks blind resend until explicit refresh', async () => {
  defaultPage = page([row({ status: 'failed' })]); await mount(); intercept = (_path, body) => body?.method === 'hooks.command_history_remove' ? response() : null;
  const removing = btn('删除运行记录').onclick(); await dialogButton(dom, '删除记录').onclick(); await removing;
  expect(root().querySelector('.shortcut-execution')).toBeTruthy(); expect(deepText(root())).toContain('未假定删除成功'); expect(deepText(root())).not.toContain('SECRET'); expect(btn('删除运行记录').disabled).toBe(true);
  await btn('删除运行记录').onclick(); expect(writes()).toHaveLength(1); await btn('刷新运行记录').onclick(); expect(btn('删除运行记录').disabled).toBe(false);
});

test('removal invalidates exact-result polls and rereads active rows', async () => {
  defaultPage = page([row({ id: uuid(2), event_id: 99, status: 'failed' }), row()]); await mount(); let resolve;
  intercept = (path, body) => path.includes('execution_id=') ? new Promise(done => { resolve = done; }) : body?.method === 'hooks.command_history_remove' ? json({ removed_count: 1 }) : null;
  const polling = tick(); await until(() => resolve); const removing = root().querySelectorAll('button').find(item => item.textContent === '删除运行记录' && !item.disabled).onclick(); await dialogButton(dom, '删除记录').onclick(); await removing;
  resolve(json(page([row({ status: 'succeeded' })]))); await polling; expect(root().querySelectorAll('.shortcut-execution')).toHaveLength(1); expect(deepText(root())).toContain('执行中');
});

test('late deletion never paints another project or starts a reread there', async () => {
  defaultPage = page([row({ status: 'succeeded' })]); await mount(); let resolve; intercept = (_path, body) => body ? new Promise(done => { resolve = done; }) : null;
  const removing = btn('删除运行记录').onclick(); await dialogButton(dom, '删除记录').onclick(); await until(() => resolve); owned = false; component.dispose(); const next = document.createElement('p'); root().replaceChildren(next); const count = requests.length;
  resolve(json({ removed_count: 1 })); await removing; expect(root().children).toEqual([next]); expect(requests).toHaveLength(count);
});

test('acknowledged removal survives failed reread, no retry or resurrection', async () => {
  defaultPage = page([row({ status: 'succeeded' })]); await mount(); intercept = (path, body) => body ? json({ removed_count: 1 }) : path.includes('/commands/executions') ? Promise.reject(new Error('offline')) : null;
  const removing = btn('删除运行记录').onclick(); await dialogButton(dom, '删除记录').onclick(); await removing;
  expect(root().querySelector('.shortcut-execution')).toBeNull(); expect(deepText(root())).toContain('已持久移除 1 条'); expect(deepText(root())).toContain('运行记录暂不可用'); expect(writes()).toHaveLength(1); expect(btn('清空已结束记录').disabled).toBe(true);
});

test('prompt Hook history links real created Worker and O input without claiming Agent completion', async () => {
  defaultPage = page([row({ kind: 'prompt', status: 'succeeded', created_worker_id: 99, created_worker_number: 'W10', input_id: 11, command_result: { stdout: 'SECRET' } })]); await mount();
  expect(deepText(root())).toContain('不是 Agent 工作完成'); expect(root().querySelector('a').href).toBe('#worker-99'); expect(deepText(root())).toContain('W10'); expect(deepText(root())).toContain('O11'); expect(deepText(root())).not.toContain('SECRET'); expect(writes()).toHaveLength(0);
});
