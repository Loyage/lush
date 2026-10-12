// Dedicated QuickChat test subprocess supervision. Never used by product code.
// The caller supplies an isolated env and only fake credentials/mock transports.
const LIMIT = 64 * 1024;

export function quickChatProcess(script, args, env, { label = 'quick-chat child', timeoutMs = 15000 } = {}) {
  const child = Bun.spawn(['bun', '-e', script, ...args], { env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const started = Date.now(), lines = [], waiters = [];
  const redact = value => String(value).replaceAll('unit-test-not-a-real-key', '[test-key]');
  let stdout = '', stderr = '', tail = '', ended = false, streamError = null, timedOut = false;
  let stderrTruncated = false, exitCode = null;
  const exitDone = child.exited.then(code => { exitCode = code; return code; });
  const notify = () => {
    while (waiters.length && (lines.length || ended)) waiters.shift()(lines.length ? lines.shift() : null);
  };
  const kill = signal => { try { child.kill(signal); } catch { /* already exited */ } };
  const timer = setTimeout(() => { timedOut = true; kill('SIGKILL'); }, timeoutMs);
  const stderrDone = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) {
      const text = decoder.decode(chunk, { stream: true });
      const room = LIMIT - stderr.length;
      stderr += text.slice(0, Math.max(0, room)); stderrTruncated ||= text.length > room;
    }
    stderr += decoder.decode();
  })().catch(error => { streamError ??= `stderr read: ${error.message}`; });
  const stdoutDone = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      const text = decoder.decode(chunk, { stream: true });
      if (Buffer.byteLength(stdout) + Buffer.byteLength(text) > LIMIT) throw new Error('stdout exceeds test output bound');
      stdout += text; tail += text;
      for (;;) {
        const newline = tail.indexOf('\n'); if (newline < 0) break;
        lines.push(tail.slice(0, newline)); tail = tail.slice(newline + 1); notify();
      }
    }
    const last = decoder.decode(); stdout += last; tail += last;
  })().catch(error => { streamError ??= `stdout read: ${error.message}`; kill('SIGKILL'); })
    .finally(() => { ended = true; notify(); });
  const done = Promise.all([exitDone, stdoutDone, stderrDone]).then(([code]) => {
    clearTimeout(timer);
    return { code, signal: child.signalCode, stdout, stderr: redact(stderr), stderrTruncated, timedOut, streamError };
  });
  const diagnostic = () => redact(`${label}: pid=${child.pid} exit=${exitCode ?? child.exitCode} signal=${child.signalCode ?? 'none'} elapsed_ms=${Date.now() - started} timed_out=${timedOut}\n${streamError ?? ''}\nstderr${stderrTruncated ? ' (truncated)' : ''}: ${stderr || '(empty)'}`);
  return {
    child, diagnostic,
    async jsonLine() {
      const line = lines.length ? lines.shift() : ended ? null : await new Promise(resolve => waiters.push(resolve));
      if (line === null) {
        // At EOF collect the real exit and stderr instead of parsing undefined or
        // reporting an unexplained JSON EOF. The original test deadline stays on.
        await done;
        throw new Error(`stdout EOF before a complete JSON line; partial_characters=${tail.length}\n${diagnostic()}`);
      }
      try { return JSON.parse(line); }
      catch { throw new Error(`invalid complete JSON line\n${diagnostic()}`); }
    },
    endInput() { try { child.stdin.end(); } catch { /* already closed */ } },
    async exited(expectedCode = 0, expectedSignal = null) {
      const result = await done;
      if (result.timedOut || result.streamError || (expectedCode !== null && result.code !== expectedCode)
        || (expectedSignal !== null && result.signal !== expectedSignal)) throw new Error(`unexpected child exit\n${diagnostic()}`);
      return result;
    },
    async stop() {
      try { child.stdin.end(); } catch { /* already closed */ }
      // Graceful close first, then bounded TERM/KILL cleanup even when another
      // sibling's startup/assertion failed. No child is retried or silently skipped.
      const wait = ms => new Promise(resolve => {
        const timeout = setTimeout(() => resolve(false), ms);
        done.then(() => { clearTimeout(timeout); resolve(true); });
      });
      if (!await wait(500)) {
        kill('SIGTERM');
        if (!await wait(500)) kill('SIGKILL');
      }
      await done;
    },
  };
}
