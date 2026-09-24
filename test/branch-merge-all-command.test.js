import { test, expect } from 'bun:test';
import { PARAMS, USER_ONLY, assertAllowed } from '../src/rpc/registry.js';
import { run } from '../src/cli/commands/branch.js';

/** 一个只记录请求的 client：CLI 的职责就是把参数翻译成 RPC 调用，不需要真 daemon。 */
function clientStub(result) {
  const calls = [];
  return { calls, async request(method, params) { calls.push({ method, params }); return result; } };
}

test('registry：merge_plan 只读，merge_all / merge_cancel 是用户专属写操作', () => {
  expect(PARAMS['branch.merge_plan']).toEqual(['branch']);
  expect(PARAMS['branch.merge_all']).toEqual(['branch']);
  expect(PARAMS['branch.merge_cancel']).toEqual(['branch']);
  expect(USER_ONLY.has('branch.merge_plan')).toBe(false);
  expect(USER_ONLY.has('branch.merge_all')).toBe(true);
  expect(USER_ONLY.has('branch.merge_cancel')).toBe(true);
  // 只读计划 agent 也能查；两个写操作必须由用户批准。
  expect(assertAllowed('branch.merge_plan', { branch: 'main' }, 5)).toBe(5);
  expect(() => assertAllowed('branch.merge_all', { branch: 'main' }, 5)).toThrow(/requires user approval/);
  expect(() => assertAllowed('branch.merge_cancel', { branch: 'main' }, 5)).toThrow(/requires user approval/);
  expect(() => assertAllowed('branch.merge_all', { branch: 'main', extra: 1 }, null)).toThrow(/unknown parameter/);
});

test('CLI：branch merge-plan / merge-all / merge-cancel 翻译成对应 RPC', async () => {
  const planResult = { target_branch: 'main', items: [], order: [] };
  const planned = clientStub(planResult);
  expect(await run('branch', ['merge-plan', 'main'], { client: planned, json: true })).toEqual(planResult);
  expect(planned.calls).toEqual([{ method: 'branch.merge_plan', params: { branch: 'main' } }]);

  const allResult = { target_branch: 'main', status: 'running', plan: { order: ['a'] } };
  const all = clientStub(allResult);
  expect(await run('branch', ['merge-all', 'main'], { client: all, json: true })).toEqual(allResult);
  expect(all.calls).toEqual([{ method: 'branch.merge_all', params: { branch: 'main' } }]);

  const cancelResult = { target_branch: 'main', status: 'cancelled', done: ['a'] };
  const cancel = clientStub(cancelResult);
  expect(await run('branch', ['merge-cancel', 'main'], { client: cancel, json: true })).toEqual(cancelResult);
  expect(cancel.calls).toEqual([{ method: 'branch.merge_cancel', params: { branch: 'main' } }]);

  await expect(run('branch', ['merge-all'], { client: clientStub(allResult), json: true })).rejects.toThrow();
});

test('CLI：非 JSON 输出把计划顺序与取消结果说成人话', async () => {
  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    await run('branch', ['merge-plan', 'main'], { json: false, client: clientStub({
      target_branch: 'main', order: ['a'], items: [{ branch: 'a', depth: 1, action: 'merge', ready: true, blockers: [] }],
    }) });
    await run('branch', ['merge-cancel', 'main'], { json: false, client: clientStub({ target_branch: 'main', done: ['a', 'b'] }) });
  } finally { console.log = original; }
  const text = logs.join('\n');
  expect(text).toContain('可执行 1 / 共 1');
  expect(text).toContain('快进合入');
  expect(text).toContain('已取消 main 的一键合并');
  expect(text).toContain('2');
});
