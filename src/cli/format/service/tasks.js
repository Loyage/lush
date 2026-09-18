/**
 * The task side of the text output: one task line, the list table, the
 * delegation tree, one task's inspect block, its result, the `call` outcome and
 * the task-removal one-liner.
 *
 * `taskLine` is exported because the service side reuses it: a service's
 * `inspect` lists the tasks mounted on it with exactly this line.
 */
import {
  alignRows, eventLine, excerpt, indentLines, objectLines, shortValue, stamp, taskMetadataTitle,
} from '../primitives.js';

/** One task line: `#12 project[3] running · goal`. Shared by list and inspect. */
export function taskLine(task, serviceName = null) {
  const where = serviceName === null ? `sid ${task.sid}` : `${serviceName}[${task.sid}]`;
  return `#${task.id} ${where} ${task.status} · ${shortValue(task.goal, 60)}`;
}

/** `lush task list` text output: fixed-width columns, one row per task. */
export function formatTaskList(result) {
  const table = [['ID', 'SID', 'PARENT', 'STATUS', 'GOAL', 'RESULT']];
  for (const task of result) {
    table.push([
      `#${task.id}`,
      String(task.sid),
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
 * by cooperation between services".
 */
export function formatTaskTree(node, serviceName = null) {
  const lines = [];
  const walk = (task, prefix, branch) => {
    const name = task.service_name ?? serviceName;
    const where = name === null || name === undefined ? `sid ${task.sid}` : `${name}[${task.sid}]`;
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
 * `lush task inspect` text output: the task summary, the service it is mounted
 * on, its child tasks, then calls and events. The task's own scratch state is a
 * block, not a table cell.
 */
export function formatTaskInspect(result) {
  const {
    recent_calls = [], recent_events = [], child_tasks = [], service = null, state, ...task
  } = result;
  const rows = [
    ['service', service === null ? `sid ${task.sid}` : `${service.name}[${service.sid}] · ${service.template} · ${service.status}`],
    ['parent task', task.parent_task_id === null ? '-' : `#${task.parent_task_id}`],
    ['root task', `#${task.root_task_id}`],
    ['goal', task.goal],
    ['created', stamp(task.created_at)],
    ['started', task.started_at === null ? '-' : stamp(task.started_at)],
    ['finished', task.finished_at === null ? '-' : stamp(task.finished_at)],
  ];
  if (task.error !== null && task.error !== undefined) rows.push(['error', task.error]);
  const lines = [taskMetadataTitle(task, service?.name ?? null), ...alignRows(rows).map((row) => `  ${row}`)];

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
  const where = result.service === undefined || result.service === null
    ? `sid ${task.sid}`
    : `${result.service.name}[${task.sid}]`;
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
