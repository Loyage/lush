import path from 'node:path';
import fs from 'node:fs';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonicalProjectPath, launcherWebConfig, projectRouteId } from '../../host/registry.js';
import { createProjectHost } from '../../host/project-host.js';
import { docsIndex, docsSearchIndex, readDoc } from './docs.js';
import { previewResponse } from './notice-preview.js';
import { check, id, isPlainObject } from '../../core/types.js';
import { restartProjectDaemon } from '../../host/service-control.js';
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
const MUTATIONS = new Set(['quick_explain.configure','quick_explain.start','quick_explain.delete','agent.network.configure','agent.configure','agent.environment.configure','agent.usage.configure','agent.connections.save','agent.connections.remove','agent.connections.sampling','agent.connections.query','agent.connections.models.refresh','agent.connections.login.start','agent.connections.login.finish','agent.connections.device.start','agent.connections.device.poll','agent.connections.device.cancel','agent.packages.install','agent.packages.remove','agent.packages.update','system.configure','hooks.save','hooks.remove','worker.completion','worker.hook_attach','worker.hook_update','worker.hook_remove','order.submit','draft.add','draft.update','draft.remove','worker.spawn','worker.message','worker.auto_merge','worker.reserve','worker.reserve_all','worker.resolve','worker.accept','worker.reopen','worker.sync_parent','worker.resolve_sync','worker.resolve_divergence','worker.unreserve','worker.approve_merge','worker.cancel','worker.retry','worker.clear_override','worker.interrupt','worker.resume','worker.configure','worker.cleanup','worker.delete','notice.answer','notice.dismiss','notice.read','branch.archive']);
const CORE_INPUT_READ = /^\/api\/input\/(draft|input)\/([1-9]\d*)$/;
const CORE_QUICK_EXPLAIN_READ = /^\/api\/quick-explain\/[1-9]\d*$/;
const CORE_READS = new Set(['/api/quick-explain/config','/api/quick-explain/history','/api/hooks','/api/inputs','/api/input-parents','/api/overview','/api/snapshot','/api/workers','/api/notices','/api/worker-graph','/api/versions','/api/agent/config','/api/agent/models','/api/agent/resources','/api/agent/status','/api/agent/usage/config','/api/agent/usage/history','/api/agent/connections','/api/agent/connections/history','/api/agent/connections/models','/api/agent/packages','/api/agent/selection/resources','/api/agent/environment','/api/agent/network','/api/docs','/api/docs/search-index']);
const CORE_WORKER_READ = /^\/api\/worker\/\d+(?:\/(?:hooks|history|history-page|delete-preview|diff|code-state|code-tree|code-file|usage|report|transcript|transcript-page|transcript-latest|transcript-step|transcript-search))?$/;
// 问卷选项的静态 HTML 预览：独立子文档，和报告一样有更严的 CSP，不能被上面的 Worker 读白名单漏掉。
const CORE_NOTICE_PREVIEW = /^\/api\/worker\/\d+\/notice\/\d+\/preview\/\d+\/\d+$/;
const CORE_DOC_READ = /^\/api\/docs\/[a-z0-9._-]+$/;
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
  // HTTP URL parsing turns backslashes into slashes and strips some controls.
  // Validate both the submitted path and the normalized Location (dot segments
  // can otherwise turn /a/..//host into a protocol-relative redirect).
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return '/';
  const base = 'http://lush.invalid';
  try {
    const parsed = new URL(value, base);
    if (parsed.origin !== base || parsed.pathname.startsWith('//')) return '/';
    return parsed.pathname + parsed.search + parsed.hash;
  } catch { return '/'; }
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
  // same-site is not same-origin (ports, schemes and sibling domains differ).
  // Fetch Metadata may reject a request, but cannot override an explicit Origin.
  const origin = request.headers.get('origin');
  // Preserve the established old-client/webview opaque or missing-origin policy.
  if (!origin || origin === 'null') return true;
  try {
    const parsed = new URL(origin);
    return parsed.origin !== 'null' && origin === parsed.origin
      && (parsed.origin === url.origin || origins.includes(parsed.origin));
  } catch { return false; }
}


export function startWeb(config, port = 4318, options = {}) {
  check(Number.isInteger(port) && port >= 0 && port <= 65535, 'invalid web port');
  const env = options.env || config?.env || process.env;
  const launcher = !config;
  const authConfig = options.authConfig === undefined ? (config || launcherWebConfig(env)) : options.authConfig;
  const auth = authConfig ? loadAuth(authConfig, { launcher }) : null;
  const projectHost = options.projectHost || createProjectHost(config, { ...options, env, allowedProjects: launcher ? auth?.projects : null });
  const sessions = new Map();
  const failures = new Map();
  let hostRestarting = false;
  const emptyJson = async request => {
    check(request.headers.get('content-type')?.split(';')[0] === 'application/json', 'application/json required');
    const body = await request.json();
    check(isPlainObject(body) && Object.keys(body).length === 0, 'restart body must be an empty object; paths and agent tokens are not accepted');
  };
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
        if (request.method === 'GET' && url.pathname === '/api/host') return json({ ...await projectHost.status(),
          pid: process.pid, restart_supported: typeof options.restartHost === 'function', project_control: true });
        if (request.method === 'POST' && url.pathname === '/api/host/restart') {
          await emptyJson(request);
          check(typeof options.restartHost === 'function', '当前嵌入界面不支持重启服务，请使用命令行重启 Host');
          check(!hostRestarting, '界面服务已经在重启，请稍后再试');
          hostRestarting = true;
          // Let Bun flush the small acceptance response before releasing the listener.
          setTimeout(() => options.restartHost(), 200);
          return json({ restarting: true });
        }
        if (request.method === 'GET' && url.pathname === '/api/host/projects') return json({ projects: await projectHost.projects() });
        if (request.method === 'POST' && ['/api/host/projects/start', '/api/host/projects/stop'].includes(url.pathname)) {
          check(request.headers.get('content-type')?.split(';')[0] === 'application/json', 'application/json required');
          const body = await request.json();
          check(isPlainObject(body) && Object.keys(body).length === 1 && typeof body.id === 'string' && /^[a-f0-9]{16}$/.test(body.id),
            'project control body must contain only a registered project id');
          const method = url.pathname.endsWith('/start') ? 'start' : 'stop';
          check(typeof projectHost[method] === 'function', 'project background control is unavailable');
          return json(await projectHost[method](body.id));
        }
        if (request.method === 'POST' && url.pathname === '/api/host/select') {
          check(projectHost.launcher, 'project switching is disabled for this Web UI');
          check(request.headers.get('content-type')?.split(';')[0] === 'application/json', 'application/json required');
          const body = await request.json();
          const project = await projectHost.select(body?.project);
          // 只登记 / 连接并回传稳定身份；页面归属由前端跳到该项目的 /p/<id>/ 决定，不在服务端留「当前项目」。
          return json({ ...await projectHost.status(), id: projectRouteId(project), project });
        }
        if (request.method === 'POST' && url.pathname === '/api/host/remove') {
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
        const projectApi = inner.startsWith('/api/') && !inner.startsWith('/api/docs') && !inner.startsWith('/api/host');
        if (projectHost.launcher && !prefix && projectApi) {
          // 旧页面发出的无项目身份请求：拒绝并提示刷新，绝不用另一标签页选中的项目代答。
          return json({ error: '缺少项目身份：全局 Web 的项目读写必须经 /p/<project>/ 路由；请刷新页面或从项目列表重新打开' }, 400);
        }
        const binding = projectApi ? (prefix ? await projectHost.openRoute(prefix[1]) : await projectHost.require()) : null;
        const client = binding?.client;
        if (request.method === 'POST' && url.pathname === '/api/service/restart') {
          await emptyJson(request);
          return json(await restartProjectDaemon(binding.config));
        }
        if (request.method === 'GET') {
          if (url.pathname.startsWith('/api/') && !CORE_READS.has(url.pathname) && !CORE_WORKER_READ.test(url.pathname) && !CORE_INPUT_READ.test(url.pathname) && !CORE_NOTICE_PREVIEW.test(url.pathname) && !CORE_DOC_READ.test(url.pathname) && !CORE_QUICK_EXPLAIN_READ.test(url.pathname))
            return json({ error: 'not found' }, 404);
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
          if (url.pathname === '/api/notices') {
            const page = await client.request('notice.page', {
              status: url.searchParams.get('status') ?? 'all',
              before: url.searchParams.get('before'),
              limit: Number(url.searchParams.get('limit') ?? 30),
            });
            return json({ ...page, notices: page.notices.filter(notice => notice.kind !== 'plan') });
          }
          if (url.pathname === '/api/inputs') {
            const params = {};
            for (const [key, value] of url.searchParams) {
              check(['cursor','limit','q','status','integration'].includes(key) && !(key in params), 'unknown or duplicate input history query parameter');
              params[key] = key === 'limit' ? Number(value) : value;
            }
            return json(await client.request('input.history', params));
          }
          if (url.pathname === '/api/quick-explain/config') {
            check(!url.search, 'explanation config accepts no query parameters');
            return json(await client.request('quick_explain.config'));
          }
          if (url.pathname === '/api/quick-explain/history') {
            const params = {};
            for (const [key, value] of url.searchParams) {
              check(['before','limit'].includes(key) && !(key in params), 'unknown or duplicate explanation history query parameter');
              params[key] = id(value);
            }
            return json(await client.request('quick_explain.list', params));
          }
          if (CORE_QUICK_EXPLAIN_READ.test(url.pathname)) {
            check(!url.search, 'explanation detail accepts no query parameters');
            return json(await client.request('quick_explain.get', { id: id(url.pathname.split('/').at(-1)) }));
          }
          if (url.pathname === '/api/hooks') {
            check(!url.search, 'Hooks list accepts no query parameters');
            return json(await client.request('hooks.list'));
          }
          const workerHooks = /^\/api\/worker\/([1-9]\d*)\/hooks$/.exec(url.pathname);
          if (workerHooks) {
            check(!url.search, 'Worker Hooks accepts no query parameters');
            return json(await client.request('worker.hooks', { id: id(workerHooks[1]) }));
          }
          if (url.pathname === '/api/input-parents') {
            check(!url.search, 'input parents accepts no query parameters');
            return json(await client.request('input.parents'));
          }
          const input = CORE_INPUT_READ.exec(url.pathname);
          if (input) {
            check(!url.search, 'input detail accepts no query parameters');
            return json(await client.request('input.get', { kind: input[1], id: id(input[2]) }));
          }
          if (url.pathname === '/api/workers') return json(await client.request('worker.page', {
            scope: url.searchParams.get('scope') ?? 'work',
            before: url.searchParams.has('before') ? Number(url.searchParams.get('before')) : null,
            limit: Number(url.searchParams.get('limit') ?? 50),
          }));
          if (url.pathname === '/api/agent/config') return json(await client.request('agent.config'));
          if (url.pathname === '/api/agent/models') return json(await client.request('agent.models', { agent: url.searchParams.get('agent') || '' }));
          if (url.pathname === '/api/agent/resources') return json(await client.request('agent.resources'));
          if (url.pathname === '/api/agent/status') return json(await client.request('agent.status'));
          if (url.pathname === '/api/agent/selection/resources') {
            check(!url.search, 'model selection resources accepts no query parameters');
            return json(await client.request('agent.selection.resources'));
          }
          if (url.pathname === '/api/agent/connections') {
            check(!url.search, 'connection list accepts no query parameters');
            return json(await client.request('agent.connections.list'));
          }
          if (url.pathname === '/api/agent/connections/history') {
            const params = {};
            for (const [key, value] of url.searchParams) {
              check(['id','days'].includes(key) && !(key in params), 'unknown or duplicate connection history query parameter');
              params[key] = key === 'days' ? Number(value) : value;
            }
            return json(await client.request('agent.connections.history', params));
          }
          if (url.pathname === '/api/agent/connections/models') {
            const params = {};
            for (const [key, value] of url.searchParams) {
              check(['id'].includes(key) && !(key in params), 'unknown or duplicate connection model query parameter');
              params[key] = value;
            }
            check(params.id, 'connection id is required');
            return json(await client.request('agent.connections.models', params));
          }
          if (url.pathname === '/api/agent/packages') {
            check(!url.search, 'installed resource list accepts no query parameters');
            return json(await client.request('agent.packages.list'));
          }
          if (url.pathname === '/api/agent/usage/config') return json(await client.request('agent.usage.config'));
          if (url.pathname === '/api/agent/usage/history') return json(await client.request('agent.usage.history', {
            ...(url.searchParams.has('provider') ? { provider: url.searchParams.get('provider') } : {}),
            ...(url.searchParams.has('account_key') ? { account_key: url.searchParams.get('account_key') } : {}),
            ...(url.searchParams.has('days') ? { days: Number(url.searchParams.get('days')) } : {}),
          }));
          if (url.pathname === '/api/agent/network') {
            check(!url.search, 'network settings do not accept query parameters');
            return json(await client.request('agent.network'));
          }
          if (url.pathname === '/api/agent/environment') return json(await client.request('agent.environment', { target: url.searchParams.get('target') || '' }));
          // Worker 图的 Git 诊断单独按需取数，不进概览的常规轮询。
          if (url.pathname === '/api/worker-graph') return json(await client.request('worker.graph'));
          if (url.pathname === '/api/versions') {
            const params = {};
            for (const [key, value] of url.searchParams) {
              check(['cursor','limit'].includes(key) && !(key in params), 'unknown or duplicate version history query parameter');
              params[key] = key === 'limit' ? Number(value) : value;
            }
            return json(await client.request('branch.history', params));
          }
          const preview = /^\/api\/worker\/(\d+)\/notice\/(\d+)\/preview\/(\d+)\/(\d+)$/.exec(url.pathname);
          if (preview) {
            const page = await client.request('notice.page', { before: Number(preview[2]) + 1, limit: 1 });
            const notice = page.notices.find(row => row.id === Number(preview[2]) && row.task_id === Number(preview[1]) && row.kind === 'questionnaire');
            check(notice, 'questionnaire not found');
            const html = JSON.parse(notice.body).questions?.[Number(preview[3])]?.options?.[Number(preview[4])]?.previewHtml;
            check(typeof html === 'string', 'HTML preview not found');
            return previewResponse(html, headers);
          }
          const report = /^\/api\/worker\/(\d+)\/report$/.exec(url.pathname);
          if (report) {
            const task = await client.request('worker.inspect', { id: Number(report[1]) });
            if (task.role !== 'verifier') return json({ error: 'not found' }, 404);
            const file = path.join(binding.config.home, 'verify', String(task.id), 'report.html');
            if (!fs.existsSync(file)) return json({ error: `worker #${task.id} has no report yet` }, 404);
            const stat = fs.lstatSync(file);
            check(stat.isFile() && !stat.isSymbolicLink() && fs.realpathSync(file) === file && stat.size <= 8 * 1024 * 1024, 'unsafe report file');
            // 独立顶层文档（新标签打开）：不受主页面 CSP 约束，但仍显式收紧到一个自包含页面。
            return new Response(Bun.file(file), { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': REPORT_CSP } });
          }
          const deletePreview = /^\/api\/worker\/(\d+)\/delete-preview$/.exec(url.pathname);
          if (deletePreview) {
            check([...url.searchParams].length === 0, 'delete preview accepts no query parameters');
            return json(await client.request('worker.delete_preview', { id: Number(deletePreview[1]) }));
          }
          const codeRead = /^\/api\/worker\/(\d+)\/(code-state|code-tree|code-file)$/.exec(url.pathname);
          if (codeRead) {
            const method = 'worker.' + codeRead[2].replace('-', '_'), params = { id: Number(codeRead[1]) };
            const allowed = codeRead[2] === 'code-state' ? ['scope','after','limit'] : codeRead[2] === 'code-tree'
              ? ['scope','path','query','changed','after','limit','revision'] : ['scope','path','view','side','offset','limit','context','revision'];
            for (const [key, value] of url.searchParams) {
              check(allowed.includes(key) && !(key in params), 'unknown or duplicate code query parameter');
              if (key === 'changed') { check(value === 'true' || value === 'false', 'invalid changed filter'); params[key] = value === 'true'; }
              else params[key] = ['after','limit','offset','context'].includes(key) ? Number(value) : value;
            }
            return json(await client.request(method, params));
          }
          const reading = /^\/api\/worker\/(\d+)\/(transcript-search|transcript-step|transcript-page|transcript-latest|explanations|intros)$/.exec(url.pathname);
          if (reading) {
            const id = Number(reading[1]), q = url.searchParams;
            if (reading[2] === 'intros') return json(await client.request('intro.list', { id, before: q.has('before') ? Number(q.get('before')) : null }));
            if (reading[2] === 'transcript-search') return json(await client.request('worker.transcript_search', {
              id, query: q.get('query') ?? '', kind: q.get('kind') ?? '', tool: q.get('tool') ?? '', errors: q.get('errors') === 'true',
              after: Number(q.get('after') ?? 0), limit: Number(q.get('limit') ?? 50),
            }));
            if (reading[2] === 'transcript-page') return json(await client.request('worker.transcript_page', { id, seq: Number(q.get('seq') ?? 1), offset: Number(q.get('offset') ?? 0) }));
            if (reading[2] === 'transcript-latest') return json(await client.request('worker.transcript_latest', {
              id, after: Number(q.get('after') ?? 0), before: Number(q.get('before') ?? 0), limit: Number(q.get('limit') ?? 100),
            }));
            if (reading[2] === 'transcript-step') return json(await client.request('worker.transcript_step', { id, seq: Number(q.get('seq')), offset: Number(q.get('offset') ?? 0) }));
            return json(await client.request('explanation.list', { id, before: q.has('before') ? Number(q.get('before')) : null }));
          }
          const explanation = /^\/api\/explanation\/(\d+)$/.exec(url.pathname);
          if (explanation) return json(await client.request('explanation.get', { id: Number(explanation[1]) }));
          if (url.pathname === '/api/intro/config') return json(await client.request('intro.config'));
          const intro = /^\/api\/intro\/(\d+)$/.exec(url.pathname);
          if (intro) return json(await client.request('intro.get', { id: Number(intro[1]) }));
          const historyPage = /^\/api\/worker\/(\d+)\/history-page$/.exec(url.pathname);
          if (historyPage) return json(await client.request('worker.history_page', {
            id: Number(historyPage[1]), before: url.searchParams.has('before') ? Number(url.searchParams.get('before')) : null,
            limit: Number(url.searchParams.get('limit') ?? 100),
          }));
          const read = /^\/api\/worker\/(\d+)(\/(history|diff|transcript|usage))?$/.exec(url.pathname);
          if (read) {
            const taskId = Number(read[1]);
            if (read[3] === 'history') return json(await client.request('worker.history', { id: taskId, after: Number(url.searchParams.get('after') ?? 0) }));
            if (read[3] === 'diff') return json(await client.request('worker.diff', { id: taskId }));
            if (read[3] === 'usage') return json(await client.request('worker.usage', { id: taskId }));
            if (read[3] === 'transcript') return json(await client.request('worker.transcript', { id: taskId, after: Number(url.searchParams.get('after') ?? 0) }));
            return json(await client.request('worker.inspect', { id: taskId }));
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
  if (auth) console.warn('[web] 公网 HTTP 监听已启用；直接通过 HTTP 访问会明文传输账号密码、会话和项目数据，存在窃听与篡改风险。建议由用户配置 HTTPS 反向代理或 SSH 端口转发；HTTP 不会因此被拒绝。');
  return server;
}

/** 进程正常关闭时再记一次当前项目：Web 与桌面并开时，以最后关闭的实例为准。 */
export function rememberWebProject(server) {
  try { WEB_HOSTS.get(server)?.rememberCurrent(); } catch { /* 缓存失败不能阻止进程退出 */ }
}
