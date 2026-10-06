import fs from 'node:fs';
import path from 'node:path';
import { Config } from '../src/config.js';
import { env, temp } from './helpers.js';

/**
 * 纯读取会话投影的轻量 fixture：真实的 Config 与 `<root>/.lush` 目录，
 * 但不打开 SQLite、不构造 Project。transcript / usage / 删除归属只依赖 config 与文件，
 * 因此这些用例无需为每次读取付出 Store + Project 的初始化成本。
 */
export function sessionFixture(extra = {}) {
  const root = temp();
  const config = new Config({ project: root, env: env(extra) });
  config.prepare();
  return { root, config, close() { fs.rmSync(root, { recursive: true, force: true }); } };
}

/** pi 的会话记录长这样：一行一条 JSON，字符串原样写入以便测试造出半行。 */
export function sessionFile(root, taskId, lines, name = `2026-01-01T00-00-00-000Z_lush-task-${taskId}.jsonl`) {
  const dir = path.join(root, '.lush', 'sessions');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.map(line => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n');
  return file;
}
