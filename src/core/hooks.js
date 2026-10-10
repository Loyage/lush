import { createHash } from 'node:crypto';
import { check, id, isPlainObject, text } from './types.js';
import { normalizeHookSchedule } from './hook-schedule.js';

export const HOOK_LIMITS = Object.freeze({ mounts: 32, templates: 50, actions: 4, bytes: 131072, batch: 16 });
export const HOOK_TRIGGERS = Object.freeze([
  ['time.scheduled', '指定时间提交动作', '一次性或每日按显式时区提交待执行动作；安全点尽早准入，不保证 Agent 准点开始，停机错过跳过。'],
  ['agent.started', 'Agent 开始调用', '本轮正式获得执行位。'],
  ['agent.returned', 'Agent 正常返回', '本轮实际退出；可能仍在等待，不代表工作完成。'],
  ['agent.failed', 'Agent 异常结束', '异常、超时或重启发现中断；不自动重试。'],
  ['agent.paused', 'Agent 安全暂停', '用户暂停已实际生效。'],
  ['agent.preempted', 'Agent 输入抢占', '追加输入导致安全收尾，不是失败。'],
  ['worker.delivery_ready', 'Agent 完成工作后', '调用退出、消息、待决及后代已收口；合并仍核验 Git。'],
  ['worker.frozen', 'Worker 进入冻结', '整体分支写门由开放变为冻结。'],
  ['worker.unfrozen', 'Worker 冻结解除', '最后一项冻结原因已释放。'],
  ['worker.parent_ready', 'Worker 可创建子 Worker', '父身份、分支、冻结与同步准入已复核。'],
  ['worker.awaiting', 'Worker 等待用户', '出现尚未回答的待决。'],
  ['worker.resumed', 'Worker 等待结束', '全部待决已解除，不代表交付完成。'],
  ['worker.merge_received', 'Worker 成功接收合并后', '代码已成功合入所挂载 Worker 的分支；每次成功合并独立触发，不代表源 Worker 已验收。'],
  ['delivery.integrated', '交付已落地', '代码已受检合入父分支，仍待验收。'],
  ['delivery.suspended', '交付挂起', '执行位已释放，等待显式恢复。'],
  ['delivery.blocked', '交付待核验', '副作用未知，仍保留父执行位。'],
  ['worker.accepted', 'Worker 已验收', '用户或直接父 Worker 已确认不再有异议，开发资源已归档回收，运行历史保留。'],
  ['worker.cancelled', 'Worker 已取消', '明确取消，不删除代码现场。'],
].map(([id, label, description]) => Object.freeze({ id, label, description })));
const TRIGGERS = new Set(HOOK_TRIGGERS.map(t => t.id));
export const HOOK_ACTIONS = Object.freeze([
  { type: 'command', label: '运行快捷指令', description: '仅调用项目中明确授权的快捷指令版本，以 daemon 用户权限在挂载 Worker 的实际检出目录运行；不是沙箱，失败停用未来执行，输出不公开。', triggers: [...TRIGGERS].filter(t => !['time.scheduled','agent.failed','worker.accepted','worker.cancelled'].includes(t)), modes: ['once','persistent'], agent_call: false },
  { type: 'accept_worker', label: '自动验收', description: '安全校验通过后代替用户确认并归档回收 worktree/ref；保留运行历史，不丢弃脏现场，不调用质量评审 Agent。', triggers: ['delivery.integrated'], modes: ['persistent'], agent_call: false, builtin_only: true },
  { type: 'archive_worker', label: '自动归档', description: '内置串行阶段：已验收后受检归档子树，不丢弃未提交修改。', triggers: ['worker.accepted'], modes: ['persistent'], agent_call: false, builtin_only: true },
  { type: 'request_merge', label: '请求合并', description: '经现有安全检查向直接父队列请求合并。', triggers: ['worker.delivery_ready'], modes: ['once','persistent'], agent_call: true },
  { type: 'create_worker', label: '预约创建 Worker', description: '在所挂载父 Worker 下创建独立工作区，按保存参数启动。', triggers: ['worker.parent_ready','time.scheduled'], modes: ['once'], modes_by_trigger: { 'time.scheduled': ['once','persistent'] }, agent_call: true },
  { type: 'notify', label: '发送告知', description: '只保存纯告知，不启动 Agent。', triggers: [...TRIGGERS], modes: ['once','persistent'], agent_call: false },
  { type: 'message', label: '追加消息', description: '仅当前或直接父子；可能唤醒 Agent。生命周期规则仅一次性，定时规则按所选周期提交，沿用目标运行设置。', triggers: [...TRIGGERS], modes: ['once'], modes_by_trigger: { 'time.scheduled': ['once','persistent'] }, agent_call: true },
  { type: 'retry_worker', label: '重试失败 Worker', description: '仅当前或直接父子；到点只重试 failed，沿用工作区与已有运行设置，不自动判断额度恢复。', triggers: ['time.scheduled'], modes: ['once','persistent'], agent_call: true },
  { type: 'resume_worker', label: '继续暂停 Worker', description: '仅当前或直接父子；到点只继续 paused，不撤销尚未生效的暂停、不恢复取消或已验收工作。', triggers: ['time.scheduled'], modes: ['once','persistent'], agent_call: true },
]);
const STATUSES = new Set(['queued','running','waiting','awaiting','paused','awaiting_acceptance','completed','failed','cancelled']);
const INTEGRATIONS = new Set(['none','pending','review','merging','merged','conflict','superseded']);
export const hookRevision = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function hookObject(value, keys, label) {
  check(isPlainObject(value) && Object.keys(value).every(k => keys.includes(k)), `invalid ${label} fields`);
}
function choices(values, allowed, label) {
  check(Array.isArray(values) && values.length <= allowed.size && values.every(v => allowed.has(v)), `invalid hook ${label}`);
  return [...new Set(values)];
}
export function normalizeHook(value) {
  hookObject(value, ['name','trigger','mode','enabled','conditions','actions','schedule'], 'hook');
  text(value.name, 'hook name'); check(value.name.length <= 120, 'hook name exceeds 120 characters');
  check(TRIGGERS.has(value.trigger), 'unknown hook trigger');
  check(['once','persistent'].includes(value.mode), 'hook mode must be once or persistent');
  check(typeof value.enabled === 'boolean', 'hook enabled must be boolean');
  const conditions = value.conditions ?? {};
  hookObject(conditions, ['statuses','integrations'], 'hook conditions');
  const normalized = { name: value.name, trigger: value.trigger, mode: value.mode, enabled: value.enabled,
    conditions: { ...(conditions.statuses !== undefined ? { statuses: choices(conditions.statuses, STATUSES, 'statuses') } : {}),
      ...(conditions.integrations !== undefined ? { integrations: choices(conditions.integrations, INTEGRATIONS, 'integrations') } : {}) } };
  if (value.trigger === 'time.scheduled') normalized.schedule = normalizeHookSchedule(value.schedule, value.mode);
  else check(value.schedule === undefined, 'schedule is only allowed for time.scheduled hooks');
  check(Array.isArray(value.actions) && value.actions.length >= 1 && value.actions.length <= HOOK_LIMITS.actions, 'hook requires 1-4 actions');
  normalized.actions = value.actions.map(action => {
    const entry = HOOK_ACTIONS.find(a => a.type === action?.type);
    check(entry && !entry.builtin_only && entry.triggers.includes(value.trigger), 'hook action is not allowed at this trigger or is built-in only');
    check((entry.modes_by_trigger?.[value.trigger] ?? entry.modes).includes(value.mode), `${entry.type} hooks must be once to prevent repeated side effects`);
    if (action.type === 'command') {
      hookObject(action, ['type','command_id','command_version'], 'command action');
      check(typeof action.command_id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(action.command_id)
        && Number.isSafeInteger(action.command_version) && action.command_version > 0, 'invalid shortcut command reference');
      return { type: action.type, command_id: action.command_id, command_version: action.command_version };
    }
    if (action.type === 'request_merge') { hookObject(action, ['type'], 'merge action'); return { type: action.type }; }
    if (action.type === 'create_worker') {
      hookObject(action, ['type','content','references','start','profile'], 'create action');
      check(value.trigger === 'time.scheduled' || value.mode === 'once', 'Worker creation hooks must be once'); text(action.content, 'hook content');
      check(action.start === undefined || typeof action.start === 'boolean', 'hook start must be boolean');
      check(action.references === undefined || Array.isArray(action.references), 'hook references must be an array');
      check(action.profile === undefined || isPlainObject(action.profile), 'invalid hook profile');
      return { type: action.type, content: action.content, references: action.references ?? [], start: action.start !== false,
        ...(action.profile !== undefined ? { profile: action.profile } : {}) };
    }
    if (action.type === 'notify') {
      hookObject(action, ['type','title','body'], 'notify action'); text(action.title, 'hook title');
      check(typeof action.body === 'string' && action.body.length <= 32000, 'invalid hook notice body');
      return { type: action.type, title: action.title, body: action.body };
    }
    if (['retry_worker','resume_worker'].includes(action.type)) {
      hookObject(action, ['type','target_id','profile'], 'Worker restart action');
      check(action.profile === undefined || isPlainObject(action.profile), 'invalid hook profile');
      return { type: action.type, target_id: id(action.target_id), ...(action.profile !== undefined ? { profile: action.profile } : {}) };
    }
    hookObject(action, ['type','target_id','body'], 'message action'); text(action.body, 'hook message');
    // Persistent automatic messages can re-awaken each other's Agents indefinitely. One-shot is an explicit fuse.
    check(value.trigger === 'time.scheduled' || value.mode === 'once', 'message hooks must be once to prevent recursive Agent calls');
    return { type: action.type, target_id: id(action.target_id), body: action.body };
  });
  check(Buffer.byteLength(JSON.stringify(normalized)) <= HOOK_LIMITS.bytes, 'hook definition is too large');
  check(normalized.actions.filter(a => a.type === 'create_worker').length <= 1, 'a hook can create only one Worker');
  return normalized;
}
export function publicHookDefinition(definition) {
  return { name: definition.name, trigger: definition.trigger, mode: definition.mode, enabled: definition.enabled,
    conditions: definition.conditions, ...(definition.schedule ? { schedule: { ...definition.schedule } } : {}), actions: definition.actions.map(({ profile, ...action }) => ({ ...action,
      ...(profile ? { model_selection: { agent: profile.agent, config_mode: profile.config_mode === 'pi' ? 'pi' : 'lush',
        connection_id: profile.connection_id || null, model: profile.model || '', thinking: profile.thinking || '', explicit: true } } : {}) })) };
}
export function hookConditionsMatch(hook, task) {
  return (!hook.conditions.statuses?.length || hook.conditions.statuses.includes(task.status))
    && (!hook.conditions.integrations?.length || hook.conditions.integrations.includes(task.integration));
}
