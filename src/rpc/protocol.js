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
  'system.status': [], 'system.stop': [], 'system.timeline': ['limit'], 'input.submit': ['content'], 'input.list': [], 'input.flow': ['id','flow'],
  'draft.add': ['content'], 'draft.list': [], 'draft.remove': ['id'], 'draft.commit': [],
  'task.list': ['after','limit'], 'task.tree': ['id'], 'task.inspect': ['id'], 'task.history': ['id','after'], 'task.diff': ['id'],
  'task.transcript': ['id','after','limit'],
  'task.spawn': ['parent','goal','role','deps','name'], 'task.message': ['id','body'], 'task.cancel': ['id'], 'task.retry': ['id'],
  'task.merge': ['id'], 'task.cleanup': ['id'], 'task.verify': ['id'], 'task.clear': [], 'task.ladder': [],
  'notice.list': [], 'notice.post': ['task','title','body'], 'notice.answer': ['id','answer'], 'notice.dismiss': ['id'],
};
const USER_ONLY = new Set(['system.stop','input.submit','draft.add','draft.remove','draft.commit','task.cancel','task.retry','task.merge','task.cleanup','task.verify','task.clear','notice.answer','notice.dismiss']);
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
      case 'system.timeline': return p.timeline({ limit: params.limit });
      case 'input.submit': return p.submit(params.content);
      case 'input.list': return p.inputs();
      case 'input.flow': {
        // Agent 省略 id 时判定自己的输入；用户（无 token）可对任意根 task 判定或改判。
        const target = params.id ?? actor;
        check(target !== null && target !== undefined, 'input.flow requires a root task id (agents may omit it to use their own task)');
        check(actor === null || id(target) === actor, 'agents may classify only their own input');
        return p.setInputFlow(id(target), params.flow);
      }
      case 'draft.add': return p.draft(params.content);
      case 'draft.list': return p.drafts();
      case 'draft.remove': return p.dropDraft(params.id);
      case 'draft.commit': return p.commitDrafts();
      case 'task.list': {
        const after = Number(params.after ?? 0), limit = Number(params.limit ?? 200);
        check(Number.isSafeInteger(after) && after >= 0 && Number.isInteger(limit) && limit > 0 && limit <= 1000, 'invalid task page');
        return bounded(p.decorate(p.store.summaries().filter(task => task.id > after).slice(0, limit)), 900000);
      }
      case 'task.tree': return p.tree(params.id ?? null);
      case 'task.ladder': return p.ladder();
      case 'task.inspect': return p.inspect(params.id);
      case 'task.history': {
        p.store.task(params.id);
        const after = Number(params.after ?? 0);
        check(Number.isSafeInteger(after) && after >= 0, 'invalid history cursor');
        return p.store.history(id(params.id), after);
      }
      case 'task.diff': return p.diff(params.id);
      case 'task.transcript': return p.transcript(id(params.id), Number(params.after ?? 0), Number(params.limit ?? 100));
      case 'task.spawn': {
        const parent = params.parent ?? actor;
        check(actor === null || id(parent) === actor, 'agents may delegate only from their own task');
        return p.spawn(parent, params.goal, params.role, params.deps ?? [], params.name ?? null);
      }
      case 'task.message': return p.message(params.id, params.body, actor);
      case 'task.cancel': return p.cancel(params.id);
      case 'task.retry': return p.retry(params.id);
      case 'task.merge': return p.workspaces.merge(id(params.id));
      case 'task.verify': return p.verify(id(params.id));
      case 'task.cleanup':
        check(!p.running.has(id(params.id)), 'agent is still stopping; cleanup must wait');
        return p.workspaces.cleanup(id(params.id));
      case 'task.clear': return p.clear();
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
