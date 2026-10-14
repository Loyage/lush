import { check } from '../core/types.js';
import { PARAMS, MANAGER_METHODS, INTEGRATION_METHODS, assertAllowed } from './registry.js';
import { publicResult } from './public-result.js';
import { LUSHC_METHODS } from './management-policy.js';
import { assertManagementCapabilityExecution, dispatchManagementCode } from '../core/project/management-code.js';
import { handlers as systemHandlers } from './handlers/system.js';
import { handlers as inputHandlers } from './handlers/input.js';
import { handlers as taskHandlers } from './handlers/task.js';
import { handlers as specHandlers } from './handlers/spec.js';
import { handlers as noticeHandlers } from './handlers/notice.js';
import { handlers as branchHandlers } from './handlers/branch.js';
import { handlers as candidateHandlers } from './handlers/candidate.js';
import { handlers as hookHandlers } from './handlers/hooks.js';

/** 合并各 handler 表：重名说明两个分区认领了同一个方法，PARAMS 里没有对应 handler 说明拆漏了。 */
function mergeHandlers(groups) {
  const table = {};
  for (const group of groups) for (const [method, handler] of Object.entries(group)) {
    if (Object.hasOwn(table, method)) throw new Error(`duplicate RPC handler: ${method}`);
    table[method] = handler;
  }
  for (const method of Object.keys(PARAMS)) if (!Object.hasOwn(table, method)) throw new Error(`missing RPC handler: ${method}`);
  return Object.fromEntries(Object.keys(PARAMS).map(method => [method, table[method]]));
}

export const HANDLERS = mergeHandlers([systemHandlers, inputHandlers, taskHandlers, specHandlers, noticeHandlers, branchHandlers, candidateHandlers, hookHandlers]);

export class Dispatcher {
  constructor(project, stopping, identity) {
    this.project = project; this.stopping = stopping; this.identity = identity;
    // This trusted callback is never a public RPC. The management engine records
    // reviewed capabilities / exact user confirmations before reaching it.
    project.managementDispatch = async (method, params, actorId = null, receiptId = null) => {
      assertAllowed(method, params, LUSHC_METHODS.has(method) ? actorId : null);
      check(!this.stopping?.isRequested?.(), '项目后台正在停止，请稍后再试');
      // Legacy user handlers are still governed by reviewed policy and an exact
      // durable receipt, not merely by reaching this trusted callback.
      if (!LUSHC_METHODS.has(method)) assertManagementCapabilityExecution(project, actorId, receiptId, method, params);
      const result = LUSHC_METHODS.has(method)
        ? await dispatchManagementCode(project, method, params, actorId, receiptId,
          actor => HANDLERS[method].call(this, project, params, actor))
        : await HANDLERS[method].call(this, project, params, null);
      return publicResult(result, method);
    };
  }
  async dispatch(method, params = {}) {
    // 身份解析交给 registry：只有白名单与未知参数都过了才去查 token（actor() 会写 agent_last_seen_at）。
    const actor = assertAllowed(method, params, () => this.project.actor(params._token));
    const p = this.project;
    // actor() still returns an invocation-bound integer. Do not grant a manager the
    // ordinary Agent surface (e.g. notice.post/progress/message) merely for having a token.
    const actorTask = actor === null || actor === undefined ? null : p.store?.task(actor);
    check(!(actorTask?.role === 'manager' || actorTask?.task_kind === 'management') || MANAGER_METHODS.has(method),
      'management agents can only use their dedicated reviewed management tools');
    if ((actorTask?.role === 'manager' || actorTask?.task_kind === 'management') && method === 'worker.lookup')
      p.assertManagementPermission(actor, 'worker.lookup');
    // Capability comes from the authenticated Store identity, not role labels, prompts or caller params.
    // New public methods remain denied until explicitly reviewed for the isolated integration helper.
    check(actorTask?.task_kind !== 'integration' || INTEGRATION_METHODS.has(method),
      'integration agents can only inspect work and post notices or report progress for themselves');
    check(!this.stopping?.isRequested?.() || ['system.status', 'system.summary'].includes(method),
      '项目后台正在停止，请稍后再试');
    return publicResult(await HANDLERS[method].call(this, p, params, actor), method);
  }
}
