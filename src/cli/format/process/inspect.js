/**
 * The process side of the text output: `history`, `inspect`, `inspect --with`,
 * `list`, the lifecycle one-liners, removal reports and the orphan pool.
 *
 * What these have in common is that they render a *node* — its metadata, its
 * Context, its recent calls and events, its tasks — never a running agent (that
 * is `agents.js`) and never a task on its own (that is `tasks.js`).
 */
import { RESERVED_VARIABLES } from '../../../core/variables.js';
import {
  alignRows, duration, eventLine, excerpt, indentLines, metadataTitle, objectLines, shortValue,
  stamp, taskDetail, taskTitle, variableSummary,
} from '../primitives.js';
// A process's own `inspect` lists the tasks mounted on it with the task side's line.
import { taskLine } from './tasks.js';

/**
 * `lush task history` text output: one block per message, body verbatim so
 * long agent replies stay readable, then the pagination cursor. Roles are the
 * stored Chat-Completions ones (user / assistant / tool).
 */
export function formatHistory(result) {
  const lines = [];
  for (const message of result.messages) {
    const body = message.body ?? {};
    const tool = body.role === 'tool' && body.tool_call_id ? ` · ${body.tool_call_id}` : '';
    lines.push(`#${message.id} ${body.role} · ${stamp(message.created_at)} · call ${message.call_id}${tool}`);
    const content = typeof body.content === 'string' && body.content !== '' ? body.content.split('\n') : [];
    const calls = (body.tool_calls ?? []).map((call) => `→ ${call.function.name} ${call.function.arguments}`);
    lines.push(...(content.length || calls.length ? [...content, ...calls] : ['(empty)']), '');
  }
  if (result.messages.length === 0) lines.push('(no messages)');
  lines.push(`(${result.messages.length} messages · next --after ${result.next_after})`);
  return lines.join('\n');
}

/**
 * `lush process inspect` text output: process summary, then context, recent
 * calls and recent events. The creation-time `template_snapshot` and the
 * variable declarations stay in `--json` — they are reference material, not
 * something to read at a glance. The task's `title` gets a row and a long
 * `detail` gets its own block (truncated in text; `--json` has it whole).
 */
export function formatInspect(result) {
  const {
    context = {}, recent_calls = [], recent_events = [], recent_tasks = [], template_snapshot, variables, ...process
  } = result;
  const parent = process.parent_pid === null
    ? '-'
    : `${process.parent_pid}${process.original_parent_pid === process.parent_pid ? '' : ` (original ${process.original_parent_pid})`}`;
  // `variables` was destructured out of `process` above; the reserved task
  // fields live there.
  const fields = { variables };
  const title = taskTitle(fields);
  const rows = [
    ['template', process.template],
    ['parent', parent],
    ['goal', process.goal ?? '-'],
    ...(title === null ? [] : [['title', title]]),
    ['created', stamp(process.created_at)],
    ['updated', stamp(process.updated_at)],
    ['children', process.children?.length ? process.children.join(', ') : '(none)'],
  ];
  // `name` is the process name above, `title` and `detail` are shown in full
  // right here: only the variables with no rendering of their own remain.
  const declared = variableSummary(variables, {
    omit: [RESERVED_VARIABLES.processName, RESERVED_VARIABLES.headline, RESERVED_VARIABLES.body],
  });
  if (declared) rows.push(['variables', declared]);
  if (process.agent) {
    const profile = process.agent.profile ? ` · agent ${process.agent.profile}` : '';
    const broken = process.agent.profile_error ? ` (${process.agent.profile_error})` : '';
    rows.push(['agent', `${process.agent.status} · ${process.agent.provider}${profile}${broken}`]);
  }
  const lines = [metadataTitle(process), ...alignRows(rows).map((row) => `  ${row}`)];

  // A task body can be long and multi-line: it gets a block of its own rather
  // than a table cell that would break the alignment.
  const detail = taskDetail(fields);
  if (detail !== null) lines.push('', 'detail', ...indentLines(excerpt(detail, 4000), 1));

  lines.push('');
  if (recent_tasks.length === 0) {
    lines.push('tasks  (none)');
  } else {
    lines.push(`tasks · recent ${recent_tasks.length}, newest first`);
    for (const task of recent_tasks) lines.push(`  ${taskLine(task)}`);
  }

  lines.push('', `context · ${context.message_count ?? 0} messages`);
  const state = context.state ?? {};
  lines.push(...(Object.keys(state).length ? ['  state', ...objectLines(state, 2)] : ['  state  (empty)']));
  if (context.system_prompt) lines.push('  system_prompt', ...indentLines(context.system_prompt, 2));
  for (const key of ['artifacts', 'references']) {
    if (context[key]?.length) lines.push(`  ${key}`, ...indentLines(JSON.stringify(context[key], null, 2), 2));
  }

  lines.push('');
  if (recent_calls.length === 0) {
    lines.push('calls  (none)');
  } else {
    lines.push(`calls · recent ${recent_calls.length}, newest first`);
    for (const call of recent_calls) {
      const window = call.finished_at === null
        ? `since ${stamp(call.started_at)}`
        : `${stamp(call.started_at)} → ${stamp(call.finished_at)}`;
      lines.push(`  #${call.id} ${call.status} · ${window}`);
      for (const key of ['prompt', 'output', 'error']) {
        if (call[key]) lines.push(`    ${key}`, ...indentLines(call[key], 3));
      }
    }
  }

  lines.push('');
  if (recent_events.length === 0) {
    lines.push('events  (none)');
  } else {
    lines.push(`events · recent ${recent_events.length}, newest first`);
    for (const event of recent_events) lines.push(eventLine(event));
  }

  if (template_snapshot !== undefined) {
    lines.push('', `# --json has the full snapshot, including template_snapshot and variable declarations`);
  }
  return lines.join('\n');
}

/** `lush process inspect --with ...`: the sections that were requested, in order. */
export function formatView(result) {
  const lines = [`pid ${result.pid}`];
  if ('parent' in result) {
    lines.push('', 'parent', `  ${result.parent === null ? '(none)' : metadataTitle(result.parent)}`);
  }
  if ('children' in result) {
    lines.push('', 'children', ...(result.children.length
      ? result.children.map((child) => `  ${metadataTitle(child)}`)
      : ['  (none)']));
  }
  if ('call_prompt' in result) {
    lines.push('', 'call_prompt', ...indentLines(result.call_prompt ?? '(none)', 1));
  }
  return lines.join('\n');
}

/**
 * `start` / `stop` (and the task verbs) text output: the verb plus the
 * resulting state of the row, instead of dumping the whole metadata row.
 */
export function formatLifecycle(verb, result) {
  return `${verb} ${metadataTitle(result)}`;
}

/** `lush process orphans` text output: the pool, or what one sweep just froze. */
export function formatOrphans(result) {
  // A sweep report is the only shape that carries `evicted`; the read model has
  // `orphans`. Both stay JSON under --json.
  if (Array.isArray(result.evicted)) {
    const lines = [
      `trigger=${result.trigger} checked=${result.checked}`
      + ` active ${result.active_before}->${result.active_after}`
      + ` evicted=${result.evicted.length} deferred=${result.deferred.length}`
      + ` (limit=${result.limit} ttl=${result.ttl_seconds}s)`,
    ];
    for (const orphan of result.evicted) {
      lines.push(`  evicted ${orphan.pid} ${orphan.from}->${orphan.to}`
        + ` reason=${orphan.reason} idle=${orphan.idle_seconds}s ${orphan.name}`);
    }
    for (const orphan of result.deferred) {
      lines.push(`  deferred ${orphan.pid} reason=${orphan.reason} (a busy orphan with a running call is never frozen)`);
    }
    return lines.join('\n');
  }
  const { policy } = result;
  const lines = [
    `policy adopt=${policy.adopt} limit=${policy.limit} ttl=${policy.ttl_seconds}s sweep=${policy.sweep_seconds}s`,
    `orphans active=${result.active_count} busy=${result.busy_count} over_limit=${result.over_limit}`,
  ];
  if (result.orphans.length === 0) {
    lines.push('  (none — nothing is currently adopted by PID 0)');
    return lines.join('\n');
  }
  const table = [['PID', 'STATUS', 'IDLE', 'BUSY', 'NAME']];
  for (const orphan of result.orphans) {
    table.push([String(orphan.pid), orphan.status,
      duration(orphan.idle_seconds * 1000), orphan.busy ? 'yes' : 'no', orphan.name]);
  }
  const width = table[0].map((_column, index) => Math.max(...table.map((row) => row[index].length)));
  for (const row of table) lines.push(`  ${row.map((cell, index) => cell.padEnd(width[index])).join('  ').trimEnd()}`);
  return lines.join('\n');
}

/**
 * `lush process list` text output: fixed-width columns, one row per process.
 * The trailing TITLE column is the one-line summary a template may declare (a
 * reserved variable name, see `core/variables.js`): every existing column keeps
 * its width, and a process without a title — only dev-task declares one — shows
 * `-` instead.
 */
export function formatList(result) {
  const rows = [['PID', 'PPID', 'STATUS', 'NAME', 'TITLE']];
  for (const process of result) {
    const title = taskTitle(process);
    rows.push([String(process.pid), process.parent_pid === null ? '-' : String(process.parent_pid),
      process.status, process.name, title === null ? '-' : shortValue(title, 40)]);
  }
  const nameWidth = rows.reduce((max, row) => Math.max(max, row[3].length), 0);
  return rows
    .map(([pid, ppid, status, name, title]) => `${pid.padEnd(6)}${ppid.padEnd(6)}${status.padEnd(10)}${name.padEnd(nameWidth)}  ${title}`.trimEnd())
    .join('\n');
}

/**
 * `lush process delete|purge` text output: what disappeared, which tasks had to
 * be cancelled first, and how much of the record went with it.
 */
export function formatRemoval(result) {
  const target = result.deleted.length === 1
    ? `pid ${result.pid}`
    : `pid ${result.pid} (subtree ${result.deleted.join(', ')})`;
  const cancelled = result.cancelled?.length ? `, after cancelling task ${result.cancelled.join(', ')}` : '';
  const terminated = result.terminated.length
    ? `, after stopping ${result.terminated.join(', ')}`
    : '';
  const rows = Object.entries(result.rows).map(([table, count]) => `${table}=${count}`).join(' ');
  return `deleted ${target}${cancelled}${terminated}  ${rows}`;
}
