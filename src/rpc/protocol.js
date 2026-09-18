import { LushError, check, isPlainObject, id, bounded } from '../core/types.js';
export const MAX_FRAME = 1024 * 1024;
export function encode(value) {
  const payload = Buffer.from(JSON.stringify(value) + '\n');
  check(payload.length <= MAX_FRAME, 'RPC frame exceeds 1 MiB; use paginated history');
  return payload;
}
export const errorResponse = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
export function parseRequest(raw) {
  let value;
  try { value = JSON.parse(raw.toString('utf8')); } catch { throw new LushError('parse error', -32700); }
  check(isPlainObject(value) && value.jsonrpc === '2.0' && typeof value.method === 'string', 'invalid JSON-RPC request');
  check(value.id === undefined || value.id === null || typeof value.id === 'string' || Number.isSafeInteger(value.id), 'invalid request id');
  return value;
}
const PARAMS = {
  'system.status': [], 'system.stop': [], 'input.submit': ['content'], 'input.list': [],
  'task.list': ['after','limit'], 'task.tree': ['id'], 'task.inspect': ['id'], 'task.history': ['id','after'],
  'task.spawn': ['parent','goal','role'], 'task.message': ['id','body'], 'task.cancel': ['id'], 'task.retry': ['id'],
  'task.merge': ['id'], 'task.cleanup': ['id'],
  'notice.list': [], 'notice.post': ['task','title','body'], 'notice.answer': ['id','answer'], 'notice.dismiss': ['id'],
};
const USER_ONLY = new Set(['system.stop','input.submit','task.cancel','task.retry','task.merge','task.cleanup','notice.answer','notice.dismiss']);
export class Dispatcher {
  constructor(project, stopping, identity) { this.project = project; this.stopping = stopping; this.identity = identity; }
  async dispatch(method, params = {}) {
    check(isPlainObject(params), 'params must be an object');
    if (!Object.hasOwn(PARAMS, method)) throw new LushError(`unknown method: ${method}`, -32601);
    check(Object.keys(params).every(key => key === '_token' || PARAMS[method].includes(key)), 'unknown parameter');
    const actor = this.project.actor(params._token);
    check(actor === null || !USER_ONLY.has(method), `${method} requires user approval, not an agent`);
    const p = this.project;
    switch (method) {
      case 'system.status': return { ...p.status(), ...this.identity, pid: process.pid };
      case 'system.stop': this.stopping.request(); return { stopping: true };
      case 'input.submit': return p.submit(params.content);
      case 'input.list': return p.inputs();
      case 'task.list': {
        const after = Number(params.after ?? 0), limit = Number(params.limit ?? 200);
        check(Number.isSafeInteger(after) && after >= 0 && Number.isInteger(limit) && limit > 0 && limit <= 1000, 'invalid task page');
        return bounded(p.store.summaries().filter(task => task.id > after).slice(0, limit), 900000);
      }
      case 'task.tree': return p.tree(params.id ?? null);
      case 'task.inspect': return p.inspect(params.id);
      case 'task.history': {
        p.store.task(params.id);
        const after = Number(params.after ?? 0);
        check(Number.isSafeInteger(after) && after >= 0, 'invalid history cursor');
        return p.store.history(id(params.id), after);
      }
      case 'task.spawn': {
        const parent = params.parent ?? actor;
        check(actor === null || id(parent) === actor, 'agents may delegate only from their own task');
        return p.spawn(parent, params.goal, params.role);
      }
      case 'task.message': return p.message(params.id, params.body, actor);
      case 'task.cancel': return p.cancel(params.id);
      case 'task.retry': return p.retry(params.id);
      case 'task.merge': return p.workspaces.merge(id(params.id));
      case 'task.cleanup':
        check(!p.running.has(id(params.id)), 'agent is still stopping; cleanup must wait');
        return p.workspaces.cleanup(id(params.id));
      case 'notice.list': return bounded(p.store.all("SELECT * FROM notices ORDER BY (status='open') DESC, id DESC LIMIT 200"), 900000);
      case 'notice.post': {
        const task = params.task ?? actor;
        check(actor === null || id(task) === actor, 'agents may post notices only for their own task');
        return p.notice(task, params.title, params.body);
      }
      case 'notice.answer': return p.answer(params.id, params.answer);
      case 'notice.dismiss': return p.answer(params.id, '', true);
    }
  }
}
