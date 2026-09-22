import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { check } from './types.js';

const runner = fileURLToPath(new URL('./preview-runner.js', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function listening(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = ok => { socket.destroy(); resolve(ok); };
    socket.setTimeout(200, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Trusted local code execution, not an OS sandbox. No shell parsing or agent credentials. */
export async function startPreview({ cwd, command, urlPath = '/', directory, signal, onChange }) {
  check(Array.isArray(command) && command.length > 0 && command.length <= 100
    && command.every(arg => typeof arg === 'string' && arg.length > 0 && arg.length <= 4000 && !arg.includes('\0')),
  'preview command must be an argv array (1..100 non-empty strings)');
  check(typeof urlPath === 'string' && /^\/(?!\/)/.test(urlPath) && urlPath.length <= 2000 && !/[\\\s\x00-\x1f]/.test(urlPath),
    'preview path must be a local URL path');
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  check(!signal?.aborted, 'showcase was cancelled');
  const argv = command.map(arg => arg.replaceAll('{port}', String(port)));
  const env = Object.fromEntries(['PATH','HOME','USER','LOGNAME','SHELL','TMPDIR','TMP','TEMP','LANG','LC_ALL','SYSTEMROOT'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  Object.assign(env, { HOST: '127.0.0.1', PORT: String(port), LUSH_PREVIEW: '1' });
  fs.mkdirSync(directory, { recursive: true });
  const logPath = `${directory}/preview.log`;
  const child = spawn(process.execPath, [runner, cwd, JSON.stringify(argv)], { cwd, env, stdio: ['pipe','pipe','pipe'] });
  const entry = { status: 'starting', url: `http://127.0.0.1:${port}${urlPath}`, command: argv, port, log_path: logPath, error: null };
  let logs = Buffer.alloc(0), closed = false;
  const capture = chunk => {
    logs = Buffer.concat([logs, chunk]).subarray(-65536);
    try { fs.writeFileSync(logPath, logs, { mode: 0o600 }); } catch { /* logging must not orphan a child */ }
  };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  child.stdin.on('error', () => {});
  const exited = new Promise(resolve => {
    const done = error => {
      if (closed) return;
      closed = true;
      entry.status = error ? 'failed' : 'stopped';
      entry.error = error?.message ?? entry.error;
      signal?.removeEventListener('abort', abort);
      onChange?.(entry);
      resolve();
    };
    child.once('error', done); child.once('close', () => done());
  });
  entry.stop = async () => {
    if (!closed) { entry.status = 'stopping'; child.stdin.end(); }
    await exited;
  };
  const abort = () => { void entry.stop(); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    for (let i = 0; i < 80 && !closed && !signal?.aborted && entry.status === 'starting'; i++) {
      if (await listening(port)) {
        entry.status = 'running';
        // Once ready the preview outlives a successful invocation; cancellation is handled by Project.
        signal?.removeEventListener('abort', abort);
        return entry;
      }
      await pause(100);
    }
    entry.error = 'preview did not listen on its assigned loopback port; inspect preview.log';
    await entry.stop();
    throw new Error(entry.error);
  } catch (error) {
    await entry.stop();
    throw error;
  }
}
