import { Workspaces } from '../workspaces.js';
import { AgentProvider, MockProvider } from '../../agent/provider.js';
import { AgentSettings } from '../../agent/settings.js';

// 构造与实例状态（config / store / provider / workspaces / running / stopping / scheduled / ancestry）。
/** One project, a persistent task tree, and a bounded pool of disposable agents. */
export class ProjectBase {
  constructor(config, store, provider = null) {
    this.config = config; this.store = store;
    this.agentSettings = new AgentSettings(config);
    this.provider = provider || (config.provider === 'mock' ? new MockProvider() : new AgentProvider(config, this.agentSettings));
    this.workspaces = new Workspaces(config, store);
    // 运行设置（并发上限）写盘后由 Config 回调这里重新 pump。
    this.config.onKick = () => this.kick();
    this.running = new Map(); this.stopping = false; this.scheduled = false; this.ancestry = new Map();
    this.integratingIntents = new Set();
  }
}
