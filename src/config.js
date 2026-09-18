import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { check } from './core/types.js';

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
    check(['pi', 'mock'].includes(this.provider), 'LUSH_PROVIDER must be pi or mock');
    this.concurrency = positive(env, 'LUSH_CONCURRENCY', 4, 64);
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
      check(!fs.existsSync(path.join(this.home, 'lush.db')), 'legacy database found; move .lush aside (no automatic migration)');
      fs.writeFileSync(file, JSON.stringify({ version: 2, path: this.project }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    }
  }
}
