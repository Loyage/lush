import { check, id } from '../../core/types.js';
import { actorInputSource } from '../../persistence/store/input-sources.js';
import { contextTarget, contextDetail, contextHistory } from '../../core/worker-context.js';
import { NOTICE_SELECT } from '../../persistence/notice-projection.js';

export const handlers = {
  'context.inspect'(p, params, actor) { return contextDetail(p, contextTarget(p, actor, params).id); },
  'context.history'(p, params, actor) {
    const task = contextTarget(p, actor, params), after = params.after ?? 0;
    check(Number.isSafeInteger(after) && after >= 0, 'invalid history cursor');
    const events = contextHistory(p.store.history(task.id, after));
    const next = events.at(-1)?.id ?? after;
    return { events, next, has_more: Boolean(p.store.get('SELECT id FROM events WHERE task_id=? AND id>? LIMIT 1', task.id, next)),
      coverage: 'event_metadata_only' };
  },
  'context.transcript'(p, params, actor) {
    const task = contextTarget(p, actor, params);
    return p.transcript(task.id, params.after ?? 0, params.limit ?? 100);
  },
  'context.children'(p, params, actor) {
    // taskRelations is the existing bounded direct-child SQL pagination source.
    const page = p.taskRelations(actor, params).children;
    return page;
  },
  'context.spawn'(p, params, actor) {
    check(['order','child'].includes(p.store.task(actor).task_kind), 'only order/child Workers can delegate');
    return Promise.resolve(p.spawn(actor, params.goal, 'agent', [], params.name ?? null, null, undefined, actorInputSource(p.store, actor)))
      .then(value => contextDetail(p, value.id));
  },
  async 'context.message'(p, params, actor) {
    const task = contextTarget(p, actor, params, ['parent','child']);
    await p.message(task.id, params.body, actor);
    return contextDetail(p, task.id);
  },
  async 'context.accept'(p, params, actor) {
    const task = contextTarget(p, actor, { relation: 'child', child: params.child });
    await p.acceptTask(task.id, actor);
    return contextDetail(p, task.id);
  },
  'context.auto_title'(p, params, actor) { return p.setTaskAutoTitle(actor, params.title); },
  'context.notices'(p, params, actor) {
    const before = params.before === undefined ? null : id(params.before), limit = params.limit ?? 30;
    check(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'limit must be 1..100');
    const rows = p.store.all(`${NOTICE_SELECT} WHERE n.task_id=?${before === null ? '' : ' AND n.id<?'} ORDER BY n.id DESC LIMIT ?`,
      actor, ...(before === null ? [] : [before]), limit + 1);
    const notices = []; let bytes = 0;
    for (const row of rows.slice(0, limit)) {
      const size = Buffer.byteLength(JSON.stringify(row));
      if (notices.length && bytes + size > 900000) break;
      notices.push(row); bytes += size;
    }
    return { notices, cursor: notices.at(-1)?.id ?? before, has_more: rows.length > notices.length, limit };
  },
  'context.notice'(p, params, actor) {
    const kind = params.kind ?? 'question';
    check(['question','info'].includes(kind), 'notice kind must be question or info');
    return p.notice(actor, params.title, params.body, kind, params.questions);
  },
  'context.progress_plan'(p, params, actor) { return p.reportProgressPlan(actor, params.steps); },
  'context.progress_complete'(p, params, actor) { return p.completeProgressStep(actor, params.step); },
};
