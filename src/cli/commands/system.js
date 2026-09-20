import fs from 'node:fs';
import path from 'node:path';
import { daemon } from '../daemon.js';
import { codeIdentity } from '../../identity.js';
import { check } from '../../core/types.js';
import { exact } from '../args.js';

const DEFAULT_WEB_PORT = 4318;

/** 起 Web：前台占用终端，直到进程被杀（与 `bun run web` 完全一致）。 */
async function serveWeb(config, port) {
  const { startWeb } = await import('../../ui/web/server.js');
  const publicMode = fs.existsSync(path.join(config.home, 'web.json'));
  let server;
  try { server = startWeb(config, port); }
  catch (error) {
    // 端口被占最常见的原因就是上一次的 Web 还活着。Bun 只说「Is port XX in use?」，
    // 这里补上是谁占的、以及换成本地代码的那条命令。
    if (!/in use|EADDRINUSE|address/i.test(error.message)) throw error;
    const { busyPortHint } = await import('../../ui/web/control.js');
    throw new Error(`${error.message}${await busyPortHint(port)}`);
  }
  console.log(`Lush ${config.project}\nhttp://${publicMode ? '0.0.0.0' : '127.0.0.1'}:${server.port}${publicMode ? '\n公网监听，需登录；请在前置代理启用 HTTPS。' : ''}`);
}

/**
 * 换掉端口上的旧 Web：先停、后起。停不干净（有别人的进程 / 杀了还在）就报错退出，
 * 不硬着头皮再起一个——否则用户会看到两个 Web 抢同一个端口，却不知道哪个在答。
 */
async function restartWeb(config, port) {
  const { stopStaleWeb } = await import('../../ui/web/control.js');
  const result = await stopStaleWeb(port);
  check(result.reason !== 'no-port-tool', `无法判断端口 ${port} 上有没有旧 Web 进程（缺少 lsof / ss）；确认端口空闲后再运行 bun run web ${port}`);
  if (result.refused.length) {
    const owners = result.refused.map(owner => `  pid ${owner.pid}: ${owner.command || '(取不到命令行)'}`).join('\n');
    throw new Error(`端口 ${port} 被不是 Lush Web 的进程占用，没有动它：\n${owners}`);
  }
  // 停不干净就别硬起：两个 Web 抢一个端口，用户根本看不出谁在答。
  if (!result.free) {
    const who = result.stuck.length ? `pid ${result.stuck.join(', ')} 还活着` : '还有别人在监听';
    throw new Error(`端口 ${port} 没能腾出来（${who}）；确认占用者之后再试`);
  }
  if (result.stopped.length) console.log(`已停掉端口 ${port} 上的旧 Web 进程 ${result.stopped.join(', ')}`);
  else console.log(`端口 ${port} 上没有旧 Web 进程，直接启动。`);
  // 杀了却还在进程表里：端口已经空出来了，多半是父进程还没回收（僵尸），不该拦住重启。
  if (result.stuck.length) console.log(`注：pid ${result.stuck.join(', ')} 仍在进程表里（可能刚被结束、尚未回收），端口已空出。`);
  await serveWeb(config, port);
}

export async function run(command, args, ctx) {
  const { client } = ctx;
  const config = client.config;
  let value;
  if (command === 'web' || command === 'web-restart') {
    check(!client.token, 'agents cannot start web servers');
    check(args.length <= 1, `${command} accepts one port`);
    const port = Number(args[0] ?? DEFAULT_WEB_PORT);
    check(Number.isInteger(port) && port >= 0 && port <= 65535, 'invalid web port');
    if (command === 'web') await serveWeb(config, port); else await restartWeb(config, port);
    return;
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
