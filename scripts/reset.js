/**
 * `bun run reset [yes]` — rebuild the service tree of the current LUSH_HOME.
 *
 * Ports the Justfile's `reset` recipe: every service except SID 0 is
 * recursively purged, then the daemon is restarted. The daemon itself,
 * `agents/` and `daemon.log` survive, so this is "same data, new tree". It only
 * ever touches the daemon answering for the current LUSH_HOME.
 *
 * The intension queue is cleared first: those rows are user input, not the tree,
 * but an input still waiting to be parsed would be picked up right after the
 * restart and could rebuild what this script just threw away — "推倒重来" has to
 * mean the whole picture, not the tree alone.
 *
 * Without an argument it asks for `yes` on stdin; pass `yes` (or `y`, `--yes`,
 * `-y`, `all`) to skip the confirmation. A failed purge makes the script exit 1.
 */
import readline from 'node:readline/promises';
import { captureLush, runLush, scriptEnv } from './lib.js';

/** Root nodes = non-zero services whose parent is SID 0 or already missing. */
function rootsOf(rows) {
  const targets = rows.filter((row) => row.sid !== 0);
  const targetSids = new Set(targets.map((row) => row.sid));
  return targets
    .filter((row) => row.parent_sid === null || !targetSids.has(row.parent_sid))
    .map((row) => row.sid)
    .sort((a, b) => a - b);
}

async function confirmed(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const reply = (await rl.question(prompt)).trim();
    return reply === 'yes' || reply === 'y';
  } catch {
    return false; // closed / empty stdin counts as "do not delete"
  } finally {
    rl.close();
  }
}

function lines(text) {
  return text.split('\n').filter((line) => line !== '');
}

/**
 * Withdraw every input still in the queue so the daemon that comes back has
 * nothing to re-parse. Returns how many rows were withdrawn.
 */
function clearQueue() {
  const listed = captureLush(['intent', 'list', '--open', '--json']);
  let rows;
  try {
    rows = JSON.parse(listed.out);
  } catch {
    return 0;
  }
  let withdrawn = 0;
  for (const row of rows) {
    const done = captureLush(['intent', 'withdraw', String(row.id), '--reason', 'reset']);
    if (done.code === 0) withdrawn += 1;
    else process.stderr.write(`撤不回 intension #${row.id}：${done.err.trim()}\n`);
  }
  return withdrawn;
}

export async function reset(args = []) {
  const skip = args[0] ?? '';
  const home = scriptEnv().LUSH_HOME;

  if (runLush(['daemon', 'status'], { stdout: 'ignore', stderr: 'ignore' }) !== 0) {
    process.stdout.write(`daemon 未运行（${home}），直接启动\n`);
    return runLush(['daemon', 'start']);
  }

  const listed = captureLush(['service', 'list', '--json']);
  let rows;
  try {
    rows = JSON.parse(listed.out);
  } catch {
    process.stderr.write(`读不到 ${home} 的服务列表，已中止\n`);
    return 1;
  }

  const sids = rootsOf(rows);

  process.stdout.write(`home  ${home}\n\n`);
  runLush(['service', 'tree']);
  process.stdout.write('\n');

  if (sids.length === 0) {
    process.stdout.write('服务树已经是空的（只剩 SID 0），只重启 daemon\n');
  } else {
    process.stdout.write(`将递归 purge 这些根节点（连同整棵子树）：${sids.join(', ')}\n`);
  }

  if (!['yes', 'y', '--yes', '-y', 'all'].includes(skip)) {
    if (!(await confirmed('输入 yes 回车确认清空并重启（其他任何输入取消）: '))) {
      process.stdout.write('已取消，什么都没删\n');
      return 1;
    }
  }

  const withdrawn = clearQueue();
  if (withdrawn > 0) process.stdout.write(`已撤回队列里 ${withdrawn} 条未处理的输入\n`);

  let failed = 0;
  for (const sid of sids) {
    process.stdout.write(`--- purge ${sid} ---\n`);
    const purged = captureLush(['service', 'purge', String(sid), '--recursive']);
    if (purged.code === 0) {
      for (const line of lines(`${purged.out}${purged.err}`)) {
        if (!line.startsWith('lush: warning:')) process.stdout.write(`${line}\n`);
      }
    } else {
      for (const line of lines(`${purged.out}${purged.err}`)) process.stderr.write(`${line}\n`);
      failed += 1;
    }
  }

  process.stdout.write('\n');
  runLush(['daemon', 'restart']);
  process.stdout.write('\n');
  runLush(['service', 'tree']);

  if (failed > 0) {
    process.stdout.write(`有 ${failed} 个根节点 purge 失败（见上面输出）\n`);
    return 1;
  }
  process.stdout.write(`已重置 ${home}：服务树只剩 SID 0，daemon 已重启\n`);
  return 0;
}
