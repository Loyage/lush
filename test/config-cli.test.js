import { test, expect } from 'bun:test';
import { run as runConfigCommand } from '../src/cli/commands/config.js';
import { HELP } from '../src/cli/help.js';

// `lush config`：读 / 写项目级并发上限。参数解析、越界不落盘、agent 被拒都在这里覆盖。
const statusModel = () => ({ file: '/tmp/demo/.lush/settings.json',
  concurrency: { value: 4, default: 4, overridden: false },
  control_concurrency: { value: 2, default: 2, overridden: false } });

/** 假 daemon：system.status 给读模型，system.configure 按核心语义（数字覆盖 / null 清除）回写。 */
function fakeClient({ token = null, settings = statusModel() } = {}) {
  const calls = [];
  return { token, calls,
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'system.status') return { settings };
      if (method === 'system.configure') {
        const next = { ...settings };
        for (const [key, value] of Object.entries(params.settings)) {
          next[key] = value === null
            ? { ...next[key], value: next[key].default, overridden: false }
            : { ...next[key], value, overridden: true };
        }
        return { file: next.file, concurrency: next.concurrency, control_concurrency: next.control_concurrency };
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

test('config show 人类可读输出：执行通道 / 控制通道 / 设置文件', async () => {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { await runConfigCommand('config', ['show'], { client: fakeClient(), json: false }); }
  finally { console.log = original; }
  const text = lines.join('\n');
  expect(text).toContain('执行通道 concurrency');
  expect(text).toContain('生效 4 · 环境默认 4 · 环境默认');
  expect(text).toContain('控制通道 control-concurrency');
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
  const single = fakeClient({ settings: { file: '/tmp/demo/.lush/settings.json',
    concurrency: { value: 8, default: 4, overridden: true },
    control_concurrency: { value: 6, default: 2, overridden: true } } });
  const one = await runConfigCommand('config', ['reset', 'control-concurrency'], { client: single, json: true });
  expect(single.calls).toEqual([{ method: 'system.configure', params: { settings: { control_concurrency: null } } }]);
  expect(one.control_concurrency).toEqual({ value: 2, default: 2, overridden: false });
  expect(one.concurrency).toEqual({ value: 8, default: 4, overridden: true });

  const both = fakeClient({ settings: { file: '/tmp/demo/.lush/settings.json',
    concurrency: { value: 8, default: 4, overridden: true },
    control_concurrency: { value: 6, default: 2, overridden: true } } });
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

test('config 是用户专属：带 agent token 调用被拒', async () => {
  const client = fakeClient({ token: 'agent-token' });
  await expect(runConfigCommand('config', ['show'], { client, json: true })).rejects.toThrow('agents cannot change runtime settings');
  await expect(runConfigCommand('config', ['set', 'concurrency', '8'], { client, json: true })).rejects.toThrow('agents cannot change runtime settings');
  expect(client.calls).toEqual([]);
});

test('help 列出 config 的三个子命令', () => {
  expect(HELP).toContain('config set concurrency');
  expect(HELP).toContain('config set control-concurrency');
  expect(HELP).toContain('config reset');
});
