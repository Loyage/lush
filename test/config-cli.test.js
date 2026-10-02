import { test, expect } from 'bun:test';
import { run as runConfigCommand } from '../src/cli/commands/config.js';
import { HELP } from '../src/cli/help.js';

// `lush config`：读 / 写项目级并发上限与快速路由前缀。参数解析、越界不落盘、agent 被拒都在这里覆盖。
const DEFAULT_ROUTES = [{ prefix: '开发', target: 'worker' }, { prefix: '解释', target: 'research' }];
const routes = (value, overridden = false) => ({ value: value.map(r => ({ ...r })), default: DEFAULT_ROUTES.map(r => ({ ...r })), overridden });
const statusModel = (overrides = {}) => ({ file: '/tmp/demo/.lush/settings.json',
  concurrency: { value: 4, default: 4, overridden: false },
  control_concurrency: { value: 2, default: 2, overridden: false },
  call_timeout: { value: 900, default: 900, overridden: false },
  task_call_limit: { value: 24, default: 24, overridden: false },
  max_depth: { value: 8, default: 8, overridden: false },
  input_routes: routes(DEFAULT_ROUTES),
  ...overrides });

/** 假 daemon：system.status 给读模型，system.configure 按核心语义（数字覆盖 / null 清除 / 前缀表整表写）回写。 */
function fakeClient({ token = null, settings = statusModel() } = {}) {
  const calls = [];
  return { token, calls,
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'system.status') return { settings };
      if (method === 'system.configure') {
        const next = { ...settings };
        for (const [key, value] of Object.entries(params.settings)) {
          if (value === null) next[key] = { ...next[key], value: next[key].default, overridden: false };
          else if (key === 'input_routes') next[key] = { ...next[key], value: value.map(r => ({ ...r })), overridden: true };
          else next[key] = { ...next[key], value, overridden: true };
        }
        return next;
      }
      throw new Error(`unexpected method ${method}`);
    } };
}

test('config show（含省略子命令）读取生效值、环境默认与设置文件', async () => {
  const client = fakeClient();
  const value = await runConfigCommand('config', [], { client, json: true });
  expect(value).toEqual(statusModel());
  expect(client.calls).toEqual([{ method: 'system.status', params: undefined }]);

  const explicit = fakeClient();
  expect(await runConfigCommand('config', ['show'], { client: explicit, json: true })).toEqual(statusModel());
});

test('config show 人类可读输出：执行通道 / 控制通道 / 快速路由 / 设置文件', async () => {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { await runConfigCommand('config', ['show'], { client: fakeClient(), json: false }); }
  finally { console.log = original; }
  const text = lines.join('\n');
  expect(text).toContain('执行通道 concurrency');
  expect(text).toContain('生效 4 · 环境默认 4 · 环境默认');
  expect(text).toContain('控制通道 control-concurrency');
  expect(text).toContain('快速路由 input_routes\t生效 2 条 · 环境默认 2 条 · 环境默认');
  expect(text).toContain('  开发 → worker');
  expect(text).toContain('  解释 → research');
  expect(text).toContain('设置文件\t/tmp/demo/.lush/settings.json');
  expect(text).toContain('单 Worker 调用上限 worker-call-limit');
  expect(text).not.toContain('task-call-limit');
});

test('config set 写回对应通道，--json 给结构化读模型', async () => {
  const client = fakeClient();
  const value = await runConfigCommand('config', ['set', 'concurrency', '8'], { client, json: true });
  expect(client.calls).toEqual([{ method: 'system.configure', params: { settings: { concurrency: 8 } } }]);
  expect(value.concurrency).toEqual({ value: 8, default: 4, overridden: true });
  expect(value.control_concurrency).toEqual({ value: 2, default: 2, overridden: false });

  const control = fakeClient();
  await runConfigCommand('config', ['set', 'control-concurrency', '6'], { client: control, json: true });
  expect(control.calls).toEqual([{ method: 'system.configure', params: { settings: { control_concurrency: 6 } } }]);
});

test('config set 调用与拆解限额写回对应键，--json 给结构化读模型', async () => {
  const client = fakeClient();
  const value = await runConfigCommand('config', ['set', 'call-timeout', '1200'], { client, json: true });
  expect(client.calls).toEqual([{ method: 'system.configure', params: { settings: { call_timeout: 1200 } } }]);
  expect(value.call_timeout).toEqual({ value: 1200, default: 900, overridden: true });

  const calls = fakeClient();
  await runConfigCommand('config', ['set', 'worker-call-limit', '40'], { client: calls, json: true });
  expect(calls.calls).toEqual([{ method: 'system.configure', params: { settings: { task_call_limit: 40 } } }]);

  const depth = fakeClient();
  await runConfigCommand('config', ['set', 'max-depth', '10'], { client: depth, json: true });
  expect(depth.calls).toEqual([{ method: 'system.configure', params: { settings: { max_depth: 10 } } }]);
});

test('config reset worker-call-limit retains its persisted task_call_limit key', async () => {
  const client = fakeClient();
  await runConfigCommand('config', ['reset', 'worker-call-limit'], { client, json: true });
  expect(client.calls).toEqual([{ method: 'system.configure', params: { settings: { task_call_limit: null } } }]);
});

test('config set 越界或非整数报错，且不发出写请求', async () => {
  for (const [flag, raw, range] of [['concurrency', '65', '1 to 64'], ['concurrency', '0', '1 to 64'],
    ['concurrency', '2.5', '1 to 64'], ['concurrency', 'abc', '1 to 64'],
    ['control-concurrency', '17', '1 to 16'], ['control-concurrency', 'x', '1 to 16'],
    ['call-timeout', '86401', '1 to 86400'], ['call-timeout', '0', '1 to 86400'],
    ['worker-call-limit', '1001', '1 to 1000'], ['max-depth', '65', '1 to 64']]) {
    const client = fakeClient();
    await expect(runConfigCommand('config', ['set', flag, raw], { client, json: true })).rejects.toThrow(range);
    expect(client.calls).toEqual([]);
  }
});

test('config reset 清除指定键或全部，回到环境默认', async () => {
  const single = fakeClient({ settings: statusModel({
    concurrency: { value: 8, default: 4, overridden: true },
    control_concurrency: { value: 6, default: 2, overridden: true } }) });
  const one = await runConfigCommand('config', ['reset', 'control-concurrency'], { client: single, json: true });
  expect(single.calls).toEqual([{ method: 'system.configure', params: { settings: { control_concurrency: null } } }]);
  expect(one.control_concurrency).toEqual({ value: 2, default: 2, overridden: false });
  expect(one.concurrency).toEqual({ value: 8, default: 4, overridden: true });

  const both = fakeClient({ settings: statusModel({
    concurrency: { value: 8, default: 4, overridden: true },
    control_concurrency: { value: 6, default: 2, overridden: true },
    call_timeout: { value: 1200, default: 900, overridden: true },
    task_call_limit: { value: 40, default: 24, overridden: true },
    max_depth: { value: 10, default: 8, overridden: true } }) });
  const all = await runConfigCommand('config', ['reset'], { client: both, json: true });
  expect(both.calls).toEqual([{ method: 'system.configure', params: { settings: {
    concurrency: null, control_concurrency: null, call_timeout: null, task_call_limit: null, max_depth: null } } }]);
  expect(all.concurrency).toEqual({ value: 4, default: 4, overridden: false });
  expect(all.control_concurrency).toEqual({ value: 2, default: 2, overridden: false });
  expect(all.call_timeout).toEqual({ value: 900, default: 900, overridden: false });
  expect(all.task_call_limit).toEqual({ value: 24, default: 24, overridden: false });
  expect(all.max_depth).toEqual({ value: 8, default: 8, overridden: false });
});

test('config 参数错误与未知子命令、未知键都被拒绝', async () => {
  const client = fakeClient();
  await expect(runConfigCommand('config', ['reset', 'bogus'], { client, json: true })).rejects.toThrow('config reset');
  await expect(runConfigCommand('config', ['set', 'bogus', '3'], { client, json: true })).rejects.toThrow('config set');
  await expect(runConfigCommand('config', ['set', 'task-call-limit', '3'], { client, json: true })).rejects.toThrow('config set');
  await expect(runConfigCommand('config', ['reset', 'task-call-limit'], { client, json: true })).rejects.toThrow('config reset');
  await expect(runConfigCommand('config', ['set', 'concurrency'], { client, json: true })).rejects.toThrow('invalid arguments');
  await expect(runConfigCommand('config', ['set', 'concurrency', '3', 'extra'], { client, json: true })).rejects.toThrow('invalid arguments');
  await expect(runConfigCommand('config', ['nope'], { client, json: true })).rejects.toThrow('unknown config command');
  expect(client.calls).toEqual([]);
});

test('config route 已下线：未知子命令被拒绝', async () => {
  const client = fakeClient();
  await expect(runConfigCommand('config', ['route', 'list'], { client, json: true })).rejects.toThrow('unknown config command');
  await expect(runConfigCommand('config', ['route', 'add', '修复'], { client, json: true })).rejects.toThrow('unknown config command');
  expect(client.calls).toEqual([]);
});

test('config 是用户专属：带 agent token 调用被拒', async () => {
  const client = fakeClient({ token: 'agent-token' });
  await expect(runConfigCommand('config', ['show'], { client, json: true })).rejects.toThrow('agents cannot change runtime settings');
  await expect(runConfigCommand('config', ['set', 'concurrency', '8'], { client, json: true })).rejects.toThrow('agents cannot change runtime settings');
  expect(client.calls).toEqual([]);
});

test('help 列出 config 的并发与限额子命令，不再列 route', () => {
  expect(HELP).toContain('config show|set|reset');
  expect(HELP).toContain('worker-call-limit');
  expect(HELP).not.toContain('config route');
});
