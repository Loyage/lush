import fs from 'node:fs';
import { check } from '../core/types.js';
import { RPCClient } from '../rpc/client.js';
import { administratorHome, administratorPaths, assertPrivateDirectory, assertPrivateFile, readControlSecret } from './paths.js';
import { ADMINISTRATOR_RPC } from './runtime-protocol.js';

/** Server-side control client. Never load this module in the model extension. */
export class AdministratorClient {
  constructor({ env = process.env, home = administratorHome(env), startService = null, timeout = 30 } = {}) {
    this.env = env; this.paths = administratorPaths(home); this.startService = startService; this.timeout = timeout;
  }
  assertUserControl() {
    check(!this.env.LUSH_AGENT_TOKEN && !this.env.LUSH_ADMINISTRATOR_TOKEN && !this.env.LUSH_ADMIN_TOKEN, 'Agent identities cannot use administrator user control');
  }
  async request(method, params = {}, options = {}) {
    this.assertUserControl();
    assertPrivateDirectory(this.paths.home);
    assertPrivateFile(this.paths.socket, { socket: true });
    const control = readControlSecret(this.paths);
    return new RPCClient(this.paths.socket, this.timeout).request(method, { ...params, control }, options);
  }
  async readStatus() {
    this.assertUserControl();
    if (!fs.existsSync(this.paths.home)) return { version: 1, online: false, history_complete: false, coverage: 'administrator_service_offline' };
    assertPrivateDirectory(this.paths.home);
    if (!assertPrivateFile(this.paths.socket, { missing: true, socket: true })) return { version: 1, online: false, history_complete: false, coverage: 'administrator_service_offline' };
    try { return await this.request(ADMINISTRATOR_RPC.status); }
    catch (error) {
      if (error.code === -32004) return { version: 1, online: false, history_complete: false, coverage: 'administrator_service_offline' };
      throw error;
    }
  }
  async list(options = {}) {
    if (!(await this.readStatus()).online) return { version: 1, online: false, items: [], next_cursor: null, has_more: false,
      history_complete: false, coverage: 'administrator_service_offline_history_unread' };
    return this.request(ADMINISTRATOR_RPC.list, { options });
  }
  async detail(options) { return this.request(ADMINISTRATOR_RPC.detail, { options }); }
  async preview(definition, userBinding) {
    this.assertUserControl();
    if (!(await this.readStatus()).online) {
      check(typeof this.startService === 'function', 'administrator service is offline; explicit user start required');
      await this.startService();
    }
    return this.request(ADMINISTRATOR_RPC.preview, { definition, user_binding: userBinding });
  }
  async commit(body, userBinding) { return this.request(ADMINISTRATOR_RPC.commit, { body, user_binding: userBinding }); }
  async receipt(options, userBinding) { return this.request(ADMINISTRATOR_RPC.receipt, { options, user_binding: userBinding }); }
  async stop(id, userBinding) { return this.request(ADMINISTRATOR_RPC.stop, { id, user_binding: userBinding }); }
  async shutdown(userBinding) { return this.request(ADMINISTRATOR_RPC.shutdown, { user_binding: userBinding }); }
}

/** Invocation client is intentionally incapable of obtaining control credentials or user bindings. */
export class AdministratorInvocationClient {
  constructor(socket, token, { timeout = 30 } = {}) {
    check(typeof socket === 'string' && socket.startsWith('/') && typeof token === 'string' && token.length >= 32, 'administrator invocation binding required');
    this.socket = socket; this.token = token; this.timeout = timeout;
  }
  catalog(options = {}) { return new RPCClient(this.socket, this.timeout).request(ADMINISTRATOR_RPC.toolCatalog, { token: this.token }, options); }
  call(operation, params, options = {}) {
    return new RPCClient(this.socket, this.timeout).request(ADMINISTRATOR_RPC.toolCall, { token: this.token, operation, params }, options);
  }
}
