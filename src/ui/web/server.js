import path from 'node:path';
import fs from 'node:fs';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { UIClient } from '../client.js';
import { Config } from '../../config.js';
import { daemon } from '../../cli/daemon.js';
import { canonicalProjectPath, launcherWebConfig, readLauncherState, removeLauncherProject, projectRouteId, writeLauncherState } from '../launcher.js';
import { docsIndex, docsSearchIndex, readDoc } from './docs.js';
import { previewResponse } from './notice-preview.js';
import { check, id } from '../../core/types.js';
const ASSETS = fileURLToPath(new URL('./assets/', import.meta.url));
const AUTH_FILE = 'web.json';
const SESSION_COOKIE = 'lush_session';
const SESSION_SECONDS = 12 * 60 * 60;
const WEB_HOSTS = new WeakMap();
/**
 * 前端资源按 basename 解析，新增模块只加文件、不改这张表——否则每个拆分 asset 的并行 worker
 * 都要动同一个 server.js，正是我们要消掉的那种冲突。扩展名白名单把目录穿越、dotfile
 * 与任意文件读取挡在外面：name 里不允许 '/'，只接受 .js / .css。
 */
const ASSET_EXTENSIONS = new Set(['.js', '.css']);
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function assetFile(pathname) {
  if (pathname === '/') return path.join(ASSETS, 'index.html');
  const name = pathname.slice(1);
  if (!ASSET_NAME.test(name) || !ASSET_EXTENSIONS.has(path.extname(name))) return null;
  return path.join(ASSETS, name);
}
const MUTATIONS = new Set(['sleep.start','sleep.stop','sleep.resume','explanation.start','intro.start','intro.configure','showcase.start','showcase.reserve','showcase.unreserve','showcase.stop','agent.configure','agent.environment.configure','system.configure','say.submit','input.submit','draft.add','draft.remove','draft.update','draft.commit','task.message','task.reserve','task.resolve_divergence','task.analyze','task.unreserve','task.approve_merge','task.cancel','task.retry','task.merge','task.merge_many','task.cleanup','task.verify','task.delete','task.clear','notice.answer','notice.dismiss','plan.approve','plan.reject','candidate.prepare','candidate.verify','candidate.accept','candidate.changes','candidate.reject','branch.bind','branch.merge','branch.sync','branch.catchup','branch.archive']);
/** 检验报告是 agent 写的自包含 HTML：只允许内联样式/脚本与 data: 图片，禁止任何外部加载与表单提交。
 *  主页面 CSP 不会作用于这个独立文档，所以这里必须自己收紧。 */
const REPORT_CSP = "sandbox allow-scripts; frame-ancestors 'self'; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'";
const PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const LOGIN_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function secretEqual(left, right) {
  const a = createHash('sha256').update(String(left)).digest();
  const b = createHash('sha256').update(String(right)).digest();
  return timingSafeEqual(a, b);
}
function passwordHash(password) {
  const salt = randomBytes(16);
  const digest = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${digest.toString('base64url')}`;
}
function verifyPassword(password, encoded) {
  const match = /^scrypt\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(encoded);
  if (!match) return false;
  const salt = Buffer.from(match[1], 'base64url');
  const expected = Buffer.from(match[2], 'base64url');
  const actual = scryptSync(password, salt, expected.length);
  return expected.length > 0 && timingSafeEqual(actual, expected);
}
/** web.json 出现即表示显式开启公网模式；首次启动会把临时明文密码原地换成 scrypt hash。
 *  全局启动器还必须列出可打开的项目，避免一个公网入口变成任意本机目录选择器。 */
function loadAuth(config, { launcher = false } = {}) {
  const file = path.join(config.home, AUTH_FILE);
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  check(!stat.isSymbolicLink() && stat.isFile() && stat.uid === process.getuid(), `unsafe Web auth file: ${file}`);
  check((stat.mode & 0o077) === 0, `${file} must only be readable by its owner (chmod 600)`);
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error(`invalid JSON in ${file}`); }
  check(value && value.version === 1, `${file} must have version 1`);
  check(typeof value.username === 'string' && value.username === value.username.trim() && value.username.length >= 1 && value.username.length <= 128,
    `${file} username must be 1-128 characters without surrounding whitespace`);
  check(value.origin === undefined || typeof value.origin === 'string', `${file} origin must be a string`);
  check(value.origins === undefined || Array.isArray(value.origins), `${file} origins must be an array of strings`);
  let projects = null;
  if (launcher) {
    check(Array.isArray(value.projects) && value.projects.length > 0, `${file} projects must be a non-empty array of allowed project paths`);
    projects = [...new Set(value.projects.map(entry => canonicalProjectPath(entry, config.env)))];
  }
  // 反向代理把 Host 改写成 127.0.0.1 时，浏览器发出的 Origin 是对外地址：这里把对外地址登记成可信源。
  const origins = [...(value.origin ? [value.origin] : []), ...(value.origins || [])].map(entry => {
    let parsed;
    try { parsed = new URL(entry); } catch { parsed = null; }
    check(parsed && ['http:', 'https:'].includes(parsed.protocol) && parsed.pathname === '/' && !parsed.search && !parsed.hash,
      `${file} origin "${entry}" must look like https://lush.example.com`);
    return parsed.origin;
  });
  const plaintext = typeof value.password === 'string';
  const hashed = typeof value.password_hash === 'string';
  check(plaintext !== hashed, `${file} must contain exactly one of password or password_hash`);
  let password_hash = value.password_hash;
  if (plaintext) {
    // 首尾空白一律忽略：从终端或聊天窗口复制密码时很容易带上换行，它不该变成登录失败。
    const secret = value.password.trim();
    check(secret.length >= 12 && secret.length <= 1024, `${file} password must be 12-1024 characters`);
    password_hash = passwordHash(secret);
    const replacement = JSON.stringify({ version: 1, username: value.username, ...(projects ? { projects } : {}), ...(origins.length ? { origin: origins[0], ...(origins.length > 1 ? { origins: origins.slice(1) } : {}) } : {}), password_hash }, null, 2) + '\n';
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, replacement, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, file);
      fs.chmodSync(file, 0o600);
    } finally { fs.rmSync(temporary, { force: true }); }
  } else check(/^scrypt\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/.test(password_hash), `${file} has an invalid password_hash`);
  return { username: value.username, password_hash, origins, projects,
    config_hint: launcher ? '全局 Web 配置 web.json' : '.lush/web.json' };
}
function cookieValue(request, name) {
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const index = part.indexOf('=');
    if (index >= 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}
function safeNext(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/';
}
function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
function loginPage(error = '', next = '/') {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lush · 登录</title><style>
:root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color-scheme:dark;color:#e6efe9;background:#0f1613}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}.login{width:min(380px,100%);padding:28px;background:#161f1a;border:1px solid #27362d;border-radius:12px}.login h1{margin:0 0 4px;color:#8fd6a9;font-size:24px}.login p{margin:0 0 20px;color:#93a89b;font-size:13px}.login label{display:block;margin:12px 0 5px;font-size:13px}.login input{width:100%;padding:10px;border:1px solid #27362d;border-radius:7px;background:#0f1613;color:#e6efe9;font:inherit}.login button{width:100%;margin-top:20px;padding:10px;border:0;border-radius:7px;background:#8fd6a9;color:#12211a;font:inherit;font-weight:600;cursor:pointer}.error{color:#ffb4ac!important}.warning{margin-top:16px!important;font-size:11px!important}
</style></head><body><main class="login"><h1>Lush</h1><p>登录后访问项目 Web UI</p>${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}<form method="post" action="/login"><input type="hidden" name="next" value="${escapeHtml(safeNext(next))}"><label for="username">账号</label><input id="username" name="username" autocomplete="username" required autofocus><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit">登录</button></form><p class="warning">公网访问请在本服务前配置 HTTPS 反向代理，避免账号密码被明文传输。</p></main></body></html>`;
}
/** 请求自带的 host 就是浏览器看到的 host；反向代理改写过 Host 时两者才会不一致，需要用 web.json 的 origin 显式登记对外地址。 */
function originAllowed(request, url, origins) {
  const site = request.headers.get('sec-fetch-site');
  const navigation = request.method === 'GET' && request.headers.get('sec-fetch-mode') === 'navigate' && request.headers.get('sec-fetch-dest') === 'document';
  // 顶层导航只是「有人从别的站点点了链接进来」，后面还有认证拦着；跨站子请求才是 CSRF 的形状。
  if (site === 'cross-site' && !navigation) return false;
  // Sec-Fetch-* 由浏览器自己填，网页改不了；浏览器既然说不是跨站就不必再拿 Origin 复算一遍。
  // 内嵌 webview / 沙箱 iframe / 部分隐私扩展会报 Origin: null 却依然是同源，硬要 Origin 会白挡下正常的个人使用。
  if (site) return true;
  // 没有 Sec-Fetch（旧浏览器）时退回 Origin 校验。
  const origin = request.headers.get('origin');
  if (!origin || origin === 'null') return true;
  let parsed;
  try { parsed = new URL(origin); } catch { parsed = null; }
  return Boolean(parsed) && (parsed.host === url.host || origins.includes(parsed.origin));
}

export function createProjectHost(initialConfig = null, options = {}) {
  const launcher = !initialConfig;
  const env = options.env || process.env;
  const allowedProjects = options.allowedProjects ? new Set(options.allowedProjects) : null;
  const openProject = options.openProject || (async project => {
    const config = new Config({ project, env });
    await daemon(config, 'start');
    return { config, client: new UIClient(config) };
  });
  const boundProject = initialConfig ? initialConfig.project : null;
  /** 每个 canonical 路径一份连接与客户端；连接失败只脏这一格，不影响其它项目。 */
  const connections = new Map();
  const inflight = new Map();
  const failures = new Map();
  /** 摘要读取的退避：不可达项目不每轮重试，但不影响其它项目的行。 */
  const summaryBackoff = new Map();
  const SUMMARY_TIMEOUT_MS = 4000, SUMMARY_BACKOFF_MS = 60_000;
  if (initialConfig) connections.set(boundProject, { config: initialConfig, client: new UIClient(initialConfig) });

  /** 已登记项目：公网模式只认白名单（不退化为仅控制选择器）；本地全局模式认启动器列表；单项目模式只有自己。 */
  function registry() {
    if (allowedProjects) return [...allowedProjects];
    const list = [];
    if (boundProject) list.push(boundProject);
    if (launcher) for (const project of readLauncherState(env).projects) if (!list.includes(project)) list.push(project);
    return list;
  }

  /**
   * URL 里的不透明 ID → canonical 路径。只认已登记集合，绝不把 URL 片段当路径。
   * 登记项与磁盘 realpath 不一致（符号链接 / 目录搬家）时按真实路径匹配，但只在它仍存在时。
   */
  function routePath(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{16}$/.test(id)) return null;
    for (const entry of registry()) {
      if (projectRouteId(entry) === id) return entry;
      try {
        const real = fs.realpathSync(entry);
        if (projectRouteId(real) === id) return real;
      } catch { /* 目录不在了：保留原登记项，解析失败时显式报错而不是绑定别的目录 */ }
    }
    return null;
  }

  /** 同一项目的并发打开只做一次启动 / 连接尝试（single-flight）。 */
  async function connect(project) {
    const existing = connections.get(project);
    if (existing) return existing;
    const pending = inflight.get(project);
    if (pending) return await pending;
    const attempt = (async () => {
      const next = await openProject(project);
      check(next?.config && next?.client, 'project opener returned an invalid binding');
      connections.set(project, next);
      failures.delete(project);
      summaryBackoff.delete(project);
      return next;
    })();
    inflight.set(project, attempt);
    try { return await attempt; }
    catch (error) { failures.set(project, error.message); throw error; }
    finally { inflight.delete(project); }
  }

  function entries() {
    const state = launcher ? readLauncherState(env) : { last_project: boundProject };
    const last = state.last_project && (!allowedProjects || allowedProjects.has(state.last_project)) ? state.last_project : null;
    return registry().map(project => ({ id: projectRouteId(project), project, name: path.basename(project) || project,
      connected: connections.has(project) || inflight.has(project), last: project === last,
      error: failures.get(project) ?? null }));
  }

  async function select(value) {
    check(launcher, 'this Web UI is bound to one project; restart it without --project to switch projects');
    const project = canonicalProjectPath(value, env);
    check(!allowedProjects || allowedProjects.has(project), `项目不在全局 Web 白名单中：${project}`);
    writeLauncherState(project, env);
    await connect(project);
    return project;
  }

  return {
    launcher,
    async status() {
      const state = launcher ? readLauncherState(env) : { last_project: boundProject };
      const last = state.last_project && (!allowedProjects || allowedProjects.has(state.last_project)) ? state.last_project : null;
      return { mode: launcher ? 'launcher' : 'bound', project: boundProject,
        last_project: last, last_project_id: last ? projectRouteId(last) : null,
        error: null, ...(launcher && allowedProjects ? { allowed_projects: [...allowedProjects] } : {}),
        projects: entries() };
    },
    /** 项目列表 + 仅对已经连接的项目读一次有界摘要；不因为列表面板就启动没打开过的 daemon。
     *  每个项目独立计时、失败独立退避：一个卡住的 daemon 不能拖住整张列表。 */
    async projects() {
      return await Promise.all(entries().map(async row => {
        const binding = connections.get(row.project);
        if (!binding) return row;
        const retryAt = summaryBackoff.get(row.project) ?? 0;
        if (retryAt > Date.now()) return { ...row, error: failures.get(row.project) ?? '项目暂时不可达' };
        let timer = null;
        try {
          const status = await Promise.race([
            binding.client.request('system.summary'),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('项目摘要读取超时')), SUMMARY_TIMEOUT_MS); timer.unref?.(); }),
          ]);
          summaryBackoff.delete(row.project);
          return { ...row, error: null, summary: { project: status.project, revision: status.revision, provider: status.provider,
            agents_total: status.agents_total ?? 0, notices: status.notices ?? 0,
            waiting_approval: status.intents?.waiting_approval ?? 0, pending_merges: status.pending_merges?.length ?? 0 } };
        } catch (error) {
          summaryBackoff.set(row.project, Date.now() + SUMMARY_BACKOFF_MS);
          return { ...row, error: error.message };
        } finally { if (timer) clearTimeout(timer); }
      }));
    },
    async select(value) { return await select(value); },
    /** 项目页请求：解析 ID、必要时连接；未知 / 失效身份显式报错，绝不回退到「当前项目」。 */
    async openRoute(id) {
      const project = routePath(id);
      check(project, `未知或已失效的项目身份：${id}（请刷新页面或从项目列表重新打开）`);
      return await connect(project);
    },
    /** 从列表移除：只删入口并断开 Web 连接，不停止 daemon。 */
    remove(id) {
      check(launcher, 'this Web UI is bound to one project');
      const project = routePath(id);
      check(project, `未知的项目身份：${id}`);
      const state = removeLauncherProject(project, env);
      connections.delete(project);
      failures.delete(project);
      summaryBackoff.delete(project);
      return { project, ...state };
    },
    async require() { check(!launcher, '请通过 /p/<project>/ 访问具体项目'); return await connect(boundProject); },
    hasRoute(id) { return Boolean(routePath(id)); },
    rememberCurrent() { if (launcher && connections.size) writeLauncherState(boundProject ?? [...connections.keys()].at(-1), env); },
  };
}

export function startWeb(config, port = 4318, options = {}) {
  check(Number.isInteger(port) && port >= 0 && port <= 65535, 'invalid web port');
  const launcher = !config;
  const authConfig = options.authConfig === undefined ? (config || launcherWebConfig(options.env || process.env)) : options.authConfig;
  const auth = authConfig ? loadAuth(authConfig, { launcher }) : null;
  const projectHost = createProjectHost(config, { ...options, allowedProjects: launcher ? auth?.projects : null });
  const sessions = new Map();
  const failures = new Map();
  const server = Bun.serve({
    hostname: auth ? '0.0.0.0' : '127.0.0.1', port, maxRequestBodySize: 128 * 1024,
    async fetch(request, server) {
      const url = new URL(request.url);
      const host = request.headers.get('host');
      const localHosts = [`127.0.0.1:${server.port}`, `localhost:${server.port}`];
      if (!host || url.host !== host || (!auth && !localHosts.includes(host))) return new Response('Invalid host', { status: 403 });
      const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': PAGE_CSP };
      const json = (body, status = 200, extra = {}) => Response.json(body, { status, headers: { ...headers, ...extra } });
      if (!originAllowed(request, url, auth?.origins || [])) {
        const seen = ['origin', 'sec-fetch-site', 'referer'].map(name => `${name}=${request.headers.get(name) ?? '-'}`).join(' ');
        console.warn(`[web] blocked cross-site ${request.method} ${url.pathname} (host=${host} ${seen})`);
        // 登录提交被挡最容易发生在反向代理后面：直接告诉用户去哪儿改，而不是甩一行 403 文本。
        if (request.method === 'POST' && url.pathname === '/login') return new Response(loginPage(`请求被判定为跨站（host=${host}）。如果通过反向代理/域名访问，请在${auth?.config_hint || '.lush/web.json'}里写上对外地址，例如 "origin": "https://lush.example.com"。`), { status: 403, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': LOGIN_CSP } });
        return new Response('Cross-site access denied', { status: 403 });
      }
      const token = cookieValue(request, SESSION_COOKIE);
      const expires = token && sessions.get(token);
      const authenticated = !auth || (expires && expires > Date.now());
      if (token && expires && expires <= Date.now()) sessions.delete(token);

      if (request.method === 'GET' && url.pathname === '/login') {
        if (!auth || authenticated) return new Response(null, { status: 303, headers: { Location: '/' } });
        return new Response(loginPage('', url.searchParams.get('next')), { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': LOGIN_CSP } });
      }
      if (request.method === 'POST' && url.pathname === '/login' && auth) {
        const type = request.headers.get('content-type')?.split(';')[0];
        if (type !== 'application/x-www-form-urlencoded') return json({ error: 'form encoding required' }, 400);
        const remote = server.requestIP(request)?.address || 'unknown';
        const attempt = failures.get(remote);
        if (attempt?.retry_at > Date.now()) return new Response(loginPage('登录尝试过多，请一分钟后再试。'), { status: 429, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': LOGIN_CSP } });
        const form = await request.formData();
        const username = String(form.get('username') ?? '').trim();
        const password = String(form.get('password') ?? '').trim();
        const usernameOk = secretEqual(username, auth.username);
        const passwordOk = verifyPassword(password, auth.password_hash);
        if (!usernameOk || !passwordOk) {
          const count = (attempt?.count || 0) + 1;
          failures.set(remote, count >= 5 ? { count: 0, retry_at: Date.now() + 60_000 } : { count, retry_at: 0 });
          if (failures.size > 1024) failures.clear();
          // 只记「账号对不对」，不记密码；用于区分「没连上服务器」与「确实被拒」。
          console.warn(`[web] login rejected from ${remote} (username ${usernameOk ? 'matched' : 'mismatched'}, ${count}/5)`);
          return new Response(loginPage('账号或密码错误。', form.get('next')), { status: 401, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': LOGIN_CSP } });
        }
        failures.delete(remote);
        const session = randomBytes(32).toString('base64url');
        sessions.set(session, Date.now() + SESSION_SECONDS * 1000);
        for (const [key, expiry] of sessions) if (expiry <= Date.now()) sessions.delete(key);
        const secure = url.protocol === 'https:' || request.headers.get('x-forwarded-proto')?.split(',')[0].trim() === 'https';
        const cookie = `${SESSION_COOKIE}=${session}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secure ? '; Secure' : ''}`;
        return new Response(null, { status: 303, headers: { Location: safeNext(form.get('next')), 'Set-Cookie': cookie, ...headers } });
      }
      if (!authenticated) {
        // 项目 API 也在 /p/<id>/api/ 下：未登录时同样用 401，前端才能跳登录并带回原路径。
        if (/\/api\//.test(url.pathname)) return json({ error: 'authentication required' }, 401);
        return new Response(null, { status: 303, headers: { Location: `/login?next=${encodeURIComponent(url.pathname + url.search)}`, ...headers } });
      }
      if (request.method === 'POST' && url.pathname === '/logout') {
        if (token) sessions.delete(token);
        return new Response(null, { status: 303, headers: { Location: '/login', 'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`, ...headers } });
      }

      try {
        // ---- 宿主级路由：启动器等不属于任何项目的接口先于项目路由匹配 ----
        if (request.method === 'GET' && url.pathname === '/api/launcher') return json(await projectHost.status());
        if (request.method === 'GET' && url.pathname === '/api/launcher/projects') return json({ projects: await projectHost.projects() });
        if (request.method === 'POST' && url.pathname === '/api/launcher/select') {
          check(projectHost.launcher, 'project switching is disabled for this Web UI');
          check(request.headers.get('content-type')?.split(';')[0] === 'application/json', 'application/json required');
          const body = await request.json();
          const project = await projectHost.select(body?.project);
          // 只登记 / 连接并回传稳定身份；页面归属由前端跳到该项目的 /p/<id>/ 决定，不在服务端留「当前项目」。
          return json({ ...await projectHost.status(), id: projectRouteId(project), project });
        }
        if (request.method === 'POST' && url.pathname === '/api/launcher/remove') {
          check(projectHost.launcher, 'project removal is disabled for this Web UI');
          check(request.headers.get('content-type')?.split(';')[0] === 'application/json', 'application/json required');
          const body = await request.json();
          return json(projectHost.remove(body?.id));
        }
        // ---- 项目路由：/p/<id>/** 显式携带项目身份；无前缀项目读写只在单项目模式保留 ----
        const prefix = /^\/p\/([a-z0-9]{16})(\/.*)?$/.exec(url.pathname);
        const inner = prefix ? (prefix[2] || '/') : url.pathname;
        if (prefix && inner === '/' && !projectHost.hasRoute(prefix[1])) {
          // 未知 / 已移除的身份绝不回退到「当前项目」：全局模式回项目列表，单项目模式 404。
          if (projectHost.launcher) return new Response(null, { status: 303, headers: { Location: '/', ...headers } });
          return json({ error: `未知或已失效的项目身份：${prefix[1]}` }, 404);
        }
        if (prefix) url.pathname = inner;
        const projectApi = inner.startsWith('/api/') && !inner.startsWith('/api/docs') && !inner.startsWith('/api/launcher');
        if (projectHost.launcher && !prefix && projectApi) {
          // 旧页面发出的无项目身份请求：拒绝并提示刷新，绝不用另一标签页选中的项目代答。
          return json({ error: '缺少项目身份：全局 Web 的项目读写必须经 /p/<project>/ 路由；请刷新页面或从项目列表重新打开' }, 400);
        }
        const binding = projectApi ? (prefix ? await projectHost.openRoute(prefix[1]) : await projectHost.require()) : null;
        const client = binding?.client;
        if (request.method === 'GET') {
          if (url.pathname === '/api/sleep') return json(await client.request('sleep.status'));
          if (url.pathname === '/api/sleep/choices') return json(await client.request('sleep.choices', {
            before: url.searchParams.has('before') ? id(url.searchParams.get('before')) : null,
            limit: Number(url.searchParams.get('limit') ?? 30),
          }));
          if (url.pathname === '/api/usage') return json(await client.request('system.usage', {
            start: url.searchParams.get('start'), end: url.searchParams.get('end'), interval: url.searchParams.get('interval') ?? 'auto',
          }));
          if (url.pathname === '/api/snapshot') return json(await client.snapshot());
          if (url.pathname === '/api/overview') return json(await client.overview(url.searchParams.get('revision')));
          if (url.pathname === '/api/notices') return json(await client.request('notice.page', {
            status: url.searchParams.get('status') ?? 'all',
            before: url.searchParams.get('before'),
            limit: Number(url.searchParams.get('limit') ?? 30),
          }));
          if (url.pathname === '/api/tasks') return json(await client.request('task.page', {
            scope: url.searchParams.get('scope') ?? 'work',
            before: url.searchParams.has('before') ? Number(url.searchParams.get('before')) : null,
            limit: Number(url.searchParams.get('limit') ?? 50),
          }));
          if (url.pathname === '/api/agent/config') return json(await client.request('agent.config'));
          if (url.pathname === '/api/agent/models') return json(await client.request('agent.models', { agent: url.searchParams.get('agent') || '' }));
          if (url.pathname === '/api/agent/resources') return json(await client.request('agent.resources'));
          if (url.pathname === '/api/agent/environment') return json(await client.request('agent.environment', { target: url.searchParams.get('target') || '' }));
          // 分支图跑 git，不进 1.5s 的 /api/snapshot：只有打开视图时才单独取一次。
          if (url.pathname === '/api/graph') return json(await client.request('graph.get'));
          if (url.pathname === '/api/showcases') return json(await client.request('showcase.list', { branch: url.searchParams.get('branch') }));
          const preview = /^\/api\/task\/(\d+)\/notice\/(\d+)\/preview\/(\d+)\/(\d+)$/.exec(url.pathname);
          if (preview) {
            const page = await client.request('notice.page', { before: Number(preview[2]) + 1, limit: 1 });
            const notice = page.notices.find(row => row.id === Number(preview[2]) && row.task_id === Number(preview[1]) && row.kind === 'questionnaire');
            check(notice, 'questionnaire not found');
            const html = JSON.parse(notice.body).questions?.[Number(preview[3])]?.options?.[Number(preview[4])]?.previewHtml;
            check(typeof html === 'string', 'HTML preview not found');
            return previewResponse(html, headers);
          }
          const report = /^\/api\/task\/(\d+)\/report$/.exec(url.pathname);
          if (report) {
            const task = await client.request('task.inspect', { id: Number(report[1]) });
            check(['verifier','showcase'].includes(task.role), `task #${task.id} is not a verification or showcase`);
            const file = path.join(binding.config.home, task.role === 'showcase' ? 'showcase' : 'verify', String(task.id), 'report.html');
            if (!fs.existsSync(file)) return json({ error: `task #${task.id} has no report yet` }, 404);
            const stat = fs.lstatSync(file);
            check(stat.isFile() && !stat.isSymbolicLink() && fs.realpathSync(file) === file && stat.size <= 8 * 1024 * 1024, 'unsafe report file');
            // 独立顶层文档（新标签打开）：不受主页面 CSP 约束，但仍显式收紧到一个自包含页面。
            return new Response(Bun.file(file), { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': REPORT_CSP } });
          }
          const reading = /^\/api\/task\/(\d+)\/(transcript-search|transcript-step|transcript-page|transcript-latest|explanations|intros)$/.exec(url.pathname);
          if (reading) {
            const id = Number(reading[1]), q = url.searchParams;
            if (reading[2] === 'intros') return json(await client.request('intro.list', { id, before: q.has('before') ? Number(q.get('before')) : null }));
            if (reading[2] === 'transcript-search') return json(await client.request('task.transcript_search', {
              id, query: q.get('query') ?? '', kind: q.get('kind') ?? '', tool: q.get('tool') ?? '', errors: q.get('errors') === 'true',
              after: Number(q.get('after') ?? 0), limit: Number(q.get('limit') ?? 50),
            }));
            if (reading[2] === 'transcript-page') return json(await client.request('task.transcript_page', { id, seq: Number(q.get('seq') ?? 1), offset: Number(q.get('offset') ?? 0) }));
            if (reading[2] === 'transcript-latest') return json(await client.request('task.transcript_latest', {
              id, after: Number(q.get('after') ?? 0), before: Number(q.get('before') ?? 0), limit: Number(q.get('limit') ?? 100),
            }));
            if (reading[2] === 'transcript-step') return json(await client.request('task.transcript_step', { id, seq: Number(q.get('seq')), offset: Number(q.get('offset') ?? 0) }));
            return json(await client.request('explanation.list', { id, before: q.has('before') ? Number(q.get('before')) : null }));
          }
          const explanation = /^\/api\/explanation\/(\d+)$/.exec(url.pathname);
          if (explanation) return json(await client.request('explanation.get', { id: Number(explanation[1]) }));
          if (url.pathname === '/api/intro/config') return json(await client.request('intro.config'));
          const intro = /^\/api\/intro\/(\d+)$/.exec(url.pathname);
          if (intro) return json(await client.request('intro.get', { id: Number(intro[1]) }));
          const historyPage = /^\/api\/task\/(\d+)\/history-page$/.exec(url.pathname);
          if (historyPage) return json(await client.request('task.history_page', {
            id: Number(historyPage[1]), before: url.searchParams.has('before') ? Number(url.searchParams.get('before')) : null,
            limit: Number(url.searchParams.get('limit') ?? 100),
          }));
          const read = /^\/api\/task\/(\d+)(\/(history|diff|transcript|usage))?$/.exec(url.pathname);
          if (read) {
            const taskId = Number(read[1]);
            if (read[3] === 'history') return json(await client.request('task.history', { id: taskId, after: Number(url.searchParams.get('after') ?? 0) }));
            if (read[3] === 'diff') return json(await client.request('task.diff', { id: taskId }));
            if (read[3] === 'usage') return json(await client.request('task.usage', { id: taskId }));
            if (read[3] === 'transcript') return json(await client.request('task.transcript', { id: taskId, after: Number(url.searchParams.get('after') ?? 0) }));
            return json(await client.request('task.inspect', { id: taskId }));
          }
          if (url.pathname === '/favicon.ico') return new Response(null, { status: 204, headers });
          // 「文档」页：读的是随这份代码发布的 docs/**/*.md 与 README.md，与当前项目目录无关。
          // 只接受已扫出的 id，请求里的字符串不进文件系统路径，未知 id 与非 .md 一律 404。
          if (url.pathname === '/api/docs') return json({ docs: docsIndex() });
          if (url.pathname === '/api/docs/search-index') return json({ docs: docsSearchIndex() });
          const doc = /^\/api\/docs\/([a-z0-9._-]+)$/.exec(url.pathname);
          if (doc) {
            const found = readDoc(doc[1]);
            return found ? json(found) : json({ error: `no such document: ${doc[1]}` }, 404);
          }
          const file = assetFile(url.pathname);
          if (file && fs.existsSync(file) && fs.statSync(file).isFile()) return new Response(Bun.file(file), { headers });
        }
        if (request.method === 'POST' && url.pathname === '/api/action') {
          check(request.headers.get('content-type')?.split(';')[0] === 'application/json', 'application/json required');
          const { method, params } = await request.json();
          check(MUTATIONS.has(method), 'method not allowed from Web UI');
          check(!params?._token, 'agent tokens are not accepted by Web UI');
          return json(await client.request(method, params));
        }
        return json({ error: 'not found' }, 404);
      } catch (error) { return json({ error: error.message }, 400); }
    },
  });
  WEB_HOSTS.set(server, projectHost);
  return server;
}

/** 进程正常关闭时再记一次当前项目：Web 与桌面并开时，以最后关闭的实例为准。 */
export function rememberWebProject(server) {
  try { WEB_HOSTS.get(server)?.rememberCurrent(); } catch { /* 缓存失败不能阻止进程退出 */ }
}
