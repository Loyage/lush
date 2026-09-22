import { check } from '../../core/types.js';
import { exact } from '../args.js';

function step(value) {
  const raw = String(value);
  const at = raw.indexOf(':');
  const key = (at === -1 ? raw : raw.slice(0, at)).trim();
  const label = (at === -1 ? raw : raw.slice(at + 1)).trim();
  check(key && label, 'progress steps use KEY[:LABEL]');
  return { key, label };
}

/** Agent-only progress reporting; task identity comes from LUSH_AGENT_TOKEN, never a CLI task id. */
export async function run(command, args, { client }) {
  const verb = args.shift();
  check(client.token, 'progress commands are available only inside a running Lush agent task');
  if (verb === 'plan') {
    check(args.length > 0, 'progress plan needs KEY[:LABEL] steps');
    return client.request('progress.plan', { steps: args.map(step) });
  }
  if (verb === 'complete') {
    exact(args, 1);
    return client.request('progress.complete', { step: args[0] });
  }
  check(false, 'unknown progress command; use progress plan or progress complete');
}
