/**
 * Human-readable output for the `process` verbs: history, inspect, view, one
 * agent, one lifecycle change, the agent table, the orphan pool, the pi session
 * and the dry-run command line.
 */
import { shellEnv, shellQuote } from '../../shell.js';
import { RESERVED_VARIABLES } from '../../core/variables.js';
import {
  alignRows, duration, eventLine, excerpt, indentLines, metadataTitle, objectLines, shortValue,
  stamp, taskDetail, taskMetadataTitle, taskTitle, variableSummary,
} from './primitives.js';

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

/** `lush task agents show AGENT_ID`: runtime facts, on-disk session, durable call. */
export function formatAgent(result) {
  const mode = result.interactive ? 'tty' : result.os_pid === null ? 'in-process' : 'pipe';
  const rows = [
    ['task', `#${result.task_id}${result.task_status === null ? '' : ` (${result.task_status})`}`],
    ['pid', `${result.pid}${result.name === null ? '' : ` (${result.name})`}`],
    ['provider', result.provider],
    ['status', result.status],
    ['call', `#${result.call_id}`],
    ['os-pid', result.os_pid === null ? '-' : String(result.os_pid)],
    ['mode', mode],
    ['started', stamp(result.started_at)],
    ['ended', result.ended_at === null ? '-' : stamp(result.ended_at)],
    ['elapsed', duration(result.elapsed_ms)],
  ];
  if (result.error !== null) rows.push(['error', result.error]);
  const lines = [`agent ${result.id}`, ...alignRows(rows).map((row) => `  ${row}`)];

  if (result.session) {
    lines.push('', 'session', ...alignRows([
      ['dir', result.session.session_dir],
      ['id', result.session.session_id],
      ['file', result.session.file ?? '(none yet)'],
    ]).map((row) => `  ${row}`));
  }
  if (result.call) {
    const call = result.call;
    const window = call.finished_at === null ? 'running' : `→ ${stamp(call.finished_at)}`;
    lines.push('', `call #${call.id} · ${call.status} · ${stamp(call.started_at)} ${window}`);
    for (const key of ['prompt', 'output', 'error']) {
      if (call[key]) lines.push(`  ${key}`, ...indentLines(call[key], 2));
    }
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

/** `lush task agents list` text output: one row per live (or kept) worker. */
export function formatAgents(rows) {
  if (rows.length === 0) return 'no running agents';
  const table = [['AGENT', 'TASK', 'PID', 'NAME', 'PROVIDER', 'STATUS', 'CALL', 'OS-PID', 'ELAPSED', 'MODE']];
  for (const agent of rows) {
    const mode = agent.interactive ? 'tty' : agent.os_pid === null ? 'in-process' : 'pipe';
    table.push([agent.id, `#${agent.task_id}`, String(agent.pid), agent.name, agent.provider, agent.status,
      String(agent.call_id), agent.os_pid === null ? '-' : String(agent.os_pid), duration(agent.elapsed_ms), mode]);
  }
  const width = table[0].map((_column, index) => Math.max(...table.map((row) => row[index].length)));
  return table.map((row) => row.map((cell, index) => cell.padEnd(width[index])).join('  ').trimEnd()).join('\n');
}

/** `lush task agents kill` text output: what died, and how the OS side fared. */
export function formatAgentKill(result) {
  const who = `agent ${result.id}`;
  if (result.outcome === 'killed') return `killed ${who} (os ${result.os_pid})`;
  if (result.outcome === 'gone') {
    return `killed ${who} (os ${result.os_pid} was already gone; call interrupted)`;
  }
  // No OS pid: either an in-process provider (the abort settles it right here)
  // or an interactive agent whose terminal has not reported its pi yet.
  if (result.interactive) {
    return `cancellation requested for ${who} (no OS pid reported yet; its terminal still owns that pi)`;
  }
  return `killed ${who} (in-process provider; call interrupted)`;
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

/** `lush task session` text output: where the agent session lives and how to open it. */
export function formatSession(result) {
  if (result.agent !== 'pi' || result.session_dir === null) {
    return `# agent ${result.agent} runs in-process; no external session to inspect.`;
  }
  const rows = [
    ['task', `#${result.task_id} (${result.task_status})`],
    ['process', `${result.name}[${result.pid}]`],
    ['agent', result.agent],
    ['profile', result.profile ?? 'default'],
    ['session-dir', result.session_dir],
    ['session-id', result.session_id],
    ['file', result.file ?? '(none yet)'],
    ['cwd', result.cwd],
  ];
  if (result.busy) rows.push(['busy', 'yes — a call is running; opening the session now may interleave writes']);
  rows.push(['browse', formatRun({ ...result, command: result.browse_command })]);
  const width = Math.max(...rows.map(([key]) => key.length));
  return rows.map(([key, value]) => `${key.padEnd(width)}  ${value}`).join('\n');
}

/** `cd <cwd> && ENV=... <command>` — shell line that runs `result.command`. */
export function formatRun(result) {
  const prefix = [
    result.path_prefix === undefined ? '' : `PATH=${shellQuote(result.path_prefix)}:$PATH`,
    shellEnv(result.env ?? {}),
  ].filter((part) => part !== '').join(' ');
  const parts = [];
  if (result.cwd !== null && result.cwd !== undefined) parts.push(`cd ${shellQuote(result.cwd)}`);
  parts.push(prefix === '' ? result.command : `${prefix} ${result.command}`);
  return parts.join(' && ');
}

/** `lush call --dry-run` text output: the runnable command, or what would be sent. */
export function formatDryRun(result) {
  if (typeof result.command !== 'string') {
    return `# agent ${result.agent} runs in-process; no external command. Use --json for the invocation details.`;
  }
  return formatRun(result);
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

/** One task line: `#12 project[3] running · goal`. Shared by list and inspect. */
export function taskLine(task, processName = null) {
  const where = processName === null ? `pid ${task.pid}` : `${processName}[${task.pid}]`;
  return `#${task.id} ${where} ${task.status} · ${shortValue(task.goal, 60)}`;
}

/** `lush task list` text output: fixed-width columns, one row per task. */
export function formatTaskList(result) {
  const table = [['ID', 'PID', 'PARENT', 'STATUS', 'GOAL', 'RESULT']];
  for (const task of result) {
    table.push([
      `#${task.id}`,
      String(task.pid),
      task.parent_task_id === null ? '-' : `#${task.parent_task_id}`,
      task.status,
      shortValue(task.goal, 60),
      task.result === null || task.result === undefined ? '-' : shortValue(task.result, 40),
    ]);
  }
  const width = table[0].map((_column, index) => Math.max(...table.map((row) => row[index].length)));
  return table.map((row) => row.map((cell, index) => cell.padEnd(width[index])).join('  ').trimEnd()).join('\n');
}

/**
 * `lush task tree` text output: the task and everything it delegated, one
 * branch per child task. This is the view of "how one piece of work was solved
 * by cooperation between processes".
 */
export function formatTaskTree(node, processName = null) {
  const lines = [];
  const walk = (task, prefix, branch) => {
    const name = task.process_name ?? processName;
    const where = name === null || name === undefined ? `pid ${task.pid}` : `${name}[${task.pid}]`;
    const result = task.result === null || task.result === undefined ? '' : ` → ${shortValue(task.result, 50)}`;
    const error = task.status === 'failed' || task.status === 'cancelled'
      ? ` (${shortValue(task.error ?? task.status, 50)})`
      : '';
    lines.push(`${prefix}${branch}#${task.id} ${where} ${task.status} · ${shortValue(task.goal, 60)}${result}${error}`);
    const children = task.children ?? [];
    const nextPrefix = prefix + (branch === '└── ' ? '    ' : branch === '' ? '' : '│   ');
    children.forEach((child, index) => {
      walk(child, nextPrefix, index === children.length - 1 ? '└── ' : '├── ');
    });
  };
  walk(node, '', '');
  return lines.join('\n');
}

/**
 * `lush task inspect` text output: the task summary, the process it is mounted
 * on, its child tasks, then calls and events. The task's own scratch state is a
 * block, not a table cell.
 */
export function formatTaskInspect(result) {
  const {
    recent_calls = [], recent_events = [], child_tasks = [], process = null, state, ...task
  } = result;
  const rows = [
    ['process', process === null ? `pid ${task.pid}` : `${process.name}[${process.pid}] · ${process.template} · ${process.status}`],
    ['parent task', task.parent_task_id === null ? '-' : `#${task.parent_task_id}`],
    ['root task', `#${task.root_task_id}`],
    ['goal', task.goal],
    ['created', stamp(task.created_at)],
    ['started', task.started_at === null ? '-' : stamp(task.started_at)],
    ['finished', task.finished_at === null ? '-' : stamp(task.finished_at)],
  ];
  if (task.error !== null && task.error !== undefined) rows.push(['error', task.error]);
  const lines = [taskMetadataTitle(task, process?.name ?? null), ...alignRows(rows).map((row) => `  ${row}`)];

  if (task.result !== null && task.result !== undefined) {
    lines.push('', 'result', ...indentLines(excerpt(String(task.result), 4000), 1));
  }

  lines.push('');
  if (Object.keys(state ?? {}).length === 0) {
    lines.push('state  (empty)');
  } else {
    lines.push('state', ...objectLines(state, 1));
  }

  lines.push('');
  if (child_tasks.length === 0) {
    lines.push('child tasks  (none)');
  } else {
    lines.push(`child tasks · ${child_tasks.length}`);
    for (const child of child_tasks) lines.push(`  ${taskLine(child)}`);
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
  return lines.join('\n');
}

/** `lush task result` text output: the conclusion, or an explicit "not finished". */
export function formatTaskResult(result) {
  if (!result.finished) return `task #${result.id} is ${result.status} (not finished yet; use 'lush task wait ${result.id}')`;
  const head = `task #${result.id} ${result.status}`;
  if (result.error !== null && result.error !== undefined) return `${head}\n  error: ${result.error}`;
  if (result.result === null || result.result === undefined) return `${head}\n  (no result)`;
  return `${head}\n  ${typeof result.result === 'string' ? result.result : JSON.stringify(result.result)}`;
}

/**
 * `lush call` text output: which task was created and what it came back with.
 * The task id is printed first so the tree stays observably addressable
 * (`lush task tree <id>`), whatever the outcome.
 */
export function formatCall(result) {
  const task = result.task ?? result;
  const where = result.process === undefined || result.process === null
    ? `pid ${task.pid}`
    : `${result.process.name}[${task.pid}]`;
  const head = `task #${task.id} ${where} ${task.status}`;
  const lines = [head];
  if (task.error !== null && task.error !== undefined) lines.push(`error: ${excerpt(String(task.error), 4000)}`);
  else if (task.result !== null && task.result !== undefined) lines.push(excerpt(String(task.result), 20000));
  else if (task.status === 'running' || task.status === 'created' || task.status === 'waiting') {
    lines.push('(still running in the daemon; watch it with `lush task tree ' + task.id + '`)');
  }
  return lines.join('\n');
}

/** `lush task delete` text output: which task rows went, and how many of them. */
export function formatTaskRemoval(result) {
  const target = result.deleted.length === 1 ? `task #${result.task_id}` : `task #${result.task_id} (subtree ${result.deleted.join(', ')})`;
  return `deleted ${target}  tasks=${result.rows.tasks} task_events=${result.rows.task_events}`;
}
