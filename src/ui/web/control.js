/**
 * Web 进程的识别与回收：`bun run web-restart` 靠它把端口上那个**跑着旧代码**的 Web 换掉。
 *
 * 为什么必须有这一步：`bun run web` 起的进程自己活到被杀为止，不会跟着代码换版本。改完
 * `src/ui/web/` 再在同一个端口上跑一次，只会拿到 "Is port 4318 in use?"；用户接着刷新页面，
 * 旧进程会把**新的** `app.js` 发下来、却对自己没有的路由（比如 `/api/docs`）回 404，
 * 页面于是「打开失败」，而报错里看不出是进程过期。
 *
 * 动手的门槛是两条同时成立：端口上那个 pid 还活着，且它的命令行确实是一个 Lush Web。
 * 别的程序（哪怕名字里带 lush-web）只报告、不杀——宁可让用户自己决定，也不替他关掉别人的进程。
 */
import cp from 'node:child_process';

/** 只有这些运行时的命令行才会被当成 Lush Web；`bun run web` 的子进程是它们中的第一个。 */
const RUNTIME = /(?:^|\/)(?:bun|node|deno)(?:\s|$)/;
const WEB_COMMANDS = [
  // bun run web / bun ./scripts/ops.js web 4318；web-restart 起完之后自己就是那个监听者，
  // 命令行留着 -restart，所以下一次 web-restart 必须照样认得出它。
  /(?:^|\s|\/)ops\.js\s+web(?:-restart)?(?:\s|$)/,
  /(?:^|\s)run\s+web(?:-restart)?(?:\s|$)/,   // bun run web（包装进程，杀不杀都行）
  /(?:^|\s|\/)lush-web(?:\s|$)/,               // bin/lush-web
  /ui[\\/]web[\\/]server\.js/,                 // 直接跑模块
];

/** `ps -o command=` 的一行是不是 Lush Web。空串、别的程序一律 false。 */
export function isLushWebCommand(command) {
  const text = String(command ?? '');
  return RUNTIME.test(text) && WEB_COMMANDS.some(pattern => pattern.test(text));
}

/** `lsof -t` 的输出：一行一个 pid，去重并丢掉非数字行。 */
export function parsePidList(text) {
  const pids = new Set();
  for (const line of String(text ?? '').split('\n')) {
    const value = line.trim();
    if (!/^\d+$/.test(value)) continue;
    const pid = Number.parseInt(value, 10);
    if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

/** `ss -ltnp` 的输出：pid 藏在 `users:(("bun",pid=123,fd=18))` 里，可能一行多个。 */
export function parseSsPids(text) {
  const pids = new Set();
  for (const match of String(text ?? '').matchAll(/pid=(\d+)/g)) {
    const pid = Number.parseInt(match[1], 10);
    if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

/**
 * 端口上的监听进程。优先 `lsof`（macOS 自带、多数 Linux 也有），退回 `ss`（iproute2）。
 * 两个都没有时返回 null：调用方据此告诉用户「自己确认端口」，而不是假装端口空着。
 */
export function webListenerPids(port) {
  const lsof = cp.spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
  if (!lsof.error) return parsePidList(lsof.stdout);
  const ss = cp.spawnSync('ss', ['-ltnp', `sport = :${port}`], { encoding: 'utf8' });
  if (!ss.error) return parseSsPids(ss.stdout);
  return null;
}

function commandOfPid(pid) {
  const result = cp.spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  if (result.error) return '';
  return String(result.stdout ?? '').trim();
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * 停掉一组 pid：只处理命令行确实是 Lush Web 的，先 SIGTERM 给一次收尾机会，
 * 超时再 SIGKILL。返回三段名单，让调用方自己决定怎么说话：
 * `stopped` 真的停掉的、`refused` 不敢动的（附命令行）、`stuck` 杀了还在的。
 */
export async function stopWebPids(pids, options = {}) {
  const {
    timeoutMs = 5000, graceMs = 1000, sleep = ms => Bun.sleep(ms),
    kill = (pid, signal) => process.kill(pid, signal),
    alive = isAlive, commandOf = commandOfPid,
  } = options;
  const targets = [], refused = [];
  for (const pid of pids) {
    if (!alive(pid)) continue;
    const command = commandOf(pid);
    if (isLushWebCommand(command)) targets.push(pid); else refused.push({ pid, command });
  }
  if (!targets.length) return { stopped: [], refused, stuck: [], reason: refused.length ? 'not-lush-web' : 'free' };
  for (const pid of targets) kill(pid, 'SIGTERM');
  const survivors = async () => targets.filter(pid => alive(pid));
  const deadline = Date.now() + timeoutMs;
  while ((await survivors()).length && Date.now() < deadline) await sleep(50);
  const stubborn = await survivors();
  for (const pid of stubborn) kill(pid, 'SIGKILL');
  if (stubborn.length) {
    const grace = Date.now() + graceMs;
    while ((await survivors()).length && Date.now() < grace) await sleep(20);
  }
  const left = await survivors();
  return { stopped: targets.filter(pid => !left.includes(pid)), refused, stuck: left, reason: left.length ? 'stuck' : 'stopped' };
}

/**
 * 把端口腾干净：认出监听者、停下其中确实是 Lush Web 的，再等端口真的空出来——
 * 不等的话紧接着的 `Bun.serve` 可能撞上还没释放的 socket。返回 `stopWebPids` 的三段名单，
 * 外加 `free`（端口现在是否没人监听）与 `reason`。
 */
export async function stopStaleWeb(port, options = {}) {
  const { timeoutMs = 5000, sleep = ms => Bun.sleep(ms), pids = webListenerPids(port), listeners = webListenerPids } = options;
  if (pids === null) return { stopped: [], refused: [], stuck: [], free: false, reason: 'no-port-tool' };
  const result = await stopWebPids(pids, options);
  const deadline = Date.now() + timeoutMs;
  let free = (listeners(port) || []).length === 0;
  while (!free && Date.now() < deadline) { await sleep(50); free = (listeners(port) || []).length === 0; }
  return { ...result, free };
}

/** 端口被别人占着时的补充说明：是旧 Web 就指路 `web-restart`，不是就原样报出命令行。 */
export async function busyPortHint(port) {
  const pids = webListenerPids(port);
  if (pids === null) return '';
  const owners = pids.filter(isAlive).map(pid => ({ pid, command: commandOfPid(pid) }));
  if (!owners.length) return '';
  const web = owners.filter(owner => isLushWebCommand(owner.command));
  if (web.length) return `\n端口 ${port} 上已有一个 Lush Web 进程（pid ${web.map(owner => owner.pid).join(', ')}，跑的很可能仍是旧代码）：用 bun run web-restart ${port} 换成本地代码。`;
  return `\n端口 ${port} 被 pid ${owners.map(owner => owner.pid).join(', ')} 占用，命令行不是 Lush Web，没有动它：\n${owners.map(owner => `  ${owner.command}`).join('\n')}`;
}
