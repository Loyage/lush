import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { daemon } from '../daemon.js';
import { ROOT, codeIdentity } from '../../identity.js';
import { check } from '../../core/types.js';
import { exact } from '../args.js';

const DEFAULT_WEB_PORT = 4318;
const WEB_START = ['web', 'web-restart'];
const WEB_COMMANDS = [...WEB_START, 'web-stop', 'web-status'];

/** 对应作用域的 web.json 存在即公网模式；Electron 临时 host 永远只监听回环。 */
function publicWeb(config) {
  return config.env?.LUSH_WEB_EPHEMERAL !== '1' && fs.existsSync(path.join(config.home, 'web.json'));
}
function webUrl(config, port) {
  return `http://${publicWeb(config) ? '0.0.0.0' : '127.0.0.1'}:${port}`;
}

function webLog(config) { return path.join(config.home, 'web.log'); }

function codeView(value, extra = {}) {
  if (!value || typeof value !== 'object' || !value.fingerprint || !value.code_dir) return null;
  return { ...extra, code_dir: value.code_dir, version: value.code_version ?? value.version ?? null, fingerprint: value.fingerprint };
}

function commandText(parts) {
  return parts.map(part => (/^[A-Za-z0-9_./:-]+$/.test(String(part)) ? String(part) : JSON.stringify(String(part)))).join(' ');
}

function webUpdateHint(config, report) {
  if (report.code_match !== false) return null;
  const command = ['bun', 'run', 'web-restart', String(report.port), ...(!config.launcher && config.project ? ['--project', config.project] : [])];
  return { process: 'web', reason: 'code_mismatch', project: config.project ?? null, pid: report.pid, command,
    message: `端口 ${report.port} 上的 Web 与当前磁盘代码不一致；只在准备好清空 Web 登录会话时运行 ${commandText(command)}` };
}

function daemonUpdateHint(config, status, current) {
  if (!status || status.fingerprint === current.fingerprint && status.code_dir === current.code_dir) return null;
  const command = ['bun', 'run', 'daemon-restart', '--project', config.project];
  return { process: 'daemon', reason: 'code_mismatch', project: config.project, pid: status.pid ?? null, command,
    message: `项目 ${config.project} 的 daemon 与当前磁盘代码不一致；确认没有活动 invocation 后运行 ${commandText(command)}` };
}

function withWebDiagnostics(config, report, state, current = codeIdentity()) {
  const webCode = codeView(state, state ? { pid: state.pid, started_at: state.started_at ?? null } : {});
  const value = { ...report, state_file: path.join(config.home, 'web.state.json'), current_code: codeView(current), web_code: webCode,
    identities: { current: codeView(current), web: webCode } };
  value.update_hint = webUpdateHint(config, value);
  return value;
}

/** 启动失败时把日志尾巴带进报错：Bun 只会在日志里说「Is port XX in use?」。 */
function logTail(config, lines = 3) {
  try { return fs.readFileSync(webLog(config), 'utf8').trimEnd().split('\n').slice(-lines).join(' | ').slice(0, 300); }
  catch { return ''; }
}

/**
 * 前台服务：占住终端直到被杀。后台启动的真正就是它（`bin/lush-web`），
 * 调试时也可以 `bun run web --foreground` 直接盯着日志。
 */
async function serveWeb(config, port) {
  const control = await import('../../ui/web/control.js');
  const web = await import('../../ui/web/server.js');
  const publicMode = publicWeb(config);
  let server;
  try { server = web.startWeb(config.launcher ? null : config, port, { env: config.env, authConfig: publicMode ? config : null }); }
  catch (error) {
    // 端口被占最常见的原因就是上一次的 Web 还活着。Bun 只说「Is port XX in use?」，
    // 这里补上是谁占的、以及换成本地代码的那条命令。
    if (!/in use|EADDRINUSE|address/i.test(error.message)) throw error;
    throw new Error(`${error.message}${await control.busyPortHint(port)}`);
  }
  const ephemeral = config.env.LUSH_WEB_EPHEMERAL === '1';
  if (!ephemeral) control.recordWebState(config, { pid: process.pid, port: server.port });
  // 收到 SIGTERM 时先放开端口再清掉记录：留下的陈旧记录会让下一次 web-status 撒谎。
  const shutdown = () => { web.rememberWebProject(server); server.stop(true); if (!ephemeral) control.clearWebState(config, process.pid); process.exit(0); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  if (ephemeral) console.log(`LUSH_WEB_READY ${JSON.stringify({ url: webUrl(config, server.port), port: server.port })}`);
  else console.log(`Lush ${config.project || '项目启动器'}\n${webUrl(config, server.port)}${publicMode ? '\n公网监听，需登录；请在前置代理启用 HTTPS。' : ''}`);
}

/**
 * 后台起 Web：脱离终端、日志进 `.lush/web.log`，等它真的占住端口再返回——
 * 命令返回时页面就能打开，而不是让用户在浏览器里发现它还没起来。
 */
async function launchWeb(config, port, extra = {}) {
  const control = await import('../../ui/web/control.js');
  control.ensureHome(config);
  const fd = fs.openSync(webLog(config), 'a', 0o600);
  const child = cp.spawn(process.execPath, [path.join(ROOT, 'bin/lush-web'), String(port)], {
    cwd: config.project || ROOT, env: config.env, detached: true, stdio: ['ignore', fd, fd],
  });
  fs.closeSync(fd); child.unref();
  let error = null;
  child.on('error', err => { error = err; });
  const state = await control.waitForWebState(config, child.pid, { timeoutMs: 10000, abort: () => Boolean(error) || child.exitCode !== null });
  if (!state) throw new Error(`web failed to start: ${error?.message || logTail(config) || `see ${webLog(config)}`}`);
  return { ...stateReport(config, state), ...extra };
}

/** 记录 → 报告：刚起完的进程不必再问一遍端口（容器里可能根本没有 lsof）。 */
function stateReport(config, state) {
  const current = codeIdentity();
  return withWebDiagnostics(config, {
    project: config.project, port: state.port, url: webUrl(config, state.port),
    running: true, pid: state.pid, pids: [state.pid], others: [],
    log: webLog(config), started_at: state.started_at, code_match: codeMatches(state, current), listeners_known: true,
  }, state, current);
}

/** 在跑的 Web 是不是这份代码：Web 进程不会跟着代码换版本，这是它唯一会骗人的地方。 */
function codeMatches(state, local = codeIdentity()) {
  return state.fingerprint === local.fingerprint && state.code_dir === local.code_dir;
}

/** 后台 Web 跑的是别的代码：页面「打开失败」最常见的成因，在报告里直接点出来。 */
function noteStaleCode(value) {
  if (value?.update_hint) console.error(`lush: ${value.update_hint.message}（日志 ${value.log}）`);
}

/** 端口上的 Web 现状：谁在听、跑的是不是这份代码、日志在哪。 */
async function webReport(config, port) {
  const control = await import('../../ui/web/control.js');
  const owners = control.webOwners(config, port);
  const state = control.liveWebState(config);
  const lush = (owners ?? []).filter(owner => owner.lush);
  const served = state && lush.some(owner => owner.pid === state.pid) ? state : null;
  const current = codeIdentity();
  return withWebDiagnostics(config, {
    project: config.project, port, url: webUrl(config, port),
    running: lush.length > 0, pid: lush[0]?.pid ?? null, pids: lush.map(owner => owner.pid),
    others: (owners ?? []).filter(owner => !owner.lush).map(owner => ({ pid: owner.pid, command: owner.command })),
    log: webLog(config), started_at: served?.started_at ?? null,
    code_match: served ? codeMatches(served, current) : null,
    listeners_known: owners !== null,
  }, served, current);
}

/** `web`：已经在跑就如实报告（幂等），否则后台起一个新的；别人的进程只报告、不碰。 */
async function webStart(config, port, foreground) {
  if (foreground) return await serveWeb(config, port);
  const control = await import('../../ui/web/control.js');
  const owners = control.webOwners(config, port);
  const lush = (owners ?? []).filter(owner => owner.lush);
  if (lush.length) {
    const report = { ...(await webReport(config, port)), already_running: true };
    noteStaleCode(report);
    return report;
  }
  const others = (owners ?? []).filter(owner => !owner.lush);
  if (others.length) throw new Error(`端口 ${port} 被别的进程占用，没有动它：\n${others.map(owner => `  pid ${owner.pid}: ${owner.command || '(取不到命令行)'}`).join('\n')}\n换一个端口，或先停掉它。`);
  return await launchWeb(config, port, { already_running: false });
}

/**
 * 停掉端口上的 Web 并如实报告：停不干净（有别人的进程 / 杀了还在）就报错退出，
 * 不硬着头皮再起一个——否则用户会看到两个 Web 抢同一个端口，却不知道哪个在答。
 */
async function stopWeb(config, port) {
  const control = await import('../../ui/web/control.js');
  const pids = control.webCandidatePids(config, port);
  check(pids !== null, `无法判断端口 ${port} 上有没有 Web 进程（缺少 lsof / ss，也没有 ${control.webStateFile(config)}）；确认端口空闲后再试`);
  const result = await control.stopStaleWeb(port, { pids });
  if (result.refused.length) {
    const owners = result.refused.map(owner => `  pid ${owner.pid}: ${owner.command || '(取不到命令行)'}`).join('\n');
    throw new Error(`端口 ${port} 被不是 Lush Web 的进程占用，没有动它：\n${owners}`);
  }
  if (!result.free) {
    const who = result.stuck.length ? `pid ${result.stuck.join(', ')} 还活着` : '还有别人在监听';
    throw new Error(`端口 ${port} 没能腾出来（${who}）；确认占用者之后再试`);
  }
  // 人类可读的注脚走 stderr：stdout 留给 `--json` 的机器可读结果。
  for (const pid of [...result.stopped, ...result.stuck]) control.clearWebState(config, pid);
  if (result.stopped.length) console.error(`已停掉端口 ${port} 上的 Web 进程 ${result.stopped.join(', ')}`);
  else console.error(`端口 ${port} 上没有在跑的 Web 进程。`);
  // 杀了却还在进程表里：端口已经空出来了，多半是父进程还没回收（僵尸），不该拦住后续操作。
  if (result.stuck.length) console.error(`注：pid ${result.stuck.join(', ')} 仍在进程表里（可能刚被结束、尚未回收），端口已空出。`);
  return result;
}

/** `web-restart`：换掉端口上那个跑着旧代码的 Web。 */
async function webRestart(config, port, foreground) {
  const result = await stopWeb(config, port);
  if (foreground) return await serveWeb(config, port);
  return await launchWeb(config, port, { already_running: false, restarted: true, stopped: result.stopped });
}

/** 端口参数缺省时优先用后台 Web 自己记的端口：`web 0` 让内核挑号，命令行的 0 不是地址。 */
function resolvePort(value, state) {
  if (value === undefined) return state?.port ?? DEFAULT_WEB_PORT;
  const port = Number(value);
  check(Number.isInteger(port) && port >= 0 && port <= 65535, 'invalid web port');
  return port;
}

export async function run(command, args, ctx) {
  const { client } = ctx;
  const config = client.config;
  let value;
  if (WEB_COMMANDS.includes(command)) {
    // `--foreground` 是 bin/lush-web 与调试用的入口：占住终端，其余情况一律后台。
    const foreground = args.includes('--foreground');
    if (foreground) args.splice(args.indexOf('--foreground'), 1);
    check(!client.token, 'agents cannot control web servers');
    check(args.length <= 1, `${command} accepts one port`);
    check(!foreground || WEB_START.includes(command), `${command} has no foreground mode`);
    const control = await import('../../ui/web/control.js');
    const port = resolvePort(args[0], control.liveWebState(config));
    if (command === 'web') value = await webStart(config, port, foreground);
    else if (command === 'web-restart') value = await webRestart(config, port, foreground);
    else if (command === 'web-stop') {
      const result = await stopWeb(config, port);
      value = { ...(await webReport(config, port)), running: false, pid: null, pids: [], stopped: result.stopped };
      if (result.stuck.length) value.stuck = result.stuck;
    } else {
      value = await webReport(config, port);
      noteStaleCode(value);
    }
    return value;
  }
  if (command === 'daemon') {
    check(!client.token, 'agents cannot control daemons'); exact(args, 1); value = await daemon(config, args[0]);
  } else if (command === 'doctor') {
    exact(args, 0);
    const current = codeIdentity();
    value = { bun: Bun.version, project: config.project, home: config.home, socket: config.socket, provider: config.provider, ...current,
      current_code: codeView(current) };
    let daemonStatus = null;
    try {
      daemonStatus = await client.request('system.status');
      value.daemon = daemonStatus;
      value.code_match = daemonStatus.fingerprint === current.fingerprint && daemonStatus.code_dir === current.code_dir;
      value.daemon_code_match = value.code_match;
    } catch (error) { value.daemon = error.message; value.daemon_code_match = null; }
    const control = await import('../../ui/web/control.js');
    const state = control.liveWebState(config);
    value.web = state
      ? await webReport(config, state.port)
      : withWebDiagnostics(config, { project: config.project, port: null, url: null, running: false, pid: null, pids: [], others: [],
        log: webLog(config), started_at: null, code_match: null, listeners_known: false }, null, current);
    const daemonCode = codeView(daemonStatus, daemonStatus ? { pid: daemonStatus.pid ?? null, project: daemonStatus.project ?? null,
      started_at: daemonStatus.started_at ?? null } : {});
    value.daemon_code = daemonCode;
    value.web_code = value.web.web_code;
    value.web_code_match = value.web.code_match;
    value.identities = { current: codeView(current), daemon: daemonCode, web: value.web.web_code };
    value.update_hints = [daemonUpdateHint(config, daemonStatus, current), value.web.update_hint].filter(Boolean);
    if (value.update_hints[0]?.process === 'daemon') console.error(`lush: ${value.update_hints[0].message}`);
    noteStaleCode(value.web);
  } else if (command === 'status') { exact(args, 0); value = await client.request('system.status');
  }
  else if (command === 'log') {
    exact(args, 0); console.log(fs.readFileSync(path.join(config.home, 'daemon.log'), 'utf8').split('\n').slice(-60).join('\n')); return;
  }
  return value;
}
