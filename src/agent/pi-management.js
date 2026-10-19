/** Trusted Pi adapter: one fixed real CLI, never a shell or a user RPC client. */
import cp from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { managementInvocation } from './management-rpc.js';
import { validateManagementCLI, managementCLIParseError, safeManagementCLIError } from './management-cli-protocol.js';
import { builtInPrompt } from './prompts.js';
import { safeWorkerQueryError } from '../core/worker-query.js';
import { safeManagementPreflightError } from '../core/management-guidance.js';
import { safeManagementDiagnosticError } from '../core/management-diagnostic.js';

const HELPER = fileURLToPath(new URL('./management-cli.js', import.meta.url));
export const MANAGEMENT_TOOL_NAMES = Object.freeze(['lush_cli']);
const MAX_OUTPUT = 256 * 1024;
const UNCONFIRMED = '管理请求被拒绝或未确认完成；副作用可能已经发生，不能换身份或自动重试。可用 lush_cli 的 help 核对用法和授权前置条件；未知执行结果须交用户检查。';

/** Node Pi runs only the fixed, bounded Bun bridge. No caller executable/cwd/env. */
export async function managementCLIRequest(argv, requestId, signal, env = process.env, { timeoutMs = 30000 } = {}) {
  managementInvocation(env); validateManagementCLI(argv, requestId);
  if (!path.isAbsolute(env.LUSH_MANAGER_BUN || '')) throw new Error('trusted management CLI bridge is unavailable');
  if (signal?.aborted) throw new Error(UNCONFIRMED);
  const child = cp.spawn(env.LUSH_MANAGER_BUN, [HELPER], { stdio: ['pipe', 'pipe', 'ignore'], env: {
    PATH: env.PATH || '', LUSH_PROJECT: env.LUSH_PROJECT, LUSH_HOME: env.LUSH_HOME,
    LUSH_TASK_ID: env.LUSH_TASK_ID, LUSH_AGENT_TOKEN: env.LUSH_AGENT_TOKEN,
    LUSH_RUNTIME_CONTEXT: env.LUSH_RUNTIME_CONTEXT, LUSH_MANAGER_RPC_SOCKET: env.LUSH_MANAGER_RPC_SOCKET,
  } });
  const closed = new Promise(resolve => child.once('close', resolve));
  let output = '', timer;
  const kill = () => { try { child.kill('SIGKILL'); } catch {} };
  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        error ? reject(error) : resolve(result);
      };
      timer = setTimeout(() => { kill(); finish(new Error(UNCONFIRMED)); }, timeoutMs);
      timer.unref?.();
      signal?.addEventListener('abort', kill, { once: true });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        output += chunk;
        if (Buffer.byteLength(output) > MAX_OUTPUT) { kill(); finish(new Error(UNCONFIRMED)); }
      });
      child.stdin.on('error', () => { kill(); finish(new Error(UNCONFIRMED)); });
      child.on('error', () => finish(new Error(UNCONFIRMED)));
      child.on('close', code => {
        if (signal?.aborted) { finish(new Error(UNCONFIRMED)); return; }
        try {
          const response = JSON.parse(output);
          if (code !== 0) {
            const safe = safeManagementCLIError(response) ?? safeManagementDiagnosticError(response) ?? safeWorkerQueryError(response) ?? safeManagementPreflightError(response);
            if (safe) { finish(Object.assign(new Error(JSON.stringify(safe)), safe)); return; }
            throw new Error();
          }
          if (!response || response.exit_code !== 0 || !Object.hasOwn(response, 'result')) throw new Error();
          finish(null, response);
        } catch { finish(new Error(UNCONFIRMED)); }
      });
      child.stdin.end(JSON.stringify({ argv, request_id: requestId }));
      if (signal?.aborted) kill();
    });
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', kill); kill(); await closed;
  }
}

export function registerManagementTools(pi, request = managementCLIRequest, env = process.env) {
  const bound = { ...env };
  pi.registerTool({ name: 'lush_cli', label: 'Lush CLI', exposure: 'model-only',
    description: '运行固定可信 lush CLI 的 argv 数组（不含 lush/bun 前缀），共用真实解析、help 和用法。先调用 ["help"] 或 ["help","worker","inspect"]；无 Shell、文件、跨项目、交互认证或环境覆盖。JSON 负载用命令支持的 --data/--questions-json，不读本地文件。当前项目与 management 身份固定；写入仍逐项授权/精确确认，unknown 不重放。',
    parameters: { type: 'object', properties: { argv: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 128 } }, required: ['argv'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async execute(toolCallId, params, signal) {
      try {
        if (!params || Object.keys(params).some(key => key !== 'argv')) throw managementCLIParseError();
        managementInvocation(bound); validateManagementCLI(params.argv, toolCallId);
      } catch (error) {
        const safe = safeManagementCLIError(error);
        if (safe) throw Object.assign(new Error(JSON.stringify(safe)),safe);
        throw error;
      }
      const result = await request(params.argv, toolCallId, signal, bound);
      const text = JSON.stringify(result);
      if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_OUTPUT) throw new Error(UNCONFIRMED);
      return { content: [{ type: 'text', text }], details: result };
    },
  });
  const restrict = () => pi.setActiveTools([...MANAGEMENT_TOOL_NAMES]);
  pi.on('session_start', restrict);
  pi.on('before_agent_start', () => { restrict(); return { systemPrompt: builtInPrompt('manager') }; });
  pi.on('tool_call', event => {
    if (!MANAGEMENT_TOOL_NAMES.includes(event.toolName)) return { block: true, reason: 'Valet 只允许固定 lush_cli，不开放文件、Shell 或未审核 RPC。' };
  });
}
export default function lushManagement(pi) { registerManagementTools(pi); }
