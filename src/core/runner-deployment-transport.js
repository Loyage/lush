import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { managedRunnerArguments, managedRecoveryRunnerArguments } from './runner-deployment-remote.js';
import { StdioTransport } from '../runner/transport.js';

/** Trusted descriptor/snapshot only, never a user command/path setting. No plaintext auth in argv/env.
 * This transport is for deployment verification; production selection must additionally require a
 * confirmed receipt and the current explicitly published generation before choosing it.
 */
export const deploymentTransport = options => managedTransport(options, managedRunnerArguments);
export const deploymentRecoveryTransport = options => managedTransport(options, managedRecoveryRunnerArguments);
function managedTransport({ managed, configuration, ...admission }, argumentsFactory) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-managed-ssh-'));
  let transport, disposed = false;
  const cleanup = () => { if (!disposed) { fs.rmSync(directory, { recursive: true, force: true }); disposed = true; } };
  try {
    fs.chmodSync(directory, 0o700);
    const config = path.join(directory, 'config'); fs.writeFileSync(config, configuration, { flag: 'wx', mode: 0o600 });
    const args = argumentsFactory({ ...admission, managed, ssh_alias: managed.ssh_alias, ssh_configuration_file: config });
    const env = Object.fromEntries(['PATH', 'SSH_AUTH_SOCK'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    const user = os.userInfo(); Object.assign(env, { HOME: user.homedir, USER: user.username, LOGNAME: user.username, LANG: 'C', LC_ALL: 'C' });
    transport = new StdioTransport({ command: 'ssh', args, env });
    return { request: (...args) => transport.request(...args), async close() { try { return await transport.close(); } finally { cleanup(); } } };
  } catch { cleanup(); throw new Error('Managed deployment transport could not be prepared'); }
}
