import { check } from '../../core/types.js';
import { exact, option } from '../args.js';

const TARGETS = new Set(['default', 'planner', 'coordinator', 'worker', 'research', 'verifier', 'merger']);

export async function run(command, args, { client }) {
  check(!client.token, 'agents cannot change Agent configuration');
  const verb = args.shift() || 'show';
  if (verb === 'show') { exact(args, 0); return client.request('agent.config'); }
  if (verb === 'models') {
    exact(args, 1);
    check(['pi', 'codex'].includes(args[0]), 'agent models requires pi or codex');
    return client.request('agent.models', { agent: args[0] });
  }

  const current = await client.request('agent.config');
  if (verb === 'reset') {
    exact(args, 1);
    const role = args[0];
    check(role !== 'default' && TARGETS.has(role), 'agent reset requires a role');
    const roles = { ...current.roles }; delete roles[role];
    return client.request('agent.configure', { config: { version: 1, default: current.default, roles } });
  }

  check(verb === 'set', 'agent expects show, models, set or reset');
  const target = args.shift();
  check(TARGETS.has(target), 'agent set target must be default or a task role');
  const supplied = name => args.includes(name);
  const hasAgent = supplied('--agent'), hasModel = supplied('--model'), hasThinking = supplied('--thinking');
  const hasDefaultPrompt = supplied('--default-prompt');
  const hasExplicitAppend = supplied('--append-prompt'), hasLegacyPrompt = supplied('--prompt');
  const hasAppendPrompt = hasExplicitAppend || hasLegacyPrompt;
  check(!(hasExplicitAppend && hasLegacyPrompt), 'use either --append-prompt or the legacy --prompt alias');
  const backend = option(args, '--agent');
  const model = option(args, '--model');
  const thinking = option(args, '--thinking');
  const defaultPrompt = option(args, '--default-prompt');
  const appendPrompt = hasExplicitAppend ? option(args, '--append-prompt') : option(args, '--prompt');
  exact(args, 0);
  check(hasAgent || hasModel || hasThinking || hasDefaultPrompt || hasAppendPrompt, 'agent set requires at least one setting');
  const base = target === 'default' ? current.default : (current.roles[target] || current.resolved[target]);
  const next = { ...base };
  if (hasAgent) next.agent = backend;
  if (hasModel) next.model = model;
  if (hasThinking) next.thinking = thinking;
  if (hasDefaultPrompt) next.default_prompt = defaultPrompt;
  if (hasAppendPrompt) next.append_prompt = appendPrompt;
  // Switching backend without explicitly choosing its model/thinking must not carry incompatible values across CLIs.
  if (hasAgent && backend !== base.agent) {
    if (!hasModel) next.model = '';
    if (!hasThinking) next.thinking = '';
  }
  const roles = { ...current.roles };
  if (target === 'default') return client.request('agent.configure', { config: { version: 1, default: next, roles } });
  roles[target] = next;
  return client.request('agent.configure', { config: { version: 1, default: current.default, roles } });
}
