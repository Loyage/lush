/**
 * The CLI's argument primitives: the two usage errors and the small helpers
 * every layer of the command tree uses to read its own tokens.
 *
 * This is the leaf of the CLI import graph (it only knows `core/types.js`), so
 * `tree/*` can decode arguments without importing the parser that walks the
 * tree. `parse.js` builds the token walk on top of it.
 */
import { VIEW_SECTIONS } from '../core/types.js';

export class UsageError extends Error {}

/** Thrown when the user asked for help in place of a real argument. Never leaves the CLI. */
export class HelpRequested extends Error {}

export const FLAG_HELP = new Set(['-h', '--help']);
export const HELP_TOKENS = new Set(['help', ...FLAG_HELP]);

export function next(args, label) {
  const value = args.shift();
  if (value === undefined) throw new UsageError(`the following arguments are required: ${label}`);
  if (FLAG_HELP.has(value)) throw new HelpRequested();
  return value;
}

export function noMore(args) {
  if (args.length) throw new UsageError(`unrecognized arguments: ${args.join(' ')}`);
}

export function intArg(value, label) {
  if (value === undefined) throw new UsageError(`the following arguments are required: ${label}`);
  if (FLAG_HELP.has(value)) throw new HelpRequested();
  if (!/^-?\d+$/.test(value)) throw new UsageError(`argument ${label}: invalid int value: '${value}'`);
  return Number.parseInt(value, 10);
}

/** Parse a CLI JSON argument, reporting usage errors instead of stack traces. */
export function jsonArg(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new UsageError(`argument ${label}: invalid JSON`);
  }
}

/**
 * `inspect --with` selects sections of the unified view. Returns null when the
 * flag is absent, which keeps plain `lush process inspect PID` on the full payload.
 */
export function inspectSections(args) {
  const sections = [];
  while (args.length) {
    const flag = args.shift();
    if (flag !== '--with') throw new UsageError(`unrecognized arguments: ${flag}`);
    for (const part of next(args, '--with').split(',')) {
      const section = part.trim();
      if (!VIEW_SECTIONS.includes(section)) {
        throw new UsageError(`argument --with: invalid choice: '${section}'`
          + ` (choose from ${VIEW_SECTIONS.join(', ')})`);
      }
      // Repeating a section is harmless on the command line; the RPC layer rejects it.
      if (!sections.includes(section)) sections.push(section);
    }
  }
  return sections.length ? sections : null;
}
