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

export function validSid(sid) {
  if (typeof sid !== 'number' || !Number.isInteger(sid) || sid < 0 || sid > MAX_INT) {
    throw new LushError('sid must be a non-negative SQLite integer', -32602);
  }
  return sid;
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

/**
 * The unified `service.view` read model — the three questions a parent asks
 * about a node before using it, plus where it sits in the tree:
 * `description` is what the node is (its capability boundary),
 * `templates` is what it may still create (the child templates its own agent
 * sees as `available_child_templates`),
 * `prompt` is the prompt its tasks run with (the call prompt),
 * `parent` / `children` are its tree position.
 */
export const VIEW_SECTIONS = ['description', 'parent', 'children', 'prompt', 'templates'];

/**
 * Service variables are declared and stored in two regions: `immutable`
 * values are fixed at creation (they are the template's initial variables),
 * `mutable` values stay changeable through `service.update_vars`.
 */
export const VARIABLE_GROUPS = ['immutable', 'mutable'];

/** Normalize requested view sections to canonical order; reject unknown or repeated names. */
export function viewSections(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new LushError(`sections must be a non-empty list of ${VIEW_SECTIONS.join(', ')}`, -32602);
  }
  const requested = new Set();
  for (const section of value) {
    if (!VIEW_SECTIONS.includes(section)) {
      throw new LushError(`invalid view section: ${String(section)}`, -32602);
    }
    if (requested.has(section)) throw new LushError(`duplicate view section: ${section}`, -32602);
    requested.add(section);
  }
  return VIEW_SECTIONS.filter((section) => requested.has(section));
}
