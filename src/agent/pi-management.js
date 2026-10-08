/** Trusted Pi extension: three management tools, no model-controlled command or RPC method. */
import cp from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { managementInvocation, validateManagementRPC } from './management-rpc.js';
import { builtInPrompt } from './prompts.js';

const HELPER = fileURLToPath(new URL('./management-rpc.js', import.meta.url));
export const MANAGEMENT_TOOL_NAMES = Object.freeze(['manager_query', 'manager_start', 'manager_retry']);
const workerSchema = { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'string', pattern: '^W[1-9][0-9]*(?:-[1-9][0-9]*)*$' }],
  description: '当前项目 Worker 的内部整数 ID 或精确持久编号（如 W117、W117-1），不能猜测编号。' };
const MAX_OUTPUT = 256 * 1024;
const UNCONFIRMED = '管理请求被拒绝或未确认完成；副作用可能已经发生，不能换身份或自动重试。';

/** Node Pi cannot use Bun.connect. Run only the fixed trusted Bun bridge for one bounded request. */
export async function managementRPCRequest(method, params, signal, env = process.env) {
  managementInvocation(env); validateManagementRPC(method, params);
  if (!path.isAbsolute(env.LUSH_MANAGER_BUN || '')) throw new Error('trusted management RPC bridge is unavailable');
  if (signal?.aborted) throw new Error(UNCONFIRMED);
  const child = cp.spawn(env.LUSH_MANAGER_BUN, [HELPER], { stdio: ['pipe', 'pipe', 'ignore'], env: {
    // The bridge needs no model credential, user Pi settings or caller-supplied executable resources.
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
      timer = setTimeout(() => { kill(); finish(new Error(UNCONFIRMED)); }, 30000);
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
        if (signal?.aborted || code !== 0) { finish(new Error(UNCONFIRMED)); return; }
        try {
          const response = JSON.parse(output);
          if (!response || Object.hasOwn(response, 'error') || !Object.hasOwn(response, 'result')) throw new Error();
          finish(null, response.result);
        } catch { finish(new Error(UNCONFIRMED)); }
      });
      child.stdin.end(JSON.stringify({ method, params }));
      if (signal?.aborted) kill();
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', kill);
    kill();
    await closed;
  }
}

function validateWorker(params, required) {
  if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => key !== 'worker'))
    throw new Error('only the Worker selector is accepted');
  if (params.worker === undefined && !required) return undefined;
  const worker = params.worker;
  if (Number.isSafeInteger(worker) && worker > 0) return worker;
  if (typeof worker === 'string' && /^W[1-9]\d*(?:-[1-9]\d*)*$/.test(worker)) return worker;
  throw new Error('worker must be a positive internal ID or a persistent W number');
}

export function registerManagementTools(pi, request = managementRPCRequest, env = process.env) {
  // Capture the invocation, never reread a replacement token or fall back to a user RPC.
  const bound = { ...env };
  const call = async (method, params, signal) => {
    managementInvocation(bound); validateManagementRPC(method, params);
    if (signal?.aborted) throw new Error(UNCONFIRMED);
    return request(method, params, signal, bound);
  };
  for (const [name, method, label, description] of [
    ['manager_query', 'manager.query', '查询 Worker', '查询当前项目的有界 Worker 摘要或单目标安全诊断；不读文件、会话或凭证。'],
    ['manager_start', 'manager.start', '开始／继续 Worker', '只提交开始／继续 paused 的开发 Worker。waiting 由 runtime 持久等待安全点，提交后结束本轮，不轮询。'],
    ['manager_retry', 'manager.retry', '重试失败 Worker', '只提交重试 failed 的开发 Worker，保留已有运行设置。成功不是任务完成或额度恢复；unknown／异常不能自动重试。'],
  ]) {
    pi.registerTool({ name, label, description, exposure: 'model-only',
      // TypeBox 1 schemas are ordinary JSON Schema; no third-party runtime import is needed.
      parameters: { type: 'object', properties: { worker: workerSchema }, additionalProperties: false,
        ...(method === 'manager.query' ? {} : { required: ['worker'] }) },
      annotations: { readOnlyHint: method === 'manager.query', destructiveHint: false, idempotentHint: true, openWorldHint: false },
      async execute(_toolCallId, params, signal) {
        const selector = validateWorker(params, method !== 'manager.query');
        const target = typeof selector === 'string' ? await call('worker.lookup', { number: selector }, signal) : null;
        const id = target ? target.id : selector;
        if (selector !== undefined && (!Number.isSafeInteger(id) || id <= 0)) throw new Error('Worker number did not resolve to a current target');
        const result = await call(method, id === undefined ? {} : { id }, signal);
        const text = JSON.stringify(result);
        if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_OUTPUT) throw new Error('management response exceeds its bound');
        return { content: [{ type: 'text', text }], details: result };
      },
    });
  }
  const restrict = () => pi.setActiveTools([...MANAGEMENT_TOOL_NAMES]);
  pi.on('session_start', restrict);
  pi.on('before_agent_start', () => {
    restrict();
    // Pi's global APPEND_SYSTEM.md can survive --system-prompt even with context discovery off.
    // The documented forced-prompt projection removes ambient system sections from model requests.
    return { systemPrompt: builtInPrompt('manager') };
  });
  // Even a malicious/resumed model tool call cannot reach an inactive built-in or nested tool.
  pi.on('tool_call', event => {
    if (!MANAGEMENT_TOOL_NAMES.includes(event.toolName)) return { block: true, reason: '管理型 Agent 只允许查询、开始／继续和重试失败工具。' };
  });
}

export default function lushManagement(pi) { registerManagementTools(pi); }
