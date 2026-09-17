/**
 * The token walk: descend the command tree, hand a leaf the rest of the line,
 * and turn `help` at any layer into that layer's help.
 */
import { FLAG_HELP, HELP_TOKENS, HelpRequested, UsageError, noMore, next } from './args.js';
import { helpRequest } from './help.js';
import { ROOT } from './tree/index.js';

/** Consume every remaining token against a leaf's option spec, or fail with usage. */
export function parseOptions(args, result, options) {
  while (args.length) {
    const flag = args.shift();
    if (FLAG_HELP.has(flag)) throw new HelpRequested();
    // --json is global: accepted before the command and after any leaf.
    if (flag === '--json') {
      result.json = true;
      continue;
    }
    const spec = options[flag];
    if (spec === undefined) throw new UsageError(`unrecognized arguments: ${flag}`);
    spec.apply(result, spec.arg === null ? true : next(args, flag));
  }
}

/**
 * Walk the command tree once. Group tokens descend, a leaf owns the rest of the
 * line, and `help` / `-h` / `--help` at any layer returns that layer's help.
 */
export function parseArgs(argv) {
  const args = [...argv];
  let json = false;
  let node = ROOT;
  const commandPath = [];

  for (;;) {
    const token = args.shift();
    if (token === undefined) {
      if (commandPath.length) {
        throw new UsageError(`the following arguments are required: subcommand (try 'lush ${commandPath.join(' ')} help')`);
      }
      throw new UsageError('the following arguments are required: command');
    }
    if (token === '--json') {
      json = true;
      continue;
    }
    if (HELP_TOKENS.has(token)) return helpRequest(json, node, commandPath, args);

    const child = node.children?.[token];
    if (child === undefined) {
      const choices = node.children ? ` (choose from ${Object.keys(node.children).join(', ')})` : '';
      throw new UsageError(`argument command: invalid choice: '${token}'${choices}`);
    }
    commandPath.push(token);
    node = child;
    if (node.children) continue; // still a group: keep descending

    if (HELP_TOKENS.has(args[0])) {
      args.shift();
      return helpRequest(json, node, commandPath);
    }
    const result = { json, command: node.command, node };
    try {
      Object.assign(result, node.parse ? node.parse(args) : {});
      parseOptions(args, result, node.options ?? {});
    } catch (err) {
      if (err instanceof HelpRequested) return helpRequest(json, node, commandPath);
      throw err;
    }
    noMore(args);
    node.check?.(result);
    return result;
  }
}
