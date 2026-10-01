import cp from 'node:child_process';
import path from 'node:path';

/** One owned ephemeral Host for all local windows; remote windows never call start(). */
export function createLocalHost({ root, bun = process.env.LUSH_BUN_COMMAND || 'bun', env = process.env,
  spawn = cp.spawn, timeoutMs = 15000 } = {}) {
  let child = null, url = null, pending = null, abortStart = null;
  function stop() {
    abortStart?.(new Error('桌面服务启动已取消'));
    if (child && !child.killed) child.kill('SIGTERM');
    child = null; url = null;
  }
  function start() {
    if (pending) return pending;
    if (child && url) return Promise.resolve(url);
    const childEnv = { ...env, LUSH_WEB_LAUNCHER: '1', LUSH_WEB_EPHEMERAL: '1' };
    delete childEnv.LUSH_PROJECT; delete childEnv.LUSH_HOME;
    const owned = spawn(bun, [path.join(root, 'bin', 'lush-host'), '0'], {
      cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    child = owned;
    const attempt = new Promise((resolve, reject) => {
      let output = '', errors = '', settled = false;
      const finish = (error, ready) => {
        if (settled) return;
        settled = true; clearTimeout(timer); abortStart = null;
        if (error) {
          if (child === owned) { child = null; url = null; }
          if (!owned.killed) owned.kill('SIGTERM');
          reject(error);
        } else { url = ready; resolve(ready); }
      };
      const timer = setTimeout(() => finish(new Error(`桌面服务启动超时${errors ? `：${errors.trim()}` : ''}`)), timeoutMs);
      abortStart = error => finish(error);
      owned.stdout.setEncoding('utf8'); owned.stderr.setEncoding('utf8');
      owned.stderr.on('data', chunk => { errors = (errors + chunk).slice(-2000); });
      owned.stdout.on('data', chunk => {
        output += chunk;
        let index;
        while ((index = output.indexOf('\n')) >= 0) {
          const line = output.slice(0, index); output = output.slice(index + 1);
          if (!line.startsWith('LUSH_HOST_READY ')) continue;
          try {
            const ready = new URL(JSON.parse(line.slice(16)).url);
            if (ready.protocol !== 'http:' || ready.hostname !== '127.0.0.1' || ready.pathname !== '/' || ready.username || ready.password) throw new Error('invalid local Host URL');
            finish(null, ready.href);
          } catch (error) { finish(error); }
        }
        output = output.slice(-8192);
      });
      owned.once('error', error => finish(new Error(`无法启动 Bun：${error.message}`)));
      owned.once('exit', code => {
        if (child === owned) { child = null; url = null; }
        finish(new Error(`桌面服务已退出（${code ?? 'signal'}）${errors ? `：${errors.trim()}` : ''}`));
      });
    });
    pending = attempt.finally(() => { pending = null; });
    return pending;
  }
  return { start, stop };
}
