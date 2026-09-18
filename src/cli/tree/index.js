import { daemonGroup } from './daemon.js';
import { agentGroup } from './agent.js';
import { serviceGroup } from './service.js';
import { taskGroup } from './task.js';
import { callCommand } from './call.js';

/**
 * The root of the CLI declaration tree.
 *
 * Every layer documents itself: `summary` is the one-line entry shown in the
 * parent's listing, `cover` says what the layer does and does not cover,
 * `usage` / `positionals` / `options` describe how to call it, `children`
 * holds the next layer down. Rendering and parsing both read this table, so
 * `help` can never drift from the real parser.
 */
export const ROOT = {
  summary: 'AI 的操作系统：被动的 Service 节点 + 会干活的 Task',
  cover: [
    'CLI 是 daemon（lushd）的客户端，通过 Unix socket 上的 JSON-RPC 操作 Lush，自身不持有状态。',
    '两类东西：Service 是被动节点（身份、变量、持久 state、权限、生命周期），Task 是挂在 service 上的一次工作（有自己的 agent、会话与 result）。',
    '入口是 `lush call SID \'<目标>\'`：在某个 service 上开一个根 task 并等它结束；task 会向下游 service 派子 task，`lush task tree` 能看到这棵树。',
    '命令分三层：顶层 → 命令组（daemon / service / task / agent）→ 具体命令，再往下是参数；每一层都有 help。',
    'daemon 未运行时，`lush agent ...` 仍可用（它只读写 $LUSH_HOME/agents/*.json），其余命令会连接失败（退出码 1）。',
  ],
  usage: ['lush [--json] <command> [args]', 'lush [--json] help [command [subcommand]]'],
  children: {
    call: callCommand,
    task: taskGroup,
    service: serviceGroup,
    daemon: daemonGroup,
    agent: agentGroup,
  },
};
