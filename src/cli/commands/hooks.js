import { check } from '../../core/types.js';
import { resolveWorkerId } from '../worker-number.js';
import { exact, option } from '../args.js';
import { readPrivateJson } from '../private-json.js';

function readRevision(args) {
  const revision = option(args, '--revision');
  check(typeof revision === 'string' && revision.length > 0 && revision.length <= 256
    && revision === revision.trim() && !/[\x00-\x1f\x7f]/.test(revision),
  'first read hooks list or worker hooks ID, then provide --revision REV');
  return revision;
}

export async function run(command, args, { client }) {
  check(!client.token, 'Hooks configuration is user only, not an agent operation');
  const verb = args.shift();
  if (verb === 'list') { exact(args, 0); return client.request('hooks.list'); }
  check(['save','remove'].includes(verb), 'hooks requires list|save|remove; run lush help');
  const expected_revision = readRevision(args);
  if (verb === 'save') {
    const file = option(args, '--file'); exact(args, 0);
    check(file, 'hooks save requires --file PATH');
    return client.request('hooks.save', { template: readPrivateJson(file), expected_revision });
  }
  exact(args, 1);
  return client.request('hooks.remove', { id: args[0], expected_revision });
}

/** worker hook attach ID --file PATH; enable|disable|remove ID HOOK_ID. */
export async function runWorkerHook(args, client) {
  check(!client.token, 'Hooks configuration is user only, not an agent operation');
  const verb = args.shift();
  check(['attach','enable','disable','remove'].includes(verb), 'worker hook requires attach|enable|disable|remove; run lush help');
  const expected_revision = readRevision(args);
  if (verb === 'attach') {
    const file = option(args, '--file'); exact(args, 1);
    check(file, 'worker hook attach requires --file PATH');
    const hook = readPrivateJson(file);
    return client.request('worker.hook_attach', { id: await resolveWorkerId(client, args[0]), hook, expected_revision });
  }
  exact(args, 2);
  return client.request(verb === 'remove' ? 'worker.hook_remove' : 'worker.hook_update', {
    id: await resolveWorkerId(client, args[0]), hook_id: args[1], ...(verb === 'remove' ? {} : { enabled: verb === 'enable' }), expected_revision,
  });
}
