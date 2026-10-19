import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { check, isPlainObject } from '../../core/types.js';
import { validateInputEmissionRequest } from '../../core/input-emission-protocol.js';
import { exact, option } from '../args.js';
import { resolveWorkerId } from '../worker-number.js';

// main owns the -- boundary. Its argv keeps literal strings for exact()/body,
// while option/includes/indexOf see only the option-bearing prefix. Do not copy
// or independently split that argv here (including for duplicate checks).
export function cliOption(args, name, fallback = null) {
  const value = option(args, name, fallback);
  check(!args.includes(name), `duplicate option: ${name}`);
  return value;
}
export function cliFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  check(!args.includes(name), `duplicate option: ${name}`);
  return true;
}
export function positionalArguments(args, count) {
  check(!args.some(arg => arg.startsWith('--') && args.indexOf(arg) !== -1),
    'unknown CLI option; use -- before literal text beginning with --');
  exact(args, count); return args;
}
export function cliInteger(value, name, min = 1, max = Number.MAX_SAFE_INTEGER) {
  check(typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value)
    && Number.isSafeInteger(Number(value)) && Number(value) >= min && Number(value) <= max,
  `${name} must be an integer from ${min} to ${max}`);
  return Number(value);
}
function inlineJSON(value, name) {
  check(Buffer.byteLength(value) <= 49152, `${name} exceeds the inline JSON budget`);
  try { return JSON.parse(value); } catch { throw new Error(`${name} must be valid JSON`); }
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

/** Parse first, then resolve real Worker identities; saving never reads a profile. */
export function inputOptions(args, { update = false, append = false, profile = false } = {}) {
  const branch = cliOption(args, '--branch'), target = append ? cliOption(args, '--append-to') : null;
  const mode = update ? cliOption(args, '--mode') : null;
  const source = cliOption(args, '--conditions'), references = cliOption(args, '--references');
  const profileFile = profile ? cliOption(args, '--profile-file') : null;
  const whenIdle = cliFlag(args, '--when-idle');
  const exclusive = update ? cliOption(args, '--exclusive') : cliFlag(args, '--exclusive');
  check(mode === null || ['new','append'].includes(mode), '--mode expects new or append');
  check(!update || exclusive === null || ['on','off'].includes(exclusive), '--exclusive expects on or off when updating');
  check(target === null || branch === null, '--append-to and --branch are mutually exclusive');
  check(mode !== 'new' || target === null, '--mode new cannot use --append-to');
  check(mode !== 'append' || branch === null, '--mode append cannot use --branch');
  const waiting = [];
  for (const [flag, kind] of [['--after-settled','worker_settled'], ['--after-merged','worker_merged']]) {
    while (args.includes(flag)) waiting.push({ kind, selector: option(args, flag) });
  }
  check(source === null || !waiting.length && !whenIdle, '--conditions cannot be combined with condition flags');
  const conditions = source === null ? [] : inlineJSON(source, '--conditions');
  check(Array.isArray(conditions), '--conditions must be a JSON array');
  if (whenIdle) conditions.push({ kind: 'parent_quiet' });
  check(conditions.length + waiting.length <= 16, 'input requires at most 16 conditions');
  const selectedMode = target !== null ? 'append' : mode === 'new' || branch !== null ? 'order' : mode;
  const selectedExclusive = update ? exclusive === null ? undefined : exclusive === 'on' : exclusive || undefined;
  check(selectedMode !== 'append' || !selectedExclusive, 'exclusive development is not available for append input');
  check(selectedMode !== 'append' || profileFile === null, 'append inputs use the target Worker run settings');
  const params = { ...(branch === null ? {} : { branch }), ...(selectedMode === null ? {} : { mode: selectedMode }),
    ...(references === null ? {} : { references: inlineJSON(references, '--references') }),
    ...(source !== null || whenIdle || waiting.length ? { conditions } : {}),
    ...(selectedExclusive === undefined ? {} : { exclusive: selectedExclusive }) };
  // Validate local shape before any lookup/file read. Saved-mode and lifecycle checks
  // remain in the original draft/emission engine (especially update and submit).
  validateInputEmissionRequest({ content: 'CLI shape validation', ...params,
    ...(selectedMode === 'append' ? { target_id: 1 } : {}) });
  return { params, target, waiting, profileFile };
}
export async function resolveInputOptions(parsed, client) {
  const params = { ...parsed.params };
  if (parsed.target !== null) params.target_id = await resolveWorkerId(client, parsed.target);
  for (const condition of parsed.waiting) params.conditions.push({ kind: condition.kind, worker_id: await resolveWorkerId(client, condition.selector) });
  return params;
}

export async function run(command, args, ctx) {
  check(command === 'order', 'unknown order command');
  const { client } = ctx;
  check(!client.token || client.management, 'agents cannot submit orders');
  const parsed = inputOptions(args, { profile: true });
  positionalArguments(args, 1);
  check(args[0].length <= 32000 && args[0].trim().length > 0, 'input must be non-blank text of at most 32000 characters');
  check(!client.management || parsed.profileFile === null, 'the management bridge cannot read local profile files');
  const params = { content: args[0], ...await resolveInputOptions(parsed, client),
    ...(parsed.profileFile === null ? {} : { profile: readProfile(parsed.profileFile) }) };
  validateInputEmissionRequest(params);
  // Preserve both reviewed RPC branches; a CLI rename does not copy permissions.
  const conditional = Object.hasOwn(params, 'conditions') || params.exclusive;
  return client.request(conditional ? 'input.emit' : 'order.submit', { ...params,
    ...(conditional ? { client_request_id: client.management ? client.requestId : randomUUID() } : {}) });
}
