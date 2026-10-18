import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { check, isPlainObject } from '../../core/types.js';
import { exact, option } from '../args.js';
import { inputNumber, workerLabel, resolveWorkerId } from '../worker-number.js';

function flag(args, name) {
  const enabled = args.includes(name);
  if (enabled) args.splice(args.indexOf(name), 1);
  check(!args.includes(name), `duplicate option: ${name}`);
  return enabled;
}

export function readProfile(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    check(stat.isFile() && stat.size <= 256 * 1024, 'invalid file');
    check(typeof process.getuid === 'function' && stat.uid === process.getuid() && (stat.mode & 0o077) === 0, 'unsafe file');
    const source = fs.readFileSync(fd, 'utf8');
    check(Buffer.byteLength(source) <= 256 * 1024, 'invalid file');
    const value = JSON.parse(source);
    check(isPlainObject(value), 'invalid profile');
    return value;
  } catch { throw new Error('cannot safely read private Worker profile JSON file (owner-only regular file required)'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export async function run(command, args, ctx) {
  const { client } = ctx;
  let value;
  if (command === 'order') {
    check(!client.token, 'agents cannot submit orders');
    const branch = option(args, '--branch');
    const profileFile = option(args, '--profile-file');
    const defer = flag(args, '--defer'); // Legacy spelling; ordinary emission now always defers safely.
    const quiet = flag(args, '--quiet'), exclusive = flag(args, '--exclusive');
    const management = flag(args, '--management'), buffer = flag(args, '--buffer');
    const append = option(args, '--append');
    const waiting = [];
    for (const [name, kind] of [['--after-settled', 'worker_settled'], ['--after-merged', 'worker_merged']]) {
      while (args.includes(name)) waiting.push({ kind, selector: option(args, name) });
    }
    exact(args, 1);
    check(!management || (!branch && !defer && !quiet && !exclusive && !buffer && append === null && !waiting.length),
      'management input cannot use development targets, buffering or conditions');
    check(!exclusive || append === null, 'exclusive development is not available for append input');
    check(append === null || branch === null, 'append input selects a Worker, not a parent branch');
    const profile = profileFile !== null ? readProfile(profileFile) : null;
    if (management) {
      value = await client.request('management.submit', { instruction: args[0], ...(profile ? { profile } : {}), client_request_id: randomUUID() });
    } else if (buffer || quiet || exclusive || append !== null || waiting.length) {
      check(!buffer || !profile, 'buffering does not save private run profiles; select the profile at emission');
      const conditions = [];
      for (const condition of waiting) conditions.push({ kind: condition.kind, worker_id: await resolveWorkerId(client, condition.selector) });
      if (quiet) conditions.push({ kind: 'parent_quiet' });
      const params = { content: args[0], ...(branch ? { branch } : {}),
        ...(append !== null ? { mode: 'append', target_id: await resolveWorkerId(client, append) } : {}),
        ...(conditions.length ? { conditions } : {}), ...(exclusive ? { exclusive: true } : {}), ...(profile ? { profile } : {}) };
      value = await client.request(buffer ? 'draft.add' : 'input.emit',
        buffer ? params : { ...params, client_request_id: randomUUID() });
    } else {
      value = await client.request('order.submit', { content: args[0], ...(branch ? { branch } : {}), ...(profile ? { profile } : {}), ...(defer ? { defer: true } : {}) });
    }
    if (!ctx.json && value?.emitted) console.log(`输入已挂载（草稿记录 #${value.draft_id}）；等待条件及 runtime 安全准入，不保证立即创建或调用 Agent。`);
    else if (!ctx.json && value?.management) console.log(`Valet 指令已提交 → ${workerLabel(value.task)}（不创建开发 Worker）`);
    else if (!ctx.json && value?.id && value?.task) console.log(`输入 ${inputNumber(value.id)} → Worker ${workerLabel(value.task)}`);
  }
  return value;
}
