import { check } from '../../core/types.js';
import { resolveWorkerId } from '../worker-number.js';
import { exact, option } from '../args.js';
import { takeJsonInput } from '../private-json.js';
import { validateHookRegistration } from '../../core/hook-registration.js';

function readRevision(args) {
  const revision = option(args, '--revision');
  check(typeof revision === 'string' && revision.length > 0 && revision.length <= 256
    && revision === revision.trim() && !/[\x00-\x1f\x7f]/.test(revision),
  'first read hooks list or worker hooks ID, then provide --revision REV');
  return revision;
}

export async function run(command, args, { client }) {
  check(!client.token || client.management, 'Hooks configuration is user only, not an agent operation');
  const verb = args.shift();
  if (verb === 'list') { exact(args, 0); return client.request('hooks.list'); }
  if (verb === 'install') check(false, 'hooks install is retired; first hooks register --file PATH, then separately request worker hook attach with registered id/version');
  if (verb === 'register') {
    const value = takeJsonInput(args, client, 'Hook registration'); exact(args, 0);
    return client.request('hooks.register', validateHookRegistration(value));
  }
  if (verb === 'completion-defaults') {
    const expected_revision = readRevision(args); exact(args, 2);
    check(['on','off'].includes(args[0]) && ['merge','accept'].includes(args[1]), 'completion-defaults expects on|off merge|accept --revision REV');
    return client.request('hooks.completion_defaults', { enabled: args[0] === 'on', level: args[1], expected_revision });
  }
  if (verb === 'upgrade') {
    const expected_revision = readRevision(args); exact(args, 0);
    return client.request('hooks.upgrade', { expected_revision });
  }
  if (verb === 'command') return runCommand(args, client);
  if (verb === 'signal') return runSignal(args, client);
  if (verb === 'management') return runManagement(args, client);
  check(['save','remove','auto-select'].includes(verb), 'hooks requires list|register|upgrade|save|remove|auto-select|command|signal|management; run lush help');
  const expected_revision = readRevision(args);
  if (verb === 'auto-select') {
    const scope = option(args, '--scope'); exact(args, 1);
    check(scope === null || scope === 'device', 'auto-select scope must be device');
    check(['on','off'].includes(args[0]), 'hooks auto-select expects on|off');
    return client.request('hooks.auto_select', { enabled: args[0] === 'on', expected_revision,
      ...(client.management && scope !== null ? { scope } : {}) });
  }
  if (verb === 'save') {
    const template = takeJsonInput(args, client); exact(args, 0);
    return client.request('hooks.save', { template, expected_revision });
  }
  exact(args, 1);
  return client.request('hooks.remove', { id: args[0], expected_revision });
}

async function runCommand(args, client) {
  const verb = args.shift();
  if (verb === 'history-remove') {
    const clear = args.includes('--all'); if (clear) args.splice(args.indexOf('--all'), 1); exact(args, clear ? 0 : 1);
    return client.request('hooks.command_history_remove', clear ? { clear: true } : { execution_id: args[0] });
  }
  check(['list','save','remove','history','import','export'].includes(verb),
    'hooks command requires list|save|remove|history|import|export; run lush help');
  if (verb === 'list') { exact(args, 0); return client.request('hooks.list'); }
  if (verb === 'history') {
    const before = option(args, '--before'), limit = option(args, '--limit'), execution_id = option(args, '--execution');
    exact(args, 0);
    const params = {};
    for (const [key, value] of [['before', before], ['limit', limit]]) if (value !== null) {
      check(/^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) && (key !== 'limit' || Number(value) <= 100),
        `${key} must be a positive integer${key === 'limit' ? ' up to 100' : ''}`);
      params[key] = Number(value);
    }
    if (execution_id !== null) {
      check(before === null, '--execution cannot be combined with --before');
      check(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(execution_id), 'invalid execution id');
      params.execution_id = execution_id;
    }
    return client.request('hooks.command_history', params);
  }
  if (verb === 'export') {
    const rawVersion = option(args, '--version'); exact(args, 1);
    check(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args[0]), 'invalid command id');
    check(typeof rawVersion === 'string' && /^[1-9]\d*$/.test(rawVersion)
      && Number.isSafeInteger(Number(rawVersion)), 'provide --version N as a positive integer');
    return client.request('hooks.command_export', { id: args[0], version: Number(rawVersion) });
  }
  const expected_revision = readRevision(args);
  if (verb === 'save' || verb === 'import') {
    const value = takeJsonInput(args, client, 'shortcut command'); exact(args, 0);
    const keys = verb === 'save' ? ['id','name','kind','command','prompt','default_worker_id','description','when_to_use','tags','examples','warnings'] : ['template_id','worker_id','hook_id'];
    check(Object.keys(value).every(key => keys.includes(key)), 'unknown shortcut command parameter');
    if (verb === 'import' && Object.hasOwn(value, 'worker_id')) {
      check(!Object.hasOwn(value, 'template_id') && Object.hasOwn(value, 'hook_id'), 'invalid import source');
      value.worker_id = await resolveWorkerId(client, value.worker_id);
    }
    return client.request(`hooks.command_${verb}`, { [verb === 'save' ? 'command' : 'source']: value, expected_revision });
  }
  exact(args, 1);
  check(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args[0]), 'invalid command id');
  return client.request('hooks.command_remove', { id: args[0], expected_revision });
}

async function runSignal(args, client) {
  const verb = args.shift();
  check(['save','remove'].includes(verb), 'hooks signal requires save|remove; run lush help');
  const expected_revision = readRevision(args);
  if (verb === 'save') {
    const signal = takeJsonInput(args, client, 'signal'); exact(args, 0);
    return client.request('hooks.signal_save', { signal, expected_revision });
  }
  exact(args, 1);
  return client.request('hooks.signal_remove', { id: args[0], expected_revision });
}

async function runManagement(args, client) {
  const verb = args.shift();
  check(['create','enable','disable','receipt','permission-get','permission-set','emergency-preview','emergency-stop'].includes(verb),
    'hooks management requires create|enable|disable|receipt|permission-get|permission-set|emergency-preview|emergency-stop; run lush help');
  if (verb === 'receipt') {
    const after = option(args, '--after'), limit = option(args, '--limit'); exact(args, 1);
    const integer = (value, min, max = Number.MAX_SAFE_INTEGER) => {
      check(typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value))
        && Number(value) >= min && Number(value) <= max, 'invalid management receipt integer');
      return Number(value);
    };
    return client.request('management.receipt', { receipt_id: integer(args[0], 1),
      ...(after === null ? {} : { after: integer(after, 0) }), ...(limit === null ? {} : { limit: integer(limit, 1, 100) }) });
  }
  if (verb === 'emergency-preview') { exact(args, 0); return client.request('management.emergency_preview'); }
  if (verb === 'emergency-stop') {
    const revision = readRevision(args), confirmIndex = args.indexOf('--confirm');
    check(confirmIndex !== -1, 'management emergency-stop requires --confirm after reading emergency-preview');
    args.splice(confirmIndex, 1); exact(args, 0);
    return client.request('management.emergency_stop', { revision, confirm: true });
  }
  if (verb === 'permission-get' || verb === 'permission-set') {
    const scope = option(args, '--scope');
    check(scope === 'device', 'management permissions require --scope device');
    const expected_revision = verb === 'permission-set' ? readRevision(args) : undefined;
    exact(args, verb === 'permission-get' ? 1 : 2);
    return client.request(`management.${verb.replace('-', '_')}`, { method: args[0], scope,
      ...(verb === 'permission-set' ? { access: args[1], expected_revision } : {}) });
  }
  if (verb === 'create') {
    const request = takeJsonInput(args, client, 'management'); exact(args, 0);
    check(Object.keys(request).every(key => ['name','instruction','signal_id','mode','profile','client_request_id'].includes(key)), 'unknown management parameter');
    return client.request('management.create', request);
  }
  const expected_revision = readRevision(args); exact(args, 1);
  return client.request('management.binding_update', { id: await resolveWorkerId(client, args[0]), enabled: verb === 'enable', expected_revision });
}

/** Highest automatic stage; uses the current worker.hooks read revision. */
export async function runWorkerCompletion(args, client) {
  check(!client.token || client.management, 'Hooks configuration is user only, not an agent operation');
  const expected_revision = readRevision(args);
  exact(args, 2);
  check(['off','merge','accept'].includes(args[1]), 'completion expects off|merge|accept');
  return client.request('worker.completion', {
    id: await resolveWorkerId(client, args[0]), level: args[1], expected_revision,
  });
}

/** worker hook attach ID --file PATH; enable|disable|remove ID HOOK_ID. */
export async function runWorkerHook(args, client) {
  check(!client.token || client.management, 'Hooks configuration is user only, not an agent operation');
  const verb = args.shift();
  check(['attach','enable','disable','remove'].includes(verb), 'worker hook requires attach|enable|disable|remove; run lush help');
  const expected_revision = readRevision(args);
  if (verb === 'attach') {
    const hook = takeJsonInput(args, client); exact(args, 1);
    return client.request('worker.hook_attach', { id: await resolveWorkerId(client, args[0]), hook, expected_revision });
  }
  exact(args, 2);
  return client.request(verb === 'remove' ? 'worker.hook_remove' : 'worker.hook_update', {
    id: await resolveWorkerId(client, args[0]), hook_id: args[1], ...(verb === 'remove' ? {} : { enabled: verb === 'enable' }), expected_revision,
  });
}
