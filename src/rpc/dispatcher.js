import { PARAMS, assertAllowed } from './registry.js';
import { handlers as systemHandlers } from './handlers/system.js';
import { handlers as inputHandlers } from './handlers/input.js';
import { handlers as taskHandlers } from './handlers/task.js';
import { handlers as specHandlers } from './handlers/spec.js';
import { handlers as noticeHandlers } from './handlers/notice.js';
import { handlers as branchHandlers } from './handlers/branch.js';
import { handlers as candidateHandlers } from './handlers/candidate.js';

/** 合并各 handler 表：重名说明两个分区认领了同一个方法，PARAMS 里没有对应 handler 说明拆漏了。 */
function mergeHandlers(groups) {
  const table = {};
  for (const group of groups) for (const [method, handler] of Object.entries(group)) {
    if (Object.hasOwn(table, method)) throw new Error(`duplicate RPC handler: ${method}`);
    table[method] = handler;
  }
  for (const method of Object.keys(PARAMS)) if (!Object.hasOwn(table, method)) throw new Error(`missing RPC handler: ${method}`);
  return table;
}

export const HANDLERS = mergeHandlers([systemHandlers, inputHandlers, taskHandlers, specHandlers, noticeHandlers, branchHandlers, candidateHandlers]);

export class Dispatcher {
  constructor(project, stopping, identity) { this.project = project; this.stopping = stopping; this.identity = identity; }
  async dispatch(method, params = {}) {
    // 身份解析交给 registry：只有白名单与未知参数都过了才去查 token（actor() 会写 agent_last_seen_at）。
    const actor = assertAllowed(method, params, () => this.project.actor(params._token));
    const p = this.project;
    return await HANDLERS[method].call(this, p, params, actor);
  }
}
