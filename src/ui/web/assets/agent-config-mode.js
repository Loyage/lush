/**
 * Agent 运行配置模式（Lush 配置 / Pi 默认配置）的纯逻辑接缝。
 *
 * 项目 Agent 配置、Worker 完整 Profile 编辑器与用户新建指令的运行设置三处共用这一份语义：
 * - `lush`（默认）：使用 Lush 托管的模型来源、模型、思考深度、Prompt、扩展 / Skills、软预算与环境变量。
 * - `pi`：执行机器上用户自己的 Pi 配置。Lush 不注入托管来源、模型、思考深度、自定义 Prompt 文件、
 *   Agent 环境变量文件或资源列表；执行环境仍保留 Lush 必需的任务指令、会话、消息、内置 runtime /
 *   抢占协议与项目网络策略，且不自动批准未受信项目。
 *
 * 这里只做取值归一化与「发送哪些字段」的裁剪，不建 DOM、不读接口；编辑器负责隐藏被清除的字段。
 */

export const CONFIG_MODES = [
  { id: 'lush', label: 'Lush 配置', note: '使用 Lush 托管的模型来源与运行选项；对自己的配置掌握力更强。' },
  { id: 'pi', label: 'Pi 默认配置', note: '交给执行机器上用户自己的 Pi 配置：Lush 不注入账号、模型、思考深度、Prompt、资源或环境变量。' },
];
export const CONFIG_MODE_IDS = CONFIG_MODES.map(mode => mode.id);
export const DEFAULT_CONFIG_MODE = 'lush';
/** Pi 支持的思考等级；与后端 `settings.THINKING_LEVELS.pi` 同序，仅用于连接默认设定的下拉展示。 */
export const PI_THINKING_LEVELS = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export const PI_MODE_HELP = 'Pi 默认配置由执行机器的 Pi 目录自行管理认证、模型、资源与项目信任；Lush 仍提供任务指令、会话、消息与必需运行协议，不自动批准未受信项目。';

/** 只认已知模式；未知值按默认 Lush 处理，不猜测。 */
export function normalizeConfigMode(value) {
  return value === 'pi' ? 'pi' : 'lush';
}

/**
 * 按模式裁剪将要提交的 Profile：Pi 模式只保留后端与模式，其余托管字段全部丢弃，
 * 避免把 Lush 的账号、模型、Prompt、资源或环境变量带进 Pi 默认配置的运行。
 * 非 Pi 后端不允许进入 Pi 模式（服务端同样校验）。
 */
export function profileForMode(mode, profile = {}) {
  const selected = normalizeConfigMode(mode);
  if (selected !== 'pi') return { ...profile, config_mode: 'lush' };
  const agent = profile.agent === 'pi' ? 'pi' : (profile.agent || 'pi');
  return { agent, config_mode: 'pi' };
}

/** Pi 模式下表单必须禁用/隐藏的字段与区块 id（编辑器按同一份列表收口，避免各写各的）。 */
export const MANAGED_SECTIONS = ['runtime', 'workstyle', 'advanced', 'resources', 'budget', 'env'];
