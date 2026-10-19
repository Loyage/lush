import { check } from '../../core/types.js';
import { exact, option } from '../args.js';
import { takeOptions } from '../command-options.js';
import { resolveWorkerId } from '../worker-number.js';

function draftRevision(value) {
  check(value === 'null' || typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value)), 'draft revision must be a positive integer or explicit null');
  return value === 'null' ? null : Number(value);
}
/** Public buffered-input CLI. Persisted Input/Message bodies remain immutable. */
export async function run(command, args, { client }) {
  const verb = args.shift();
  if (verb === 'parents') { exact(args, 0); return client.request('input.parents'); }
  if (verb === 'history') {
    const params = takeOptions(args, { cursor: 'string', limit: 'number', q: 'string', status: 'string', integration: 'string',
      conditional: 'string', view: 'string', modes: 'json' }); exact(args, 0);
    return client.request('input.history', params);
  }
  if (verb === 'get') { exact(args, 2); return client.request('input.get', { kind: args[0], id: Number(args[1]) }); }
  if (['emit','cancel-emission','release-exclusive'].includes(verb)) {
    const revision = draftRevision(option(args, '--revision')); exact(args, 1);
    return client.request({ emit: 'input.emit', 'cancel-emission': 'input.emission_cancel', 'release-exclusive': 'input.exclusive_release' }[verb],
      { draft_id: Number(args[0]), expected_revision: revision });
  }
  check(verb === 'buffer', 'unknown input command');
  const action = args.shift(), revision = draftRevision(option(args, '--revision'));
  check(['update','remove'].includes(action), 'buffer expects update/remove');
  if (action === 'remove') { exact(args, 1); return client.request('draft.remove', { id: Number(args[0]), expected_revision: revision }); }
  const params = takeOptions(args, { branch: 'string', mode: 'string', conditions: 'json', exclusive: 'boolean', references: 'json' });
  const target = option(args, '--target'); exact(args, 2);
  return client.request('draft.update', { id: Number(args[0]), content: args[1], expected_revision: revision, ...params,
    ...(target === null ? {} : { target_id: await resolveWorkerId(client, target) }) });
}
