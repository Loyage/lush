// User configuration only: never synthesize a Shell command from a Hook reference.
export const COMMAND_WARNING = '任意 Shell 命令将在所选 Worker 的真实目录中，以 daemon 用户权限执行；这不是沙箱，可读取或修改文件、访问网络及凭证。不调用 Agent；原始输出不公开，未知副作用不自动重放。';
export const validCommands = model => model?.version === 1 && typeof model.revision === 'string' && !!model.revision.trim()
  && Array.isArray(model.items) && model.items.every(item => typeof item.id === 'string' && item.id.length > 0
    && typeof item.name === 'string' && typeof item.command === 'string' && Number.isSafeInteger(item.version) && item.version > 0 && typeof item.authorized === 'boolean');
export const legacyCommands = hook => hook.actions?.some(item => item.type === 'command' && Object.hasOwn(item, 'command'));
export const referencedCommand = (item, catalogue) => validCommands(catalogue?.commands)
  ? catalogue.commands.items.find(command => command.id === item.command_id && command.version === item.command_version) : null;
export function commandReferencesIssue(hook, catalogue, requireAuthorization = true) {
  const actions = hook.actions?.filter(item => item.type === 'command') || [];
  if (!actions.length) return null;
  if (legacyCommands(hook)) return '旧内联命令已停止直接执行；请先显式导入快捷指令并重新授权。';
  if (!validCommands(catalogue?.commands)) return '快捷指令目录不可用；请更新服务并刷新，不能授权或执行命令。';
  for (const item of actions) {
    const command = referencedCommand(item, catalogue);
    if (!command) return '引用版本已变更或指令已删除；请明确选择新版本，不会自动升级引用。';
    if (requireAuthorization && !command.authorized) return '所引用的快捷指令版本未授权或已撤权；请先在快捷指令区授权。';
  }
  return null;
}
export function commandSummary(item, catalogue) {
  if (Object.hasOwn(item, 'command')) return `旧内联命令（已停止直接执行，需显式导入）：\n${item.command}`;
  const command = referencedCommand(item, catalogue);
  return `快捷指令：${command?.name || item.command_id || '未知指令'} · v${item.command_version ?? '?'}${command
    ? ` · ${command.authorized ? '已授权' : '未授权／已撤权'}\n${command.command}` : ' · 引用版本不可用；不会自动升级'}`;
}
