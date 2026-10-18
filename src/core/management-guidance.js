import { LushError } from './types.js';

// Pure, credential-free protocol shared by help, catalogues and both bridge ends.
export const DEVICE_SCOPE_GUIDANCE = '用户 CLI 的 scope 默认 device；Valet 经 manager_call 调用时必须显式传 scope:"device"，且本轮用户指令明确包含“设备／全局／device”。接口 read/automatic 权限不替代这两项条件；缺少用户授权须询问用户，不能自行补写授权或换身份。';
export const MANAGEMENT_RECOVERY_GUIDANCE = '用法查询：终端使用 <入口> help <命令路径>（或 <命令> --help）；Valet 无 Shell，应调用 manager_catalog，按目标 method 的 parameters/schema/examples/authorization 构造请求。只有明确 execution=not_started 的参数错误可按指引修正；授权不足须用户决定，未知结果不得自动重试。';
export const MANAGEMENT_PREFLIGHT_CODE = -32031;
const diagnostics = Object.freeze({
  scope_required: {
    internal: 'device settings require explicit scope in both user instruction and parameters',
    error: '缺少设备范围参数：Valet 必须显式传 scope:"device"；接口权限不替代范围及用户授权。先用 manager_catalog 核对目标 method 的 authorization；仅在本轮用户已明确要求设备／全局操作时补参，否则先询问用户。本次请求未执行。',
    kind: 'invalid_parameters', recovery: 'read_catalog',
  },
  invalid_scope: {
    internal: 'management settings must explicitly select device scope',
    error: '设备接口的 scope 必须为 "device"，不是查询列表范围。用 manager_catalog 核对目标 method 的 authorization；本轮用户未明确要求设备／全局操作时须先询问用户。本次请求未执行。',
    kind: 'invalid_parameters', recovery: 'read_catalog',
  },
  user_authorization_required: {
    internal: 'device scope must be explicitly requested in the user instruction',
    error: '缺少本轮用户的设备范围授权：即使接口为 read/automatic，也不能替用户推定设备／全局授权。请向用户说明所需读取或修改范围并询问；不能仅补 scope、换身份或自行重试。用法见 manager_catalog 的 authorization。本次请求未执行。',
    kind: 'authorization_required', recovery: 'ask_user',
  },
});

export function managementScopeError(reason) {
  const diagnostic = diagnostics[reason];
  if (!diagnostic) throw new Error('unknown management scope diagnostic');
  return new LushError(diagnostic.internal, MANAGEMENT_PREFLIGHT_CODE);
}

/** Fixed pre-dispatch scope failures only; never relay arbitrary auth/handler errors. */
export function safeManagementPreflightError(error) {
  if (error?.code !== MANAGEMENT_PREFLIGHT_CODE) return null;
  const message = error?.message ?? error?.error;
  const diagnostic = Object.values(diagnostics).find(item => message === item.internal || message === item.error);
  if (!diagnostic) return null;
  return { error: diagnostic.error, code: MANAGEMENT_PREFLIGHT_CODE,
    kind: diagnostic.kind, execution: 'not_started', recovery: diagnostic.recovery };
}

export function managementScopeAuthorization() {
  return { scope: 'device', explicit_scope_required: true, explicit_user_instruction_required: true,
    instruction_terms: ['设备', '全局', 'device'], example: { scope: 'device' } };
}
