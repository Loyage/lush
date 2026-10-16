import { RUNNER_METHODS } from './runner-methods.js';
import { PARAMS, USER_ONLY, AGENT_ONLY } from './registry.js';
import { check, isPlainObject } from '../core/types.js';
import { HOOK_INSTALL_CAPABILITY, validateHookInstallation } from '../core/hook-install.js';
import { CLI_COMMANDS, LUSHC_PATHS, LUSHC_METHODS } from '../cli/catalog.js';

export { LUSHC_METHODS };
// Classify the actual development catalogue, rather than copying its RPC names.
const codeEntries = CLI_COMMANDS.filter(entry => LUSHC_PATHS.has(entry.path));
const codeReads = new Set(codeEntries.filter(entry => entry.kind === 'read').flatMap(entry => entry.rpc));
const codeConfirmations = new Set(codeEntries.filter(entry => entry.kind === 'destructive').flatMap(entry => entry.rpc)
  .filter(method => !codeReads.has(method)));

const reads = new Set([
  'manager.catalog','manager.query','manager.history','system.summary','system.status','system.diagnostics','worker.lookup','worker.inspect','worker.list','worker.activity','worker.page','worker.tree',
  'worker.graph','worker.relations','worker.progress_history','branch.tree','branch.show','graph.get',
  'hooks.list','worker.hooks','hooks.command_history','input.history','input.get','input.parents',
  'notice.list','notice.page','branch.convergence','branch.convergence_list','branch.convergence_runs',
  'branch.convergence_defaults','branch.history','branch.version_graph','worker.delete_preview',
  'agent.connections.list','agent.connections.history','agent.connections.models','agent.usage.config','agent.usage.history',
  'agent.models','agent.resources','agent.selection.resources','agent.packages.list','agent.status','system.settings',
]);
const automatic = new Set(['draft.add','draft.update','draft.remove','input.emit','order.submit','worker.message',
  'input.emission_cancel','input.exclusive_release','worker.resume','worker.retry']);
export const MANAGEMENT_DEVICE_ALIASES = new Set(['hooks.auto_select']);
export function managementDispatchParams(method, params) {
  if (!MANAGEMENT_DEVICE_ALIASES.has(method)) return params;
  // scope is management authorization metadata for these device-only legacy aliases,
  // not a new parameter accepted by their ordinary public RPC handlers.
  const { scope: _explicitDeviceScope, ...definition } = params;
  return definition;
}
const unavailable = new Set([
  ...Object.keys(RUNNER_METHODS), // Node and control credentials are strictly user-owned, even after confirmation.
  'cli.catalog', // User learning surface, not a new manager tool; use manager.catalog.
  'hooks.automation_settings','worker.acceptance_notice', // user configuration, never model-authorized
  'management.permissions','management.permissions_update','management.submit','management.create','management.binding_update', // no self-replicating managers/authorization changes
  'worker.spawn','worker.integrate','worker.resolve_child_divergence','notice.post',
  'agent.config','agent.environment','agent.environment.configure','agent.network','agent.network.configure',
  'agent.connections.save','agent.connections.login.start','agent.connections.login.finish',
  'agent.connections.device.start','agent.connections.device.poll','agent.connections.device.cancel',
  'settings.migration.preview','settings.migration.apply','settings.clear_override',
  'worker.run_settings','worker.code_state','worker.code_tree','worker.code_file',
  'worker.version_graph','worker.version_deliveries','worker.version_commit','worker.version_lineage','worker.version_lineage_commit',
  'worker.reading_page','worker.reading_record','worker.history','worker.history_page',
  'worker.transcript','worker.transcript_latest','worker.transcript_page','worker.transcript_step','worker.transcript_search',
  'worker.runs_page','worker.artifacts_page','worker.artifact', // raw provider/tool material is not a credential-safe read surface
]);
function legacyManagementPolicy(method) {
  if (!Object.hasOwn(PARAMS, method)) return { access: 'unavailable', reason: '当前版本没有此公开功能。' };
  if (method === 'system.stop_if_idle') return { access: 'unavailable',
    reason: '管理执行自身占用后台操作位，无法用空闲停机入口；请用户直接安全停机，或明确确认 system.stop 停止当前项目。' };
  if (reads.has(method)) return { access: 'read', reason: null };
  if (unavailable.has(method) || AGENT_ONLY.has(method) || method.startsWith('manager.') || method.startsWith('progress.'))
    return { access: 'unavailable', reason: '需要用户交互、私有材料或专用身份；请使用用户界面。运行诊断使用 manager.history 的安全摘要。' };
  if (automatic.has(method)) return { access: 'automatic', reason: null };
  if (USER_ONLY.has(method)) return { access: 'confirmation', reason: '必须预检并由用户确认精确操作；模型及自动选择不能授权。' };
  return { access: 'unavailable', reason: '尚未审核为管理能力，不开放泛化 RPC。' };
}

export function managementPolicy(method) {
  if (method === 'hooks.install') return { access: 'confirmation', reason: '安装持续 Shell 自动化必须由用户确认精确命令、目标及触发条件；不立即执行。' };
  if (LUSHC_METHODS.has(method)) {
    if (codeReads.has(method)) return { access: 'read', reason: ['worker.transcript', 'worker.history'].includes(method)
      ? '管家只读安全元数据与续读游标，不返回原始提示词、工具参数、输出或事件正文。' : null };
    if (codeConfirmations.has(method)) return { access: 'confirmation', reason: '必须预检并由用户确认精确操作；模型及自动选择不能授权。' };
    return { access: 'automatic', reason: '仅当前项目的受控代理；自身元数据／决策不冒充开发身份，跨树协作仍通过原安全引擎。' };
  }
  return legacyManagementPolicy(method);
}

export const MANAGEMENT_GROUPS = Object.freeze([
  { id: 'workers', label: '工作与生命周期', description: '查看、提交、继续、重试及管理当前项目工作。' },
  { id: 'inputs', label: '输入与草稿', description: '查看输入历史，编辑草稿及安排条件发射。' },
  { id: 'automation', label: '自动化', description: '读取与配置 Hook、时间信号、快捷指令及自动流程。' },
  { id: 'branches', label: '分支与归并', description: '查看分支历史及管理交付、归并与归档。' },
  { id: 'notices', label: '通知与决定', description: '读取通知，确认后答复或调整已读状态。' },
  { id: 'agents', label: '模型与资源', description: '读取安全模型资源信息；私有配置与凭证仍不可用。' },
  { id: 'system', label: '项目与服务', description: '读取项目诊断，确认后修改设置或服务状态。' },
]);
const groupFor = method => method.startsWith('hooks.') ? 'automation'
  : /^(input|draft)\./.test(method) ? 'inputs' : /^(branch|graph)\./.test(method) ? 'branches'
  : method.startsWith('notice.') ? 'notices' : method.startsWith('agent.') ? 'agents'
  : /^(worker|order|manager|management|progress)\./.test(method) ? 'workers' : 'system';
const names = { 'hooks.install': '安装合并后命令自动化', 'manager.query': '安全工作查询', 'manager.history': '安全调用历史', 'worker.lookup': '解析工作编号',
  'worker.resume': '开始／继续工作', 'worker.retry': '重试失败工作', 'draft.add': '新增草稿',
  'draft.update': '修改草稿', 'draft.remove': '移除草稿', 'order.submit': '提交开发指令',
  'worker.inspect': '查看工作详情', 'system.diagnostics': '项目运行诊断', 'worker.message': '追加工作消息' };
const actionLabels = {
  status: '状态', summary: '概览', diagnostics: '运行诊断', stop: '停止服务', stop_if_idle: '空闲停机',
  configure: '修改配置', settings: '设置', interrupt_all: '中断全部', resume_all: '继续全部',
  clear_override: '清除覆盖', preview: '预检', apply: '应用', config: '配置', models: '模型', resources: '资源',
  network: '出站网络', environment: '环境变量', history: '历史', list: '列表', save: '保存', remove: '移除',
  sampling: '采样策略', query: '查询', start: '开始', finish: '完成', poll: '查询认证进度', cancel: '取消', refresh: '刷新',
  install: '安装', update: '更新', command_save: '保存快捷指令', command_export: '导出快捷指令',
  command_remove: '移除快捷指令', command_history: '快捷指令历史', command_history_remove: '移除快捷指令历史',
  command_import: '导入旧快捷指令', auto_select: '自动选择', completion_defaults: '默认自动链', automation_settings: '自动化默认设置',
  acceptance_notice: '待验收告知', signal_save: '保存时间信号', signal_remove: '移除时间信号',
  permissions: '默认权限', permissions_update: '保存默认权限', create: '创建', binding_update: '更新绑定', submit: '提交',
  catalog: '发现能力目录', call: '受控能力代理', retry: '重试', hooks: '自动化挂载', completion_page: '自动链工作列表',
  completion: '自动链级别', hook_attach: '挂载自动化', hook_update: '更新自动化', hook_remove: '移除自动化',
  get: '读取', parents: '父工作候选', emit: '条件发射', emission_cancel: '取消发射', exclusive_release: '释放独占', add: '新增',
  auto_title: '自动标题', rename: '重命名', lookup: '解析编号', graph: '关系图', activity: '活动', page: '分页列表',
  tree: '工作树', inspect: '详情', run_settings: '运行设置', progress_history: '进度历史', relations: '关系',
  version_graph: '版本图', version_deliveries: '交付版本', version_commit: '提交内容', version_lineage: '分支历程', version_lineage_commit: '历程提交内容', reading_page: '完整历史分页',
  reading_record: '完整历史记录', history_page: '历史分页', diff: '代码差异', usage: '用量', code_state: '代码状态',
  code_tree: '代码目录', code_file: '代码文件', transcript: '原始执行记录', transcript_latest: '最近执行记录',
  transcript_page: '执行记录分页', transcript_step: '执行步骤', transcript_search: '搜索执行记录', runs_page: '调用分页',
  artifacts_page: '产物分页', artifact: '产物', spawn: '派生子工作', integrate: '旧交付入口', reserve: '请求合并',
  reserve_all: '批量请求合并', auto_merge: '自动合并开关', resolve: '处理合并', resolve_divergence: '处理合并分歧',
  accept: '验收与回收', reopen: '重新打开', sync_parent: '同步父基线', resolve_sync: '处理同步分歧',
  resolve_child_divergence: '子工作分歧回复', unreserve: '撤销预约', approve_merge: '确认旧合并', message: '追加消息',
  cleanup: '清理资源', delete_preview: '删除预检', delete: '彻底删除', interrupt: '安全中断', resume: '开始／继续',
  plan: '规划里程碑', complete: '完成里程碑', sync: '同步通知', post: '发布', answer: '答复', dismiss: '忽略', read: '标记已读',
  show: '详情', bind: '绑定', archive: '归档', convergence: '归并状态', convergence_list: '归并列表',
  convergence_set: '设置归并', convergence_defaults: '归并默认值', convergence_defaults_set: '设置归并默认值',
  convergence_runs: '归并记录', convergence_retry: '重试归并',
};
const methodLabel = method => names[method] ?? `${MANAGEMENT_GROUPS.find(group => group.id === groupFor(method)).label} · ${actionLabels[method.split('.').at(-1)] ?? method}`;
export function managementAllowedAccess(base, method) {
  if (method === 'manager.catalog') return ['read']; // Necessary discovery, not optional execution authority.
  return { read: ['read','unavailable'], automatic: ['automatic','confirmation','unavailable'],
    confirmation: ['confirmation','unavailable'], unavailable: ['unavailable'] }[base];
}
// Authorization records are complete, not overlays: absent methods fail closed.
// Live callers supply the current effective policy; null is only the historical
// fallback for receipts that already started under the original reviewed policy.
export function effectiveManagementPolicy(method, snapshot = null) {
  const base = managementPolicy(method);
  if (method === 'manager.catalog') return base;
  if (!snapshot) return legacyManagementPolicy(method);
  const access = Object.hasOwn(snapshot.permissions ?? {}, method) ? snapshot.permissions[method] : 'unavailable';
  if (!managementAllowedAccess(base.access, method).includes(access)) return { access: 'unavailable', reason: '授权记录未授权此功能。' };
  return { access, reason: access === 'unavailable' && base.access !== 'unavailable'
    ? '最新管家权限禁止此功能。' : base.reason };
}
export function managementPermissionMethods(snapshot = null) {
  return Object.keys(PARAMS).map(method => {
    const base = managementPolicy(method), effective = snapshot === null ? base : effectiveManagementPolicy(method, snapshot), group = groupFor(method);
    const label = methodLabel(method);
    return { method, group, label,
      description: `${label}（${method}）。${base.reason ?? '仅当前项目，仍通过原入口安全校验。'}`,
      base_access: base.access, ...effective, allowed_access: [...managementAllowedAccess(base.access, method)] };
  });
}
export function managementCatalog(snapshot = null, legacy = false) {
  const effectiveSnapshot = legacy ? { permissions: Object.fromEntries(Object.keys(PARAMS)
    .map(method => [method, legacyManagementPolicy(method).access])) } : snapshot;
  return { scope: 'current_project', groups: MANAGEMENT_GROUPS.map(group => ({ ...group })),
    methods: managementPermissionMethods(effectiveSnapshot).map(item => ({ ...item,
      parameters: [...PARAMS[item.method], ...(MANAGEMENT_DEVICE_ALIASES.has(item.method) ? ['scope'] : [])],
      ...(item.method === 'hooks.install' ? HOOK_INSTALL_CAPABILITY : {}) })),
    limitations: ['无任意 Shell 或文件工具', '不读取凭证、原始会话或私有配置', '不跨项目',
      '设备操作须指令及 scope 参数显式指定', '未知副作用不自动重放'] };
}

export function validateManagementCall(method, params, instruction = '', snapshot = null) {
  check(typeof method === 'string' && Object.hasOwn(PARAMS, method), 'unknown management capability');
  const policy = effectiveManagementPolicy(method, snapshot);
  check(policy.access !== 'unavailable', policy.reason);
  check(isPlainObject(params) && Object.keys(params).every(key => PARAMS[method].includes(key)
    || key === 'scope' && MANAGEMENT_DEVICE_ALIASES.has(method)), 'unknown management parameter');
  // Auth identities and secret-bearing payloads must never be model-controlled, including nested dictionaries.
  const visit = (value, depth = 0) => {
    check(depth < 20, 'management parameter nesting exceeds limit');
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      check(!['_token','credential','credentials','agent_token','agent_token_hash','env','default_prompt','append_prompt'].includes(key),
        'private authentication, environment and prompt payloads require the user interface');
      visit(child, depth + 1);
    }
  };
  visit(params);
  check(Buffer.byteLength(JSON.stringify(params)) <= 32768, 'management parameters exceed limit');
  const projectMountScope = method === 'branch.convergence_defaults_set';
  if (!projectMountScope && Object.hasOwn(params, 'scope')) {
    check(params.scope === 'device', 'management settings must explicitly select device scope');
    check(/设备|全局|device/i.test(instruction), 'device scope must be explicitly requested in the user instruction');
  } else if (!projectMountScope && (PARAMS[method].includes('scope') || MANAGEMENT_DEVICE_ALIASES.has(method)) && method !== 'agent.status') {
    check(false, 'device settings require explicit scope in both user instruction and parameters');
  }
  // Validate the complete install before asking for authorization, not after confirmation.
  if (method === 'hooks.install') validateHookInstallation(params);
  // Strict registry validation still runs at the trusted dispatch boundary; never accept a replacement actor.
  return policy;
}
