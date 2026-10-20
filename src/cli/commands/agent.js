import { check } from '../../core/types.js';
import { exact, option } from '../args.js';
import { takeConfigurationScope, scopedSettingsClient } from '../settings-scope.js';
import { runSources, runResources } from './agent-sources.js';

/** Only public core resource operations; private configuration conveniences are retired. */
export async function run(command, args, { client, json }) {
  check(command === 'agent', 'unknown agent command');
  check(!client.token || client.management, 'agents cannot read or change managed model sources');
  client = scopedSettingsClient(client, takeConfigurationScope(args));
  const verb = args.shift();
  if (verb === 'status') { exact(args, 0); return client.request('agent.status'); }
  if (verb === 'source') return runSources(args, client, { json });
  check(verb === 'model', 'agent requires status, model or source');
  const action = args.shift();
  if (action === 'choices') return runResources(args, client, { json });
  check(action === 'list', 'agent model requires list or choices');
  const backend = option(args, '--backend'); exact(args, 0);
  check(['pi', 'codex'].includes(backend), 'agent model list requires --backend pi|codex');
  return client.request('agent.models', { agent: backend });
}
