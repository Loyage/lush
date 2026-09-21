import { StoreBase } from './store/base.js';
import { tasks } from './store/tasks.js';
import { specs } from './store/specs.js';
import { deps } from './store/deps.js';
import { messages } from './store/messages.js';
import { events } from './store/events.js';
import { verification } from './store/verification.js';
import { drafts } from './store/drafts.js';
import { timeline } from './store/timeline.js';
import { branches } from './store/branches.js';
import { runs } from './store/runs.js';
import { candidates } from './store/candidates.js';

/**
 * 持久化入口：只做装配，实现按职责住在 src/persistence/store/ 下。
 * 每个职责模块导出一个方法对象（方法体里照旧用 this），这里并进原型；
 * 重名＝拆分出错，立刻抛错，不静默覆盖。
 */
export class Store extends StoreBase {}

for (const [module, mixin] of Object.entries({ tasks, specs, deps, messages, events, verification, drafts, timeline, branches, runs, candidates })) {
  for (const name of Object.keys(mixin)) {
    if (Object.prototype.hasOwnProperty.call(Store.prototype, name)) {
      throw new Error(`duplicate Store method ${name} (${module}.js)`);
    }
    Store.prototype[name] = mixin[name];
  }
}
