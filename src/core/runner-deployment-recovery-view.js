import { check } from './types.js';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const RECOVERY_ACTIONS = Object.freeze(['bind_runtime_generation', 'start_original_unit']);
export function validateRecoveryRequest(kind, request) {
  const keys = kind === 'plan' ? ['id', 'expected_revision'] : kind === 'apply' ? ['id', 'expected_revision', 'recovery_id', 'approved_actions', 'confirm'] : ['id', 'expected_revision', 'recovery_id'];
  check(['plan', 'apply', 'reconcile'].includes(kind) && request && Object.keys(request).every(key => keys.includes(key))
    && uuid(request.id) && Number.isSafeInteger(request.expected_revision) && request.expected_revision > 0, 'Invalid original installation recovery request');
  if (kind !== 'plan') check(uuid(request.recovery_id), 'Original recovery identity required');
  if (kind === 'apply') check(request.confirm === true && Array.isArray(request.approved_actions) && request.approved_actions.length <= 2
    && new Set(request.approved_actions).size === request.approved_actions.length && request.approved_actions.every(id => RECOVERY_ACTIONS.includes(id)), 'Explicit recovery action approval required');
}
export function validateRecoveryApproval(plan, approved) {
  check(plan?.supported === true && Array.isArray(plan.blockers) && !plan.blockers.length && Array.isArray(plan.actions)
    && plan.actions.length >= 1 && plan.actions.length <= 2 && new Set(plan.actions.map(a => a.id)).size === plan.actions.length
    && plan.actions.some(a => a.id === 'bind_runtime_generation') && plan.actions.every(a => RECOVERY_ACTIONS.includes(a.id)
      && a.privileged === (a.id === 'start_original_unit') && typeof a.effect === 'string' && a.effect.length > 0 && a.effect.length <= 1024), 'Recovery plan is blocked or has incomplete actions');
  check(Array.isArray(approved) && new Set(approved).size === approved.length && approved.length === plan.actions.length
    && plan.actions.every(a => approved.includes(a.id)), 'Every recovery action must be independently approved');
  for (const action of plan.actions.filter(a => a.privileged)) check(typeof action.unit_path === 'string'
    && /^\/etc\/systemd\/system\/lush-runner-delegate-[1-9][0-9]*-[a-f0-9-]{36}\.service$/.test(action.unit_path)
    && hex(action.unit_sha256) && typeof action.unit_summary === 'string' && action.unit_summary.length > 0 && action.unit_summary.length <= 1024
    && action.unit_path === plan.unit?.path && action.unit_sha256 === plan.unit?.sha256, 'Original unit approval preview is incomplete');
}
const blockers = Object.freeze({ verification_budget_too_small: '当前中央预算低于验证器最低 100ms／64 字节；不会越过预算尝试恢复', old_commands_unconfirmed: '原命令物理停止未确认；不清理旧 slot', database_wal_or_journal_pending: '原数据库有未结 WAL／journal，不能只读证明一致状态',
  database_unverifiable: '原数据库身份或一致性不可证明', database_legacy_commands: '旧命令格式缺少恢复所需证据', original_unit_unverifiable: '没有原固定委派 unit 的可信摘要',
  original_unit_or_cgroup_changed: '原 unit 或委派资源身份不可证明', original_unit_containment_not_empty: '原委派进程树未证明为空', privilege_denied: '未证明可无交互启动原 unit',
  busy: '原安装仍有活动连接；不抢占执行', not_confirmed: '恢复检查未确认；原安装不变' });
const path = value => typeof value === 'string' && value.length <= 1024 && /^\/sys\/fs\/cgroup\/[A-Za-z0-9_./@:-]+$/.test(value) && !value.includes('..') ? value : null;
const scalars = (value, keys) => Object.fromEntries(keys.filter(key => ['boolean', 'number'].includes(typeof value?.[key])
  || typeof value?.[key] === 'string' && value[key].length <= 1024 && !/[\x00-\x1f\x7f]/.test(value[key])).map(key => [key, value[key]]));
export function abandonRecoveryState(state) {
  for (const item of Array.isArray(state?.items) ? state.items : []) {
    if (item.status === 'running') { item.status = 'unknown'; for (const stage of item.stages ?? []) if (stage.status === 'running') stage.status = 'unknown'; }
    for (const o of item.observations ?? []) if (o.status === 'running') o.status = 'unknown';
  }
}
export function publicRecovery(item) {
  const p = item.plan ?? {}, frozen = item.frozen ?? {}, previous = frozen.managed?.runtime_generation?.generation;
  const projected = !item.frozen && Number.isSafeInteger(p.from_generation);
  const from = projected ? p.from_generation : frozen.from_generation, budgets = projected ? p.verification_budgets : frozen.verification_budgets;
  const oldPath = projected ? p.cgroup?.previous_path : previous?.cgroup?.path ?? frozen.managed?.cgroup_root, observedPath = projected ? p.cgroup?.observed_path : p.cgroup?.path;
  const result = { ...scalars(item, ['id', 'status', 'created_at', 'updated_at']), plan: {
    from_generation: Number.isSafeInteger(from) && from >= 0 && from < 16 ? from : 0, to_generation: Number.isSafeInteger(from) && from >= 0 && from < 16 ? from + 1 : 1,
    boot_changed: projected ? p.boot_changed === true : typeof p.boot_id === 'string' ? p.boot_id !== (previous?.boot_id ?? frozen.managed?.remote?.boot_id) : false,
    supported: p.supported === true && !frozen.blockers?.length, cgroup: { previous_path: path(oldPath), observed_path: path(observedPath), changed: path(oldPath) !== path(observedPath) },
    actions: (Array.isArray(p.actions) ? p.actions : []).filter(a => RECOVERY_ACTIONS.includes(a?.id)).slice(0, 2).map(a => ({ ...scalars(a, ['id', 'privileged', 'effect']),
      label: a.id === 'start_original_unit' ? '单独批准启动原委派服务（sudo -n）' : '验证并绑定原安装的新运行代次',
      ...(a.id === 'start_original_unit' ? scalars(a, ['unit_path', 'unit_sha256', 'unit_summary']) : {}) })),
    blockers: [...(Array.isArray(p.blockers) ? p.blockers : ['not_confirmed']), ...(frozen.blockers ?? [])].slice(0, 32).map(value => { const code = typeof value === 'string' ? value : value?.code; return { code: Object.hasOwn(blockers, code) ? code : 'not_confirmed', message: blockers[code] ?? blockers.not_confirmed }; }),
    old_commands: { status: projected && ['stopped', 'unconfirmed', 'unavailable'].includes(p.old_commands?.status) ? p.old_commands.status : p.commands?.supported === true ? p.commands.total === 0 ? 'stopped' : 'unconfirmed' : 'unavailable',
      message: '只观察物理停止证据；旧 Worker／Run、输出、副作用、交付与清理未知不会因此解除' },
    ...(budgets ? { verification_budgets: scalars(budgets, ['max_commands', 'timeout_ms', 'output_bytes']) } : {}),
  }, stages: (Array.isArray(item.stages) ? item.stages : []).filter(stage => ['check_original', 'bind_runtime_generation', 'verify_runner', 'seal_generation', 'publish_generation', 'activate_generation'].includes(stage.id)).slice(0, 8).map(stage => scalars(stage, ['id', 'status'])) };
  if (item.observations?.length || item.observation) { const value = item.observations?.at(-1) ?? item.observation; result.observation = { ...scalars(value, ['id', 'status']),
    remote_status: ['unknown', 'prepared', 'sealed', 'activated'].includes(value.remote_status) ? value.remote_status : 'unknown' }; }
  return result;
}
export function publicRecoveryState(record) {
  const state = record.private_data?.recovery;
  if (!state) return Array.isArray(record.recoveries) ? {
    runtime_generation: Number.isSafeInteger(record.runtime_generation) && record.runtime_generation >= 0 && record.runtime_generation <= 16 ? record.runtime_generation : 0,
    recoveries: record.recoveries.slice(0, 16).map(publicRecovery), recoveries_truncated: record.recoveries_truncated === true || record.recoveries.length > 16 } : {};
  return { runtime_generation: Array.isArray(state.generations) ? state.generations.filter(g => state.items?.some(item => item.id === g.recovery_id && item.status === 'ready')).length : 0,
    recoveries: (Array.isArray(state.items) ? state.items : []).slice(0, 16).map(publicRecovery), recoveries_truncated: (state.items?.length ?? 0) > 16 };
}
