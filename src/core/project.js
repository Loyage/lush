import { ProjectBase } from './project/base.js';
import statusMethods from './project/status.js';
import agentMethods from './project/agents.js';
import depsMethods from './project/deps.js';
import inputsMethods from './project/inputs.js';
import draftsMethods from './project/drafts.js';
import referencesMethods from './project/references.js';
import specsMethods from './project/specs.js';
import plansMethods from './project/plans.js';
import tasksMethods from './project/tasks.js';
import treeMethods from './project/tree.js';
import timelineMethods from './project/timeline.js';
import messagesMethods from './project/messages.js';
import mergeMethods from './project/merge.js';
import graphMethods from './project/graph.js';
import branchesMethods from './project/branches.js';
import verifyMethods from './project/verify.js';
import candidateMethods from './project/candidates.js';
import integrationMethods from './project/integration.js';
import transcriptMethods from './project/transcript.js';
import settingMethods from './project/settings.js';
import schedulingMethods from './project/scheduling.js';
import lifecycleMethods from './project/lifecycle.js';

/**
 * 两类用户输入：develop 会派生 worker 产码，explain 只出结论、不产生待合并改动。
 * FLOWS 定义在 project/inputs.js（输入与流程判定的唯一使用者），入口照旧导出它：
 * 这样 mixin 不必反过来 import 入口，直接 import 任一 project/*.js 都不会撞上循环依赖。
 */
export { FLOWS } from './project/inputs.js';

/**
 * Project 由若干职责模块拼装：每个模块（`src/core/project/*.js`）导出一个方法对象，
 * 方法体里照旧用 `this`，这里把它们的原型属性合并进来，所以搬家时方法体一行都不用改。
 * 合并时查重名：重名＝拆分出错，立刻抛错，绝不静默覆盖。
 * 这些方法是用 Object.assign 挂上去的，因此是**可枚举**属性（原生 class 方法不可枚举）。
 * 这是有意为之：运行时与各 mixin 都不依赖可枚举性，故意不为「更像 class」而改成 defineProperty。
 */
const MIXINS = [
  ['status', statusMethods], ['agents', agentMethods], ['deps', depsMethods], ['inputs', inputsMethods], ['drafts', draftsMethods], ['references', referencesMethods],
  ['specs', specsMethods], ['plans', plansMethods], ['tasks', tasksMethods], ['tree', treeMethods],
  ['timeline', timelineMethods], ['messages', messagesMethods], ['merge', mergeMethods], ['verify', verifyMethods],
  ['candidates', candidateMethods], ['integration', integrationMethods], ['graph', graphMethods], ['branches', branchesMethods],
  ['transcript', transcriptMethods], ['settings', settingMethods], ['scheduling', schedulingMethods], ['lifecycle', lifecycleMethods],
];

export class Project extends ProjectBase {}

for (const [module, methods] of MIXINS) {
  const duplicates = Object.keys(methods).filter(name => Object.prototype.hasOwnProperty.call(Project.prototype, name));
  if (duplicates.length) throw new Error(`duplicate Project method(s) ${duplicates.join(', ')} from project/${module}.js`);
  Object.assign(Project.prototype, methods);
}
