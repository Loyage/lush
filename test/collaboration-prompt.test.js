import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Config } from '../src/config.js';
import { agentPrompt, builtInPrompt } from '../src/agent/prompts.js';
import { capabilityGuide } from '../src/agent/capabilities.js';
import { temp, env } from './helpers.js';

const coreRules = [
  '普通进度在 progress 能力开启时优先使用进度机制，关闭时留在本轮结果',
  '不为报进度重新启用能力',
  '需要对方行动的决策、接口变化、阻塞、安全问题及必须补做的验证',
  '相关接口确认集中说明变更、受影响调用点和需对方完成的动作',
  '失败与安全问题及时报告',
  '不依赖 runtime 按正文过滤',
];
const uiRules = [
  '大型 UI 改动必须在实施前用问卷附简短、安全的静态预览',
  '默认内容、哪些高级功能按需展开、高频操作的步骤及窄屏表现',
  '区分“具备功能”和“默认突出功能”',
  '静态提案，不是已实现效果',
  '交付按已确认的信息层级、交互及布局验证',
  '浏览器布局检查不能替用户确认信息优先级',
];

test('collaboration and UI decisions survive configuration modes and disabled optional capabilities', () => {
  const root = temp();
  try {
    const config = new Config({ project: root, env: env({ LUSH_GLOBAL_CONFIG: path.join(root, 'device') }) });
    for (const taskKind of ['order', 'child']) {
      for (const config_mode of ['lush', 'pi']) {
        const view = agentPrompt(config, 'agent', { config_mode }, taskKind);
        for (const rule of [...coreRules, ...uiRules]) expect(view.text).toContain(rule);
        expect(view.text).toContain('普通成功消息攒到本轮所有子 Worker 交付结算再唤醒');
        expect(view.text).toContain('必须检查结果、测试与交付事实');
        expect(view.text).toContain('发布 notice 必须是本轮最后一个动作');
      }
      const disabled = builtInPrompt('agent', { taskKind, capabilities: {
        progress_reporting: false, worker_delegation: false,
      } });
      for (const rule of [...coreRules, ...uiRules]) expect(disabled).toContain(rule);
      expect(disabled).not.toContain('lushc skills get progress');
      expect(disabled).not.toContain('lushc skills get delegation');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('on-demand guides concentrate interface changes and avoid redundant progress messages', () => {
  const delegation = capabilityGuide('delegation').content;
  for (const rule of [
    '接口确认尽量在派工 goal 中一次写清', '一条集中消息',
    '导出／参数变化、受影响调用点、生命周期／依赖及必须补做的验证',
    '明确需要对方执行什么', '不要求“收到”式回复',
    '失败与安全问题及时报告', '保留成功信号聚合与必要成果审查',
  ]) expect(delegation).toContain(rule);
  const progress = capabilityGuide('progress').content;
  expect(progress).toContain('不再给父／子 Worker 追加');
  expect(progress).toContain('不能用里程碑代替需要对方行动的沟通');
});

test('isolated non-development roles do not inherit UI redesign or collaboration workflows', () => {
  for (const role of ['manager', 'butler', 'explainer']) {
    const prompt = builtInPrompt(role);
    for (const rule of [...coreRules, ...uiRules]) expect(prompt).not.toContain(rule);
  }
});
