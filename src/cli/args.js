import { check } from '../core/types.js';
import { workerLabel } from './worker-number.js';
import { inputNumber, noticeNumber } from '../core/record-number.js';

const literalBoundary = Symbol('CLI literal boundary');

// Preserve literal argv after -- without changing any string sent to a handler.
// Mutating Array helpers keep the boundary when roots, verbs and options are consumed.
export function cliArguments(values) {
  const separator = values.indexOf('--');
  const args = separator < 0 ? [...values] : [...values.slice(0, separator), ...values.slice(separator + 1)];
  Object.defineProperty(args, literalBoundary, { value: separator < 0 ? Infinity : separator, writable: true });
  Object.defineProperties(args, {
    indexOf: { value(value, start = 0) {
      const index = Array.prototype.indexOf.call(this, value, start);
      return typeof value === 'string' && value.startsWith('-') && index >= this[literalBoundary] ? -1 : index;
    } },
    includes: { value(value, start = 0) { return this.indexOf(value, start) !== -1; } },
    splice: { value(start, count, ...items) {
      const actual = start < 0 ? Math.max(0, this.length + start) : Math.min(start, this.length);
      const removed = Math.min(count ?? this.length - actual, this.length - actual);
      if (actual < this[literalBoundary]) this[literalBoundary] += items.length - Math.min(removed, this[literalBoundary] - actual);
      return Array.prototype.splice.call(this, start, count, ...items);
    } },
    shift: { value() { return this.splice(0, 1)[0]; } },
  });
  return args;
}
export function isOptionIndex(args, index) { return index < (args[literalBoundary] ?? Infinity); }
export function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  check(isOptionIndex(args, index + 1) && index + 1 < args.length && !args[index + 1].startsWith('--'), `${name} requires a value`);
  const value = args[index + 1]; args.splice(index, 2); return value;
}
export function exact(args, n) { check(args.length === n, 'invalid arguments; run lush help'); }
export function print(value, json) {
  if (json || !Array.isArray(value)) { console.log(JSON.stringify(value, null, 2)); return; }
  if (!value.length) { console.log('(empty)'); return; }
  for (const row of value) {
    const label = 'worker_number' in row || ('role' in row && 'goal' in row) ? workerLabel(row)
      : 'task_id' in row && 'kind' in row && 'title' in row ? noticeNumber(row)
        : row.kind === 'input' || ('flow' in row && 'content' in row) ? inputNumber(row.id)
          : row.id ?? '-';
    console.log(`${label}\t${row.status || row.role || ''}\t${(row.display_title || row.auto_title || row.goal || row.content || row.title || JSON.stringify(row)).replaceAll('\n',' ').slice(0, 180)}`);
  }
}
