import { defineCommands } from '../command-spec.js';

export const COMMANDS = defineCommands(add => {
  for (const verb of ['start', 'status', 'stop']) add(`administrator ${verb}`, '', {
    start: '显式启动旧全局管理员的只读历史服务，不启动模型或接受新工作。',
    status: '只读旧管理员历史服务状态；不启动服务、不读取凭据。',
    stop: '停止旧管理员历史服务；保留历史和未知副作用，不重放工作。',
  }[verb], '', [], verb === 'status' ? 'local-read' : 'local-write',
  '仅真实用户的旧历史服务生命周期入口；不向 Agent 开放。全局创建与输入已退役，新工作在项目管家中选择单条密码提权；不提供 --yes 或自动输入旁路。', {
    parameters: { positionals: [], options: {} }, applicability: ['user'], scope: 'device_user',
    preconditions: ['无 Agent/invocation 身份；不接受 --project；同一后台机器与系统用户。'],
    effects: [verb === 'start' ? '仅启动只读历史服务；不执行模型。' : verb === 'stop' ? '请求收尾；stopping 不等于已退出。' : '只读，不自动恢复或重放。'],
    recovery: '未知结果只读核对原状态，不自动重发或重放副作用。',
  });
});
