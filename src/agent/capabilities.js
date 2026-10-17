import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { check } from '../core/types.js';

const developmentRoles = new Set(['agent', 'planner', 'coordinator', 'research', 'worker', 'verifier', 'merger']);
const isolatedRoles = new Set(['manager', 'butler', 'explainer']);

/** Fixed, code-owned resources, never user paths or a second permission/scheduling system. */
export const AGENT_CAPABILITIES = Object.freeze([
  { id: 'progress', setting: 'progress_reporting', title: '进度汇报',
    description: '本轮开始实质工作前加载，汇报有序里程碑并在实际完成后更新。',
    trigger: '开始实质工作前必须加载；完成步骤时按指南上报。' },
  { id: 'delegation', setting: 'worker_delegation', title: '子 Worker 委派',
    description: '需要创建子 Worker 或拆分并行工作时加载；复用 Lush 的非阻塞委派与交付。',
    trigger: '决定创建新子 Worker 前必须加载；已有后代的检查、消息与交付仍遵守核心。' },
  { id: 'auto-title', setting: 'worker_auto_title', title: '自动标题',
    description: '当前 order/child 尚无自动标题时加载，为自身生成一次简短标题。',
    trigger: '当前 task_kind 为 order/child 且 auto_title 为空时，理解目标后、结束本轮前必须加载。' },
  { id: 'context', setting: 'context_retrieval', title: '上下文检索',
    description: '启动上下文不足时加载，有界查询 Worker 摘要、事件和执行记录。',
    trigger: '给定上下文不足、确需补充 Worker 历史或执行记录时加载；不要默认扫描项目历史。' },
  { id: 'result-notice', setting: 'result_notice', title: '结果告知',
    description: '任务仅分析，或用户明确要求完成后告知时加载；结果就绪后主动发布非阻塞告知。',
    trigger: '自己的任务只是分析，或用户明确要求“做好了告诉我”等完成提醒时，必须加载；实际完成后、结束本轮前调用 lushw notice post --kind info 告知结果，不能只写最终回答。' },
].map(entry => Object.freeze({ ...entry, name: `lush-${entry.id}`,
  skill: fileURLToPath(new URL(`./skills/lush-${entry.id}/SKILL.md`, import.meta.url)),
  guide: fileURLToPath(new URL(`./skills/lush-${entry.id}/guide.md`, import.meta.url)) })));

/** Public built-in metadata only: this does not disclose device settings or effective enablement. */
export function listCapabilityGuides() {
  return AGENT_CAPABILITIES.map(({ id, name, title, description, setting }) => ({ id, name, title, description, setting }));
}

export function capabilityGuide(id) {
  const entry = AGENT_CAPABILITIES.find(entry => entry.id === id);
  check(entry, 'unknown built-in skill; use lushw skills list');
  const content = fs.readFileSync(entry.guide, 'utf8').trim();
  check(Buffer.byteLength(content) <= 65536, 'built-in skill guide exceeds 65536 bytes');
  return { ...listCapabilityGuides().find(entry => entry.id === id), content };
}

function applicable(entry, role, taskKind) {
  if (isolatedRoles.has(role) || !developmentRoles.has(role)) return false;
  if (entry.id === 'delegation' || entry.id === 'auto-title') {
    return role === 'agent' && [null, undefined, 'order', 'child', 'say'].includes(taskKind);
  }
  return true;
}

/** Read the settings model once, then carry the resulting policy and paths through one invocation. */
export function resolveAgentCapabilities(config = {}, role = 'agent', taskKind = null, settings = undefined) {
  if (isolatedRoles.has(role) || !developmentRoles.has(role)) return [];
  const model = settings ?? config.runtimeSettings?.get() ?? {};
  return AGENT_CAPABILITIES.map(entry => ({ ...entry,
    applicable: applicable(entry, role, taskKind),
    enabled: applicable(entry, role, taskKind) && (model[entry.setting]?.value ?? model[entry.setting]
      ?? (entry.id === 'progress' ? config.progressReporting : undefined)) !== false,
  }));
}

/** Thin mandatory discovery index; long workflows live in the fixed CLI guides. */
export function capabilityPromptPart(entries) {
  if (!entries.length) return null;
  const enabled = entries.filter(entry => entry.enabled), disabled = entries.filter(entry => entry.applicable && !entry.enabled);
  const lines = [
    '以下为本 invocation 的 Lush 内置能力快照，优先于旧会话中的能力入口。只主动使用已开启且适用的模块。开关仅控制注入与主动使用，不撤销 CLI/RPC 权限，也不是沙箱；不要根据命令仍可调用推断能力已开启。',
    '加载某项能力时，先读取其 Skill 入口，或直接运行列出的 lushw skills get 命令取得当前 CLI 版本的完整指南；不要凭旧会话或记忆猜流程。bash 中的 lushw 已由 daemon 固定，不另找版本。',
  ];
  if (enabled.length) {
    lines.push('已开启：');
    for (const entry of enabled) lines.push(`- ${entry.id}（${entry.title}）：${entry.trigger} 指南：lushw skills get ${entry.id}；Skill：${entry.skill}`);
  } else lines.push('没有已开启且适用的可选模块。');
  if (disabled.length) lines.push(`已关闭：${disabled.map(entry => `${entry.id}（${entry.title}）`).join('、')}。不加载这些指南，不主动执行其流程；自定义 Prompt 和旧上下文原文保留，不以其中的旧指令重新启用。`);
  if (entries.some(entry => !entry.applicable)) lines.push(`本身份不适用：${entries.filter(entry => !entry.applicable).map(entry => entry.id).join('、')}。不要加载或使用。`);
  lines.push('关闭或不适用不取消已有后代：必要的成果检查、合法消息、等待释放本轮、源侧修复、测试和交付继续按核心边界执行；不借此新建子 Worker。');
  return { name: 'capabilities', title: '可选 Agent 能力', source: 'builtin', content: lines.join('\n') };
}
