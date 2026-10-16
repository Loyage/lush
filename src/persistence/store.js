import { StoreBase } from './store/base.js';
import { tasks } from './store/tasks.js';
import { specs } from './store/specs.js';
import { deps } from './store/deps.js';
import { messages } from './store/messages.js';
import { events } from './store/events.js';
import { reading } from './store/reading.js';
import { verification } from './store/verification.js';
import { drafts } from './store/drafts.js';
import { inputHistory } from './store/input-history.js';
import { timeline } from './store/timeline.js';
import { branches } from './store/branches.js';
import { runs } from './store/runs.js';
import { candidates } from './store/candidates.js';
import { references } from './store/references.js';
import { agentUsage } from './store/agent-usage.js';
import { agentConnections } from './store/agent-connections.js';
import { convergence, ensureConvergenceColumns } from './store/convergence.js';
import { runner, ensureRunnerSchema } from './store/runner.js';

/**
 * 持久化入口：只做装配，实现按职责住在 src/persistence/store/ 下。
 * 每个职责模块导出一个方法对象（方法体里照旧用 this），这里并进原型；
 * 重名＝拆分出错，立刻抛错，不静默覆盖。
 */
export class Store extends StoreBase {
  constructor(...args) { super(...args); ensureConvergenceColumns(this.db); ensureRunnerSchema(this.db); }
}

for (const [module, mixin] of Object.entries({ tasks, specs, deps, messages, events, reading, verification, drafts, inputHistory, references, timeline, branches, runs, candidates, agentUsage, agentConnections, convergence, runner })) {
  for (const name of Object.keys(mixin)) {
    if (Object.prototype.hasOwnProperty.call(Store.prototype, name)) {
      throw new Error(`duplicate Store method ${name} (${module}.js)`);
    }
    Store.prototype[name] = mixin[name];
  }
}
