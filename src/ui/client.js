import { RPCClient } from '../rpc/client.js';
import { check, LushError } from '../core/types.js';
export class UIClient {
  constructor(config, token = null) { this.config = config; this.token = token; this.rpc = new RPCClient(config.socket, 30); }
  async request(method, params = {}) {
    try {
      return await this.rpc.request(method, { ...params, ...(this.token ? { _token: this.token } : {}) });
    } catch (error) {
      // -32601 几乎总是客户端比 daemon 新（改了 src/ 但没重启），而不是命令拼错；
      // 只回一句 "unknown method" 会让人以为是接口不存在，所以直接把下一步写进错误里。
      if (error.code === -32601) throw new LushError(
        `${error.message}; this project's daemon may still be running older code — restart it with 'lush daemon restart' (or 'bun run daemon-restart' in the Lush checkout)`, error.code);
      throw error;
    }
  }
  /** Compatibility snapshot: intentionally retains the complete historical task walk. */
  async snapshot() {
    const [status, timeline, ladder, inputs, drafts, notices, specs, candidates] = await Promise.all(
      ['system.status','system.timeline','task.ladder','input.list','draft.list','notice.list','spec.list','candidate.list'].map(method => this.request(method)));
    check(status.project === this.config.project, 'daemon project mismatch');
    const tasks = []; let after = 0;
    for (;;) {
      const page = await this.request('task.list', { after });
      tasks.push(...page);
      if (!page.length) break;
      after = page.at(-1).id;
      if (page.length < 200) break;
    }
    return { status, timeline, ladder, tasks, inputs, drafts, notices, specs, candidates };
  }

  /** Bounded homepage model. A matching revision turns the poll into one cheap status request. */
  async overview(revision = null) {
    const status = await this.request('system.summary');
    check(status.project === this.config.project, 'daemon project mismatch');
    if (revision && revision === status.revision) return { unchanged: true, revision };
    const [timeline, ladder, activity, inputs, drafts, notices, specs, candidates] = await Promise.all([
      this.request('system.timeline'), this.request('task.ladder'), this.request('task.activity', { limit: 50 }),
      this.request('input.list'), this.request('draft.list'), this.request('notice.list'),
      this.request('spec.list'), this.request('candidate.list'),
    ]);
    return { revision: status.revision, status, timeline, ladder, tasks: activity.tasks, task_page: activity.page,
      inputs, drafts, notices, specs, candidates };
  }
}
