import { test, expect } from 'bun:test';
import { run } from '../src/cli/commands/candidate.js';

/** 一个只记录请求的 client：CLI 的职责就是把参数翻译成 RPC 调用，不需要真 daemon。 */
function clientStub(result) {
  const calls = [];
  return { calls, async request(method, params) { calls.push({ method, params }); return result; } };
}

const RESULT = { id: 2, input_id: 1, version: 1, status: 'ready', commit_hash: 'abcdef1234567890' };

test('lush candidate list forwards an optional --input filter', async () => {
  const all = clientStub([]);
  expect(await run('candidate', ['list'], { client: all, json: true })).toEqual([]);
  expect(all.calls).toEqual([{ method: 'candidate.list', params: {} }]);

  const scoped = clientStub([RESULT]);
  expect(await run('candidate', ['list', '--input', '1'], { client: scoped, json: true })).toEqual([RESULT]);
  expect(scoped.calls).toEqual([{ method: 'candidate.list', params: { input: 1 } }]);
});

test('lush candidate translates every acceptance action into its RPC', async () => {
  const prepare = clientStub(RESULT);
  await run('candidate', ['prepare', '1', '--summary', '一版结果'], { client: prepare, json: true });
  expect(prepare.calls).toEqual([{ method: 'candidate.prepare', params: { input: 1, summary: '一版结果' } }]);

  const inspect = clientStub(RESULT);
  await run('candidate', ['inspect', '2'], { client: inspect, json: true });
  expect(inspect.calls).toEqual([{ method: 'candidate.inspect', params: { id: 2 } }]);

  const verify = clientStub(RESULT);
  await run('candidate', ['verify', '2'], { client: verify, json: true });
  expect(verify.calls).toEqual([{ method: 'candidate.verify', params: { id: 2 } }]);

  const accept = clientStub(RESULT);
  await run('candidate', ['accept', '2'], { client: accept, json: true });
  expect(accept.calls).toEqual([{ method: 'candidate.accept', params: { id: 2 } }]);

  const changes = clientStub(RESULT);
  await run('candidate', ['changes', '2', '按钮再明显一点'], { client: changes, json: true });
  expect(changes.calls).toEqual([{ method: 'candidate.changes', params: { id: 2, feedback: '按钮再明显一点' } }]);

  const reject = clientStub(RESULT);
  await run('candidate', ['reject', '2', '--reason', '方向不对'], { client: reject, json: true });
  expect(reject.calls).toEqual([{ method: 'candidate.reject', params: { id: 2, reason: '方向不对' } }]);
});

test('unknown verb and wrong arity are rejected instead of silently forwarded', async () => {
  const client = clientStub(RESULT);
  await expect(run('candidate', ['nope'], { client, json: true })).rejects.toThrow(/unknown candidate command/);
  await expect(run('candidate', ['accept'], { client, json: true })).rejects.toThrow();
  await expect(run('candidate', ['changes', '2'], { client, json: true })).rejects.toThrow();
  expect(client.calls).toEqual([]);
});
