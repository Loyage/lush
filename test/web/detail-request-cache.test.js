import { test, expect } from 'bun:test';
import { publicReadCache } from '../../src/ui/web/assets/request-cache.js';
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test('公开读缓存 TTL/single-flight，过期失败不回落旧成功且可重试', async () => {
  let clock = 0, loads = 0, gate = deferred();
  const cache = publicReadCache({ scope: () => ({ project: 'a', boot: 1 }), now: () => clock, ttl: 30,
    load: () => { loads++; return gate.promise; } });
  const a = cache.read(), b = cache.read(); await drain(); expect(loads).toBe(1);
  gate.resolve('first'); expect(await a).toBe('first'); expect(await b).toBe('first');
  clock = 29; expect(await cache.read()).toBe('first'); expect(loads).toBe(1);
  clock = 30; gate = deferred(); const bad = cache.read();
  gate.reject(new Error('unavailable')); await expect(bad).rejects.toThrow('unavailable');
  gate = deferred(); const retry = cache.read(); gate.resolve('new'); expect(await retry).toBe('new'); expect(loads).toBe(3);
});

test('项目/boot/显式失效拒绝迟到旧事实，失败及无订阅者取消不填缓存', async () => {
  let project = 'a', boot = {}, gates = [], signals = [];
  const cache = publicReadCache({ scope: () => ({ project, boot }), load: signal => {
    signals.push(signal); const gate = deferred(); gates.push(gate); return gate.promise;
  } });
  const aError = cache.read().catch(error => error); await drain();
  project = 'b'; const b = cache.read(); await drain(); expect((await aError).name).toBe('AbortError'); expect(signals[0].aborted).toBe(true);
  gates[0].resolve('wrong project'); gates[1].resolve('b'); expect(await b).toBe('b');
  boot = {}; const cError = cache.read().catch(error => error); await drain(); cache.invalidate(); expect((await cError).name).toBe('AbortError');
  gates[2].resolve('old boot'); const d = cache.read(); await drain(); gates[3].resolve('fresh'); expect(await d).toBe('fresh');
  const cancelled = new AbortController(); cancelled.abort(); await expect(cache.read({ signal: cancelled.signal })).rejects.toMatchObject({ name: 'AbortError' });
});

test('单飞订阅者独立取消；仅最后订阅者退出时终止 HTTP，迟到结果不缓存', async () => {
  let gates = [], signals = [];
  const cache = publicReadCache({ scope: () => ({ project: 'a', boot: 1 }), load: signal => {
    signals.push(signal); const gate = deferred(); gates.push(gate); return gate.promise;
  } });
  const first = new AbortController(), last = new AbortController();
  const rejectedA = cache.read({ signal: first.signal }).catch(error => error), rejectedB = cache.read({ signal: last.signal }).catch(error => error);
  await drain(); first.abort(); expect((await rejectedA).name).toBe('AbortError'); expect(signals[0].aborted).toBe(false);
  last.abort(); expect((await rejectedB).name).toBe('AbortError'); expect(signals[0].aborted).toBe(true);
  gates[0].resolve('cancelled'); await drain(); const next = cache.read(); await drain();
  expect(gates).toHaveLength(2); gates[1].resolve('new'); expect(await next).toBe('new');
});
