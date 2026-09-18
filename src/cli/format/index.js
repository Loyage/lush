/**
 * The text renderer: `format(args, result)` picks the formatter for the command
 * that produced `result`. `--json` short-circuits everything to the raw payload.
 *
 * This module is also the barrel every formatter is re-exported from, so
 * `src/cli/main.js` can keep its historical export surface.
 */
import { objectLines, shortValue, treeLines } from './primitives.js';
import { formatAgentCommand } from './agent.js';
import { formatDaemon } from './daemon.js';
import {
  formatAgent, formatAgentKill, formatAgents, formatCall, formatDryRun, formatHistory, formatInspect, formatLifecycle,
  formatList, formatOrphans, formatRemoval, formatSession, formatTaskInspect, formatTaskList, formatTaskRemoval,
  formatTaskResult, formatTaskTree, formatView,
} from './service.js';

export * from './primitives.js';
export * from './service.js';
export { formatAgentCommand } from './agent.js';
export { formatDaemon } from './daemon.js';

/** Lifecycle commands that answer with the updated row. */
const LIFECYCLE_VERBS = {
  start: 'started',
  stop: 'stopped',
  task_complete: 'completed task',
  task_cancel: 'cancelled task',
};

export function format(args, result) {
  if (args.json) return JSON.stringify(result, null, 2);
  // `agent` is the one local command group: its result carries the action, not
  // an RPC payload.
  if (typeof args.command === 'string' && args.command.startsWith('agent_')) {
    return formatAgentCommand(args.command, result);
  }
  // `daemon start|stop|restart` (command `daemon`) and `daemon status` (command `status`)
  // all report identity in `cli`, so they share the aligned line format.
  if (args.command === 'daemon' || args.command === 'status') return formatDaemon(result);
  if (args.command === 'call') return result.dry_run ? formatDryRun(result) : formatCall(result);
  if (args.command === 'spawn') return `SID ${result.sid}`;
  if (args.command === 'tree') return treeLines(result, { agents: args.agents !== false }).join('\n');
  if (args.command === 'children' || args.command === 'list') return formatList(result);
  if (args.command === 'orphans') return formatOrphans(result);
  if (args.command === 'inspect') return args.sections ? formatView(result) : formatInspect(result);
  if (args.command === 'task_list') return formatTaskList(result);
  if (args.command === 'task_tree') return formatTaskTree(result);
  if (args.command === 'task_inspect' || args.command === 'task_wait') return formatTaskInspect(result);
  if (args.command === 'task_result') return formatTaskResult(result);
  if (args.command === 'task_spawn') return formatCall(result);
  if (args.command === 'task_delete') return formatTaskRemoval(result);
  if (args.command === 'task_update_state') return objectLines(result).join('\n');
  if (args.command === 'task_history') return formatHistory(result);
  if (args.command === 'task_session' || args.command === 'task_attach') return formatSession(result);
  if (args.command === 'task_agents_list') return formatAgents(result);
  if (args.command === 'task_agents_show') return formatAgent(result);
  if (args.command === 'task_agents_kill') return formatAgentKill(result);
  // Variables are few and scalar-ish: one `key=value` line each is easier to
  // read than a JSON blob, and `--json` still gives the merged object.
  if (args.command === 'update-vars') {
    return Object.entries(result).map(([key, value]) => `${key}=${shortValue(value)}`).join('\n');
  }
  if (args.command === 'update-state') return objectLines(result).join('\n');
  if (LIFECYCLE_VERBS[args.command]) return formatLifecycle(LIFECYCLE_VERBS[args.command], result);
  if (args.command === 'delete' || args.command === 'purge') return formatRemoval(result);
  return JSON.stringify(result, null, 2);
}
