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

/** `lush task inbox` text output: one line per queued / delivered input. */
export function formatTaskInbox(rows) {
  if (rows.length === 0) return '收件箱为空';
  return rows.map((row) => {
    const from = row.from_task_id === null ? 'Lush' : `task#${row.from_task_id}`;
    const delivered = row.delivered_at === null ? '未读' : `已投递 ${stamp(row.delivered_at)}`;
    if (row.kind === 'child_settled') {
      return `#${row.id} child_settled ${from} · ${row.data.status} · ${delivered}`;
    }
    if (row.kind === 'notice_settled') {
      return `#${row.id} notice_settled ${from} · notice#${row.data.notice_id} ${row.data.status} · ${delivered}`;
    }
    return `#${row.id} message ${from} · ${delivered} · ${shortValue(row.body, 80)}`;
  }).join('\n');
}

/** How one endpoint of a trace step is named: `#2 dev-task[3]`, or `Lush`. */
function traceEndpoint(taskId, service, sid) {
  if (taskId === null || taskId === undefined) return 'Lush';
  return service === null || service === undefined ? `#${taskId} sid ${sid}` : `#${taskId} ${service}[${sid}]`;
}

/** What a trace step is *about*: a delegated goal, a message body, an outcome. */
function traceDetail(entry) {
  const unread = entry.delivered_at === null && entry.kind !== 'delegated' ? '  (未读)' : '';
  if (entry.kind === 'delegated') return `"${shortValue(entry.goal ?? '', 60)}"`;
  if (entry.kind === 'message') return `${shortValue(entry.body ?? '', 80)}${unread}`;
  // A settled notice: the answer (or the dismissal reason) is what came back.
  if (entry.kind === 'notice_settled') {
    const answer = entry.result === null || entry.result === undefined
      ? ''
      : ` · ${shortValue(entry.result, 60)}`;
    return `notice#${entry.notice_id} ${entry.status}${answer}${unread}`;
  }
  const outcome = entry.status === 'completed'
    ? (entry.result === null || entry.result === undefined
      ? 'completed'
      : `completed · ${shortValue(entry.result, 60)}`)
    : `${entry.status}: ${shortValue(entry.error ?? '', 60)}`;
  return `${outcome}${unread}`;
}

/**
 * `lush task trace` text output: the subtree's collaboration timeline, oldest
 * step first, one line per step. This is the time-ordered companion of
 * `formatTaskTree` — the tree gives the shape, this gives who said what when.
 */
export function formatTaskTrace(result) {
  const head = `task #${result.task_id} · 调用链 ${result.entries.length} 步`
    + (result.truncated ? `（共 ${result.total} 步，只显示最近的 ${result.entries.length} 步）` : '');
  if (result.entries.length === 0) {
    return `${head}\n(这个 task 子树还没有与其他 task 的往来：派活 / 消息 / 结算都会出现在这里)`;
  }
  const lines = result.entries.map((entry) => {
    const edge = `${traceEndpoint(entry.from_task_id, entry.from_service, entry.from_sid)} → `
      + traceEndpoint(entry.to_task_id, entry.to_service, entry.to_sid);
    const detail = traceDetail(entry);
    return `${stamp(entry.at)}  ${entry.kind.padEnd(13)}  ${edge}  ${detail}`.trimEnd();
  });
  return [head, ...lines].join('\n');
}

/** `lush task message`: the message that was just queued. */
export function formatTaskMessage(row) {
  const from = row.from_task_id === null ? 'Lush' : `task#${row.from_task_id}`;
  return alignRows([
    ['inbox', `#${row.id}`],
    ['from', from],
    ['to', `task#${row.to_task_id}`],
    ['kind', row.kind],
    ['queued', stamp(row.created_at)],
  ]).concat(['', row.body]).join('\n');
}

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
    recent_calls = [], recent_events = [], recent_inbox = [], child_tasks = [], service = null, state, ...task
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
  if (recent_inbox.length === 0) {
    lines.push('inbox  (empty)');
  } else {
    lines.push(`inbox · recent ${recent_inbox.length}, newest first`);
    for (const row of recent_inbox) {
      const from = row.from_task_id === null ? 'Lush' : `task#${row.from_task_id}`;
      const delivered = row.delivered_at === null ? 'unread' : 'delivered';
      const detail = row.kind === 'child_settled'
        ? `child_settled · ${row.data.status}`
        : row.kind === 'notice_settled'
          ? `notice_settled · notice#${row.data.notice_id} ${row.data.status}`
          : `message · ${shortValue(row.body, 60)}`;
      lines.push(`  #${row.id} ${from} → ${detail} (${delivered})`);
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
 * `lush task construct` text output: which task was created and what it came
 * back with. The task id is printed first so the tree stays observably
 * addressable (`lush task tree <id>`), whatever the outcome.
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
  else if (task.status === 'running' || task.status === 'created' || task.status === 'waiting'
    || task.status === 'awaiting') {
    // "Not finished yet" has two flavours now: the agent is working, or the
    // task parked — on its children, or on a notice the user owes it.
    const state = task.status === 'awaiting'
      ? 'parked until the user settles a notice it reported'
      : task.status === 'waiting' ? 'parked on its child tasks' : 'still running';
    lines.push('(' + state + ' in the daemon; watch it with `lush task tree ' + task.id + '`)');
  }
  return lines.join('\n');
}

/** `lush task delete` text output: which task rows went, and how many of them. */
export function formatTaskRemoval(result) {
  const target = result.deleted.length === 1 ? `task #${result.task_id}` : `task #${result.task_id} (subtree ${result.deleted.join(', ')})`;
  return `deleted ${target}  tasks=${result.rows.tasks} task_events=${result.rows.task_events}`;
}
