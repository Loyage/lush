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
  /** Compatibility URL for the Web bootstrap; the payload is the same bounded core overview. */
  async snapshot() { return this.overview(); }

  /** Worker-centred homepage: no legacy planner or draft RPC calls. */
  async overview(revision = null) {
    const status = await this.request('system.summary');
    check(status.project === this.config.project, 'daemon project mismatch');
    if (revision && revision === status.revision) return { unchanged: true, revision };
    const [activity, page] = await Promise.all([
      this.request('worker.activity', { limit: 100, scope: 'work' }),
      this.request('notice.page', { status: 'all', limit: 100 }),
    ]);
    const tasks = activity.tasks.filter(task => ['say','child','main','owner'].includes(task.task_kind));
    const ids = new Set(tasks.map(task => task.id));
    return { revision: status.revision, status, tasks, task_page: activity.page,
      notices: page.notices.filter(notice => ids.has(notice.task_id)),
      ladder: { groups: [] }, inputs: [], drafts: [], specs: [], candidates: [] };
  }
}
