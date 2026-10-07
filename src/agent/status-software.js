import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveSoftwareCommand, statusCommand } from './status-command.js';

const flights = new WeakMap();
const NOTE = '当前项目 daemon 所在机器安装的 Pi / Codex 软件；仅执行 --version，不读取账号、凭证、模型或资源，不代表运行配置或某次 invocation 的实况。';

async function diagnose(config, agent, timeout) {
  const installation = resolveSoftwareCommand(config, agent);
  const result = { agent, ...installation, version: null, status: 'unavailable', warning: null };
  if (!installation.executable) {
    result.warning = '未找到当前 daemon 配置的可执行命令；未回退其他安装。';
    return result;
  }
  let directory;
  try {
    // Even --version runs without ambient credentials, project config, SDK probes or extensions.
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-software-status-'));
    fs.chmodSync(directory, 0o700);
    const env = { PATH: config.env.PATH || '', HOME: directory, TMPDIR: directory,
      PI_CODING_AGENT_DIR: directory, CODEX_HOME: directory, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' };
    const output = (await statusCommand(installation.executable, ['--version'], env, directory,
      { timeout, maxBytes: 1024 })).trim();
    const prefix = agent === 'codex' ? '(?:codex(?:-cli)?\\s+)?' : '(?:pi\\s+)?';
    const match = output.match(new RegExp(`^${prefix}(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]{1,80})?(?:\\+[0-9A-Za-z.-]{1,80})?)$`));
    if (!match) throw new Error();
    result.version = match[1]; result.status = 'available';
  } catch {
    result.warning = '版本诊断失败：命令不可用、超时或版本输出无效；未返回原始输出。';
  } finally {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
  return result;
}

/** In-flight sharing only: each later explicit check executes --version again. */
export function discoverSoftwareStatus(config, options = {}) {
  const snapshot = { project: config.project, env: { PATH: config.env.PATH,
    LUSH_PI_COMMAND: config.env.LUSH_PI_COMMAND, LUSH_CODEX_COMMAND: config.env.LUSH_CODEX_COMMAND } };
  const timeout = Number.isFinite(options.timeout) ? Math.max(1, Math.min(5000, options.timeout)) : 5000;
  const key = JSON.stringify([snapshot, timeout]);
  let entries = flights.get(config);
  if (!entries) { entries = new Map(); flights.set(config, entries); }
  if (entries.has(key)) return entries.get(key);
  const pending = Promise.all(['pi', 'codex'].map(agent => diagnose(snapshot, agent, timeout))).then(software => ({
    version: 2, checked_at: new Date().toISOString(), scope: { project: snapshot.project, note: NOTE }, software, warnings: [],
  })).finally(() => { if (entries.get(key) === pending) entries.delete(key); });
  entries.set(key, pending); return pending;
}
