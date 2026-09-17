/** Shared domain errors and validation; no transport dependencies. */

/** JavaScript numbers are only exact up to 2^53 - 1; SQLite INTEGER tops out at 2^63 - 1. */
export const MAX_INT = Number.MAX_SAFE_INTEGER;

export class LushError extends Error {
  constructor(message, code = -32009) {
    super(message);
    this.name = 'LushError';
    this.code = code;
  }
}

export function now() {
  return new Date().toISOString();
}

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validPid(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 0 || pid > MAX_INT) {
    throw new LushError('pid must be a non-negative SQLite integer', -32602);
  }
  return pid;
}

export function text(value, field, maxLength = 100_000) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
    throw new LushError(`${field} must be a non-empty string (max ${maxLength})`, -32602);
  }
  return value;
}

/** Serialize to JSON, rejecting everything that is not valid JSON (NaN, Infinity, bigint, undefined, cycles). */
export function jsonDump(value) {
  let out;
  try {
    out = JSON.stringify(value, (_key, item) => {
      if (typeof item === 'number' && !Number.isFinite(item)) throw new TypeError('non-finite number');
      if (typeof item === 'bigint') throw new TypeError('bigint');
      return item;
    });
  } catch (err) {
    throw new LushError('value must be finite JSON', -32602);
  }
  if (typeof out !== 'string') throw new LushError('value must be finite JSON', -32602);
  return out;
}

export function jsonLoad(value) {
  return JSON.parse(value);
}
