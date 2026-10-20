import { defineCommands } from '../command-spec.js';

export const COMMANDS = defineCommands(add => {
  for (const verb of ['start', 'status', 'stop']) add(`administrator ${verb}`, '', {
    start: '显式启动独立设备级管理员服务，不创建身份或提交指令。',
    status: '只读管理员服务状态；不启动服务、不读取凭据。',
    stop: '停止独立管理员服务并撤销未执行授权；等待真实退出，已发生副作用不回滚。',
  }[verb], '', [], verb === 'status' ? 'local-read' : 'local-write',
  '仅真实用户本地生命周期入口；不向普通 Valet、开发 Worker 或管理员模型开放。创建与每条新输入仅在已登录全局 /#administrator 页面精确确认，不提供 --yes 或自动输入旁路。', {
    parameters: { positionals: [], options: {} }, applicability: ['user'], scope: 'device_user',
    preconditions: ['无 Agent/invocation 身份；不接受 --project；同一后台机器与系统用户。'],
    effects: [verb === 'start' ? '仅启动服务；未确认输入不执行模型。' : verb === 'stop' ? '请求收尾；stopping 不等于已退出。' : '只读，不自动恢复或重放。'],
    recovery: '未知结果只读核对原状态，不自动重发或重放副作用。',
  });
});
