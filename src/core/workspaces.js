import { WorkspacesBase } from './workspaces/base.js';
import { methods as gitMethods } from './workspaces/git.js';
import { methods as worktreeMethods } from './workspaces/worktree.js';
import { methods as diffMethods } from './workspaces/diff.js';
import { methods as mergeMethods } from './workspaces/merge.js';
import { methods as cleanupMethods } from './workspaces/cleanup.js';
import { methods as safetyMethods } from './workspaces/safety.js';
import { methods as taskSyncMethods } from './workspaces/task-sync.js';
import { methods as codeMethods } from './workspaces/code.js';
import { methods as historyMethods } from './workspaces/history.js';
import { methods as deletionMethods } from './workspaces/deletion.js';

/** All Lush git mutations are serialized. Forced abandonment requires explicit user confirmation. */
export class Workspaces extends WorkspacesBase {}

// 一个职责一个方法对象，这里只做装配：重名（含与 base 的成员重名）就是拆分出错，立刻抛错。
for (const [module, mixin] of Object.entries({
  deletion: deletionMethods, git: gitMethods, history: historyMethods, worktree: worktreeMethods, code: codeMethods, diff: diffMethods, merge: mergeMethods, cleanup: cleanupMethods, safety: safetyMethods, taskSync: taskSyncMethods,
})) {
  for (const [name, method] of Object.entries(mixin)) {
    if (Object.prototype.hasOwnProperty.call(Workspaces.prototype, name)) {
      throw new Error(`duplicate Workspaces.prototype.${name} from workspaces/${module}.js`);
    }
    Object.defineProperty(Workspaces.prototype, name, { value: method, writable: true, configurable: true, enumerable: false });
  }
}
