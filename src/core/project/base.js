import { Workspaces } from '../workspaces.js';
import { PiProvider, MockProvider } from '../../agent/provider.js';

// 构造与实例状态（config / store / provider / workspaces / running / stopping / scheduled / ancestry）。
/** One project, a persistent task tree, and a bounded pool of disposable agents. */
export class ProjectBase {
  constructor(config, store, provider = null) {
    this.config = config; this.store = store;
    this.provider = provider || (config.provider === 'mock' ? new MockProvider() : new PiProvider(config));
    this.workspaces = new Workspaces(config, store);
    this.running = new Map(); this.stopping = false; this.scheduled = false; this.ancestry = new Map();
    this.integratingIntents = new Set();
  }
}
