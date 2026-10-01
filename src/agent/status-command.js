import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** No shell and no raw diagnostic output: neither credentials nor provider errors may escape. */
export function statusCommand(command, args, env, cwd, { timeout = 15000, maxBytes = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(command, args, { env, cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '', bytes = 0, settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(new Error(error)); else resolve(output);
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish('查询超时'); }, timeout);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) { child.kill('SIGKILL'); finish('查询结果超过大小限制'); }
      else output += chunk;
    });
    child.on('error', () => finish('无法启动查询进程'));
    child.on('close', code => finish(code === 0 ? null : '查询进程失败'));
  });
}

/** Resolve only the configured command. Do not guess another globally installed Pi. */
export function resolvePiInstallation(config) {
  const command = config.env.LUSH_PI_COMMAND || 'pi';
  let executable = null, real_path = null, package_dir = null;
  const candidates = command.includes(path.sep) ? [path.resolve(config.project, command)]
    : (config.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.resolve(config.project, dir, command));
  for (const file of candidates) {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (!fs.statSync(file).isFile()) continue;
      executable = file; real_path = fs.realpathSync(file); break;
    } catch {}
  }
  const roots = config.env.PI_PACKAGE_DIR ? [path.resolve(config.project, config.env.PI_PACKAGE_DIR)] : [];
  if (real_path) {
    let dir = path.dirname(real_path);
    for (let count = 0; count < 6; count += 1) {
      roots.push(dir);
      const parent = path.dirname(dir); if (parent === dir) break; dir = parent;
    }
  }
  for (const root of roots) {
    try {
      const stat = fs.statSync(path.join(root, 'package.json'));
      if (stat.size > 65536) continue;
      const value = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      if (['@earendil-works/pi-coding-agent', '@mariozechner/pi-coding-agent'].includes(value.name)) { package_dir = root; break; }
    } catch {}
  }
  return { command, executable, real_path, package_dir };
}
