// User configuration only: never synthesize a Shell command from a Hook reference.
export const COMMAND_WARNING = '任意 Shell 命令将在Hook 挂载 Worker 的真实目录中，以 daemon 用户权限执行；这不是沙箱，可读取或修改文件、访问网络及凭证。不调用 Agent；原始输出不公开，未知副作用不自动重放。';
export const commandKind = item => item && Object.hasOwn(item, 'kind') ? item.kind : 'shell';
export const commandBody = item => commandKind(item) === 'prompt' ? item.prompt : item.command;
export const PROMPT_WARNING = '提示词将在已启用的一次性 Hook 触发后，以挂载父 Worker 创建独立指令 Worker 并启动 Agent、消耗 token；创建成功不代表 Agent 工作完成。保存指令本身不启动 Agent。';
export const modernCommands = catalogue => catalogue?.actions?.some(item => item.type === 'prompt_command')
  || catalogue?.commands?.items?.some(item => Object.hasOwn(item, 'kind'));
export const validCommands = model => model?.version === 1 && typeof model.revision === 'string' && !!model.revision.trim()
  && Array.isArray(model.items) && model.items.every(item => item && typeof item.id === 'string' && item.id.length > 0
    && typeof item.name === 'string' && ['shell', 'prompt'].includes(commandKind(item)) && typeof commandBody(item) === 'string'
    && ['description', 'when_to_use', 'examples', 'warnings'].every(key => !Object.hasOwn(item, key) || typeof item[key] === 'string')
    && (!Object.hasOwn(item, 'tags') || Array.isArray(item.tags) && item.tags.every(tag => typeof tag === 'string')) && Number.isSafeInteger(item.version) && item.version > 0
    && (!Object.hasOwn(item, 'default_worker_id') || item.default_worker_id === null || Number.isSafeInteger(item.default_worker_id) && item.default_worker_id > 0));
export const legacyCommands = hook => hook.actions?.some(item => item.type === 'command' && Object.hasOwn(item, 'command'));
export const referencedCommand = (item, catalogue) => validCommands(catalogue?.commands)
  ? catalogue.commands.items.find(command => command.id === item.command_id) : null;
export function commandReferencesIssue(hook, catalogue) {
  const actions = hook.actions?.filter(item => ['command', 'prompt_command'].includes(item.type)) || [];
  if (!actions.length) return null;
  if (legacyCommands(hook)) return '旧内联命令已停止直接执行；请先显式导入快捷指令，再启用 Hook。';
  if (!validCommands(catalogue?.commands)) return '快捷指令目录不可用；请更新服务并刷新，不能校验或执行指令引用。';
  for (const item of actions) {
    const command = referencedCommand(item, catalogue);
    if (!command) return '所引用的指令已删除或不存在；请明确重选指令。';
    if (commandKind(command) !== (item.type === 'prompt_command' ? 'prompt' : 'shell')) return '指令类型不匹配；Shell 与提示词引用不能混用，请明确重选。';
    if (item.type === 'prompt_command' && (hook.trigger && hook.trigger !== 'worker.parent_ready' || hook.mode && hook.mode !== 'once')) return '提示词 Hook 仅支持父 Worker 可创建节点的一次性挂载。';
  }
  return null;
}
export function commandSummary(item, catalogue) {
  if (Object.hasOwn(item, 'command')) return `旧内联命令（已停止直接执行，需显式导入）：\n${item.command}`;
  const command = referencedCommand(item, catalogue);
  const mismatch = command && commandKind(command) !== (item.type === 'prompt_command' ? 'prompt' : 'shell');
  const fixed = Number.isSafeInteger(item.command_version);
  const exact = fixed && item.command_version === command?.version;
  return `快捷指令：${command?.name || item.command_id || '未知指令'}${fixed ? ` · 固定授权 v${item.command_version}` : ' · 未升级旧引用（须显式补登记）'}${command
    ? ` · 当前目录 v${command.version} · ${commandKind(command) === 'prompt' ? '提示词' : 'Shell'}${mismatch ? ' · 类型不匹配；不能执行' : ''}\n${exact ? commandBody(command) : '当前目录正文不代表此授权版本；完整历史定义请经 CLI/API 核对。'}` : validCommands(catalogue?.commands) ? ' · 指令已删除或不存在；不能执行' : ' · 指令目录不可用；无法校验引用'}`;
}
