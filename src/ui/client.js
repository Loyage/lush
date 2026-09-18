import { RPCClient } from '../rpc/client.js';
import { check } from '../core/types.js';
export class UIClient {
  constructor(config, token = null) { this.config = config; this.token = token; this.rpc = new RPCClient(config.socket, 30); }
  request(method, params = {}) {
    return this.rpc.request(method, { ...params, ...(this.token ? { _token: this.token } : {}) });
  }
  async snapshot() {
    const [status, inputs, drafts, notices] = await Promise.all(['system.status','input.list','draft.list','notice.list'].map(method => this.request(method)));
    check(status.project === this.config.project, 'daemon project mismatch');
    const tasks = []; let after = 0;
    for (;;) {
      const page = await this.request('task.list', { after });
      tasks.push(...page);
      if (!page.length) break;
      after = page.at(-1).id;
      if (page.length < 200) break;
    }
    return { status, tasks, inputs, drafts, notices };
  }
}
