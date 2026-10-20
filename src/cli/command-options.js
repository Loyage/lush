import { check } from '../core/types.js';
import { option } from './args.js';

/** Typed argv options shared by real CLI handlers; no method names come from argv. */
export function takeOptions(args, fields) {
  const result = {};
  for (const [field, type] of Object.entries(fields)) {
    const flag = `--${field.replaceAll('_', '-')}`, value = option(args, flag);
    if (value === null) continue;
    check(!args.includes(flag), 'duplicate CLI option');
    if (type === 'number') {
      check(/^(?:0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value)), 'CLI option must be a nonnegative integer');
      result[field] = Number(value);
    } else if (type === 'boolean') {
      check(['true','false'].includes(value), 'CLI boolean option expects true or false'); result[field] = value === 'true';
    } else if (type === 'json') {
      check(Buffer.byteLength(value) <= 40000, 'inline JSON exceeds budget'); result[field] = JSON.parse(value);
    } else result[field] = value;
  }
  return result;
}
