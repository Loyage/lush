import { id } from '../../core/types.js';

export const handlers = {
  'showcase.start': (p, params) => p.startShowcase(params.branch, params.baseline ?? null),
  'showcase.reserve': (p, params) => p.reserveShowcase(params.branch),
  'showcase.unreserve': (p, params) => p.unreserveShowcase(params.branch),
  'showcase.list': (p, params) => p.showcases(params.branch ?? null),
  'showcase.stop': (p, params) => p.stopShowcasePreview(id(params.id)),
  'showcase.preview': (p, params, actor) => p.startShowcasePreview(actor, params.command, params.path ?? '/'),
};
