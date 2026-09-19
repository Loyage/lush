import { createHash } from 'node:crypto';

/** 构造与串行队列状态；方法体住在各职责模块里，入口把它们并进同一个原型。 */
export class WorkspacesBase {
  constructor(config, store) {
    this.config = config; this.store = store; this.queue = Promise.resolve(); this.busy = new Set();
    this.namespace = createHash('sha256').update(config.project).digest('hex').slice(0, 10);
  }
}
