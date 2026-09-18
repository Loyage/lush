import { Config } from '../../config.js';
import { connectUI } from '../client.js';
import { WebUIServer } from './server.js';

function webPort(env) {
  const raw = env.LUSH_WEB_PORT ?? '4318';
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid LUSH_WEB_PORT: ${raw}`);
  }
  return port;
}

/** Run the local Web UI until SIGINT or SIGTERM. */
export async function main(env = process.env) {
  const config = Config.fromEnv(env);
  const ui = connectUI(config.socket, 5);
  // Web UI owns only its HTTP listener. It stays available while lushd is
  // stopped or restarted; API calls reconnect through the socket per request.
  const server = new WebUIServer(ui, { port: webPort(env) });
  await server.start();
  process.stdout.write(`Lush Web UI: ${server.url}\n`);

  let finish;
  const stopped = new Promise((resolve) => { finish = resolve; });
  const onSignal = () => finish();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    await stopped;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await server.stop();
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    process.stderr.write(`lush-web: ${err?.message ?? err}\n`);
    process.exit(1);
  }
}
