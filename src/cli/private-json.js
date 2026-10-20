import { check, isPlainObject } from '../core/types.js';
import { option } from './args.js';

/** Structured business input is inline only; no local-file execution path. */
export function takeJsonInput(args) {
  const data = option(args, '--data');
  check(data !== null && !args.includes('--data') && !args.includes('--file'), 'provide --data JSON; local files are not supported');
  check(Buffer.byteLength(data) <= 40000, 'inline JSON exceeds budget');
  const value = JSON.parse(data);
  check(isPlainObject(value), 'inline JSON must be an object');
  return value;
}
