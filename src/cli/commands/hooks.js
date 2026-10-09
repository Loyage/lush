import { check, id } from '../../core/types.js';
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
  if (verb === 'command') return runCommand(args, client);
  if (verb === 'signal') return runSignal(args, client);
  if (verb === 'management') return runManagement(args, client);
  check(['save','remove','auto-select'].includes(verb), 'hooks requires list|save|remove|auto-select|command|signal|management; run lush help');
  const expected_revision = readRevision(args);
  if (verb === 'auto-select') {
    exact(args, 1);
    check(['on','off'].includes(args[0]), 'hooks auto-select expects on|off');
    return client.request('hooks.auto_select', { enabled: args[0] === 'on', expected_revision });
  }
  if (verb === 'save') {
    const file = option(args, '--file'); exact(args, 0);
    check(file, 'hooks save requires --file PATH');
    return client.request('hooks.save', { template: readPrivateJson(file), expected_revision });
  }
  exact(args, 1);
  return client.request('hooks.remove', { id: args[0], expected_revision });
}

async function runCommand(args, client) {
  const verb = args.shift();
  check(['list','save','authorize','revoke','remove','run','import'].includes(verb),
    'hooks command requires list|save|authorize|revoke|remove|run|import; run lush help');
  if (verb === 'list') { exact(args, 0); return client.request('hooks.list'); }
  const expected_revision = readRevision(args);
  if (verb === 'save' || verb === 'import') {
    const file = option(args, '--file'); exact(args, 0);
    check(file, `hooks command ${verb} requires --file PATH`);
    const value = readPrivateJson(file, 'shortcut command');
    const keys = verb === 'save' ? ['id','name','command'] : ['template_id','worker_id','hook_id'];
    check(Object.keys(value).every(key => keys.includes(key)), 'unknown shortcut command parameter');
    if (verb === 'import' && Object.hasOwn(value, 'worker_id')) {
      check(!Object.hasOwn(value, 'template_id') && Object.hasOwn(value, 'hook_id'), 'invalid import source');
      value.worker_id = await resolveWorkerId(client, value.worker_id);
    }
    return client.request(`hooks.command_${verb}`, { [verb === 'save' ? 'command' : 'source']: value, expected_revision });
  }
  const rawVersion = verb === 'remove' ? null : option(args, '--version');
  const worker = verb === 'run' ? option(args, '--worker') : null;
  exact(args, 1);
  check(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args[0]), 'invalid command id');
  if (verb === 'remove') return client.request('hooks.command_remove', { id: args[0], expected_revision });
  check(typeof rawVersion === 'string' && /^[1-9]\d*$/.test(rawVersion)
    && Number.isSafeInteger(Number(rawVersion)), 'provide --version N as a positive integer');
  const version = Number(rawVersion);
  if (verb === 'run') {
    check(worker !== null, 'hooks command run requires --worker ID');
    return client.request('hooks.command_run', { id: args[0], version, worker_id: await resolveWorkerId(client, worker), expected_revision });
  }
  return client.request('hooks.command_authorize', { id: args[0], version, authorized: verb === 'authorize', expected_revision });
}

async function runSignal(args, client) {
  const verb = args.shift();
  check(['save','remove'].includes(verb), 'hooks signal requires save|remove; run lush help');
  const expected_revision = readRevision(args);
  if (verb === 'save') {
    const file = option(args, '--file'); exact(args, 0);
    check(file, 'hooks signal save requires --file PATH');
    return client.request('hooks.signal_save', { signal: readPrivateJson(file, 'signal'), expected_revision });
  }
  exact(args, 1);
  return client.request('hooks.signal_remove', { id: args[0], expected_revision });
}

async function runManagement(args, client) {
  const verb = args.shift();
  check(['create','enable','disable'].includes(verb), 'hooks management requires create|enable|disable; run lush help');
  if (verb === 'create') {
    const file = option(args, '--file'); exact(args, 0);
    check(file, 'hooks management create requires --file PATH');
    const request = readPrivateJson(file, 'management');
    check(Object.keys(request).every(key => ['name','instruction','signal_id','mode','profile','client_request_id'].includes(key)), 'unknown management parameter');
    return client.request('management.create', request);
  }
  const expected_revision = readRevision(args); exact(args, 1);
  return client.request('management.binding_update', { id: id(args[0]), enabled: verb === 'enable', expected_revision });
}

/** Highest automatic stage; uses the current worker.hooks read revision. */
export async function runWorkerCompletion(args, client) {
  check(!client.token, 'Hooks configuration is user only, not an agent operation');
  const expected_revision = readRevision(args);
  exact(args, 2);
  check(['off','merge','accept','archive'].includes(args[1]), 'completion expects off|merge|accept|archive');
  return client.request('worker.completion', {
    id: await resolveWorkerId(client, args[0]), level: args[1], expected_revision,
  });
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
