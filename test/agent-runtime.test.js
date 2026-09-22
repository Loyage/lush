import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Config } from '../src/config.js';
import { AGENT_ROLES, agentPrompt, builtInPrompt } from '../src/agent/prompts.js';
import { agentEnvironment, parseAgentEnv } from '../src/agent/environment.js';
import { temp, env } from './helpers.js';

test('agent prompts are composed from role-specific named parts', () => {
  const root = temp();
  try {
    const config = new Config({ project: root, env: env() });
    const planner = agentPrompt(config, 'planner');
    expect(planner.parts.map(part => part.name)).toEqual([
      'runtime', 'planner', 'role_catalog', 'dependencies', 'planner_cli', 'progress', 'decisions', 'common_cli', 'completion',
    ]);
    expect(planner.text).toContain('角色：planner');
    expect(planner.text).not.toContain('角色：worker');
    expect(agentPrompt(config, 'worker').text).not.toContain('planner 专用 CLI');
    expect(AGENT_ROLES.every(role => agentPrompt(config, role).text.includes(`角色：${role}`))).toBe(true);
    expect(agentPrompt(config, 'scheduler').resolved_role).toBe('planner');
    expect(() => agentPrompt(config, 'unknown')).toThrow('role must be one of');
    expect(builtInPrompt('research')).toContain('角色：research');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('settings replacement, project/local overlays and settings append have explicit order', () => {
  const root = temp();
  try {
    const config = new Config({ project: root, env: env() }); config.prepare();
    fs.mkdirSync(path.join(root, '.lush-agent'), { recursive: true });
    fs.mkdirSync(path.join(config.home, 'agent'), { recursive: true });
    fs.writeFileSync(path.join(root, '.lush-agent', 'common.md'), 'PROJECT COMMON');
    fs.writeFileSync(path.join(root, '.lush-agent', 'worker.md'), 'PROJECT WORKER');
    fs.writeFileSync(path.join(config.home, 'agent', 'common.md'), 'LOCAL COMMON');
    fs.writeFileSync(path.join(config.home, 'agent', 'worker.md'), 'LOCAL WORKER');
    const view = agentPrompt(config, 'worker', { default_prompt: 'REPLACEMENT', append_prompt: 'SETTINGS APPEND' });
    expect(view.parts.map(part => part.name)).toEqual([
      'settings.default_prompt', 'project.common', 'project.worker', 'local.common', 'local.worker', 'settings.append_prompt',
    ]);
    for (const [left, right] of [['REPLACEMENT','PROJECT COMMON'],['PROJECT COMMON','PROJECT WORKER'],['PROJECT WORKER','LOCAL COMMON'],['LOCAL COMMON','LOCAL WORKER'],['LOCAL WORKER','SETTINGS APPEND']]) {
      expect(view.text.indexOf(left)).toBeLessThan(view.text.indexOf(right));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('agent env parser supports dotenv literals without shell expansion', () => {
  expect(parseAgentEnv(`
# comment
export HTTP_PROXY=http://127.0.0.1:7897
QUOTED="hello world"
SINGLE='literal $HOME'
HASH=value#fragment
INLINE=value # comment
`)).toEqual({
    HTTP_PROXY: 'http://127.0.0.1:7897', QUOTED: 'hello world', SINGLE: 'literal $HOME', HASH: 'value#fragment', INLINE: 'value',
  });
  expect(() => parseAgentEnv('bad line', 'x.env')).toThrow('x.env:1');
  expect(() => parseAgentEnv('LUSH_PROJECT=/tmp/other', 'x.env')).toThrow('reserved by Lush');
});

test('role env hot-load layer overrides common env', () => {
  const root = temp();
  try {
    const config = new Config({ project: root, env: env() }); config.prepare();
    const dir = path.join(config.home, 'agent'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent.env'), 'HTTP_PROXY=http://common\nSHARED=yes\n');
    fs.writeFileSync(path.join(dir, 'research.env'), 'HTTP_PROXY=http://research\nONLY_ROLE=yes\n');
    const research = agentEnvironment(config, 'research');
    expect(research.values).toEqual({ HTTP_PROXY: 'http://research', SHARED: 'yes', ONLY_ROLE: 'yes' });
    expect(research.sources).toEqual([path.join(dir, 'agent.env'), path.join(dir, 'research.env')]);
    expect(agentEnvironment(config, 'worker').values).toEqual({ HTTP_PROXY: 'http://common', SHARED: 'yes' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
