import { Workspaces } from '../workspaces.js';
import { AgentProvider, MockProvider } from '../../agent/provider.js';
import { AgentSettings } from '../../agent/settings.js';
import { QuickIntroSettings } from '../quick-intro.js';
import { check } from '../types.js';

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
    // R-01：清空进入异步回收后，新的写入口先被拒，purge 不会删掉「已经成功返回」的数据。
    this.clearing = false;
    // 已经获准、正在跨 await 的异步写入；clear 先等它们收尾再 purge。
    this.writing = 0; this.writeIdle = Promise.resolve(); this.writeIdleResolve = null;
    // 直连模型的「快速介绍」不是任务，不进 running；单独记在跑的那次调用，shutdown 时 abort 并等它落库。
    this.introRunning = new Map();
    this.integratingIntents = new Set();
    // 一键合并的异步驱动状态：driving 表示某目标正有一轮在跑，避免同目标重复驱动。
    this.mergeRunsDriving = new Set();
    // 效果展示预约重扫的单飞状态：sweeping 表示一轮在跑，sweepAgain 表示跑到一半又收到了触发。
    this.showcaseSweeping = false; this.showcaseSweepAgain = false;
    this.previews = new Map(); this.previewStarting = new Map();
    this.workspaces.previewActive = id => this.previewStarting.has(id) || ['running','starting','stopping'].includes(this.previews.get(id)?.status);
    this.workspaces.stopPreview = id => this.stopShowcasePreview(id);
  }

  /** R-01: reject writes that would create rows while a clear is reclaiming disk. */
  assertWritable(action = 'write') {
    check(!this.clearing, `clear is in progress; retry to ${action} in a moment`);
  }

  /** R-01: run an asynchronous write under the clear gate so a purge cannot race it. */
  async write(action, fn) {
    this.assertWritable(action);
    this.writing += 1;
    if (this.writing === 1) this.writeIdle = new Promise(resolve => { this.writeIdleResolve = resolve; });
    try { return await fn(); } finally {
      if (this.writing > 0) this.writing -= 1;
      if (this.writing === 0 && this.writeIdleResolve) { const resolve = this.writeIdleResolve; this.writeIdleResolve = null; resolve(); }
    }
  }

  /** R-01: wait until every write admitted before the clear gate closed has finished. */
  async drainWrites() { if (this.writing > 0) await this.writeIdle; }
}
