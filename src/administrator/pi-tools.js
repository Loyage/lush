import cp from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMINISTRATOR_TOOL_NAMES, ADMINISTRATOR_TOOL_SCHEMA, ADMINISTRATOR_SYSTEM_PROMPT, validateAdministratorToolRequest } from './tool-protocol.js';

const BRIDGE = fileURLToPath(new URL('./tool-bridge.js', import.meta.url));
export async function administratorToolRequest(value, requestId, signal, env = process.env, { timeoutMs = 30000 } = {}) {
  validateAdministratorToolRequest(value);
  if (!path.isAbsolute(env.LUSH_ADMIN_BUN || '') || !path.isAbsolute(env.LUSH_ADMIN_SOCKET || '') || !env.LUSH_ADMIN_TOKEN || signal?.aborted) throw new Error('administrator invocation is unavailable');
  const child = cp.spawn(env.LUSH_ADMIN_BUN, [BRIDGE], { stdio: ['pipe','pipe','ignore'], env: {
    PATH: env.PATH || '', LUSH_ADMIN_SOCKET: env.LUSH_ADMIN_SOCKET, LUSH_ADMIN_TOKEN: env.LUSH_ADMIN_TOKEN,
  } });
  const closed = new Promise(resolve => child.once('close', resolve));
  let output = '', timer;
  const kill = () => { try { child.kill('SIGKILL'); } catch {} };
  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, result) => { if (settled) return; settled = true; error ? reject(error) : resolve(result); };
      timer = setTimeout(() => { kill(); finish(new Error('administrator tool timed out; effect unknown, do not replay')); }, timeoutMs);
      signal?.addEventListener('abort', kill, { once: true });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { output += chunk; if (Buffer.byteLength(output) > 512000) { kill(); finish(new Error('administrator tool output limit; effect unknown')); } });
      child.on('error', () => finish(new Error('administrator bridge launch failed')));
      child.stdin.on('error', () => finish(new Error('administrator bridge transport failed; effect unknown')));
      child.on('close', code => {
        if (signal?.aborted) { finish(new Error('administrator invocation stopped; effect unknown')); return; }
        try {
          const response = JSON.parse(output);
          if (code !== 0 || response?.ok !== true) { finish(new Error('administrator tool failed; inspect original durable receipt, do not replay')); return; }
          finish(null, response.result);
        } catch { finish(new Error('administrator bridge response unconfirmed; effect unknown')); }
      });
      // Tool-call IDs are local UI correlation only, never transport identity or authorization.
      child.stdin.end(JSON.stringify(value));
      if (signal?.aborted) kill();
    });
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', kill); kill(); await closed; }
}
export function registerAdministratorTools(pi, request = administratorToolRequest, env = process.env) {
  const bound = { PATH: env.PATH, LUSH_ADMIN_BUN: env.LUSH_ADMIN_BUN, LUSH_ADMIN_SOCKET: env.LUSH_ADMIN_SOCKET, LUSH_ADMIN_TOKEN: env.LUSH_ADMIN_TOKEN };
  pi.registerTool({ name: ADMINISTRATOR_TOOL_NAMES[0], label: '管理员执行', exposure: 'model-only',
    description: '独立管理员的可信能力入口。先用 catalog；project.call 指定 canonical project、method、params，保留原业务安全门；源码和服务操作见目录。不提供新管理员输入/确认或凭证工具。unknown 不重放。',
    parameters: ADMINISTRATOR_TOOL_SCHEMA, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async execute(toolCallId, params, signal) {
      validateAdministratorToolRequest(params);
      const result = await request(params, toolCallId, signal, bound);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  });
  const restrict = () => pi.setActiveTools([...ADMINISTRATOR_TOOL_NAMES]);
  pi.on('session_start', restrict);
  pi.on('before_agent_start', () => { restrict(); return { systemPrompt: ADMINISTRATOR_SYSTEM_PROMPT }; });
  pi.on('tool_call', event => ADMINISTRATOR_TOOL_NAMES.includes(event.toolName) ? undefined : { block: true, reason: '管理员仅允许独立可信工具，不开放原生 Shell、文件或未注册工具。' });
}
export default function administratorTools(pi) { registerAdministratorTools(pi); }
