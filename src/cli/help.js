/**
 * Help rendering: the command tree turns into text or JSON, and `help` requests
 * are resolved against that same tree. Nothing here reaches the daemon —
 * `lush help` works with or without a running daemon.
 */
import { HELP_TOKENS, UsageError } from './args.js';

const GLOBAL_JSON = '输出机器可读 JSON（默认是人类可读文本）；可放在命令之前或命令末尾（`lush --json service list` / `lush service list --json`）';

export function usageLines(node, commandPath) {
  const name = ['lush', ...commandPath].join(' ');
  if (node.usage) return node.usage;
  if (node.children) return [`${name} <command> [args]`, `${name} help [command]`];
  return [name];
}

export function optionRows(node) {
  const rows = node.options
    ? Object.entries(node.options).map(([flag, spec]) => [spec.arg === null ? flag : `${flag} ${spec.arg}`, spec.desc])
    : [];
  rows.push(['--json', GLOBAL_JSON]);
  return rows;
}

function pushList(lines, title, items) {
  if (!items?.length) return;
  lines.push(`${title}:`);
  for (const item of items) lines.push(`  - ${item}`);
  lines.push('');
}

function pushRaw(lines, title, items) {
  if (!items?.length) return;
  lines.push(`${title}:`);
  for (const item of items) lines.push(`  ${item}`);
  lines.push('');
}

function pushTable(lines, title, rows) {
  if (!rows.length) return;
  const width = Math.max(...rows.map(([key]) => key.length));
  lines.push(`${title}:`);
  for (const [key, value] of rows) lines.push(`  ${key.padEnd(width)}  ${value}`);
  lines.push('');
}

function helpHint(node, commandPath) {
  const name = ['lush', ...commandPath].join(' ');
  if (node.children) return `用 '${name} help <command>' 或 '${name} <command> -h' 查看某个子命令的完整用法。`;
  if (commandPath.length <= 1) return `用 'lush help' 查看全部命令；用 'lush help <command>' 查看同层命令。`;
  const parent = ['lush', ...commandPath.slice(0, -1)].join(' ');
  return `用 '${parent} help' 查看同层命令，用 'lush help' 查看全部命令。`;
}

export function renderHelp(node, commandPath) {
  const name = ['lush', ...commandPath].join(' ');
  const lines = [`${name} — ${node.summary}`, ''];
  pushList(lines, '覆盖范围', node.cover);
  pushRaw(lines, '用法', usageLines(node, commandPath));
  if (node.positionals) pushTable(lines, '位置参数', node.positionals);
  if (node.children) {
    const rows = Object.entries(node.children).map(([child, spec]) => [child, spec.summary]);
    rows.push(['help', '显示本层或指定子命令的帮助']);
    pushTable(lines, '子命令', rows);
  }
  pushTable(lines, '选项', optionRows(node));
  pushList(lines, '说明', node.notes);
  lines.push(helpHint(node, commandPath));
  return lines.join('\n');
}

export function renderHelpJson(node, commandPath) {
  return JSON.stringify({
    command: ['lush', ...commandPath].join(' '),
    summary: node.summary,
    cover: node.cover,
    usage: usageLines(node, commandPath),
    positionals: node.positionals?.map(([positional, description]) => ({ name: positional, description })),
    options: optionRows(node).map(([flag, description]) => ({ flag, description })),
    subcommands: node.children
      ? [...Object.entries(node.children).map(([child, spec]) => ({ name: child, summary: spec.summary })),
        { name: 'help', summary: '显示本层或指定子命令的帮助' }]
      : undefined,
    notes: node.notes,
  }, null, 2);
}

/** Resolve `lush [<group>] help [<command> ...]` into the node to render. */
export function helpRequest(json, node, commandPath, rest = []) {
  let target = node;
  let useJson = json;
  const targetPath = [...commandPath];
  for (const token of rest) {
    // `lush help --json service` and `lush service --json help` both work.
    if (token === '--json') {
      useJson = true;
      continue;
    }
    if (HELP_TOKENS.has(token)) continue;
    const child = target.children?.[token];
    if (child === undefined) {
      throw new UsageError(`argument command: invalid choice: '${token}'`
        + (target.children ? ` (choose from ${Object.keys(target.children).join(', ')})` : ''));
    }
    target = child;
    targetPath.push(token);
  }
  return { json: useJson, help: true, node: target, path: targetPath };
}
