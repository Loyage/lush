import { test, expect } from 'bun:test';
import { run } from '../src/cli/commands/branch.js';

/** 一个只记录请求的 client：CLI 的职责就是把参数翻译成 RPC 调用，不需要真 daemon。 */
function clientStub(result) {
  const calls = [];
  return { calls, async request(method, params) { calls.push({ method, params }); return result; } };
}

const RESULT = {
  branch: 'lush/h/7-feat', archived: true, worktree: 'removed', ref: 'deleted', tip: 'abcdef1234567890',
  discarded: false, tasks: [{ id: 7, status: 'completed' }], sessions: ['/tmp/home/sessions/a.jsonl'],
};

test('lush branch archive forwards BRANCH and --discard to branch.archive', async () => {
  const plain = clientStub(RESULT);
  expect(await run('branch', ['archive', 'lush/h/7-feat'], { client: plain, json: true })).toEqual(RESULT);
  expect(plain.calls).toEqual([{ method: 'branch.archive', params: { branch: 'lush/h/7-feat', discard: false } }]);

  const discard = clientStub(RESULT);
  await run('branch', ['archive', 'lush/h/7-feat', '--discard'], { client: discard, json: true });
  expect(discard.calls).toEqual([{ method: 'branch.archive', params: { branch: 'lush/h/7-feat', discard: true } }]);

  // 未知参数/缺分支不能悄悄当成别的命令。
  await expect(run('branch', ['archive', 'a', 'b'], { client: clientStub(RESULT), json: true })).rejects.toThrow();
});

test('the unknown branch command hint mentions archive', async () => {
  await expect(run('branch', ['nope'], { client: clientStub(RESULT), json: true })).rejects.toThrow(/archive/);
});

test('non-json output shows branch name, worktree/ref outcome, kept tasks and session files', async () => {
  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    await run('branch', ['archive', 'lush/h/7-feat', '--discard'], { client: clientStub({ ...RESULT, discarded: true }), json: false });
  } finally { console.log = original; }
  const text = logs.join('\n');
  expect(text).toContain('lush/h/7-feat');
  expect(text).toContain('worktree');
  expect(text).toContain('已删除');
  expect(text).toContain('丢弃了未提交改动');
  expect(text).toContain('#7 completed');
  expect(text).toContain('/tmp/home/sessions/a.jsonl');
});
