import { test, expect } from 'bun:test';
import { Dispatcher } from '../src/rpc/dispatcher.js';
import { PARAMS, USER_ONLY } from '../src/rpc/registry.js';
import { run } from '../src/cli/commands/notice.js';
import { HELP } from '../src/cli/help.js';
import { builtInPrompt } from '../src/agent/prompts.js';

const methods = ['notice.snapshot', 'notice.rechoose'];

test('retired choice RPCs reject both users and agents without invoking old implementations', async () => {
  const calls = [];
  const rpc = new Dispatcher({ actor: token => token ? 7 : null,
    noticeSnapshot() { calls.push('read'); }, rechooseNotice() { calls.push('restore'); },
  });
  for (const method of methods) {
    expect(PARAMS[method]).toBeUndefined();
    expect(USER_ONLY.has(method)).toBe(false);
    for (const token of [null, 'agent'])
      await expect(rpc.dispatch(method, { id: 8, ...(token ? { _token: token } : {}) })).rejects.toThrow('unknown method');
  }
  expect(calls).toEqual([]);
});

test('notice CLI and help no longer offer snapshots or reselection; ordinary answer still works', async () => {
  const calls = [];
  const client = { async request(method, params) { calls.push({ method, params }); return 'ok'; } };
  for (const verb of ['snapshot', 'rechoose']) {
    await expect(run('notice', [verb, '8'], { client })).rejects.toThrow('unknown notice command');
    expect(HELP).not.toContain(`notice ${verb}`);
  }
  expect(calls).toEqual([]);
  expect(await run('notice', ['answer', '8', '继续'], { client })).toBe('ok');
  expect(calls).toEqual([{ method: 'notice.answer', params: { id: 8, answer: '继续' } }]);
});

test('Agent prompt explicitly states new choices have no snapshot or rollback capability', () => {
  const prompt = builtInPrompt('agent');
  expect(prompt).toContain('选择快照与重选功能已停用');
  expect(prompt).not.toContain('新结构化问卷由 runtime 在调用实际退出后尝试保存');
  expect(prompt).toContain('若历史路线的启动上下文含 choice_reselection');
});
