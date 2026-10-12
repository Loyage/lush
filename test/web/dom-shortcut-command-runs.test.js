import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom, deepText, dialogButton } from '../dom-stub.js';
import { until } from '../helpers.js';

const uuid = n => `c8c8c8c8-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (patch = {}) => ({ event_id: 100, id: uuid(1), command_id: 'push', command_name: '运行时名称', command_version: 3,
  worker_id: 44, worker_number: 'W8-1', source: 'manual', status: 'running', created_at: '2026-10-10T00:00:00Z', finished_at: null, ...patch });
const commands = () => ({ version: 1, revision: 'revision-before', items: [{ id: 'push', name: '当前名称', command: 'printf fixture', version: 3, authorized: true, last_execution: null }] });
const page = (items = [], extra = {}) => ({ version: 1, items, has_more: false, next_before: null, ...extra });
const json = value => ({ ok: true, json: async () => structuredClone(value) });
let requests, intercept, defaultPage, component, owned, busy, model, updates, timers;
const dom = installDom({ fetch: async (url, options = {}) => {
  const path = String(url), body = options.body ? JSON.parse(options.body) : null;
  requests.push({ path, body, signal: options.signal });
  const custom = intercept?.(path, body); if (custom) return custom;
  if (path.includes('/api/hooks/commands/executions')) return json(defaultPage);
  if (path.endsWith('/api/hooks')) return json({ commands: model });
  if (path.endsWith('/api/input-parents')) return json({ items: [{ id: 1, branch: 'main' }, { id: 42, branch: 'work', worker_number: 'W8' }] });
  if (path.endsWith('/api/snapshot')) return json({ tasks: [{ id: 44, branch: 'child', task_kind: 'child', status: 'waiting', worker_number: 'W8-1' }] });
  if (body?.method === 'hooks.command_start') return json({ execution_id: uuid(1), execution: row({ status: 'pending' }), commands: { ...model, revision: 'revision-after' } });
  throw new Error(`Unexpected request ${path} ${body?.method}`);
} });
const { createShortcutRuns } = await import('../../src/ui/web/assets/shortcut-command-runs.js');
const { closeDialog } = await import('../../src/ui/web/assets/dialog.js');
const root = () => dom.node('detail');
const btn = label => root().querySelectorAll('button').find(item => item.textContent === label);
const field = () => root().querySelector('[aria-label="执行目录 Worker"]');
const writes = () => requests.filter(item => item.body);
beforeEach(() => {
  component?.dispose(); closeDialog(); requests = []; intercept = null; defaultPage = page(); owned = true; busy = false; model = commands(); updates = []; timers = new Map(); dom.location.pathname = '/';
  root().replaceChildren();
});
afterAll(() => { component?.dispose(); closeDialog(); dom.restore(); });
async function mount() {
  let timerId = 0;
  component = createShortcutRuns({ model, ownsPage: () => owned, busy: () => busy, setBusy: value => { busy = value; }, onCommands: value => { updates.push(value); model = value; component.update(value); },
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); } });
  root().replaceChildren(component.node, component.history);
  await until(() => !btn('刷新运行记录').disabled);
}
async function tick() { const [id, fn] = [...timers][0] || []; expect(fn).toBeTruthy(); timers.delete(id); await fn(); }
async function submit() {
  await btn('手动执行').onclick(); field().value = '44'; const promise = btn('确认执行一次').onclick();
  await dialogButton(dom, '执行一次').onclick(); await promise;
}

test('async submission displays durable pending identity and only reads its UUID for the final result', async () => {
  await mount(); await submit();
  expect(writes()).toHaveLength(1); expect(writes()[0].body).toEqual({ method: 'hooks.command_start', params: { id: 'push', version: 3, worker_id: 44, expected_revision: 'revision-before' } });
  expect(deepText(root())).toContain('已提交，等待执行'); expect(deepText(root())).toContain(uuid(1)); expect(timers.size).toBe(1);
  model.items[0].last_execution = { id: uuid(9), status: 'failed', command_result: { status: 'failed', stdout: 'SECRET' } };
  intercept = path => path.includes('execution_id=') ? json(page([row({ status: 'succeeded', finished_at: '2026-10-10T00:00:40Z', command_result: { exit_code: 0, stdout: 'SECRET' } })])) : null;
  await tick();
  expect(requests.at(-1).path).toContain(`execution_id=${uuid(1)}`); expect(deepText(root())).toContain('执行成功'); expect(deepText(root())).toContain('退出码 0');
  expect(deepText(root())).not.toContain('SECRET'); expect(timers.size).toBe(0); expect(writes()).toHaveLength(1);
});

test('each deliberate new run rereads authorization and the revision changed by prior settlement', async () => {
  await mount(); await submit();
  defaultPage = page([row({ status: 'succeeded', command_result: { exit_code: 0 } })]);
  intercept = path => path.includes('execution_id=') ? json(defaultPage) : path.endsWith('/api/hooks')
    ? json({ commands: { ...model, revision: 'revision-after-settlement' } }) : null;
  await tick();
  await btn('关闭手动执行').onclick(); await submit();
  expect(writes()).toHaveLength(2);
  expect(writes()[1].body.params.expected_revision).toBe('revision-after-settlement');
  expect(writes().every(item => item.body.method === 'hooks.command_start')).toBe(true);
});

test('a changed selected command is not silently replaced or sent to a Worker', async () => {
  await mount(); intercept = path => path.endsWith('/api/hooks') ? json({ commands: { ...model, items: [{ ...model.items[0], version: 4 }] } }) : null;
  await btn('手动执行').onclick();
  expect(field()).toBeNull(); expect(writes()).toHaveLength(0);
});

test('every history page retains snapshots, versions, source, Worker number and results after command removal', async () => {
  const old = row({ event_id: 20, id: uuid(2), source: 'hook', command_name: '<script>旧名字</script>', command_version: 1, status: 'failed', finished_at: '2026-10-10T00:01:00Z',
    command_result: { exit_code: 5, reason: 'output_limit', stderr: 'SECRET-OUTPUT' } });
  defaultPage = page([row({ status: 'succeeded', command_result: { exit_code: 0 } })], { has_more: true, next_before: 100 });
  await mount(); model = { ...model, items: [] }; component.update(model);
  intercept = path => path.includes('before=100') ? json(page([old])) : null;
  await btn('更早运行记录').onclick();
  expect(root().querySelectorAll('.shortcut-execution')).toHaveLength(2); expect(deepText(root())).toContain('<script>旧名字</script>'); expect(root().querySelector('script')).toBeNull();
  expect(deepText(root())).toContain('Hook 触发'); expect(deepText(root())).toContain('v1'); expect(deepText(root())).toContain('W8-1'); expect(deepText(root())).toContain('退出码 5');
  expect(deepText(root())).not.toContain('SECRET-OUTPUT'); expect(btn('更早运行记录').hidden).toBe(true); expect(writes()).toHaveLength(0);
});

test('reopening recovers persisted unknown and failed runs without replaying commands', async () => {
  defaultPage = page([row({ status: 'unknown', command_name: null, source: 'unknown', worker_number: null, command_result: null })]);
  await mount(); expect(deepText(root())).toContain('结果未知'); expect(deepText(root())).toContain('名称未保存'); expect(deepText(root())).toContain('#44');
  component.dispose(); await mount(); expect(root().querySelectorAll('.shortcut-execution')).toHaveLength(1); expect(writes()).toHaveLength(0); expect(timers.size).toBe(0);
});

test('poll disconnection leaves execution pending, stops querying, and explicit refresh recovers success', async () => {
  defaultPage = page([row()]); await mount();
  intercept = path => path.includes('execution_id=') ? Promise.reject(new Error('RPC timed out SECRET-ERROR')) : null;
  await tick(); expect(deepText(root())).toContain('执行中'); expect(deepText(root())).toContain('结果未确认'); expect(deepText(root())).not.toContain('命令结果：执行失败');
  expect(deepText(root())).not.toContain('SECRET-ERROR'); expect(timers.size).toBe(0);
  intercept = null; defaultPage = page([row({ status: 'succeeded', command_result: { exit_code: 0 } })]); await btn('刷新运行记录').onclick();
  expect(deepText(root())).toContain('执行成功'); expect(writes()).toHaveLength(0);
});

test('leaving the page stops the next scheduled read and ignores an already in-flight result', async () => {
  defaultPage = page([row()]); await mount(); const count = requests.length; owned = false; await tick(); expect(requests).toHaveLength(count); expect(timers.size).toBe(0);
  owned = true; await mount(); let resolve;
  intercept = path => path.includes('execution_id=') ? new Promise(done => { resolve = done; }) : null;
  const polling = tick(); await until(() => resolve); const signal = requests.at(-1).signal;
  owned = false; component.dispose(); const next = document.createElement('p'); next.textContent = 'next project'; root().replaceChildren(next);
  expect(signal.aborted).toBe(true); resolve(json(page([row({ status: 'failed' })]))); await polling;
  expect(root().children).toEqual([next]); expect(timers.size).toBe(0);
});

test('unconfirmed POST keeps selection and never retries the mutation or falls back to synchronous run', async () => {
  await mount(); intercept = (_path, body) => body ? Promise.reject(new Error('request timed out SECRET')) : null;
  await submit(); expect(writes()).toHaveLength(1); expect(field().value).toBe('44'); expect(btn('确认执行一次').disabled).toBe(true);
  expect(deepText(root())).toContain('不要盲目重试'); expect(deepText(root())).toContain('结果未确认'); expect(deepText(root())).not.toContain('SECRET');
  await btn('确认执行一次').onclick(); await btn('刷新运行记录').onclick(); expect(writes()).toHaveLength(1);
  expect(writes().some(item => item.body.method === 'hooks.command_run')).toBe(false);
});

test('late POST result does not repaint a new page or publish its command revision', async () => {
  await mount(); let resolve;
  intercept = (_path, body) => body ? new Promise(done => { resolve = done; }) : null;
  const submitting = submit(); await until(() => resolve); owned = false; component.dispose();
  const next = document.createElement('p'); next.textContent = 'other page'; root().replaceChildren(next);
  resolve(json({ execution_id: uuid(1), execution: row(), commands: model })); await submitting;
  expect(root().children).toEqual([next]); expect(updates).toHaveLength(1); expect(updates[0].revision).toBe('revision-before');
  expect(timers.size).toBe(0); expect(writes()).toHaveLength(1);
});

test('old service missing history disables execution and exposes keyboard-accessible help without fallback', async () => {
  intercept = path => path.includes('/commands/executions') ? Promise.resolve({ ok: false, json: async () => ({ error: 'not found' }) }) : null;
  await mount(); const execute = btn('手动执行'); expect(execute.disabled).toBe(true); expect(execute.parentNode.tabIndex).toBe(0);
  expect(execute.parentNode.getAttribute('data-help')).toContain('旧后台'); expect(deepText(root())).toContain('更新后台与界面服务');
  await execute.onclick(); expect(writes()).toHaveLength(0);
});

test('malformed or wrong UUID result is not accepted as the tracked execution result', async () => {
  defaultPage = page([row()]); await mount(); intercept = path => path.includes('execution_id=') ? json(page([row({ id: uuid(2), status: 'succeeded' })])) : null;
  await tick(); expect(deepText(root())).not.toContain('命令结果：执行成功'); expect(deepText(root())).toContain('执行中'); expect(timers.size).toBe(0); expect(writes()).toHaveLength(0);
});

test('navigation cancels Worker picker reads without falling back to another Worker', async () => {
  await mount(); let resolve;
  intercept = path => path.endsWith('/api/input-parents') ? new Promise(done => { resolve = done; }) : null;
  const picking = btn('手动执行').onclick(); await until(() => resolve);
  const request = requests.findLast(item => item.path.endsWith('/api/input-parents'));
  owned = false; component.dispose(); expect(request.signal.aborted).toBe(true);
  resolve(json({ items: [{ id: 1, branch: 'main' }] })); await picking;
  expect(field()).toBeNull(); expect(writes()).toHaveLength(0);
});

test('a pre-submission history reply cannot erase the newly acknowledged execution UUID', async () => {
  await mount(); let resolve;
  intercept = (path, body) => !body && path.includes('/commands/executions') ? new Promise(done => { resolve = done; }) : null;
  const refreshing = btn('刷新运行记录').onclick(); await until(() => resolve);
  await submit(); expect(deepText(root())).toContain(uuid(1));
  resolve(json(page())); await refreshing;
  expect(deepText(root())).toContain(uuid(1)); expect(deepText(root())).toContain('已提交，等待执行'); expect(timers.size).toBe(1);
});

test('refresh invalidates late exact-result queries and keeps the refreshed authoritative state', async () => {
  defaultPage = page([row()]); await mount(); let resolve;
  intercept = path => path.includes('execution_id=') ? new Promise(done => { resolve = done; }) : null;
  const polling = tick(); await until(() => resolve);
  defaultPage = page([row({ status: 'succeeded', command_result: { exit_code: 0 } })]); await btn('刷新运行记录').onclick();
  resolve(json(page([row({ status: 'failed', command_result: { exit_code: 9 } })]))); await polling;
  expect(deepText(root())).toContain('执行成功'); expect(deepText(root())).not.toContain('退出码 9'); expect(timers.size).toBe(0);
});

test('saved default Worker is preselected on every deliberate run, including child, without changing explicit start identity', async () => {
  model.items[0].default_worker_id = 44; await mount(); await btn('手动执行').onclick(); expect(field().value).toBe('44');
  const starting = btn('确认执行一次').onclick(); await dialogButton(dom, '执行一次').onclick(); await starting;
  expect(writes()[0].body.params.worker_id).toBe(44); expect(writes()[0].body.params.expected_revision).toBe('revision-before');
});

for (const id of [999, 42]) test(`unavailable saved directory ${id} is retained and refused, never cleared or routed to main`, async () => {
  model.items[0].default_worker_id = id;
  intercept = path => path.endsWith('/api/input-parents') ? json({ items: [{ id: 1, branch: 'main' }, { id: 42, branch: 'work', freeze: {} }] }) : null;
  await mount(); await btn('手动执行').onclick(); expect(field().value).toBe(String(id)); expect(deepText(root())).toContain('不会清空或改投 main');
  await btn('确认执行一次').onclick(); expect(writes()).toHaveLength(0);
  field().value = '44'; const starting = btn('确认执行一次').onclick(); await dialogButton(dom, '执行一次').onclick(); await starting;
  expect(writes()[0].body.params.worker_id).toBe(44);
});

for (const status of ['pending', 'running', 'unknown']) test(`${status} records have keyboard-accessible refusal help and never submit deletion`, async () => {
  defaultPage = page([row({ status })]); await mount(); const remove = btn('删除运行记录');
  expect(remove.disabled).toBe(true); expect(remove.parentNode.tabIndex).toBe(0); expect(remove.parentNode.getAttribute('data-help')).toContain('不可删除');
  await remove.onclick(); expect(writes()).toHaveLength(0);
});

test('history deletion confirms safe scope, posts only execution_id, rereads and cannot resurrect a deleted UUID from stale snapshots', async () => {
  const ended = row({ status: 'succeeded' }); defaultPage = page([ended]); await mount();
  intercept = (_path, body) => body?.method === 'hooks.command_history_remove' ? json({ removed_count: 1 }) : null;
  const removing = btn('删除运行记录').onclick(); expect(writes()).toHaveLength(0);
  expect(deepText(dom.node('modal'))).toContain('保留安全审计'); expect(deepText(dom.node('modal'))).toContain('不撤回命令副作用');
  await dialogButton(dom, '删除记录').onclick(); await removing;
  expect(writes().map(item => item.body)).toEqual([{ method: 'hooks.command_history_remove', params: { execution_id: uuid(1) } }]);
  expect(root().querySelector('.shortcut-execution')).toBeNull(); await btn('刷新运行记录').onclick(); expect(root().querySelector('.shortcut-execution')).toBeNull();
});

test('clear removes only succeeded/failed and includes unloaded records; pending and unknown survive', async () => {
  defaultPage = page([row({ status: 'succeeded' }), row({ id: uuid(2), event_id: 99, status: 'failed' }), row({ id: uuid(3), event_id: 98, status: 'unknown' }), row({ id: uuid(4), event_id: 97, status: 'pending' })]);
  await mount(); intercept = (_path, body) => body?.method === 'hooks.command_history_remove' ? json({ removed_count: 2 }) : null;
  const clearing = btn('清空已结束记录').onclick(); expect(deepText(dom.node('modal'))).toContain('尚未加载');
  await dialogButton(dom, '清空已结束').onclick(); await clearing;
  expect(writes()[0].body).toEqual({ method: 'hooks.command_history_remove', params: { clear: true } });
  expect(root().querySelectorAll('.shortcut-execution')).toHaveLength(2); expect(deepText(root())).toContain('结果未知'); expect(deepText(root())).toContain('已提交，等待执行');
});

test('cancelled removal and navigation during confirmation never post', async () => {
  defaultPage = page([row({ status: 'failed' })]); await mount(); let removing = btn('删除运行记录').onclick(); closeDialog(); await removing; expect(writes()).toHaveLength(0);
  removing = btn('删除运行记录').onclick(); owned = false; await dialogButton(dom, '删除记录').onclick(); await removing; expect(writes()).toHaveLength(0);
});

for (const response of [() => Promise.reject(new Error('offline SECRET')), () => json({ removed_count: '1' })]) test('unconfirmed deletion preserves the record and blocks blind resend until explicit reread', async () => {
  defaultPage = page([row({ status: 'failed' })]); await mount(); intercept = (_path, body) => body?.method === 'hooks.command_history_remove' ? response() : null;
  const removing = btn('删除运行记录').onclick(); await dialogButton(dom, '删除记录').onclick(); await removing;
  expect(root().querySelector('.shortcut-execution')).toBeTruthy(); expect(deepText(root())).toContain('未假定删除成功'); expect(deepText(root())).not.toContain('SECRET');
  expect(btn('删除运行记录').disabled).toBe(true); await btn('删除运行记录').onclick(); expect(writes()).toHaveLength(1);
  await btn('刷新运行记录').onclick(); expect(btn('删除运行记录').disabled).toBe(false);
});

test('removal invalidates late exact-result polls before confirmation and rereads active records afterwards', async () => {
  defaultPage = page([row({ status: 'failed', id: uuid(2), event_id: 99 }), row()]); await mount(); let resolve;
  intercept = (path, body) => path.includes('execution_id=') ? new Promise(done => { resolve = done; }) : body?.method === 'hooks.command_history_remove' ? json({ removed_count: 1 }) : null;
  const polling = tick(); await until(() => resolve);
  const removing = root().querySelectorAll('button').find(item => item.textContent === '删除运行记录' && !item.disabled).onclick(); await dialogButton(dom, '删除记录').onclick(); await removing;
  resolve(json(page([row({ status: 'succeeded' })]))); await polling;
  expect(root().querySelectorAll('.shortcut-execution')).toHaveLength(1); expect(deepText(root())).toContain('执行中'); expect(deepText(root())).not.toContain('执行成功');
});

test('a late deletion response never paints another project or starts a post-delete read there', async () => {
  defaultPage = page([row({ status: 'succeeded' })]); await mount(); let resolve;
  intercept = (_path, body) => body?.method === 'hooks.command_history_remove' ? new Promise(done => { resolve = done; }) : null;
  const removing = btn('删除运行记录').onclick(); await dialogButton(dom, '删除记录').onclick(); await until(() => resolve);
  owned = false; component.dispose(); const next = document.createElement('p'); root().replaceChildren(next); const count = requests.length;
  resolve(json({ removed_count: 1 })); await removing; expect(root().children).toEqual([next]); expect(requests).toHaveLength(count);
});

test('successful deletion with a failed subsequent reread remains acknowledged and never resends or resurrects the removed row', async () => {
  defaultPage = page([row({ status: 'succeeded' })]); await mount();
  intercept = (path, body) => body?.method === 'hooks.command_history_remove' ? json({ removed_count: 1 })
    : path.includes('/commands/executions') ? Promise.reject(new Error('offline')) : null;
  const removing = btn('删除运行记录').onclick(); await dialogButton(dom, '删除记录').onclick(); await removing;
  expect(root().querySelector('.shortcut-execution')).toBeNull(); expect(deepText(root())).toContain('已持久移除 1 条'); expect(deepText(root())).toContain('运行记录暂不可用');
  expect(writes()).toHaveLength(1); expect(btn('清空已结束记录').disabled).toBe(true);
});

test('async prompt creation polls exact identity and links created Worker without claiming Agent completion', async () => {
  model.items = [{ id: 'review', name: '审查', kind: 'prompt', prompt: '检查代码', version: 2, authorized: true }];
  intercept = (_path, body) => body?.method === 'hooks.command_start' ? json({ execution_id: uuid(1), execution: row({ kind: 'prompt', worker_id: 42, command_name: '审查', command_version: 2, status: 'pending' }), commands: model }) : null;
  await mount(); await btn('创建并启动 Agent').onclick();
  const parent = root().querySelector('[aria-label="提示词父 Worker"]'); parent.value = '42';
  const creating = btn('确认创建并启动').onclick(); await dialogButton(dom, '创建并启动').onclick(); await creating;
  expect(deepText(root())).toContain('等待创建'); expect(writes()[0].body.params).toEqual({ id: 'review', version: 2, worker_id: 42, expected_revision: 'revision-before' });
  intercept = path => path.includes('execution_id=') ? json(page([row({ kind: 'prompt', worker_id: 42, command_version: 2, status: 'succeeded', created_worker_id: 99, created_worker_number: 'W10', input_id: 11 })])) : null;
  await tick();
  expect(deepText(root())).toContain('不是 Agent 工作完成'); expect(root().querySelectorAll('a').find(link => link.href === '#worker-99').textContent).toContain('W10');
  expect(deepText(root())).toContain('O11'); expect(timers.size).toBe(0); expect(writes()).toHaveLength(1);
});
