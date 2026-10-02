import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Config } from '../src/config.js';
import { AGENT_ROLES, agentPrompt, builtInPrompt } from '../src/agent/prompts.js';
import { agentEnvironment, parseAgentEnv, readAgentEnvironment, saveAgentEnvironment } from '../src/agent/environment.js';
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

test('all built-in role prompts call the entity Worker without changing historical role names', () => {
  expect(AGENT_ROLES).toContain('worker');
  for (const role of AGENT_ROLES) {
    const prompt = builtInPrompt(role);
    expect(prompt).not.toMatch(/lush task|\bTask\b|任务/);
    expect(prompt).toContain(`角色：${role}`);
  }
});

test('agent prompt distinguishes persistent auto-merge hooks from delivery and authorization', () => {
  const prompt = builtInPrompt('agent');
  expect(prompt).toContain('自动合并设置跨追加开发轮次保留');
  expect(prompt).toContain('默认开启不可关闭的自动合并 hook');
  expect(prompt).toContain('lush worker spawn');
  expect(prompt).toContain('lush worker accept');
  expect(prompt).toContain('LUSH_TASK_ID');
  expect(prompt).toContain('Worker 数据仍使用 task 字段');
  expect(prompt).not.toMatch(/lush task|\bTask\b|任务/);
  expect(prompt).toContain('Agent 不得操作自动合并开关');
  expect(prompt).toContain('不增加父 Agent 审批');
  expect(prompt).toContain('只有显示 integration=merged 才能宣称已进入父分支');
  expect(prompt).toContain('不创建 merge Worker、不重挂 parent_id');
  expect(prompt).toContain('不额外调用父 Agent 或要求 worker.integrate');
  expect(prompt).toContain('源侧修复期间保留父执行位');
  expect(prompt).toContain('除 runtime 指定的当前尝试源侧修复外');
  expect(prompt).toContain('恢复重新排队并固定新父基线');
  expect(prompt).toContain('不得用旧尝试回复推进新尝试');
  expect(prompt).toContain('消息仅是通知，持久交付状态才是事实');
  expect(prompt).toContain('旧 version 1 人工确认与旧 version 2 merge 身份仅为历史兼容');
  expect(prompt).not.toContain('由父 Task 下的 merge 子 Task');
  expect(prompt).not.toContain('收到 merge Task 的分歧消息');
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

test('agent env editor storage validates, round-trips and writes owner-only files', () => {
  const root = temp();
  try {
    const config = new Config({ project: root, env: env() }); config.prepare();
    const saved = saveAgentEnvironment(config, 'common', { Z_LAST: 'hash # and "quote"', API_KEY: 'line 1\nline 2', EMPTY: '' });
    expect(saved.exists).toBe(true);
    expect(saved.values).toEqual({ API_KEY: 'line 1\nline 2', EMPTY: '', Z_LAST: 'hash # and "quote"' });
    expect(fs.statSync(saved.file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(saved.file)).mode & 0o777).toBe(0o700);
    expect(readAgentEnvironment(config, 'common').values.API_KEY).toBe('line 1\nline 2');
    expect(() => saveAgentEnvironment(config, 'worker', { LUSH_PROJECT: '/tmp/no' })).toThrow('reserved by Lush');
    expect(() => readAgentEnvironment(config, 'unknown')).toThrow('target must be one of');
    const cleared = saveAgentEnvironment(config, 'common', {});
    expect(cleared.exists).toBe(false);
    expect(fs.existsSync(saved.file)).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
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
