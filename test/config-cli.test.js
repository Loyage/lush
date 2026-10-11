import { test, expect } from 'bun:test';
import { run as runConfigCommand } from '../src/cli/commands/config.js';
import { HELP } from '../src/cli/help.js';

const DEFAULT_ROUTES = [{ prefix: '开发', target: 'worker' }, { prefix: '解释', target: 'research' }];
const statusModel = (overrides = {}) => ({ file: '/tmp/demo/.lush/settings.json',
  call_timeout: { value: 900, default: 900, overridden: false },
  task_call_limit: { value: 24, default: 24, overridden: false },
  max_depth: { value: 8, default: 8, overridden: false },
  input_routes: { value: DEFAULT_ROUTES, default: DEFAULT_ROUTES, overridden: false }, ...overrides });
function fakeClient({ token = null, settings = statusModel() } = {}) {
  const calls = [];
  return { token, calls, async request(method, params) {
    calls.push({ method, params });
    if (method === 'system.status') return { settings };
    if (method === 'system.configure') {
      const next = { ...settings };
      for (const [key, value] of Object.entries(params.settings))
        next[key] = { ...next[key], value: value === null ? next[key].default : value, overridden: value !== null };
      return next;
    }
    throw new Error(`unexpected method ${method}`);
  } };
}

test('config show reads active settings with no concurrency fields', async () => {
  for (const args of [[], ['show']]) {
    const client = fakeClient();
    expect(await runConfigCommand('config', args, { client, json: true })).toEqual(statusModel());
    expect(client.calls).toEqual([{ method: 'system.status', params: undefined }]);
  }
  const lines = [], original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { await runConfigCommand('config', ['show'], { client: fakeClient(), json: false }); }
  finally { console.log = original; }
  const text = lines.join('\n');
  expect(text).toContain('单次调用超时（秒） call-timeout');
  expect(text).toContain('生效 900 · 环境默认 900 · 环境默认');
  expect(text).toContain('单 Worker 调用上限 worker-call-limit');
  expect(text).toContain('快速路由 input_routes');
  expect(text).toContain('设置文件\t/tmp/demo/.lush/settings.json');
  expect(text).not.toMatch(/并发|通道|concurrency|task-call-limit/);
});

test('config set writes active call and delegation limits', async () => {
  for (const [flag, key, value] of [['call-timeout', 'call_timeout', 1200],
    ['worker-call-limit', 'task_call_limit', 40], ['max-depth', 'max_depth', 10]]) {
    const client = fakeClient();
    const result = await runConfigCommand('config', ['set', flag, String(value)], { client, json: true });
    expect(client.calls).toEqual([{ method: 'system.configure', params: { settings: { [key]: value } } }]);
    expect(result[key]).toEqual({ value, default: statusModel()[key].default, overridden: true });
  }
});

test('config rejects retired keys for both set and reset without sending requests', async () => {
  for (const flag of ['concurrency', 'control-concurrency']) for (const verb of ['set', 'reset']) {
    const client = fakeClient();
    await expect(runConfigCommand('config', [verb, flag, ...(verb === 'set' ? ['8'] : [])],
      { client, json: true })).rejects.toThrow(`config ${verb} expects`);
    expect(client.calls).toEqual([]);
  }
});

test('config rejects invalid active values without sending writes', async () => {
  for (const [flag, raw, range] of [['call-timeout', '86401', '1 to 86400'], ['call-timeout', '0', '1 to 86400'],
    ['call-timeout', '2.5', '1 to 86400'], ['call-timeout', 'abc', '1 to 86400'],
    ['worker-call-limit', '1001', '1 to 1000'], ['max-depth', '65', '1 to 64']]) {
    const client = fakeClient();
    await expect(runConfigCommand('config', ['set', flag, raw], { client, json: true })).rejects.toThrow(range);
    expect(client.calls).toEqual([]);
  }
});

test('config reset clears one or all active numeric keys only', async () => {
  const settings = statusModel({ call_timeout: { value: 1200, default: 900, overridden: true },
    task_call_limit: { value: 40, default: 24, overridden: true }, max_depth: { value: 10, default: 8, overridden: true } });
  const single = fakeClient({ settings });
  const one = await runConfigCommand('config', ['reset', 'worker-call-limit'], { client: single, json: true });
  expect(single.calls).toEqual([{ method: 'system.configure', params: { settings: { task_call_limit: null } } }]);
  expect(one.task_call_limit).toEqual(statusModel().task_call_limit);
  expect(one.call_timeout).toEqual(settings.call_timeout);
  const client = fakeClient({ settings });
  expect(await runConfigCommand('config', ['reset'], { client, json: true })).toEqual(statusModel());
  expect(client.calls).toEqual([{ method: 'system.configure', params: { settings: {
    call_timeout: null, task_call_limit: null, max_depth: null } } }]);
});

test('config argument checks, retired routes and agent permissions stay enforced', async () => {
  const client = fakeClient();
  for (const args of [['set', 'bogus', '3'], ['reset', 'bogus'], ['set', 'task-call-limit', '3'],
    ['reset', 'task-call-limit'], ['set', 'call-timeout'], ['set', 'call-timeout', '3', 'extra'],
    ['nope'], ['route', 'list'], ['route', 'add', '修复']])
    await expect(runConfigCommand('config', args, { client, json: true })).rejects.toThrow();
  expect(client.calls).toEqual([]);
  const agent = fakeClient({ token: 'agent-token' });
  for (const args of [['show'], ['set', 'call-timeout', '8']])
    await expect(runConfigCommand('config', args, { client: agent, json: true })).rejects.toThrow('agents cannot change runtime settings');
  expect(agent.calls).toEqual([]);
  expect(HELP).toContain('config show|set|reset');
  expect(HELP).toContain('worker-call-limit');
  expect(HELP).not.toMatch(/config route|并发.*上限|control-concurrency/);
});
