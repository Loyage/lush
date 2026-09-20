/**
 * Web 进程的识别、回收与自我描述。
 *
 * 为什么必须有这一步：`bun run web` 起的是**后台**进程，它自己活到被杀为止，不会跟着代码换版本。
 * 改完 `src/ui/web/` 再在同一个端口上跑一次，只会拿到「端口已在用」；用户接着刷新页面，旧进程会把
 * **新的** `app.js` 发下来、却对自己没有的路由（比如 `/api/docs`）回 404，页面于是「打开失败」，
 * 而报错里看不出是进程过期。所以这里提供三件事：
 *
 *   1. 认出端口上的监听者（`webListenerPids`）与「命令行是不是 Lush Web」（`isLushWebCommand`）；
 *   2. 只停命令行确实是 Lush Web 的进程（`stopWebPids` / `stopStaleWeb`）——别的程序（哪怕名字里带
 *      lush-web）只报告、不杀，宁可让用户自己决定，也不替他关掉别人的进程；
 *   3. 后台 Web 留下的自我描述（`.lush/web.state.json`：pid / 端口 / 代码指纹 / 启动时间），
 *      让 `web-status` 能说清「在跑的是不是这份代码」，而不是只看端口在不在。
 */
import cp from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { codeIdentity } from '../../identity.js';

/** 只有这些运行时的命令行才会被当成 Lush Web；`bun run web` 的子进程是它们中的第一个。 */
const RUNTIME = /(?:^|\/)(?:bun|node|deno)(?:\s|$)/;
const WEB_COMMANDS = [
  // 后台启动的正是 `bin/lush-web`；前台调试时命令行则是 `ops.js web ... --foreground`。
  // `bun run web` 的包装进程在同一份命令行里也带 `web`，同样认得出来。
  /(?:^|\s|\/)ops\.js\s+web(?:-restart)?(?:\s|$)/,
  /(?:^|\s)run\s+web(?:-restart)?(?:\s|$)/,   // bun run web（包装进程，杀不杀都行）
  /(?:^|\s|\/)lush-web(?:\s|$)/,               // bin/lush-web
  /ui[\\/]web[\\/]server\.js/,                 // 直接跑模块
];
/** `.lush/web.json` 是登录配置，后台 Web 的自我描述另放一个文件：两者不能混。 */
const STATE_FILE = 'web.state.json';

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

/** 端口上有没有人在听。后台启动后靠它确认服务真的起来了，而不是看日志猜。 */
export function portListening(port, timeoutMs = 1000) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
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

/** pid 名单 → `{ pid, command, lush }`：只有 `lush` 为真的才允许被停。 */
function ownersOf(pids) {
  return pids.filter(isAlive).map(pid => {
    const command = commandOfPid(pid);
    return { pid, command, lush: isLushWebCommand(command) };
  });
}

/* ---------- 后台 Web 的自我描述：`.lush/web.state.json` ---------- */

export function webStateFile(config) {
  return path.join(config.home, STATE_FILE);
}

/**
 * `.lush/` 必须存在才能落日志与状态。不存在就建出来（与 daemon 同一套权限），
 * 存在就照 `config.prepare()` 的规矩查一遍：符号链接或别人的目录一律不碰。
 */
export function ensureHome(config) {
  const stat = fs.existsSync(config.home) ? fs.lstatSync(config.home) : null;
  if (stat) {
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== process.getuid()) throw new Error(`unsafe state directory: ${config.home}`);
    return;
  }
  fs.mkdirSync(config.home, { recursive: true, mode: 0o700 });
}

/** 读记录；文件缺失、不是 JSON、版本不对一律当没有。 */
export function readWebState(config) {
  try {
    const value = JSON.parse(fs.readFileSync(webStateFile(config), 'utf8'));
    const ok = value && value.version === 1 && Number.isSafeInteger(value.pid) && value.pid > 0
      && Number.isSafeInteger(value.port) && value.port >= 0 && value.port <= 65535;
    return ok ? value : null;
  } catch { return null; }
}

/** 记录里那个进程还活着才算数：崩溃或被 SIGKILL 留下的记录不该让 status 报「在跑」。 */
export function liveWebState(config) {
  const state = readWebState(config);
  return state && isAlive(state.pid) ? state : null;
}

/**
 * 写下「我在这个端口上跑这份代码」。由正在服务的进程自己写，取不到指纹就当没写成：
 * 这份记录只服务 `web-status`，写不进去也不该拖垮 Web 本身。
 */
export function recordWebState(config, { pid, port }) {
  const { fingerprint, code_dir, version: code_version } = codeIdentity();
  const state = { version: 1, pid, port, started_at: new Date().toISOString(), fingerprint, code_dir, code_version };
  try {
    ensureHome(config);
    const file = webStateFile(config);
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
    return state;
  } catch { return null; }
}

/**
 * 删掉记录。给了 pid 就只在记录属于那个进程时才删——重启时旧进程收尾得比新进程写记录晚，
 * 无条件删会把新进程刚写下的记录抹掉。
 */
export function clearWebState(config, pid = null) {
  const state = readWebState(config);
  if (state && pid !== null && state.pid !== pid) return false;
  try { fs.rmSync(webStateFile(config), { force: true }); return true; } catch { return false; }
}

/**
 * 停/查 Web 时的候选 pid：端口上的监听者 ∪ 记录里那个进程（只在端口对得上时——
 * 记录说的是另一个端口上的 Web，不能用它去替这个端口停）。两者都不作数时返回 null，
 * 让调用方说「判断不了」，而不是把「没有 lsof」当成「端口上没人」。
 */
export function webCandidatePids(config, port) {
  const listeners = webListenerPids(port);
  const state = liveWebState(config);
  const own = state && state.port === port ? state.pid : null;
  if (listeners === null && own === null) return null;
  return [...new Set([...(listeners ?? []), ...(own === null ? [] : [own])])];
}

/** 端口（+ 记录）上的监听者名单，附命令行与「是不是 Lush Web」；判断不了时返回 null。 */
export function webOwners(config, port) {
  const pids = webCandidatePids(config, port);
  return pids === null ? null : ownersOf(pids);
}

/**
 * 等后台 Web 真的开始服务：记录里必须是刚 spawn 的那个 pid，且它记的端口已经在听。
 * `abort()` 让调用方在子进程已经退出时立刻放弃，不必等到超时。返回记录，超时/退出返回 null。
 */
export async function waitForWebState(config, pid, options = {}) {
  const {
    timeoutMs = 10000, intervalMs = 50, sleep = ms => Bun.sleep(ms),
    read = () => readWebState(config), listening = portListening, abort = () => false,
  } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = read();
    if (state && state.pid === pid && await listening(state.port)) return state;
    if (abort()) return null;
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
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
 * 外加 `free`（端口现在是否没人监听）与 `reason`。一个进程都没停掉时直接看端口，不必空等。
 */
export async function stopStaleWeb(port, options = {}) {
  const { timeoutMs = 5000, sleep = ms => Bun.sleep(ms), pids = webListenerPids(port), listeners = webListenerPids } = options;
  if (pids === null) return { stopped: [], refused: [], stuck: [], free: false, reason: 'no-port-tool' };
  const result = await stopWebPids(pids, options);
  if (!result.stopped.length) return { ...result, free: (listeners(port) || []).length === 0 };
  const deadline = Date.now() + timeoutMs;
  let free = (listeners(port) || []).length === 0;
  while (!free && Date.now() < deadline) { await sleep(50); free = (listeners(port) || []).length === 0; }
  return { ...result, free };
}

/** 端口被别人占着时的补充说明：是旧 Web 就指路 `web-restart`，不是就原样报出命令行。 */
export async function busyPortHint(port) {
  const pids = webListenerPids(port);
  if (pids === null) return '';
  const owners = ownersOf(pids);
  if (!owners.length) return '';
  const web = owners.filter(owner => owner.lush);
  if (web.length) return `\n端口 ${port} 上已有一个 Lush Web 进程（pid ${web.map(owner => owner.pid).join(', ')}，跑的很可能仍是旧代码）：用 bun run web-restart ${port} 换成本地代码。`;
  return `\n端口 ${port} 被 pid ${owners.map(owner => owner.pid).join(', ')} 占用，命令行不是 Lush Web，没有动它：\n${owners.map(owner => `  ${owner.command}`).join('\n')}`;
}
