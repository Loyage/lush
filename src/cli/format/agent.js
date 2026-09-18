/**
 * `lush agent ...` in text mode. Profiles are configuration, so the output is
 * the same shape everywhere: aligned fields for one profile, a table for many.
 * Everything it prints is also in `--json`; text is for reading.
 */
import { alignRows, shortValue } from './primitives.js';

function renderTable(header, rows) {
  const table = [header, ...rows];
  const width = header.map((_column, index) => Math.max(...table.map((row) => String(row[index]).length)));
  return table
    .map((row) => row.map((cell, index) => String(cell).padEnd(width[index])).join('  ').trimEnd())
    .join('\n');
}

function pluginCell(row) {
  if (!row.valid) return '-';
  if (row.plugins === true) return 'plugins';
  const flags = (row.flags ?? []).length ? ` +${row.flags.length} flag` : '';
  return `pure${flags}`;
}

function sourceCell(row) {
  return row.source === 'builtin' ? 'builtin' : 'file';
}

export function formatAgentList(result) {
  if (result.agents.length === 0) return '# no agent profiles (the built-in default is always available)';
  const rows = result.agents.map((row) => [
    row.name,
    row.valid ? row.provider : '-',
    row.valid ? row.command : '-',
    row.valid && row.model !== '' ? row.model : '-',
    pluginCell(row),
    row.default ? 'yes' : '',
    sourceCell(row),
    row.path,
  ]);
  const lines = [renderTable(['NAME', 'PROVIDER', 'COMMAND', 'MODEL', 'PLUGINS', 'DEFAULT', 'SOURCE', 'PATH'], rows)];
  for (const row of result.agents) {
    if (!row.valid) lines.push(`  ! ${row.name}: ${row.error}`);
  }
  lines.push('');
  lines.push(`dir ${result.dir}`);
  return lines.join('\n');
}

function pluginLine(result) {
  if (result.plugins === true) return 'plugins (pi defaults; nothing disabled)';
  const flags = result.plugin_flags ?? [];
  const extra = (result.flags ?? []).length ? `, plus ${result.flags.length} extra flag(s)` : '';
  return `pure (${flags.join(' ')}${extra})`;
}

export function formatAgentInspect(result) {
  const lines = [`agent ${result.name}${result.default ? ' (default)' : ''} · ${result.source} · ${result.path}`];
  if (!result.valid) {
    lines.push('', 'validation  FAILED');
    for (const error of result.errors ?? []) lines.push(`  ${error}`);
    lines.push('', `# fix ${result.path} by hand, or rewrite it with 'lush agent edit ${result.name} ...'`);
    return lines.join('\n');
  }
  const rows = [
    ['provider', result.provider],
    ['command', result.command],
    ['model', result.model === '' ? '-' : result.model],
    ['pi-provider', result.pi_provider === '' ? '-' : result.pi_provider],
    ['plugins', pluginLine(result)],
    ['flags', (result.flags ?? []).length ? result.flags.join(' ') : '(none)'],
    ['description', result.description === '' ? '-' : result.description],
    ['declared', (() => {
      const declared = Object.entries(result.declared ?? {}).map(([key, value]) => `${key}=${shortValue(value)}`);
      return declared.length ? declared.join(' ') : '(nothing: built-in default)';
    })()],
    ['validation', `ok${result.present ? '' : ' (built-in; no override file)'}`],
  ];
  lines.push(...alignRows(rows).map((row) => `  ${row}`));
  lines.push('');
  // The placeholder LUSH_CONTEXT payload contains a newline; keep the preview on
  // one readable line.
  const oneLine = (value) => String(value).replaceAll('\n', '\\n');
  if (result.preview_error !== null && result.preview_error !== undefined) {
    lines.push(`argv  (unavailable: ${result.preview_error})`);
  } else {
    lines.push(`argv  ${oneLine((result.preview.argv ?? []).join(' '))}`);
    lines.push(`run   ${oneLine(result.preview.command)}`);
  }
  return lines.join('\n');
}

export function formatAgentWrite(result) {
  const action = result.action === 'add' ? (result.overwrote ? 'overwrote' : 'added') : 'edited';
  const created = result.action === 'edit' && result.created ? ' (created)' : '';
  const fields = Object.entries(result.profile ?? {}).map(([key, value]) => `${key}=${shortValue(value)}`);
  return [`${action} agent ${result.name}${created}`, `  path     ${result.path}`,
    `  profile  ${fields.length ? fields.join(' ') : '(empty)'}`].join('\n');
}

export function formatAgentDelete(result) {
  return `deleted agent ${result.name}\n  path     ${result.path}`;
}

export function formatAgentDefault(result) {
  if (result.copied_from === null) {
    return `# default agent (effective)\n${formatAgentInspect({ ...result, name: result.name })}`;
  }
  return `default agent now matches ${result.copied_from}\n  path     ${result.path}`;
}

export function formatAgentPath(result) {
  return result.dir;
}

/** Route one `lush agent ...` result by its action. */
export function formatAgentCommand(action, result) {
  if (action === 'agent_list') return formatAgentList(result);
  if (action === 'agent_inspect') return formatAgentInspect(result);
  if (action === 'agent_add' || action === 'agent_edit') return formatAgentWrite(result);
  if (action === 'agent_delete') return formatAgentDelete(result);
  if (action === 'agent_default') return formatAgentDefault(result);
  if (action === 'agent_path') return formatAgentPath(result);
  return JSON.stringify(result, null, 2);
}
