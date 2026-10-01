/** Format only an actual supplied duration; never infer a daily/weekly window from its position. */
export function usageWindow(seconds) {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return '窗口时长未知';
  if (seconds === 604800) return '7 天（周）窗口';
  if (seconds % 86400 === 0) return `${seconds / 86400} 天窗口`;
  if (seconds % 3600 === 0) return `${seconds / 3600} 小时窗口`;
  if (seconds % 60 === 0) return `${seconds / 60} 分钟窗口`;
  return `${seconds} 秒窗口`;
}

export const usageErrorLabels = Object.freeze({
  expired: '凭证过期，请更新登录', unconfigured: '缺少查询凭证', unauthorized: '授权失败',
  network: '网络查询失败', invalid_response: '响应格式无效', unsupported: '不支持查询',
  timeout: '查询超时', rate_limited: '服务商限制查询频率（HTTP 429），请稍后再试',
  auth_locked: '凭证正在被其他进程使用，请稍后再试', auth_changed: '登录凭证已变化，请重新查询',
  refresh_failed: '凭证刷新失败，请检查或更新登录',
});
