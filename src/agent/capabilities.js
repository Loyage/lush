import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { check } from '../core/types.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Catalogue schemas depend on runtime profile normalization. Defer loading that
// fixed module until prompt assembly so ESM initialization order stays acyclic.
// This is still the sole code-owned catalogue version, not a second hash/cache.
export function cliCatalogVersion() { return require('../cli/catalog.js').CLI_CATALOG_VERSION; }

const developmentRoles = new Set(['agent', 'planner', 'coordinator', 'research', 'worker', 'verifier', 'merger']);
const isolatedRoles = new Set(['manager', 'butler', 'explainer']);

/** Fixed, code-owned resources, never user paths or a second permission/scheduling system. */
export const AGENT_CAPABILITIES = Object.freeze([
  { id: 'progress', setting: 'progress_reporting', title: '进度汇报',
    description: '将工作拆成里程碑，完成步骤后更新进度，方便跟踪执行情况。',
    effect: '关闭后不再主动汇报里程碑，已有进度记录保留。',
    trigger: '开始实质工作前必须加载；完成步骤时按指南上报。' },
  { id: 'delegation', setting: 'worker_delegation', title: '子 Worker 委派',
    description: '让 Agent 将合适的工作拆给独立子 Worker，并协调分工与交付。',
    effect: '关闭后不再主动创建子 Worker；已有子 Worker 的检查、消息与交付仍继续。',
    trigger: '决定创建新子 Worker 前必须加载；已有后代的检查、消息与交付仍遵守核心。' },
  { id: 'auto-title', setting: 'worker_auto_title', title: '自动标题',
    description: '为新的指令和子 Worker 生成简短标题，方便识别工作内容。',
    effect: '关闭后不再主动生成自动标题，不修改已有标题或用户设置的展示标题。',
    trigger: '当前 task_kind 为 order/child 且 auto_title 为空时，理解目标后、结束本轮前必须加载。' },
  { id: 'context', setting: 'context_retrieval', title: '上下文检索',
    description: '在上下文不足时查阅 Worker 摘要、历史和执行记录，补充必要信息。',
    effect: '关闭后不再主动使用这份检索指南，不删除历史，也不撤销已有读取权限。',
    trigger: '给定上下文不足、确需补充 Worker 历史或执行记录时加载；不要默认扫描项目历史。' },
  { id: 'result-notice', setting: 'result_notice', title: '结果告知',
    description: '纯分析任务或你明确要求完成提醒时，主动发布非阻塞结果告知。',
    effect: '与 runtime 自动提醒独立，可能收到两条；关闭只停止 Agent 主动结果告知，不修改提醒 Hook 或删除历史。',
    trigger: '自己的任务只是分析，或用户明确要求“做好了告诉我”等完成提醒时，必须加载；实际完成后、结束本轮前调用 lushw self notice notify 告知结果（非阻塞 info），不能只写最终回答。' },
].map(entry => Object.freeze({ ...entry, name: `lush-${entry.id}`,
  skill: fileURLToPath(new URL(`./skills/lush-${entry.id}/SKILL.md`, import.meta.url)),
  guide: fileURLToPath(new URL(`./skills/lush-${entry.id}/guide.md`, import.meta.url)) })));

/** Public built-in metadata only: this does not disclose device settings or effective enablement. */
export function listCapabilityGuides() {
  return AGENT_CAPABILITIES.map(({ id, name, title, description, setting, trigger, effect }) =>
    ({ id, name, title, description, setting, trigger, effect }));
}

function registeredCapability(id) {
  const entry = AGENT_CAPABILITIES.find(entry => entry.id === id);
  check(entry, 'unknown built-in skill; use lushw skills list');
  return entry;
}

function readCapabilityFile(file) {
  try {
    check(fs.statSync(file).size <= 65536, 'built-in skill file exceeds 65536 bytes');
    const content = fs.readFileSync(file, 'utf8');
    check(Buffer.byteLength(content) <= 65536, 'built-in skill file exceeds 65536 bytes');
    return content;
  } catch (error) {
    // Installation/file errors must not expose internal absolute resource paths over HTTP.
    if (error.code) throw new Error('built-in skill file is unavailable; update Host and retry');
    throw error;
  }
}

export function capabilityGuide(id) {
  const entry = registeredCapability(id);
  return { ...listCapabilityGuides().find(entry => entry.id === id), content: readCapabilityFile(entry.guide).trim() };
}

/** Exact shipped text only. No caller-controlled path, settings, execution or write operation. */
export function capabilitySource(id) {
  const entry = registeredCapability(id);
  return { version: 1, id: entry.id, name: entry.name, title: entry.title,
    entry: readCapabilityFile(entry.skill), guide: readCapabilityFile(entry.guide) };
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
    `固定 CLI catalog_version=${cliCatalogVersion()}。领域：self 自身／parent 直接父／children 直接 child；question 本地问卷／skills 内置指南。用法不确定时按需 lushw help PATH、help --search TEXT 或 help workflow；不要求每条命令先查帮助。同目录版本的静态用法可复用，版本变化／迁移提示只使相关知识失效，不重发写入；动态权限、真实目标和 revision 不可缓存为授权。`,
    '加载某项能力时，先读取其 Skill 入口，或直接运行列出的 lushw skills show 命令取得当前 CLI 版本的完整指南；不要凭旧会话或记忆猜流程。bash 中的 lushw 已由 daemon 固定，不另找版本。',
  ];
  if (enabled.length) {
    lines.push('已开启：');
    for (const entry of enabled) lines.push(`- ${entry.id}（${entry.title}）：${entry.trigger} 指南：lushw skills show ${entry.id}；Skill：${entry.skill}`);
  } else lines.push('没有已开启且适用的可选模块。');
  if (disabled.length) lines.push(`已关闭：${disabled.map(entry => `${entry.id}（${entry.title}）`).join('、')}。不加载这些指南，不主动执行其流程；自定义 Prompt 和旧上下文原文保留，不以其中的旧指令重新启用。`);
  if (entries.some(entry => !entry.applicable)) lines.push(`本身份不适用：${entries.filter(entry => !entry.applicable).map(entry => entry.id).join('、')}。不要加载或使用。`);
  lines.push('关闭或不适用不取消已有后代：必要的成果检查、合法消息、等待释放本轮、源侧修复、测试和交付继续按核心边界执行；不借此新建子 Worker。');
  return { name: 'capabilities', title: '可选 Agent 能力', source: 'builtin', content: lines.join('\n') };
}
