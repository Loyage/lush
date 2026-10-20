import { check } from '../../core/types.js';
import { AdministratorClient } from '../../administrator/client.js';
import { startAdministrator } from '../../administrator/main.js';

export async function run(command, args, { client }) {
  check(command === 'administrator' && args.length === 1 && ['start', 'stop', 'status'].includes(args[0]), 'administrator requires start|stop|status');
  check(!client?.token && !client?.management, 'Agent identities cannot control the administrator service');
  const env = client.config.env, control = new AdministratorClient({ env });
  control.assertUserControl();
  if (args[0] === 'start') return startAdministrator({ env });
  if (args[0] === 'status') return control.readStatus();
  // This is lifecycle cancellation, not an instruction or an authorization grant.
  return control.shutdown(`local-terminal-user-${process.getuid()}`);
}
