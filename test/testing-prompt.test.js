import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Config } from '../src/config.js';
import { PROMPT_PARTS, builtInPrompt, agentPrompt } from '../src/agent/prompts.js';
import { temp, env } from './helpers.js';

const developmentRoles = ['agent', 'worker', 'coordinator'];

test('complete execution means finishing the selected test scope, not always running the whole suite', () => {
  expect(PROMPT_PARTS.runtime.content).toContain('选定的测试必须实际完整运行');
  expect(PROMPT_PARTS.runtime.content).toContain('“完整运行”指所选范围跑完，不要求每次都跑全量');
  expect(PROMPT_PARTS.runtime.content).toContain('失败保留错误与完整日志路径');
});

test('development prompts retain layered testing in both configuration modes and without progress reporting', () => {
  const root = temp();
  try {
    const config = new Config({ project: root, env: env({ LUSH_GLOBAL_CONFIG: path.join(root, 'device') }) });
    for (const role of developmentRoles) {
      for (const config_mode of ['lush', 'pi']) {
        const view = agentPrompt(config, role, { config_mode });
        expect(view.parts.filter(part => part.name === 'testing')).toHaveLength(1);
        expect(view.text).toContain('默认子 Worker（child）只做本次改动的专项测试');
        expect(view.text).toContain('最终全量由直接交付 main/owner 的顶层开发指令 Worker 负责');
      }
      const withoutProgress = builtInPrompt(role, { progressReporting: false });
      expect(withoutProgress).not.toContain('## 执行进度');
      expect(withoutProgress).toContain('## 分层测试与验证责任');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('delegation passes explicit test scope and the same final owner through nested children', () => {
  const prompt = builtInPrompt('agent');
  for (const rule of [
    '根据启动 JSON 的 task_kind、直接父 Worker 与派工目标确认验证责任',
    '必须在 goal 中写明改动范围、专项／受影响回归范围',
    '最终全量由哪个指令 Worker 负责',
    '子 Worker 再派工时传递同一最终全量责任',
    '承担汇总的中间子 Worker 增加跨子成果的集成验证，不在每层重复全量',
    '必要时提前全量',
    '用户明确要求的验证范围必须遵守',
  ]) expect(prompt).toContain(rule);
});

test('final verification belongs to the instruction worktree before main delivery, not runtime or CI', () => {
  const prompt = PROMPT_PARTS.testing.content;
  for (const rule of [
    '没有子 Worker 时也由自己承担',
    '收齐并核对所有子成果、完成自身改动后',
    '在自己的 worktree 做跨模块集成验证',
    '对最终代码树运行项目规定的全量测试，之后交付 main/owner',
    '不要每收到一个子成果就跑一次全量',
    '不要等进入 main 后才验证或修复',
    '只读回答、纯文档改动按目标运行必要检查',
    '合并 runtime、自动验收和 CI 不代替这份验证责任',
    'child 不因进入修复阶段就默认全量',
    '若最终代码树变化，须重新验证最终全量',
    '不自行同步父分支或修改 main',
  ]) expect(prompt).toContain(rule);
  // The new scope policy must not weaken the existing fixed-baseline repair rules.
  expect(builtInPrompt('agent')).toContain('实际运行覆盖受影响路径的测试');
  expect(builtInPrompt('agent')).toContain('保留原源提交');
});

test('reuse and failure reporting require complete evidence for the actual final tree', () => {
  const prompt = PROMPT_PARTS.testing.content;
  for (const rule of [
    '被测代码树（含测试）、测试命令／范围及关键环境一致',
    '结果完整可追溯',
    '仅 Squash 改了提交号、上述条件不变时不重复全量',
    '无法确认一致就不复用',
    '不是 runtime 已有测试缓存或门禁',
    '修复本次引入的问题后重跑失败专项，最终再完整跑全量',
    '既有失败、环境问题与本次回归须区分',
    '不顺手扩大为无关修复',
    '不把未完成或仍失败的全量报成通过',
    '交付结果列出实际测试命令、范围、结果和未覆盖风险',
    '未跑全量时说明原因及最终负责的 Worker',
    '不能继续声称修改后的树已通过原验证',
  ]) expect(prompt).toContain(rule);
});

test('read-only and isolated roles do not inherit development full-suite responsibility', () => {
  const root = temp();
  try {
    const config = new Config({ project: root, env: env({ LUSH_GLOBAL_CONFIG: path.join(root, 'device') }) });
    const analysis = agentPrompt(config, 'agent', {}, 'analysis');
    expect(analysis.parts.some(part => part.name === 'testing')).toBe(false);
    expect(analysis.text).not.toContain('## 分层测试与验证责任');
    for (const role of ['research', 'manager', 'butler', 'explainer', 'verifier']) {
      expect(builtInPrompt(role)).not.toContain('## 分层测试与验证责任');
    }
    // Explicit user replacement remains a replacement, not a hidden injected policy.
    const replaced = agentPrompt(config, 'agent', { default_prompt: 'CUSTOM RULES' });
    expect(replaced.parts.some(part => part.name === 'testing')).toBe(false);
    expect(replaced.text).toBe('CUSTOM RULES');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
