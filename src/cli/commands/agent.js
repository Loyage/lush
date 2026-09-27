import fs from 'node:fs';
import path from 'node:path';
import { check } from '../../core/types.js';
import { AGENT_ROLES, agentPrompt } from '../../agent/prompts.js';
import { agentEnvironment } from '../../agent/environment.js';
import { AgentSettings } from '../../agent/settings.js';
import { exact, option } from '../args.js';

const TARGETS = new Set(['default', ...AGENT_ROLES]);

function role(value) {
  check(AGENT_ROLES.includes(value), `role must be one of ${AGENT_ROLES.join(', ')}`);
  return value;
}

function init(config, args) {
  const localIndex = args.indexOf('--local');
  const local = localIndex !== -1;
  if (local) args.splice(localIndex, 1);
  check(args.length <= 1, 'agent init accepts at most one role');
  const selectedRole = args.length ? role(args[0]) : null;
  const dir = local ? path.join(config.home, 'agent') : path.join(config.project, '.lush-agent');
  fs.mkdirSync(dir, { recursive: true, mode: local ? 0o700 : 0o755 });
  const files = [path.join(dir, 'common.md')];
  if (selectedRole) files.push(path.join(dir, `${selectedRole}.md`));
  const created = [], existing = [];
  for (const file of files) {
    if (fs.existsSync(file)) existing.push(file);
    else { fs.writeFileSync(file, '', { mode: local ? 0o600 : 0o644, flag: 'wx' }); created.push(file); }
  }
  const readme = path.join(dir, 'README.md');
  if (!fs.existsSync(readme)) fs.writeFileSync(readme,
    '# Lush agent customization\n\n`common.md` is appended to every role. `<role>.md` is appended only to that role.\nUse `lush agent prompt ROLE` to inspect the final composition.\n',
    { mode: local ? 0o600 : 0o644, flag: 'wx' });
  return { scope: local ? 'local' : 'project', directory: dir, created, existing, role: selectedRole };
}

export async function run(command, args, { client, json }) {
  const verb = args.shift() || 'show';
  if (verb === 'prompt') {
    exact(args, 1);
    const selectedRole = role(args[0]);
    const settings = new AgentSettings(client.config).get();
    const view = agentPrompt(client.config, selectedRole, settings.resolved[selectedRole] || settings.default);
    if (json) return view;
    console.log(`Role: ${view.role}`);
    console.log(`Composition: ${view.parts.map(part => part.name).join(' + ')}`);
    console.log('Project overlays:');
    for (const file of view.customization.project) console.log(`  ${file}${fs.existsSync(file) ? '' : ' (missing)'}`);
    console.log('Local overlays:');
    for (const file of view.customization.local) console.log(`  ${file}${fs.existsSync(file) ? '' : ' (missing)'}`);
    console.log(`Agent settings: ${view.customization.settings}`);
    console.log('\n===== Assembled prompt =====\n');
    console.log(view.text);
    return;
  }
  if (verb === 'env') {
    exact(args, 1);
    const view = agentEnvironment(client.config, role(args[0]));
    const safe = { role: view.role, files: view.files, loaded: view.sources, keys: Object.keys(view.values).sort(),
      note: 'values are redacted; daemon environment is inherited first, then agent.env, then role env' };
    if (json) return safe;
    console.log(JSON.stringify(safe, null, 2));
    return;
  }
  if (verb === 'init') {
    check(!client.token, 'agents cannot change Agent configuration');
    return init(client.config, args);
  }

  check(!client.token, 'agents cannot change Agent configuration');
  if (verb === 'show') { exact(args, 0); return client.request('agent.config'); }
  if (verb === 'models') {
    exact(args, 1);
    check(['pi', 'codex'].includes(args[0]), 'agent models requires pi or codex');
    return client.request('agent.models', { agent: args[0] });
  }

  const current = await client.request('agent.config');
  if (verb === 'reset') {
    exact(args, 1);
    const selectedRole = args[0];
    check(selectedRole !== 'default' && TARGETS.has(selectedRole), 'agent reset requires a role');
    const roles = { ...current.roles }; delete roles[selectedRole];
    return client.request('agent.configure', { config: { version: 1, default: current.default, roles } });
  }

  check(verb === 'set', 'agent expects show, models, prompt, env, init, set or reset');
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
  const budgetResponses = option(args, '--budget-responses');
  const budgetTokens = option(args, '--budget-tokens');
  const hasBudget = budgetResponses !== null || budgetTokens !== null;
  const defaultPrompt = option(args, '--default-prompt');
  const appendPrompt = hasExplicitAppend ? option(args, '--append-prompt') : option(args, '--prompt');
  exact(args, 0);
  check(hasAgent || hasModel || hasThinking || hasDefaultPrompt || hasAppendPrompt || hasBudget, 'agent set requires at least one setting');
  const base = target === 'default' ? current.default : (current.roles[target] || current.resolved[target]);
  const next = { ...base };
  if (hasAgent) next.agent = backend;
  if (hasModel) next.model = model;
  if (hasThinking) next.thinking = thinking;
  if (hasDefaultPrompt) next.default_prompt = defaultPrompt;
  if (hasAppendPrompt) next.append_prompt = appendPrompt;
  if (hasAgent && backend !== base.agent) {
    if (!hasModel) next.model = '';
    if (!hasThinking) next.thinking = '';
  }
  if (hasBudget) {
    next.soft_budget = { ...base.soft_budget };
    for (const [key, value] of [['responses', budgetResponses], ['tokens', budgetTokens]]) {
      if (value === null) continue;
      if (value === 'off') delete next.soft_budget[key];
      else next.soft_budget[key] = Number(value);
    }
  }
  const roles = { ...current.roles };
  if (target === 'default') return client.request('agent.configure', { config: { version: 1, default: next, roles } });
  roles[target] = next;
  return client.request('agent.configure', { config: { version: 1, default: current.default, roles } });
}
