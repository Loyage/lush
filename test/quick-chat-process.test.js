import { test, expect } from 'bun:test';
import { env } from './helpers.js';
import { quickChatProcess } from './quick-chat-process.js';

test('QuickChat subprocess reader waits for a complete UTF-8 JSON line and drains stderr concurrently', async () => {
  const child = quickChatProcess(`process.stdout.write('["'); await Bun.sleep(20);
    const bytes=Buffer.from('汉😀'); process.stdout.write(bytes.subarray(0,2)); await Bun.sleep(20);
    process.stdout.write(bytes.subarray(2)); process.stdout.write('",2]\\n');
    process.stderr.write('test-only-diagnostic' + 'x'.repeat(128 * 1024)); await new Response(Bun.stdin.stream()).text();`, [], env());
  try {
    expect(await child.jsonLine()).toEqual(['汉😀', 2]);
    child.endInput(); const result = await child.exited();
    expect(result.code).toBe(0); expect(result.stderr.startsWith('test-only-diagnostic')).toBe(true);
    expect(result.stderr.length).toBeLessThanOrEqual(64 * 1024); expect(result.stderrTruncated).toBe(true);
  } finally { await child.stop(); }
});

test('QuickChat EOF diagnostics include actual exit/signal and bounded redacted stderr instead of a JSON parse EOF', async () => {
  const child = quickChatProcess(`process.stdout.write('[1,');
    process.stderr.write('unit-test-not-a-real-key test-only-crash'); process.exit(7);`, [], env(), { label: 'expected crash fixture' });
  try {
    let error; try { await child.jsonLine(); } catch (caught) { error = caught; }
    expect(error.message).toContain('stdout EOF before a complete JSON line; partial_characters=3');
    expect(error.message).toContain('exit=7'); expect(error.message).toContain('signal=none');
    expect(error.message).toContain('[test-key] test-only-crash'); expect(error.message).not.toContain('unit-test-not-a-real-key');
    expect((await child.exited(7)).code).toBe(7);
  } finally { await child.stop(); }
});

test('QuickChat supervision has a finite deadline and reaps an uncooperative child without retrying it', async () => {
  const child = quickChatProcess('setInterval(()=>{},1000)', [], env(), { label: 'expected timeout fixture', timeoutMs: 100 });
  try {
    await expect(child.jsonLine()).rejects.toThrow('timed_out=true');
    expect(Number.isSafeInteger(await child.child.exited)).toBe(true);
    expect(child.child.signalCode).toBe('SIGKILL');
  } finally { await child.stop(); }
});
