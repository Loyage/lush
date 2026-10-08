import { createHash } from 'node:crypto';

/** 构造与串行队列状态；方法体住在各职责模块里，入口把它们并进同一个原型。 */
export class WorkspacesBase {
  constructor(config, store) {
    this.config = config; this.store = store; this.queue = Promise.resolve(); this.pending = 0; this.busy = new Set();
    // Evidence lives only as long as invocations watching refs; no global write counter
    // can excuse an unrelated branch move, and completed owner windows remain observable.
    this.refWatches = new Set(); this.refOwners = new Set(); this.refWrites = new Map();
    this.namespace = createHash('sha256').update(config.project).digest('hex').slice(0, 10);
  }
}
