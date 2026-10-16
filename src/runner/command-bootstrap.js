import { check } from './protocol.js';

async function bounded(promise, timeout_ms) {
  let timer;
  try { return await Promise.race([promise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), timeout_ms); })]); }
  finally { clearTimeout(timer); }
}

/** Live ChildProcess ownership only; no PID persisted or looked up after restart. */
export function observeBootstrap(child, onOutput) {
  let exited = child.exitCode !== null && child.exitCode !== undefined || child.signalCode !== null && child.signalCode !== undefined;
  let resolveExit, resolveClose, resolveOutcome, stopping = false;
  const exit = new Promise(resolve => { resolveExit = resolve; });
  const closed = new Promise(resolve => { resolveClose = resolve; });
  const outcome = new Promise(resolve => { resolveOutcome = resolve; });
  const markExit = (code, signal, reason = 'exit') => {
    exited = true; resolveExit(); resolveOutcome({ code, signal, reason });
  };
  child.once('exit', (code, signal) => markExit(code, signal));
  child.once('close', (code, signal) => {
    if (!child.pid) markExit(code, signal, 'spawn_error');
    resolveClose();
  });
  child.on('error', () => {
    // An error on an existing process is not an exit receipt (e.g. a failed kill).
    if (!child.pid) markExit(null, null, 'spawn_error');
    else resolveOutcome({ code: null, reason: 'spawn_error' });
  });
  const kill = () => { if (!exited) { try { child.kill('SIGKILL'); } catch { /* Exit must still be confirmed. */ } } };
  child.once('spawn', () => { if (stopping) kill(); });
  const stdout = data => onOutput('stdout', data), stderr = data => onOutput('stderr', data);
  child.stdout?.on('data', stdout); child.stderr?.on('data', stderr);
  if (exited) markExit(child.exitCode, child.signalCode);
  return {
    outcome,
    async terminate(timeout_ms = 1500) {
      stopping = true; kill();
      check(exited || await bounded(exit, timeout_ms), 'UNKNOWN', 'Bootstrap exit is not confirmed');
    },
    drain: (timeout_ms = 1000) => bounded(closed, timeout_ms),
    detachOutput() { child.stdout?.removeListener('data', stdout); child.stderr?.removeListener('data', stderr); },
  };
}
