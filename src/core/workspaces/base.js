import { createHash } from 'node:crypto';

/** 构造与串行队列状态；方法体住在各职责模块里，入口把它们并进同一个原型。 */
export class WorkspacesBase {
  constructor(config, store) {
    this.config = config; this.store = store; this.queue = Promise.resolve(); this.pending = 0; this.busy = new Set();
    // daemon 自己发起的 ref 写入计数：agent 在独立 pi 进程里跑自己的 git，不经这里。
    // 调用里用它区分「目标分支被交付推进」与「被本次调用的 agent 越过 worktree 直接写」。
    this.gitRefWrites = 0;
    this.namespace = createHash('sha256').update(config.project).digest('hex').slice(0, 10);
  }
}
