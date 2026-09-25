import { check } from '../core/types.js';

export function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  check(index + 1 < args.length && !args[index + 1].startsWith('--'), `${name} requires a value`);
  const value = args[index + 1]; args.splice(index, 2); return value;
}
export function exact(args, n) { check(args.length === n, 'invalid arguments; run lush help'); }
export function print(value, json) {
  if (json || !Array.isArray(value)) { console.log(JSON.stringify(value, null, 2)); return; }
  if (!value.length) { console.log('(empty)'); return; }
  for (const row of value) {
    console.log(`${row.id ?? '-'}\t${row.status || row.role || ''}\t${(row.goal || row.content || row.title || JSON.stringify(row)).replaceAll('\n',' ').slice(0, 180)}`);
  }
}
