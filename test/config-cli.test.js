import { test, expect } from 'bun:test';
import { run as runConfigCommand } from '../src/cli/commands/config.js';
import { HELP } from '../src/cli/help.js';

// `lush config`：读 / 写项目级并发上限与快速路由前缀。参数解析、越界不落盘、agent 被拒都在这里覆盖。
const DEFAULT_ROUTES = [{ prefix: '开发', target: 'worker' }, { prefix: '解释', target: 'research' }];
const routes = (value, overridden = false) => ({ value: value.map(r => ({ ...r })), default: DEFAULT_ROUTES.map(r => ({ ...r })), overridden });
const statusModel = (overrides = {}) => ({ file: '/tmp/demo/.lush/settings.json',
  concurrency: { value: 4, default: 4, overridden: false },
  control_concurrency: { value: 2, default: 2, overridden: false },
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

test('config set 越界或非整数报错，且不发出写请求', async () => {
  for (const [flag, raw] of [['concurrency', '65'], ['concurrency', '0'], ['concurrency', '2.5'],
    ['concurrency', 'abc'], ['control-concurrency', '17'], ['control-concurrency', 'x']]) {
    const client = fakeClient();
    await expect(runConfigCommand('config', ['set', flag, raw], { client, json: true }))
      .rejects.toThrow(flag === 'concurrency' ? '1 to 64' : '1 to 16');
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
    control_concurrency: { value: 6, default: 2, overridden: true } }) });
  const all = await runConfigCommand('config', ['reset'], { client: both, json: true });
  expect(both.calls).toEqual([{ method: 'system.configure', params: { settings: { concurrency: null, control_concurrency: null } } }]);
  expect(all.concurrency).toEqual({ value: 4, default: 4, overridden: false });
  expect(all.control_concurrency).toEqual({ value: 2, default: 2, overridden: false });
});

test('config 参数错误与未知子命令、未知键都被拒绝', async () => {
  const client = fakeClient();
  await expect(runConfigCommand('config', ['reset', 'bogus'], { client, json: true })).rejects.toThrow('config reset');
  await expect(runConfigCommand('config', ['set', 'bogus', '3'], { client, json: true })).rejects.toThrow('config set');
  await expect(runConfigCommand('config', ['set', 'concurrency'], { client, json: true })).rejects.toThrow('invalid arguments');
  await expect(runConfigCommand('config', ['set', 'concurrency', '3', 'extra'], { client, json: true })).rejects.toThrow('invalid arguments');
  await expect(runConfigCommand('config', ['nope'], { client, json: true })).rejects.toThrow('config expects');
  expect(client.calls).toEqual([]);
});

test('config route list 读取生效前缀表与来源；省略子命令等价 list', async () => {
  const client = fakeClient();
  expect(await runConfigCommand('config', ['route', 'list'], { client, json: true }))
    .toEqual({ file: '/tmp/demo/.lush/settings.json', overridden: false, default: DEFAULT_ROUTES, routes: DEFAULT_ROUTES });
  expect(client.calls).toEqual([{ method: 'system.status', params: undefined }]);

  const omitted = fakeClient();
  await runConfigCommand('config', ['route'], { client: omitted, json: true });
  expect(omitted.calls).toEqual([{ method: 'system.status', params: undefined }]);
});

test('config route list 人类可读输出每条 prefix → target 与来源', async () => {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { await runConfigCommand('config', ['route', 'list'], { client: fakeClient(), json: false }); }
  finally { console.log = original; }
  const text = lines.join('\n');
  expect(text).toContain('快速路由 input_routes\t生效 2 条 · 环境默认 2 条 · 环境默认');
  expect(text).toContain('  开发 → worker');
  expect(text).toContain('  解释 → research');
});

test('config route add 读当前表后整表写回，默认 worker', async () => {
  const client = fakeClient();
  const value = await runConfigCommand('config', ['route', 'add', '修复'], { client, json: true });
  expect(client.calls).toEqual([
    { method: 'system.status', params: undefined },
    { method: 'system.configure', params: { settings: { input_routes: [
      { prefix: '开发', target: 'worker' }, { prefix: '解释', target: 'research' }, { prefix: '修复', target: 'worker' }] } } },
  ]);
  expect(value.overridden).toBe(true);
  expect(value.routes).toEqual([
    { prefix: '开发', target: 'worker' }, { prefix: '解释', target: 'research' }, { prefix: '修复', target: 'worker' }]);
});

test('config route add --target research 归一到核心认可的目标', async () => {
  const client = fakeClient();
  await runConfigCommand('config', ['route', 'add', '调研', '--target', 'research'], { client, json: true });
  expect(client.calls[1].params.settings.input_routes).toEqual([
    { prefix: '开发', target: 'worker' }, { prefix: '解释', target: 'research' }, { prefix: '调研', target: 'research' }]);
});

test('config route add 重复前缀或非法 target 报核心一致的错，且不写回', async () => {
  const duplicate = fakeClient();
  await expect(runConfigCommand('config', ['route', 'add', '开发'], { client: duplicate, json: true }))
    .rejects.toThrow('duplicate prefix');
  expect(duplicate.calls.every(call => call.method === 'system.status')).toBe(true);
  expect(duplicate.calls.some(call => call.method === 'system.configure')).toBe(false);

  const badTarget = fakeClient();
  await expect(runConfigCommand('config', ['route', 'add', '新', '--target', 'bogus'], { client: badTarget, json: true }))
    .rejects.toThrow('target must be worker or research');
  expect(badTarget.calls.some(call => call.method === 'system.configure')).toBe(false);

  const blank = fakeClient();
  await expect(runConfigCommand('config', ['route', 'add', 'a b'], { client: blank, json: true }))
    .rejects.toThrow('non-whitespace');
});

test('config route remove 删除前缀并整表写回，不存在则报错', async () => {
  const client = fakeClient();
  const value = await runConfigCommand('config', ['route', 'remove', '解释'], { client, json: true });
  expect(client.calls[1]).toEqual({ method: 'system.configure',
    params: { settings: { input_routes: [{ prefix: '开发', target: 'worker' }] } } });
  expect(value.overridden).toBe(true);
  expect(value.routes).toEqual([{ prefix: '开发', target: 'worker' }]);

  const missing = fakeClient();
  await expect(runConfigCommand('config', ['route', 'remove', '不存在'], { client: missing, json: true }))
    .rejects.toThrow('is not configured');
  expect(missing.calls.some(call => call.method === 'system.configure')).toBe(false);
});

test('config route reset 写 null 回退默认表', async () => {
  const client = fakeClient({ settings: statusModel({
    input_routes: routes([...DEFAULT_ROUTES, { prefix: '修复', target: 'worker' }], true) }) });
  const value = await runConfigCommand('config', ['route', 'reset'], { client, json: true });
  expect(client.calls).toEqual([{ method: 'system.configure', params: { settings: { input_routes: null } } }]);
  expect(value.overridden).toBe(false);
  expect(value.routes).toEqual(DEFAULT_ROUTES);
});

test('config route 参数错误与未知动作被拒绝', async () => {
  const client = fakeClient();
  await expect(runConfigCommand('config', ['route', 'nope'], { client, json: true })).rejects.toThrow('config route expects');
  await expect(runConfigCommand('config', ['route', 'add'], { client, json: true })).rejects.toThrow('expects a prefix');
  await expect(runConfigCommand('config', ['route', 'remove'], { client, json: true })).rejects.toThrow('expects a prefix');
  await expect(runConfigCommand('config', ['route', 'add', '开发', 'extra'], { client, json: true })).rejects.toThrow('invalid arguments');
  await expect(runConfigCommand('config', ['route', 'reset', 'extra'], { client, json: true })).rejects.toThrow('invalid arguments');
  expect(client.calls).toEqual([]);
});

test('config 是用户专属：带 agent token 调用被拒', async () => {
  const client = fakeClient({ token: 'agent-token' });
  await expect(runConfigCommand('config', ['show'], { client, json: true })).rejects.toThrow('agents cannot change runtime settings');
  await expect(runConfigCommand('config', ['set', 'concurrency', '8'], { client, json: true })).rejects.toThrow('agents cannot change runtime settings');
  await expect(runConfigCommand('config', ['route', 'add', '修复'], { client, json: true })).rejects.toThrow('agents cannot change runtime settings');
  await expect(runConfigCommand('config', ['route', 'reset'], { client, json: true })).rejects.toThrow('agents cannot change runtime settings');
  expect(client.calls).toEqual([]);
});

test('help 列出 config 的并发与 route 子命令', () => {
  expect(HELP).toContain('config set concurrency');
  expect(HELP).toContain('config set control-concurrency');
  expect(HELP).toContain('config reset');
  expect(HELP).toContain('config route list');
  expect(HELP).toContain('config route add PREFIX [--target worker|research]');
  expect(HELP).toContain('config route remove PREFIX');
  expect(HELP).toContain('config route reset');
});
