import fs from 'node:fs';
import path from 'node:path';
import { daemon } from '../daemon.js';
import { codeIdentity } from '../../identity.js';
import { check } from '../../core/types.js';
import { exact } from '../args.js';

export async function run(command, args, ctx) {
  const { client } = ctx;
  const config = client.config;
  let value;
  if (command === 'web') {
    check(!client.token, 'agents cannot start web servers');
    check(args.length <= 1, 'web accepts one port');
    const { startWeb } = await import('../../ui/web/server.js');
    const server = startWeb(config, Number(args[0] ?? 4318));
    console.log(`Lush ${config.project}\nhttp://127.0.0.1:${server.port}`); return;
  }
  if (command === 'daemon') {
    check(!client.token, 'agents cannot control daemons'); exact(args, 1); value = await daemon(config, args[0]);
  } else if (command === 'doctor') {
    exact(args, 0);
    value = { bun: Bun.version, project: config.project, home: config.home, socket: config.socket, provider: config.provider, ...codeIdentity() };
    try { value.daemon = await client.request('system.status'); value.code_match = value.daemon.fingerprint === value.fingerprint && value.daemon.code_dir === value.code_dir; }
    catch (error) { value.daemon = error.message; }
  } else if (command === 'status') { exact(args, 0); value = await client.request('system.status');
  }
  else if (command === 'log') {
    exact(args, 0); console.log(fs.readFileSync(path.join(config.home, 'daemon.log'), 'utf8').split('\n').slice(-60).join('\n')); return;
  }
  return value;
}
