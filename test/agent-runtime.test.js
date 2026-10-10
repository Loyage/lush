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
    const config = new Config({ project: root, env: env({ LUSH_GLOBAL_CONFIG: path.join(root, 'device') }) });
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

test('acceptance guidance includes safe retirement and preserves parent-only authorization', () => {
  const prompt = builtInPrompt('agent');
  expect(prompt).toContain('验收即归档');
  expect(prompt).toContain('脏工作区阻止验收');
  expect(prompt).toContain('资源回收失败不能当作验收成功');
  expect(prompt).toContain('保留 Worker、会话、结果和运行历史');
  expect(prompt).toContain('Agent 只能确认自己直接派出的已交付 child');
  expect(prompt).not.toContain('默认确认不自动归档');
  expect(prompt).not.toContain('显式归档另行回收');
});

test('agent prompt pins writes to the worktree and forbids direct commits on the target branch', () => {
  for (const role of ['agent', 'worker', 'merger', 'planner']) {
    const prompt = builtInPrompt(role);
    expect(prompt).toContain('唯一可写的代码副本');
    expect(prompt).toContain('不要 cd 到 canonical 项目目录');
    expect(prompt).toContain('LUSH_PROJECT');
    expect(prompt).toContain('git rev-parse --abbrev-ref HEAD');
    expect(prompt).toContain('禁止在 main/父分支上 commit、merge、push、reset、cherry-pick');
    expect(prompt).toContain('越过 worktree 直接把提交写进目标分支');
  }
  // 隔离的只读角色不注入共享 runtime 片段，不受这条提交边界提示影响。
  expect(builtInPrompt('explainer')).not.toContain('唯一可写的代码副本');
});

test('message guidance survives role/mode composition and separates admission from delivery', () => {
  const root = temp();
  try {
    const config = new Config({ project: root, env: env({ LUSH_GLOBAL_CONFIG: path.join(root, 'device') }) });
    for (const role of ['agent', 'coordinator', 'worker']) {
      for (const config_mode of ['lush', 'pi']) {
        const prompt = agentPrompt(config, role, { config_mode }).text;
        for (const rule of [
          'main/owner 即使是直接父 Worker 也不接收普通消息',
          '用 worker inspect 核对目标',
          '检查只是快照',
          'requested / executing / resolving / blocked',
          '合法普通消息仍可持久入箱，由 Worker 暂存',
          'input_queue.buffered 与 reason',
          '暂存输入不抢占修复、不改变当前尝试',
          'pending 或仅开启自动合并不等于冻结',
          '目标、未发送正文与后续动作',
          '不验收仍需修改的 child',
          '下轮重新核对后再决定是否发送，不承诺自动重投',
          '不要轮询、后台重试、撤销预约、改自动合并开关或绕过冻结',
          '各条独立消息分别调用并检查返回结果，不用 && 串联',
          '消息与测试、提交命令分开执行',
          '不能因整条工具调用失败就把已成功的消息重发',
        ]) expect(prompt).toContain(rule);
        expect(prompt).not.toContain('需要修改时先 lush worker message，不确认');
        if (role !== 'worker') expect(prompt).toContain('仅在目标允许追加工作时先 lush worker message');
      }
      expect(builtInPrompt(role, { progressReporting: false })).toContain('合法普通消息仍可持久入箱，由 Worker 暂存');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('source-side repair prompts require commit review and semantic migration checks', () => {
  for (const role of ['agent', 'worker', 'merger']) {
    const prompt = builtInPrompt(role);
    expect(prompt).toContain('仅在 runtime 明确授权的分歧修复或父同步冲突修复中');
    for (const command of ['git merge-base', 'git log', 'git show', 'git diff --find-renames']) {
      expect(prompt).toContain(command);
    }
    expect(prompt).toContain('双方从共同祖先以来的增量');
    expect(prompt).toContain('不能只看提交标题或冲突标记');
    expect(prompt).toContain('公共接口／数据模型迁移、模块拆分与架构重构');
    expect(prompt).toContain('自己的新增／修改代码、调用点、测试和文档');
    expect(prompt).toContain('即使没有文本冲突也必须做语义迁移检查');
    expect(prompt).toContain('语义或架构取舍有歧义时先通过 Notice 问用户');
    expect(prompt).toContain('实际运行覆盖受影响路径的测试');
    expect(prompt).toContain('参考的固定提交、发现的迁移及适配、测试结果和未验证风险');
    expect(prompt).toContain('此步骤不授权普通 Worker 自行同步父分支');
  }
});

test('settings replacement, project/local overlays and settings append have explicit order', () => {
  const root = temp();
  try {
    const config = new Config({ project: root, env: env({ LUSH_GLOBAL_CONFIG: path.join(root, 'device') }) }); config.prepare();
    fs.mkdirSync(path.join(root, '.lush-agent'), { recursive: true });
    fs.mkdirSync(path.join(config.deviceHome, 'agent'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(root, '.lush-agent', 'common.md'), 'PROJECT COMMON');
    fs.writeFileSync(path.join(root, '.lush-agent', 'worker.md'), 'PROJECT WORKER');
    fs.writeFileSync(path.join(config.deviceHome, 'agent', 'common.md'), 'LOCAL COMMON', { mode: 0o600 });
    fs.writeFileSync(path.join(config.deviceHome, 'agent', 'worker.md'), 'LOCAL WORKER', { mode: 0o600 });
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
    const config = new Config({ project: root, env: env({ LUSH_GLOBAL_CONFIG: path.join(root, 'device') }) }); config.prepare();
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
    const config = new Config({ project: root, env: env({ LUSH_GLOBAL_CONFIG: path.join(root, 'device') }) }); config.prepare();
    // Device env fixtures must be private regardless of the runner's umask.
    const dir = path.join(config.deviceHome, 'agent'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'agent.env'), 'HTTP_PROXY=http://common\nSHARED=yes\n', { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'research.env'), 'HTTP_PROXY=http://research\nONLY_ROLE=yes\n', { mode: 0o600 });
    const research = agentEnvironment(config, 'research');
    expect(research.values).toEqual({ HTTP_PROXY: 'http://research', SHARED: 'yes', ONLY_ROLE: 'yes' });
    expect(research.sources).toEqual([path.join(dir, 'agent.env'), path.join(dir, 'research.env')]);
    expect(agentEnvironment(config, 'worker').values).toEqual({ HTTP_PROXY: 'http://common', SHARED: 'yes' });
    fs.writeFileSync(path.join(dir, 'research.env'), 'http_proxy=http://lowercase-role\n');
    expect(agentEnvironment(config, 'research').values).toEqual({ http_proxy: 'http://lowercase-role', SHARED: 'yes' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
