/** Trusted, dependency-free Pi extension. No tools, processes or background timers. */
export default function lushRuntime(pi) {
  let settings;
  try { settings = JSON.parse(process.env.LUSH_RUNTIME_CONTEXT || '{}'); }
  catch { throw new Error('invalid Lush runtime context'); }
  const budget = settings.soft_budget || {};
  let responses = 0, tokens = 0, unknownTokens = 0, warned = false;
  pi.on('session_start', () => {
    if (settings.run_id) pi.appendEntry('lush.invocation', {
      task_id: settings.task_id, run_id: settings.run_id, role: settings.role,
    });
  });
  pi.on('message_end', ({ message }) => {
    if (message.role !== 'assistant') return;
    responses++;
    const usage = message.usage;
    const valid = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
    if (valid(usage?.totalTokens)) tokens += usage.totalTokens;
    else if (usage && ['input', 'output', 'cacheRead', 'cacheWrite'].some(k => valid(usage[k]))) {
      tokens += ['input', 'output', 'cacheRead', 'cacheWrite'].reduce((sum, k) => sum + (valid(usage[k]) ? usage[k] : 0), 0);
    } else unknownTokens++;
  });
  // A context hook only runs for an already-needed model call. Never prolong a completed turn.
  pi.on('context', event => {
    if (warned || !((budget.responses && responses >= budget.responses) || (budget.tokens && tokens >= budget.tokens))) return;
    warned = true;
    const content = `Lush 软预算提醒：本次 invocation 已有 ${responses} 条模型响应、${tokens} 个累计 token（含缓存读取${unknownTokens ? `；${unknownTokens} 条用量未知` : ''}）。已达到设定阈值。请优先保存当前成果、执行必要验证并交付；停止可选探索和润色。如未完成须明确剩余工作与风险，不能为预算虚报成功。此提醒不会强制终止，也不授权跳过审批、测试或安全规则。`;
    const details = { responses, tokens, unknown_tokens: unknownTokens, limits: budget };
    pi.appendEntry('lush.soft_budget', { ...details, content });
    return { messages: [...event.messages, { role: 'custom', customType: 'lush.soft_budget', content,
      display: true, details, timestamp: Date.now() }] };
  });
}
