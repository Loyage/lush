import { test, expect } from 'bun:test';
import { main } from '../src/cli/main.js';
import { HELP } from '../src/cli/help.js';
import { UIClient } from '../src/ui/client.js';
import { fixture } from './helpers.js';

// --help / -h 出现在任意 argv 位置都只打印帮助：命令 token 被 shift() 后，子命令会把裸 flag
// 当成必填正文落库（spec add / branch summary / notice post / task spawn）。这份测试锁住全局拦截：
// 打印 HELP、不发任何 RPC、不落库，且只有独立的 flag token 才算帮助。

/** 捕获一次 main() 的 console.log，返回合并后的文本。 */
async function helpText(argv) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { await main(argv); } finally { console.log = original; }
  return lines.join('\n');
}

/** 记录 UIClient 的 RPC 调用；任何请求都抛错，避免测试悄悄依赖真 daemon。 */
function spyRpc() {
  const calls = [];
  const original = UIClient.prototype.request;
  UIClient.prototype.request = async function (...args) { calls.push(args); throw new Error('unexpected RPC'); };
  return { calls, restore() { UIClient.prototype.request = original; } };
}

/** 临时清掉 LUSH_* 环境，保证 Config 只按传入的 --project 解析。 */
async function withoutLushEnv(fn) {
  const keys = ['LUSH_PROJECT', 'LUSH_HOME', 'LUSH_AGENT_TOKEN', 'LUSH_TASK_ID', 'LUSH_PROVIDER'];
  const saved = {};
  for (const key of keys) { saved[key] = process.env[key]; delete process.env[key]; }
  try { return await fn(); } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

test('子命令里的裸 --help 只打印帮助，不落库也不发 RPC', async () => {
  const f = fixture();
  const rpc = spyRpc();
  try {
    const count = table => f.store.get(`SELECT COUNT(*) AS count FROM ${table}`).count;
    const before = { specs: count('task_specs'), tasks: count('tasks'), notices: count('notices'), branches: count('branches') };

    expect(await helpText(['spec', 'add', '--help', '--project', f.root])).toContain(HELP);
    expect(await helpText(['branch', 'summary', '--help'])).toContain(HELP);
    expect(await helpText(['notice', 'post', '--help'])).toContain(HELP);
    expect(await helpText(['task', 'spawn', '--help'])).toContain(HELP);

    // 全局 flag 先被移除，-h 与 --project 在命令前后都走同一拦截。
    expect(await helpText(['--json', 'spec', 'add', '--help'])).toContain(HELP);
    expect(await helpText(['--project', f.root, 'spec', 'add', '--help'])).toContain(HELP);
    expect(await helpText(['spec', 'add', '-h'])).toContain(HELP);

    expect(rpc.calls).toHaveLength(0);
    expect({ specs: count('task_specs'), tasks: count('tasks'), notices: count('notices'), branches: count('branches') }).toEqual(before);
  } finally {
    rpc.restore();
    await f.close();
  }
});

test('顶层 help / --help / -h / 空参仍打印 HELP', async () => {
  for (const argv of [[], ['help'], ['--help'], ['-h']]) {
    expect(await helpText(argv)).toContain(HELP);
  }
});

test('只有独立 token 才算帮助：正文里的 --help 不触发拦截', async () => {
  const f = fixture();
  const rpc = spyRpc();
  try {
    await withoutLushEnv(async () => {
      // 整段引号文本是单个 argv token，不该被当成帮助；落入真实命令路径后由被替换的 request 抛错。
      await expect(main(['say', '说明 --help 的用法', '--project', f.root])).rejects.toThrow('unexpected RPC');
    });
    expect(rpc.calls).toEqual([['input.submit', { content: '说明 --help 的用法' }]]);
  } finally {
    rpc.restore();
    await f.close();
  }
});
