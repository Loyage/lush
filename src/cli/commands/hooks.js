import { check } from '../../core/types.js';
import { resolveWorkerId } from '../worker-number.js';
import { exact, option } from '../args.js';
import { takeJsonInput } from '../private-json.js';
import { validateHookRegistration, validateTemporaryAutomation } from '../../core/hook-registration.js';

function readRevision(args) {
  const revision = option(args, '--revision');
  check(typeof revision === 'string' && revision.length > 0 && revision.length <= 256
    && revision === revision.trim() && !/[\x00-\x1f\x7f]/.test(revision),
  'first read automation list or worker automation show ID, then provide --revision REV');
  return revision;
}

/** Project definition catalogue; registration never attaches or executes a rule. */
export async function run(command, args, { client }) {
  check(command === 'automation', 'use lush automation; hooks is no longer executable');
  check(!client.token || client.management, 'Automation configuration requires user or trusted management identity');
  const verb = args.shift();
  if (verb === 'list') {
    const index = args.indexOf('--include-reclaimed'), include_reclaimed = index >= 0;
    if (include_reclaimed) args.splice(index, 1);
    const after = option(args, '--after'), limit = option(args, '--limit'); exact(args, 0);
    return client.request('hooks.list', { ...(include_reclaimed ? { include_reclaimed: true } : {}),
      ...(after !== null ? { after } : {}), ...(limit !== null ? { limit: Number(limit) } : {}) });
  }
  if (verb === 'temporary') return runTemporary(args, client);
  if (verb === 'register') {
    const value = takeJsonInput(args, client, 'Hook registration'); exact(args, 0);
    return client.request('hooks.register', validateHookRegistration(value));
  }
  if (verb === 'completion-defaults') {
    const action = args.shift();
    if (action === 'show') { exact(args, 0); return projectPart(await client.request('hooks.list'), 'completion_defaults'); }
    check(action === 'set', 'completion-defaults requires show|set');
    const expected_revision = readRevision(args); exact(args, 2);
    check(['on','off'].includes(args[0]) && ['merge','accept'].includes(args[1]), 'completion-defaults set expects on|off merge|accept --revision REV');
    return client.request('hooks.completion_defaults', { enabled: args[0] === 'on', level: args[1], expected_revision });
  }
  if (verb === 'command') return runCommand(args, client);
  if (verb === 'signal') return runSignal(args, client);
  check(['save','remove'].includes(verb), 'automation requires list|temporary|register|save|remove|completion-defaults|command|signal; run lush help automation');
  const expected_revision = readRevision(args);
  if (verb === 'save') {
    const template = takeJsonInput(args, client); exact(args, 0);
    return client.request('hooks.save', { template, expected_revision });
  }
  exact(args, 1);
  return client.request('hooks.remove', { id: args[0], expected_revision });
}

async function runTemporary(args, client) {
  const verb = args.shift();
  check(['create','reclaim','history'].includes(verb), 'automation temporary requires create|reclaim|history');
  const method = `hooks.temporary_${verb}`;
  if (verb === 'history') {
    const before = option(args, '--before'), limit = option(args, '--limit'); exact(args, 1);
    return client.request(method, validateTemporaryAutomation(method, { id: args[0],
      ...(before !== null ? { before: Number(before) } : {}), ...(limit !== null ? { limit: Number(limit) } : {}) }));
  }
  const value = takeJsonInput(args, client, 'Temporary automation'); exact(args, 0);
  return client.request(method, validateTemporaryAutomation(method, value));
}

// Keep the original read model and its actual revision; absence is not an empty catalogue.
function projectPart(value, key) {
  check(value?.[key] && typeof value[key] === 'object' && !Array.isArray(value[key]), `automation ${key} read model unavailable; inspect automation list`);
  const metadata = Object.fromEntries(['coverage','truncated','omitted','warnings']
    .filter(name => Object.hasOwn(value, name) && !Object.hasOwn(value[key], name)).map(name => [name, value[name]]));
  return { ...value[key], ...metadata };
}

async function runCommand(args, client) {
  const verb = args.shift();
  check(['list','save','remove','history','export'].includes(verb),
    'automation command requires list|save|remove|history|export; run lush help automation command');
  if (verb === 'list') { exact(args, 0); return projectPart(await client.request('hooks.list'), 'commands'); }
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
  if (verb === 'save') {
    const command = takeJsonInput(args); exact(args, 0);
    const keys = ['id','name','kind','command','prompt','default_worker_id','description','when_to_use','tags','examples','warnings'];
    check(Object.keys(command).every(key => keys.includes(key)), 'unknown shortcut command parameter');
    return client.request('hooks.command_save', { command, expected_revision });
  }
  exact(args, 1);
  check(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args[0]), 'invalid command id');
  return client.request('hooks.command_remove', { id: args[0], expected_revision });
}

async function runSignal(args, client) {
  const verb = args.shift();
  if (verb === 'list') { exact(args, 0); return projectPart(await client.request('hooks.list'), 'signals'); }
  check(['save','remove'].includes(verb), 'automation signal requires list|save|remove; run lush help automation signal');
  const expected_revision = readRevision(args);
  if (verb === 'save') {
    const signal = takeJsonInput(args, client, 'signal'); exact(args, 0);
    return client.request('hooks.signal_save', { signal, expected_revision });
  }
  exact(args, 1);
  return client.request('hooks.signal_remove', { id: args[0], expected_revision });
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

/** Worker automation calls this helper; the caller maps public detach to remove. */
export async function runWorkerHook(args, client) {
  check(!client.token || client.management, 'Hooks configuration is user only, not an agent operation');
  const verb = args.shift();
  check(['attach','enable','disable','remove'].includes(verb), 'worker automation requires attach|enable|disable|detach; run lush help worker automation');
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
