/**
 * The runtime side of the text output: one agent (`task agents show`), the
 * agent table (`task agents list`), a kill outcome, a pi session and the
 * runnable command line behind `--dry-run` / `task session --open`.
 *
 * These render things that are *running* (or that were handed to a terminal),
 * as opposed to the durable records in `inspect.js`.
 */
import { shellEnv, shellQuote } from '../../../shell.js';
import { alignRows, duration, indentLines, stamp } from '../primitives.js';

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
