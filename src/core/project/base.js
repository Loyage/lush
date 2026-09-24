import { Workspaces } from '../workspaces.js';
import { AgentProvider, MockProvider } from '../../agent/provider.js';
import { AgentSettings } from '../../agent/settings.js';
import { QuickIntroSettings } from '../quick-intro.js';

// 构造与实例状态（config / store / provider / workspaces / running / stopping / scheduled / ancestry）。
/** One project, a persistent task tree, and a bounded pool of disposable agents. */
export class ProjectBase {
  constructor(config, store, provider = null) {
    this.config = config; this.store = store;
    this.agentSettings = new AgentSettings(config);
    this.quickIntro = new QuickIntroSettings(config);
    this.provider = provider || (config.provider === 'mock' ? new MockProvider() : new AgentProvider(config, this.agentSettings));
    this.workspaces = new Workspaces(config, store);
    // 运行设置（并发上限）写盘后由 Config 回调这里重新 pump。
    this.config.onKick = () => this.kick();
    this.running = new Map(); this.stopping = false; this.scheduled = false; this.ancestry = new Map();
    // 直连模型的「快速介绍」不是任务，不进 running；单独记在跑的那次调用，shutdown 时 abort 并等它落库。
    this.introRunning = new Map();
    this.integratingIntents = new Set();
    // 效果展示预约重扫的单飞状态：sweeping 表示一轮在跑，sweepAgain 表示跑到一半又收到了触发。
    this.showcaseSweeping = false; this.showcaseSweepAgain = false;
    this.previews = new Map(); this.previewStarting = new Map();
    this.workspaces.previewActive = id => this.previewStarting.has(id) || ['running','starting','stopping'].includes(this.previews.get(id)?.status);
    this.workspaces.stopPreview = id => this.stopShowcasePreview(id);
  }
}
