import { check, id, bounded } from '../../core/types.js';

/** notice.* */
export const handlers = {
  'notice.list'(p, params, actor) { return bounded(p.store.all("SELECT * FROM notices ORDER BY (status='open') DESC, id DESC LIMIT 200"), 900000); },
  'notice.post'(p, params, actor) {
    const task = params.task ?? actor;
    check(actor === null || id(task) === actor, 'agents may post notices only for their own task');
    return p.notice(task, params.title, params.body);
  },
  'notice.answer'(p, params, actor) { return p.answer(params.id, params.answer); },
  'notice.dismiss'(p, params, actor) { return p.answer(params.id, '', true); },
};
