/** Read-only validation of retained legacy diagnostics, not a configuration entry. */
const text = value => typeof value === 'string' && value.length > 0;
export const validConvergencePolicy = (value, branch = value?.branch) => value?.version === 1
  && typeof value.mounted === 'boolean' && typeof value.enabled === 'boolean'
  && typeof value.editable === 'boolean' && text(value.revision)
  && (value.reason === null || typeof value.reason === 'string')
  && text(branch) && value.branch === branch && Number.isSafeInteger(value.owner_id) && value.owner_id > 0
  && (value.mounted || !value.enabled);

export function convergenceDiagnostic(model) {
  const errors = ['awaiting', 'failed', 'blocked'].filter(key => Number.isSafeInteger(model?.counts?.[key]) && model.counts[key] > 0);
  const counts = errors.map(key => `${({ awaiting: '待决定', failed: '失败', blocked: '落地待核查' })[key]} ${model.counts[key]}`).join(' · ');
  // A retired policy's reason explains an unavailable product feature, not a failed merge.
  // Retain genuine persisted exception counts even though its configuration is retired.
  return [model?.retired === true ? '' : model?.reason || '', counts ? `${counts}；请查看对应 Worker 的历史合并诊断。` : ''].filter(Boolean).join(' · ');
}
