import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { check } from './types.js';

export const INPUT_RULE_PATH = '.lush-ap/input.mjs';
const MAX_RULE_BYTES = 16384;

export function snapshotPath(home, apId) { return path.join(home, 'ap-rules', `ap-${apId}.mjs`); }

/** A new AP receives the rule from its frozen fork commit, not its mutable worktree. */
export async function readInputRule(workspaces, project, commit) {
  const exists = await workspaces.git(project, 'cat-file', '-e', `${commit}:${INPUT_RULE_PATH}`).then(() => true, () => false);
  if (!exists) return null;
  const source = await workspaces.git(project, 'show', `${commit}:${INPUT_RULE_PATH}`);
  check(Buffer.byteLength(source) <= MAX_RULE_BYTES, 'AP input rule exceeds 16 KiB');
  return source;
}

export function saveInputRule(home, apId, source) {
  if (source === null) return;
  const dir = path.dirname(snapshotPath(home, apId));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(snapshotPath(home, apId), source, { flag: 'wx', mode: 0o600 });
}

/** No token is passed. The repository program is trusted user code, but is bounded in time and output. */
export function decideAPInput(home, ap, body) {
  const file = snapshotPath(home, ap.id);
  if (!fs.existsSync(file)) return { delivery: 'interrupt', source: 'default' };
  const env = { PATH: process.env.PATH || '', HOME: process.env.HOME || '',
    TMPDIR: process.env.TMPDIR || '/tmp' };
  const run = spawnSync(process.execPath, [file], {
    cwd: ap.workspace && fs.existsSync(ap.workspace) ? ap.workspace : home,
    env, input: JSON.stringify({ version: 1, ap: { id: ap.id, status: ap.status, ap_kind: ap.ap_kind,
      branch: ap.branch }, input: body }) + '\n', encoding: 'utf8', timeout: 1000, maxBuffer: 16384,
  });
  if (run.error || run.status !== 0) throw new Error(`AP input rule failed: ${run.error?.message || String(run.stderr || 'non-zero exit').slice(0, 300)}`);
  let result;
  try { result = JSON.parse(run.stdout); } catch { throw new Error('AP input rule must print one JSON object'); }
  check(result && !Array.isArray(result) && ['message', 'interrupt'].includes(result.delivery),
    'AP input rule must return {"delivery":"message"} or {"delivery":"interrupt"}');
  return { delivery: result.delivery, source: 'rule' };
}
