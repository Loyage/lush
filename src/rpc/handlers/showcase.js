import { id } from '../../core/types.js';

export const handlers = {
  'showcase.start': (p, params) => p.startShowcase(params.branch, params.baseline ?? null),
  'showcase.list': (p, params) => p.showcases(params.branch ?? null),
  'showcase.stop': (p, params) => p.stopShowcasePreview(id(params.id)),
  'showcase.preview': (p, params, actor) => p.startShowcasePreview(actor, params.command, params.path ?? '/'),
};
