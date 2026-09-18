import { daemonGroup } from './daemon.js';
import { agentGroup } from './agent.js';
import { processGroup } from './process.js';

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
  summary: 'AI 的操作系统：把 AI 工作组织成持久化的逻辑 Process',
  cover: [
    'CLI 是 daemon（lushd）的客户端，通过 Unix socket 上的 JSON-RPC 操作 Lush，自身不持有状态。',
    '命令分三层：顶层 → 命令组（daemon / process / agent）→ 具体命令，再往下是参数；每一层都有 help。',
    'daemon 未运行时，`lush agent ...` 仍可用（它只读写 $LUSH_HOME/agents/*.json），其余命令会连接失败（退出码 1）。',
  ],
  usage: ['lush [--json] <command> [args]', 'lush [--json] help [command [subcommand]]'],
  children: {
    daemon: daemonGroup,
    process: processGroup,
    agent: agentGroup,
  },
};
