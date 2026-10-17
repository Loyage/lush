/** Public diagnostics are fixed text, never provider stderr, exception messages or credentials. */
const FAILURES = Object.freeze({
  pi_extension_load_failed: 'Pi 扩展加载失败。\n建议：检查 Lush 与 Pi 的版本及运行时兼容性；修复后由用户在安全空闲时更新相关服务。',
  pi_model_connection_failed: 'Pi 模型或来源连接不可用。\n建议：检查所选模型、来源配置与登录状态；此诊断不证明额度已耗尽。',
  pi_launch_failed: 'Pi 进程未能启动。\n建议：检查 Pi 是否已安装，以及 daemon 使用的可执行路径是否有效。',
  invocation_output_limit: 'Agent 输出超过安全读取上限，调用已停止。\n建议：检查执行记录与已发生的操作，缩小输出范围后再决定是否另建指令。',
  invocation_timeout: 'Agent 调用超过本次允许时长，已请求停止。\n建议：核对执行记录与受控操作收据；超时不证明已开始的操作未执行。',
  invocation_interrupted: 'Agent 调用被中断，未正常返回。\n建议：检查停止请求、执行记录与受控操作收据，不把中断视为操作已撤回。',
  pi_invocation_failed: 'Pi 调用异常结束，未获得可公开的具体原因。\n建议：检查 Pi 安装、模型与来源配置及已有执行记录；不能据此认定操作未执行。',
});

export class AgentInvocationError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(FAILURES, code) ? code : 'pi_invocation_failed';
    super(FAILURES[safeCode]);
    this.name = 'AgentInvocationError';
    this.code = safeCode;
  }
}

/** Classify bounded, process-local diagnostics; none of the matched text escapes this function. */
export function piProcessFailure(code, stderr, overflow = false) {
  if (overflow) return new AgentInvocationError('pi_invocation_failed');
  if (/Failed to load extension|Extension does not export a valid factory|ERR_UNSUPPORTED_ESM_URL_SCHEME|Cannot find module ['"]bun:|Cannot find package ['"]bun:/i.test(stderr))
    return new AgentInvocationError('pi_extension_load_failed');
  if (code === 127 && /lush-agent-guard:.*(?:ENOENT|not found)/i.test(stderr))
    return new AgentInvocationError('pi_launch_failed');
  if (/No API key|No models available|Model[^\n]*(?:not found|not available)|Unknown model|(?:authentication|authorization) failed|\b(?:401 Unauthorized|403 Forbidden)\b/i.test(stderr))
    return new AgentInvocationError('pi_model_connection_failed');
  return new AgentInvocationError('pi_invocation_failed');
}

/** Recompute fixed text from the type/code, even if a caller has replaced the Error's message. */
export function safeInvocationMessage(error) {
  return error instanceof AgentInvocationError && Object.hasOwn(FAILURES, error.code) ? FAILURES[error.code] : null;
}
