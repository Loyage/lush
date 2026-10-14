import { ProjectBase } from './project/base.js';
import statusMethods from './project/status.js';
import diagnosticsMethods from './project/diagnostics.js';
import maintenanceMethods from './project/maintenance.js';
import sleepMethods from './project/sleep.js';
import agentMethods from './project/agents.js';
import depsMethods from './project/deps.js';
import inputsMethods from './project/inputs.js';
import orderMethods from './project/order.js';
import draftsMethods from './project/drafts.js';
import referencesMethods from './project/references.js';
import specsMethods from './project/specs.js';
import plansMethods from './project/plans.js';
import tasksMethods from './project/tasks.js';
import progressMethods from './project/progress.js';
import deliveryReadMethods from './project/delivery-read.js';
import treeMethods from './project/tree.js';
import timelineMethods from './project/timeline.js';
import messagesMethods from './project/messages.js';
import inputQueueMethods from './project/input-queue.js';
import choiceSnapshotMethods from './project/choice-snapshots.js';
import mergeMethods from './project/merge.js';
import mergeQueueMethods from './project/merge-queue.js';
import mergeAllMethods from './project/merge-all.js';
import orchestrateMethods from './project/orchestrate.js';
import graphMethods from './project/graph.js';
import branchesMethods from './project/branches.js';
import verifyMethods from './project/verify.js';
import candidateMethods from './project/candidates.js';
import integrationMethods from './project/integration.js';
import transcriptMethods from './project/transcript.js';
import settingMethods from './project/settings.js';
import schedulingMethods from './project/scheduling.js';
import contextMethods from './project/context.js';
import lifecycleMethods from './project/lifecycle.js';
import taskSyncMethods from './project/task-sync.js';
import iterationMethods from './project/iteration.js';
import codeMethods from './project/code.js';
import historyMethods from './project/version-history.js';
import versionGraphMethods from './project/version-graph.js';
import versionLineageMethods from './project/version-lineage.js';
import inputHistoryMethods from './project/input-history.js';
import inputEmissionMethods from './project/input-emissions.js';
import inputEmissionSafetyMethods from './project/input-emission-safety.js';
import agentPackagesMethods from './project/agent-packages.js';
import deletionMethods from './project/deletion.js';
import hookMethods from './project/hooks.js';
import commandHookMethods from './project/command-hooks.js';
import shortcutCommandMethods from './project/shortcut-commands.js';
import scheduledHookMethods from './project/scheduled-hooks.js';
import autoSelectMethods from './project/auto-select.js';
import hookSignalMethods from './project/hook-signals.js';
import managementMethods from './project/management.js';
import completionMethods from './project/completion.js';
import automationSettingsMethods from './project/automation-settings.js';
import automationOperationMethods from './project/automation-operations.js';
import convergencePolicyMethods from './project/convergence-policy.js';
import convergenceQueueMethods from './project/convergence-queue.js';
import convergencePrepareMethods from './project/convergence-prepare.js';
import convergenceLandMethods from './project/convergence-land.js';
import convergenceSafetyMethods from './project/convergence-safety.js';
import convergenceWorkerMethods from './project/convergence-workers.js';
import convergenceAcceptanceMethods from './project/convergence-acceptance.js';

/**
 * Project 由若干职责模块拼装：每个模块（`src/core/project/*.js`）导出一个方法对象，
 * 方法体里照旧用 `this`，这里把它们的原型属性合并进来，所以搬家时方法体一行都不用改。
 * 合并时查重名：重名＝拆分出错，立刻抛错，绝不静默覆盖。
 * 这些方法是用 Object.assign 挂上去的，因此是**可枚举**属性（原生 class 方法不可枚举）。
 * 这是有意为之：运行时与各 mixin 都不依赖可枚举性，故意不为「更像 class」而改成 defineProperty。
 */
const MIXINS = [
  ['inputEmissions', inputEmissionMethods], ['inputEmissionSafety', inputEmissionSafetyMethods],
  ['deliveryRead', deliveryReadMethods], ['convergencePolicy', convergencePolicyMethods], ['convergenceQueue', convergenceQueueMethods],
  ['convergencePrepare', convergencePrepareMethods], ['convergenceLand', convergenceLandMethods], ['convergenceSafety', convergenceSafetyMethods],
  ['convergenceWorkers', convergenceWorkerMethods], ['convergenceAcceptance', convergenceAcceptanceMethods],
  ['diagnostics', diagnosticsMethods], ['maintenance', maintenanceMethods], ['sleep', sleepMethods], ['status', statusMethods], ['agents', agentMethods], ['deps', depsMethods], ['inputs', inputsMethods], ['order', orderMethods], ['drafts', draftsMethods], ['references', referencesMethods],
  ['specs', specsMethods], ['plans', plansMethods], ['tasks', tasksMethods], ['progress', progressMethods], ['tree', treeMethods],
  ['timeline', timelineMethods], ['messages', messagesMethods], ['inputQueue', inputQueueMethods], ['choiceSnapshots', choiceSnapshotMethods], ['merge', mergeMethods], ['mergeQueue', mergeQueueMethods], ['mergeAll', mergeAllMethods], ['orchestrate', orchestrateMethods], ['verify', verifyMethods],
  ['candidates', candidateMethods], ['integration', integrationMethods], ['graph', graphMethods], ['branches', branchesMethods],
  ['automationSettings', automationSettingsMethods], ['automationOperations', automationOperationMethods], ['autoSelect', autoSelectMethods], ['completion', completionMethods], ['hooks', hookMethods], ['commandHooks', commandHookMethods], ['shortcutCommands', shortcutCommandMethods], ['scheduledHooks', scheduledHookMethods], ['hookSignals', hookSignalMethods], ['management', managementMethods], ['deletion', deletionMethods], ['inputHistory', inputHistoryMethods], ['agentPackages', agentPackagesMethods], ['versionHistory', historyMethods], ['versionGraph', versionGraphMethods], ['versionLineage', versionLineageMethods], ['code', codeMethods], ['transcript', transcriptMethods], ['settings', settingMethods], ['context', contextMethods], ['scheduling', schedulingMethods], ['lifecycle', lifecycleMethods], ['taskSync', taskSyncMethods], ['iteration', iterationMethods],
];

export class Project extends ProjectBase {}

for (const [module, methods] of MIXINS) {
  const duplicates = Object.keys(methods).filter(name => Object.prototype.hasOwnProperty.call(Project.prototype, name));
  if (duplicates.length) throw new Error(`duplicate Project method(s) ${duplicates.join(', ')} from project/${module}.js`);
  Object.assign(Project.prototype, methods);
}
