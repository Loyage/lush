import fs from 'node:fs';
import path from 'node:path';
import { check } from '../../core/types.js';
import { AGENT_ROLES, agentPrompt } from '../../agent/prompts.js';
import { agentEnvironment } from '../../agent/environment.js';
import { exact } from '../args.js';

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

export async function run(command, args, ctx) {
  const { client, json } = ctx;
  const config = client.config;
  const subcommand = args.shift();
  if (subcommand === 'prompt') {
    exact(args, 1);
    const view = agentPrompt(config, role(args[0]));
    if (json) return view;
    console.log(`Role: ${view.role}`);
    console.log(`Composition: ${view.parts.map(part => part.name).join(' + ')}`);
    console.log('Project overlays:');
    for (const file of view.customization.project) console.log(`  ${file}${fs.existsSync(file) ? '' : ' (missing)'}`);
    console.log('Local overlays:');
    for (const file of view.customization.local) console.log(`  ${file}${fs.existsSync(file) ? '' : ' (missing)'}`);
    console.log('\n===== Assembled prompt =====\n');
    console.log(view.text);
    return;
  }
  if (subcommand === 'env') {
    exact(args, 1);
    const view = agentEnvironment(config, role(args[0]));
    const safe = { role: view.role, files: view.files, loaded: view.sources, keys: Object.keys(view.values).sort(),
      note: 'values are redacted; daemon environment is inherited first, then agent.env, then role env' };
    if (json) return safe;
    console.log(JSON.stringify(safe, null, 2));
    return;
  }
  if (subcommand === 'init') {
    check(!client.token, 'agents cannot change agent configuration');
    return init(config, args);
  }
  throw new Error('agent command must be prompt, env or init');
}
