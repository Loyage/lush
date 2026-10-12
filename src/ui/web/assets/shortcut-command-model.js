// User configuration only: never synthesize a Shell command from a Hook reference.
export const COMMAND_WARNING = '任意 Shell 命令将在所选 Worker 的真实目录中，以 daemon 用户权限执行；这不是沙箱，可读取或修改文件、访问网络及凭证。不调用 Agent；原始输出不公开，未知副作用不自动重放。';
export const commandKind = item => item && Object.hasOwn(item, 'kind') ? item.kind : 'shell';
export const commandBody = item => commandKind(item) === 'prompt' ? item.prompt : item.command;
export const PROMPT_WARNING = '提示词将以所选父 Worker 创建独立指令 Worker 并启动 Agent；创建成功不代表 Agent 工作完成。未来手动执行及已启用的一次性 Hook 会消耗 token；保存和授权本身不启动 Agent。';
export const modernCommands = catalogue => catalogue?.actions?.some(item => item.type === 'prompt_command')
  || catalogue?.commands?.items?.some(item => Object.hasOwn(item, 'kind'));
export function promptParents(parents) {
  if (!Array.isArray(parents?.items)) throw new Error('Parent list unavailable');
  return parents.items.filter(item => Number.isSafeInteger(item.id) && item.id > 0 && item.branch
    && (!item.task_kind || ['main', 'owner', 'order', 'say'].includes(item.task_kind)));
}
export const validCommands = model => model?.version === 1 && typeof model.revision === 'string' && !!model.revision.trim()
  && Array.isArray(model.items) && model.items.every(item => item && typeof item.id === 'string' && item.id.length > 0
    && typeof item.name === 'string' && ['shell', 'prompt'].includes(commandKind(item)) && typeof commandBody(item) === 'string'
    && ['description', 'when_to_use', 'examples', 'warnings'].every(key => !Object.hasOwn(item, key) || typeof item[key] === 'string')
    && (!Object.hasOwn(item, 'tags') || Array.isArray(item.tags) && item.tags.every(tag => typeof tag === 'string')) && Number.isSafeInteger(item.version) && item.version > 0 && typeof item.authorized === 'boolean'
    && (!Object.hasOwn(item, 'default_worker_id') || item.default_worker_id === null || Number.isSafeInteger(item.default_worker_id) && item.default_worker_id > 0));
// Parent candidates are complete for creation; snapshot adds active children.
// Keep snapshot safety facts when a parent projection only provides identity.
export function commandWorkers(parents, snapshot) {
  if (!Array.isArray(parents?.items) || !Array.isArray(snapshot?.tasks)) throw new Error('Worker list unavailable');
  const map = new Map();
  for (const item of snapshot.tasks) if (['main', 'owner', 'order', 'say', 'child'].includes(item.task_kind) && !['completed', 'failed', 'cancelled'].includes(item.status)) map.set(item.id, item);
  for (const item of parents.items) map.set(item.id, { ...map.get(item.id), ...item });
  return [...map.values()].filter(item => Number.isSafeInteger(item.id) && item.id > 0 && typeof item.branch === 'string' && item.branch);
}
export function workerDirectoryReason(item) {
  if (!item) return '目录已失效';
  if (item.archived || item.branch_archive?.archived || ['completed', 'failed', 'cancelled'].includes(item.status)) return '目录已失效';
  if (item.freeze || ['requested', 'executing', 'resolving', 'blocked'].includes(item.reservation?.status)) return '冻结，暂不可执行';
  return null;
}
export const legacyCommands = hook => hook.actions?.some(item => item.type === 'command' && Object.hasOwn(item, 'command'));
export const referencedCommand = (item, catalogue) => validCommands(catalogue?.commands)
  ? catalogue.commands.items.find(command => command.id === item.command_id && command.version === item.command_version) : null;
export function commandReferencesIssue(hook, catalogue, requireAuthorization = true) {
  const actions = hook.actions?.filter(item => ['command', 'prompt_command'].includes(item.type)) || [];
  if (!actions.length) return null;
  if (legacyCommands(hook)) return '旧内联命令已停止直接执行；请先显式导入快捷指令并重新授权。';
  if (!validCommands(catalogue?.commands)) return '快捷指令目录不可用；请更新服务并刷新，不能授权或执行命令。';
  for (const item of actions) {
    const command = referencedCommand(item, catalogue);
    if (!command) return '引用版本已变更或指令已删除；请明确选择新版本，不会自动升级引用。';
    if (commandKind(command) !== (item.type === 'prompt_command' ? 'prompt' : 'shell')) return '指令类型不匹配；Shell 与提示词引用不能混用，请明确重选。';
    if (item.type === 'prompt_command' && (hook.trigger && hook.trigger !== 'worker.parent_ready' || hook.mode && hook.mode !== 'once')) return '提示词 Hook 仅支持父 Worker 可创建节点的一次性挂载。';
    if (requireAuthorization && !command.authorized) return '所引用的快捷指令版本未授权或已撤权；请先在快捷指令区授权。';
  }
  return null;
}
export function commandSummary(item, catalogue) {
  if (Object.hasOwn(item, 'command')) return `旧内联命令（已停止直接执行，需显式导入）：\n${item.command}`;
  const command = referencedCommand(item, catalogue);
  return `快捷指令：${command?.name || item.command_id || '未知指令'} · v${item.command_version ?? '?'}${command
    ? ` · ${commandKind(command) === 'prompt' ? '提示词' : 'Shell'} · ${command.authorized ? '已授权' : '未授权／已撤权'}\n${commandBody(command)}` : ' · 引用版本不可用；不会自动升级'}`;
}
