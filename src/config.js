import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { check } from './core/types.js';
import { RuntimeSettings } from './core/settings.js';

export function discoverProject(cwd) {
  let current = fs.realpathSync(cwd);
  const start = current;
  for (;;) {
    if (fs.existsSync(path.join(current, '.lush', 'project.json')) || fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}
function positive(env, key, fallback, max) {
  const value = Number(env[key] ?? fallback);
  check(Number.isInteger(value) && value > 0 && value <= max, `${key} must be an integer from 1 to ${max}`);
  return value;
}
export class Config {
  constructor({ project, env = process.env }) {
    this.project = fs.realpathSync(project);
    check(fs.statSync(this.project).isDirectory(), 'project must be a directory');
    this.home = path.join(this.project, '.lush');
    check(!env.LUSH_HOME || path.resolve(env.LUSH_HOME) === this.home,
      'LUSH_HOME is no longer independent: unset it and select a project with --project or LUSH_PROJECT');
    this.env = { ...env, LUSH_PROJECT: this.project, LUSH_HOME: this.home };
    this.provider = env.LUSH_PROVIDER || 'pi';
    check(['pi', 'codex', 'mock'].includes(this.provider), 'LUSH_PROVIDER must be pi, codex or mock');
    // Execution and control work have separate admission lanes: long workers can never starve new intent planning.
    // 环境变量仍是默认值（构造时严格校验，非法直接抛错）；<home>/settings.json 里被显式覆盖的键优先于它。
    this.concurrencyDefault = positive(env, 'LUSH_CONCURRENCY', 4, 64);
    this.controlConcurrencyDefault = positive(env, 'LUSH_CONTROL_CONCURRENCY', 2, 16);
    this.runtimeSettings = new RuntimeSettings(this);
    const runtime = this.runtimeSettings.get();
    this.concurrency = runtime.concurrency.value;
    this.controlConcurrency = runtime.control_concurrency.value;
    // 快速路由前缀：提交输入时按这份生效值做匹配，不需要重启 daemon。
    this.inputRoutes = runtime.input_routes.value.map(route => ({ ...route }));
    // 宿主（Project）注册的回调：运行设置写盘后重新 pump，让调高的并发立即对排队任务生效。
    this.onKick = null;
    this.timeout = positive(env, 'LUSH_CALL_TIMEOUT', 900, 86400);
    this.maxCalls = positive(env, 'LUSH_TASK_CALLS', 24, 1000);
    this.maxDepth = positive(env, 'LUSH_MAX_DEPTH', 8, 64);
    const hash = createHash('sha256').update(this.project).digest('hex').slice(0, 24);
    this.socketDir = path.join(os.tmpdir(), `lush-${process.getuid()}`);
    this.socket = path.join(this.socketDir, `${hash}.sock`);
  }
  static fromEnv(env = process.env, cwd = process.cwd(), project = null) {
    return new Config({ project: project || env.LUSH_PROJECT || discoverProject(cwd), env });
  }

  /** 运行设置写盘完成后通知宿主重新准入；没有宿主（如 CLI 客户端）时是空操作。 */
  kick() {
    if (typeof this.onKick === 'function') this.onKick();
  }

  /**
   * 运行时改写并发上限：校验并原子写盘，成功后同步内存里的生效值，再 kick 一次。
   * 调低并发不取消任何在跑任务——它们自然结束，pump() 只是不再准入新任务。
   */
  configureRuntime(patch) {
    const model = this.runtimeSettings.save(patch);
    this.concurrency = model.concurrency.value;
    this.controlConcurrency = model.control_concurrency.value;
    this.inputRoutes = model.input_routes.value.map(route => ({ ...route }));
    this.kick();
    return model;
  }
  prepare() {
    for (const dir of [this.home, this.socketDir]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const stat = fs.lstatSync(dir);
      check(!stat.isSymbolicLink() && stat.isDirectory() && stat.uid === process.getuid(), `unsafe state directory: ${dir}`);
      fs.chmodSync(dir, 0o700);
    }
    const file = path.join(this.home, 'project.json');
    if (fs.existsSync(file)) {
      const binding = JSON.parse(fs.readFileSync(file, 'utf8'));
      check(binding.version === 2 && binding.path === this.project, 'state belongs to another project/version; move .lush aside to initialize a new project');
    } else {
      fs.writeFileSync(file, JSON.stringify({ version: 2, path: this.project }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    }
  }
}
