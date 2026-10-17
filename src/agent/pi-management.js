/** Trusted Pi extension: isolated management tools; capability calls remain policy-gated in the daemon. */
import cp from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { managementInvocation, validateManagementRPC, MANAGEMENT_RPC_METHODS } from './management-rpc.js';
import { builtInPrompt } from './prompts.js';
import { isWorkerNumber } from '../core/worker-number.js';

const HELPER = fileURLToPath(new URL('./management-rpc.js', import.meta.url));
export const MANAGEMENT_TOOL_NAMES = Object.freeze(MANAGEMENT_RPC_METHODS.filter(method => method.startsWith('manager.'))
  .map(method => method.replace('.', '_')));
const workerSchema = { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'string', pattern: '^(?:W[1-9][0-9]*(?:-[1-9][0-9]*)*|V[1-9][0-9]*)$' }],
  description: '当前项目 Worker／Valet 的内部整数 ID 或精确持久编号（如 W117、W117-1、V1）；V 查询不授予开发动作权限，不能猜测编号。' };
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
  if (isWorkerNumber(worker)) return worker;
  throw new Error('worker must be a positive internal ID or a persistent W/V number');
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
    ['manager_query', 'manager.query', '查询 Worker／Valet', '查询当前项目的有界开发 Worker 摘要或 Worker／Valet 单目标安全诊断；不读文件、会话或凭证。'],
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
        if (typeof selector === 'string' && target?.worker_number !== selector) throw new Error('invalid Worker/Valet lookup response');
        const id = target ? target.id : selector;
        if (selector !== undefined && (!Number.isSafeInteger(id) || id <= 0)) throw new Error('Worker number did not resolve to a current target');
        const result = await call(method, id === undefined ? {} : { id }, signal);
        const text = JSON.stringify(result);
        if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_OUTPUT) throw new Error('management response exceeds its bound');
        return { content: [{ type: 'text', text }], details: result };
      },
    });
  }
  const resultView = result => {
    const text = JSON.stringify(result);
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_OUTPUT) throw new Error('management response exceeds its bound');
    return { content: [{ type: 'text', text }], details: result };
  };
  pi.registerTool({ name: 'manager_catalog', label: '管理能力目录', exposure: 'model-only',
    description: '列出当前 Lush 全部公开功能及可自动执行、需用户确认、不可用的真实边界；目录不是授权。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute(_id, params, signal) { return resultView(await call('manager.catalog', params, signal)); },
  });
  pi.registerTool({ name: 'manager_history', label: '运行优化诊断材料', exposure: 'model-only',
    description: '分页读取项目调用状态、耗时、模型与事件数量，供流程优化诊断；不读取原始工具参数、输出、提示词或凭证。',
    parameters: { type: 'object', properties: { id: { type: 'integer', minimum: 1 }, before: { type: 'integer', minimum: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute(_id, params, signal) { return resultView(await call('manager.history', params, signal)); },
  });
  pi.registerTool({ name: 'manager_call', label: '提交受控管理操作', exposure: 'model-only',
    description: '调用目录中经过审核的当前项目 lush/lushc 能力。可跨开发树发消息、在显式开发 parent 下派 child、报告自身进度/标题/决策；history/transcript 只返回安全元数据。受控操作（含验收回收）默认自动执行，按最新设备权限检查；用户收紧为 confirmation 时提交精确确认请求。修改接口权限始终须真实用户审核，模型不可自行批准。自身 notice.post 是本轮最后动作，用户答复后续跑同一授权事项。设备设置须用户指令和 scope 参数明确指定。返回 unknown 不重放。',
    parameters: { type: 'object', properties: { method: { type: 'string', maxLength: 128 },
      params: { type: 'object', description: '目录中所选能力的参数；不传 token、凭证、环境变量或私有 Prompt。' },
      request_id: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['method','params'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async execute(toolCallId, params, signal) {
      return resultView(await call('manager.call', { ...params, request_id: params.request_id ?? toolCallId }, signal));
    },
  });
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
    if (!MANAGEMENT_TOOL_NAMES.includes(event.toolName)) return { block: true, reason: 'Valet 只允许可信管理工具，不开放文件、Shell 或未审核 RPC。' };
  });
}

export default function lushManagement(pi) { registerManagementTools(pi); }
