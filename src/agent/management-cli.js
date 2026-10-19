/** Fixed Bun CLI bridge. Executes the real parser/handlers with a non-user client. */
import { createHash } from 'node:crypto';
import { managementInvocation, runManagementRPC } from './management-rpc.js';
import { validateManagementCLI, assertManagementCLICommand, managementCLIParseError, safeManagementCLIError } from './management-cli-protocol.js';
import { main } from '../cli/main.js';
import { safeWorkerQueryError } from '../core/worker-query.js';
import { safeManagementPreflightError } from '../core/management-guidance.js';
import { safeManagementDiagnostic, safeManagementDiagnosticError } from '../core/management-diagnostic.js';

export async function runManagementCLI(argv, requestId, env = process.env, request = runManagementRPC) {
  managementInvocation(env); validateManagementCLI(argv, requestId);
  let entry, result = null, requested = false, diagnostic = null, truncated = false;
  const context = JSON.parse(env.LUSH_RUNTIME_CONTEXT);
  if (!Number.isSafeInteger(context.management_occurrence_id) || context.management_occurrence_id <= 0) throw new Error('current management occurrence required');
  const canonical = (value, depth = 0) => {
    if (depth > 24) throw new Error('CLI parameters exceed depth budget');
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1));
    return Object.fromEntries(Object.keys(value).sort().map(key => [key,canonical(value[key],depth + 1)]));
  };
  const identity = (method, params) => createHash('sha256').update(JSON.stringify(canonical({ actor: context.task_id,
    occurrence: context.management_occurrence_id, method, params }))).digest('hex');
  const client = { token: env.LUSH_AGENT_TOKEN, management: true, requestId: 'fixed-cli-generated-input-id',
    async request(method, params = {}) {
      if (!entry?.rpc.includes(method)) throw new Error('CLI handler requested an undeclared capability');
      // CLI-specific self commands use the ordinary reviewed management methods,
      // never invocation-bound development context.* or a user identity.
      // Same semantic request within one occurrence retains its identity even if
      // the model retries with another tool-call ID or reorders CLI options.
      if (method === 'input.emit') {
        const { client_request_id: _ignored, ...definition } = params;
        params = { ...definition, client_request_id: identity(method,definition) };
      }
      const key = identity(method,params);
      requested = true;
      const response = await request('manager.call', { method, params, request_id: key, cli_command: entry.path }, env);
      if (response?.diagnostic) diagnostic = safeManagementDiagnostic(response.diagnostic);
      truncated ||= response?.truncated === true;
      return response?.status === 'succeeded' && !response.receipt_id ? response.result : response;
    },
  };
  try {
    await main(argv.includes('--json') ? argv : [...argv, '--json'], { executable: 'lush', management: {
      client, assertCommand(value) { assertManagementCLICommand(value); entry = value; },
    }, output(value) { result = value; } });
  } catch (error) {
    if (!requested) throw managementCLIParseError();
    throw error;
  }
  return { exit_code: 0, result, ...(diagnostic ? { diagnostic } : {}),
    ...(truncated ? { truncated: true, coverage: 'bounded_management_projection' } : {}) };
}

if (import.meta.main) {
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk.toString();
      if (Buffer.byteLength(input) > 48000) throw new Error('CLI request exceeds budget');
    }
    const value = JSON.parse(input);
    if (!value || Object.keys(value).some(key => !['argv','request_id'].includes(key))) throw new Error('invalid CLI request');
    const result = await runManagementCLI(value.argv, value.request_id);
    const output = JSON.stringify(result);
    if (Buffer.byteLength(output) > 256 * 1024) throw new Error('CLI response exceeds budget');
    process.stdout.write(output);
  } catch (error) {
    process.stdout.write(JSON.stringify(safeManagementCLIError(error) ?? safeManagementDiagnosticError(error) ?? safeWorkerQueryError(error) ?? safeManagementPreflightError(error) ?? {
      error: '管理 CLI 请求被拒绝或未确认完成；用 help 核对用法，不能自动重试或重放未知副作用。',
    }));
    process.exitCode = 1;
  }
}
