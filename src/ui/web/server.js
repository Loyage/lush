import path from 'node:path';
import fs from 'node:fs';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { webStaticAssets } from './static-assets.js';
import { webListenHost } from '../../host/web-listen.js';
import { canonicalProjectPath, launcherWebConfig, projectRouteId } from '../../host/registry.js';
import { createProjectHost } from '../../host/project-host.js';
import { createUserServices } from '../../host/user-services.js';
import { validateAppearanceUpdate } from '../../host/project-appearance.js';
import { docsIndex, docsSearchIndex, readDoc } from './docs.js';
import { previewResponse } from './notice-preview.js';
import { check, id, isPlainObject, LushError } from '../../core/types.js';
import { restartProjectDaemon } from '../../host/service-control.js';
import { DeviceSettingsService, DEVICE_SETTINGS_READS, DEVICE_SETTINGS_ACTIONS } from '../../host/device-settings.js';
import { normalizeConfigurationScope } from '../../core/device-config.js';
import { workerLabel } from '../../cli/worker-number.js';
import { workerNumber } from '../../core/worker-number.js';
import { graphOptions } from '../../core/project/graph-pages.js';
const AUTH_FILE = 'web.json';
const SESSION_COOKIE = 'lush_session';
const SESSION_SECONDS = 12 * 60 * 60;
const WEB_HOSTS = new WeakMap();
const MUTATIONS = new Set(['settings.clear_override','settings.migration.apply','quick_explain.configure','agent.network.configure','agent.configure','agent.environment.configure','agent.usage.configure','agent.connections.save','agent.connections.remove','agent.connections.sampling','agent.connections.query','agent.connections.models.refresh','agent.connections.login.start','agent.connections.login.finish','agent.connections.device.start','agent.connections.device.cancel','agent.connections.device.poll','agent.packages.install','agent.packages.remove','agent.packages.update','system.configure','system.interrupt_all','system.resume_all','hooks.save','hooks.remove','hooks.command_save','hooks.command_authorize','hooks.command_remove','hooks.command_run','hooks.command_start','hooks.command_history_remove','hooks.command_import','hooks.auto_select','hooks.completion_defaults','hooks.signal_save','hooks.signal_remove','management.create','management.binding_update','worker.completion','worker.hook_attach','worker.hook_update','worker.hook_remove','order.submit','draft.add','draft.update','draft.remove','worker.spawn','worker.message','worker.rename','worker.auto_merge','worker.reserve','worker.reserve_all','worker.resolve','worker.accept','worker.reopen','worker.sync_parent','worker.resolve_sync','worker.resolve_divergence','worker.unreserve','worker.approve_merge','worker.cancel','worker.retry','worker.clear_override','worker.interrupt','worker.resume','worker.configure','worker.cleanup','worker.delete','notice.answer','notice.dismiss','notice.read','branch.archive','branch.convergence_set','branch.convergence_defaults_set','branch.convergence_retry']);
const QUICK_CHAT_PARAMS = new Map([
  ['prompt_save', ['prompt', 'expected_revision']], ['prompt_remove', ['id', 'expected_revision']],
  ['start', ['prompt_id', 'content', 'references']], ['send', ['id', 'content']], ['delete', ['id']],
]);
const CORE_INPUT_READ = /^\/api\/input\/(draft|input)\/([1-9]\d*)$/;
const CORE_READS = new Set(['/api/branch-convergence','/api/branch-convergence/defaults','/api/branch-convergence/runs','/api/settings/runtime','/api/settings/migration','/api/quick-explain/config','/api/hooks','/api/hooks/commands/executions','/api/inputs','/api/input-parents','/api/overview','/api/snapshot','/api/workers','/api/worker-lookup','/api/notices','/api/worker-graph','/api/versions','/api/version-graph','/api/agent/config','/api/agent/models','/api/agent/resources','/api/agent/status','/api/agent/usage/config','/api/agent/usage/history','/api/agent/connections','/api/agent/connections/history','/api/agent/connections/models','/api/agent/packages','/api/agent/selection/resources','/api/agent/environment','/api/agent/network','/api/docs','/api/docs/search-index']);
const CORE_WORKER_READ = /^\/api\/worker\/\d+(?:\/(?:hooks|history|history-page|reading-page|reading-record|progress-history|run-settings|delete-preview|diff|code-state|code-tree|code-file|usage|report|transcript|transcript-page|transcript-latest|transcript-step|transcript-search))?$/;
// 问卷选项的静态 HTML 预览：独立子文档，和报告一样有更严的 CSP，不能被上面的 Worker 读白名单漏掉。
const CORE_NOTICE_PREVIEW = /^\/api\/worker\/\d+\/notice\/\d+\/preview\/\d+\/\d+$/;
const CORE_DOC_READ = /^\/api\/docs\/[a-z0-9._-]+$/;
/** 检验报告是 agent 写的自包含 HTML：只允许内联样式/脚本与 data: 图片，禁止任何外部加载与表单提交。
 *  主页面 CSP 不会作用于这个独立文档，所以这里必须自己收紧。 */
const REPORT_CSP = "sandbox allow-scripts; frame-ancestors 'self'; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'";
const PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const LOGIN_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

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
/** 所有 Host 必须配置认证；v2 默认回环，v1 保持历史公网监听。
 *  首次启动把临时明文密码换成 scrypt hash；公网启动器必须限制项目范围。 */
function loadAuth(config, { launcher = false } = {}) {
  const file = path.join(config.home, AUTH_FILE);
  check(fs.existsSync(file), `缺少 Web 登录配置 ${file}；请手工创建 owner-only (chmod 600) 的 web.json，使用 version:2、username 和 password (12-1024 字符)。不提供默认账号或首次设置页。`);
  const stat = fs.lstatSync(file);
  check(!stat.isSymbolicLink() && stat.isFile() && stat.uid === process.getuid(), `unsafe Web auth file: ${file}`);
  check((stat.mode & 0o077) === 0, `${file} must only be readable by its owner (chmod 600)`);
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error(`invalid JSON in ${file}`); }
  const hostname = webListenHost(value);
  check(typeof value.username === 'string' && value.username === value.username.trim() && value.username.length >= 1 && value.username.length <= 128,
    `${file} username must be 1-128 characters without surrounding whitespace`);
  check(value.origin === undefined || typeof value.origin === 'string', `${file} origin must be a string`);
  check(value.origins === undefined || Array.isArray(value.origins), `${file} origins must be an array of strings`);
  let projects = null;
  if (launcher && (hostname === '0.0.0.0' || value.projects !== undefined)) {
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
    const replacement = JSON.stringify({ version: value.version, ...(value.listen !== undefined ? { listen: value.listen } : {}), username: value.username, ...(projects ? { projects } : {}), ...(origins.length ? { origin: origins[0], ...(origins.length > 1 ? { origins: origins.slice(1) } : {}) } : {}), password_hash }, null, 2) + '\n';
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, replacement, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, file);
      fs.chmodSync(file, 0o600);
    } finally { fs.rmSync(temporary, { force: true }); }
  } else check(/^scrypt\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/.test(password_hash), `${file} has an invalid password_hash`);
  return { username: value.username, password_hash, origins, projects, hostname, version: value.version,
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
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lush · 登录</title><link rel="icon" href="data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22/%3E"><style>
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


function settingQuery(url, keys = [], host = false) {
  const params = {};
  for (const [key, value] of url.searchParams) {
    check([...keys, 'scope'].includes(key) && !Object.hasOwn(params, key), 'unknown or duplicate settings query parameter');
    params[key] = value;
  }
  check(params.scope !== 'project', 'project setting overrides are no longer supported; use device settings');
  if (Object.hasOwn(params, 'scope')) normalizeConfigurationScope(params.scope);
  check(!host || params.scope === undefined || params.scope === 'device', 'Host settings only accept device scope');
  return host ? { ...params, scope: 'device' } : params;
}
const PROJECT_SETTINGS_READS = new Map([...DEVICE_SETTINGS_READS].map(([suffix, spec]) =>
  [suffix === 'runtime' ? '/api/settings/runtime' : `/api/${suffix}`, spec]));

function userQuery(url, allowed) {
  const result = {};
  for (const [key, value] of url.searchParams) {
    check(allowed.includes(key) && !Object.hasOwn(result, key), 'unknown or duplicate user workspace query parameter');
    result[key] = value;
  }
  return result;
}
async function userBody(request, url) {
  check(!url.search, 'user workspace mutation accepts no query parameters');
  check(request.headers.get('content-type')?.split(';')[0] === 'application/json', 'application/json required');
  return request.json();
}

export function startWeb(config, port = 4318, options = {}) {
  check(Number.isInteger(port) && port >= 0 && port <= 65535, 'invalid web port');
  const env = options.env || config?.env || process.env;
  const launcher = !config;
  const authConfig = options.authConfig === undefined ? (config || launcherWebConfig(env)) : options.authConfig;
  check(authConfig, 'Web 登录配置不可禁用；请手工配置对应作用域的 web.json');
  const auth = loadAuth(authConfig, { launcher });
  const projectHost = options.projectHost || createProjectHost(config, { ...options, env, allowedProjects: launcher ? auth?.projects : null });
  // Build once before listening; preserve the synchronous startWeb -> Bun server contract.
  const staticAssets = webStaticAssets();
  const sessions = new Map();
  const failures = new Map();
  let hostRestarting = false;
  let deviceSettings = null, userServices = null, quickChatClosing = false, deviceChatRetirement = null;
  const quickChats = new Map();
  const getDeviceSettings = () => deviceSettings ||= options.deviceSettingsService || new DeviceSettingsService(env, options.deviceSettingsOptions);
  const getUserServices = () => userServices ||= createUserServices(projectHost, { ...options.userServiceOptions, env });
  // Only a validated, project-identified request opens text attachments; never attach lushd.
  const getQuickChat = projectId => {
    check(!quickChatClosing, '快速对话服务正在停止');
    const home = projectHost.chatHome(projectId);
    if (!quickChats.has(home)) {
      check(!options.quickChatService || quickChats.size === 0, '注入的快速对话服务只允许绑定一个项目');
      quickChats.set(home, Promise.resolve().then(async () => {
        const { QuickChatService, retireDeviceQuickChats } = await import('../../host/quick-chat.js');
        const settings = getDeviceSettings();
        // Retirement is idempotent, refuses active/unsafe legacy history, and never imports it.
        // Do not cache a rejection forever: an explicit later request may succeed after old Hosts stop.
        const retirement = deviceChatRetirement ||= Promise.resolve().then(() => retireDeviceQuickChats(settings.config.home));
        try { await retirement; } catch (error) { deviceChatRetirement = null; throw error; }
        check(!quickChatClosing, '快速对话服务正在停止');
        if (options.quickChatService) return options.quickChatService;
        return new QuickChatService(env, { ...options.quickChatOptions, home, settingsService: settings });
      }).catch(error => { quickChats.delete(home); throw error; }));
    }
    return quickChats.get(home);
  };
  const chatRequest = async (projectId, method, ...args) => {
    try {
      const service = await getQuickChat(projectId);
      check(!quickChatClosing, '快速对话服务正在停止');
      return await service[method](...args);
    } catch (error) {
      if (error instanceof LushError || error?.quickChatSafe === true) throw error;
      throw new Error('快速对话操作未确认，请保留输入并刷新历史核对；不要自动重试。');
    }
  };
  const emptyJson = async request => {
    check(request.headers.get('content-type')?.split(';')[0] === 'application/json', 'application/json required');
    const body = await request.json();
    check(isPlainObject(body) && Object.keys(body).length === 0, 'restart body must be an empty object; paths and agent tokens are not accepted');
  };
  const server = Bun.serve({
    hostname: auth.hostname, port, maxRequestBodySize: 128 * 1024,
    async fetch(request, server) {
      const url = new URL(request.url);
      const host = request.headers.get('host');
      const localHosts = [`127.0.0.1:${server.port}`, `localhost:${server.port}`];
      if (!host || url.host !== host || (auth.hostname === '127.0.0.1' && !localHosts.includes(host) && !auth.origins.some(origin => new URL(origin).host === host))) return new Response('Invalid host', { status: 403 });
      const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': PAGE_CSP };
      const json = (body, status = 200, extra = {}) => Response.json(body, { status, headers: { ...headers, ...extra } });
      if (!originAllowed(request, url, auth?.origins || [])) {
        const seen = ['origin', 'sec-fetch-site', 'referer'].map(name => `${name}=${request.headers.get(name) ?? '-'}`).join(' ');
        console.warn(`[web] blocked cross-site ${request.method} ${url.pathname} (host=${host} ${seen})`);
        // 登录提交被挡最容易发生在反向代理后面：直接告诉用户去哪儿改，而不是甩一行 403 文本。
        if (request.method === 'POST' && url.pathname === '/login') return new Response(loginPage(`请求被判定为跨站（host=${host}）。如果通过反向代理/域名访问，请在${auth?.config_hint || '.lush/web.json'}里写上对外地址，例如 "origin": "https://lush.example.com"。`), { status: 403, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': LOGIN_CSP } });
        return new Response('Cross-site access denied', { status: 403, headers });
      }
      const token = cookieValue(request, SESSION_COOKIE);
      const expires = token && sessions.get(token);
      const authenticated = expires && expires > Date.now();
      if (token && expires && expires <= Date.now()) sessions.delete(token);

      if (request.method === 'GET' && url.pathname === '/login') {
        if (authenticated) return new Response(null, { status: 303, headers: { Location: '/', ...headers } });
        return new Response(loginPage('', url.searchParams.get('next')), { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': LOGIN_CSP } });
      }
      if (request.method === 'POST' && url.pathname === '/login') {
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
        // Session identity is root-only and never attaches a project or instantiates device services.
        if (/^\/p\/[a-z0-9]{16}\/api\/host\/session$/.test(url.pathname)) return json({ error: 'not found' }, 404);
        if (url.pathname === '/api/host/session') {
          if (request.method !== 'GET') return json({ error: 'not found' }, 404);
          userQuery(url, []);
          return json({ username: auth.username });
        }
        // Old global chat history and actions are retired, including project-prefixed aliases.
        if (/^(?:\/p\/[a-z0-9]{16})?\/api\/host\/quick-chat(?:\/|$)/.test(url.pathname)) return json({ error: 'not found' }, 404);
        // ---- 宿主级路由：启动器等不属于任何项目的接口先于项目路由匹配 ----
        if (['/api/host/preferences', '/api/host/automation', '/api/host/dashboard'].includes(url.pathname)) {
          const methods = {
            '/api/host/preferences': ['readPreferences', 'savePreferences'],
            '/api/host/automation': ['readAutomation', 'saveAutomation'],
            '/api/host/dashboard': ['readDashboard', 'saveDashboard'],
          }[url.pathname];
          if (request.method === 'GET') {
            userQuery(url, []);
            return json(await getUserServices()[methods[0]]());
          }
          if (request.method === 'POST') {
            const body = await userBody(request, url);
            return json(await getUserServices()[methods[1]](body));
          }
          return json({ error: 'not found' }, 404);
        }
        if (request.method === 'GET' && url.pathname === '/api/host/inbox') {
          const query = userQuery(url, ['status', 'before', 'limit']);
          if (Object.hasOwn(query, 'limit')) {
            check(/^[1-9]\d*$/.test(query.limit), 'inbox limit must be a positive integer');
            query.limit = Number(query.limit);
          }
          return json(await getUserServices().listInbox(query));
        }
        if (request.method === 'GET' && url.pathname === '/api/host/inbox/notice') {
          const query = userQuery(url, ['project_id', 'id']);
          check(typeof query.id === 'string' && /^[1-9]\d*$/.test(query.id), 'positive Notice id required');
          query.id = Number(query.id);
          return json(await getUserServices().getNotice(query));
        }
        if (request.method === 'POST' && url.pathname === '/api/host/inbox/action') {
          return json(await getUserServices().actionInbox(await userBody(request, url)));
        }
        if (request.method === 'GET' && url.pathname.startsWith('/api/host/settings/')) {
          const suffix = url.pathname.slice('/api/host/settings/'.length), spec = DEVICE_SETTINGS_READS.get(suffix);
          if (!spec) return json({ error: 'not found' }, 404);
          return json(await getDeviceSettings().request(spec[0], settingQuery(url, spec[1], true)));
        }
        if (request.method === 'POST' && url.pathname === '/api/host/settings/action') {
          check(!url.search, 'settings action accepts no query parameters');
          check(request.headers.get('content-type')?.split(';')[0] === 'application/json', 'application/json required');
          const body = await request.json();
          check(isPlainObject(body) && Object.keys(body).every(key => ['method', 'params'].includes(key))
            && DEVICE_SETTINGS_ACTIONS.has(body.method), 'method not allowed from Host settings');
          check(isPlainObject(body.params) && !Object.hasOwn(body.params, '_token'), 'settings params required; agent tokens are not accepted');
          return json(await getDeviceSettings().request(body.method, body.params));
        }
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
        const appearanceRoute = /^\/api\/host\/projects\/([a-f0-9]{16})\/appearance$/.exec(url.pathname);
        if (appearanceRoute && ['GET', 'POST'].includes(request.method)) {
          check(!url.search, 'project appearance accepts no query parameters or agent tokens');
          if (request.method === 'GET') {
            check(typeof projectHost.appearance === 'function', 'project appearance is unavailable');
            return json(await projectHost.appearance(appearanceRoute[1]));
          }
          check(request.headers.get('content-type')?.split(';')[0] === 'application/json', 'application/json required');
          const body = validateAppearanceUpdate(await request.json());
          check(typeof projectHost.saveAppearance === 'function', 'project appearance is unavailable');
          return json(await projectHost.saveAppearance(appearanceRoute[1], body));
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
        // Text conversations are project attachments served by Host even when lushd is offline.
        if (url.pathname.startsWith('/api/quick-chat/')) {
          const projectId = prefix?.[1] ?? null, suffix = url.pathname.slice('/api/quick-chat/'.length);
          if (request.method === 'GET' && suffix === 'config') {
            userQuery(url, []);
            return json(await chatRequest(projectId, 'config'));
          }
          if (request.method === 'GET' && suffix === 'history') {
            const query = userQuery(url, ['before', 'limit']);
            if (Object.hasOwn(query, 'before')) query.before = id(query.before);
            if (Object.hasOwn(query, 'limit')) { query.limit = id(query.limit); check(query.limit <= 50, 'quick chat limit must be 1..50'); }
            return json(await chatRequest(projectId, 'list', query));
          }
          if (request.method === 'GET' && /^[1-9]\d*$/.test(suffix)) {
            userQuery(url, []);
            return json(await chatRequest(projectId, 'get', id(suffix)));
          }
          if (request.method === 'POST' && suffix === 'action') {
            const body = await userBody(request, url);
            check(isPlainObject(body) && Object.keys(body).every(key => ['method', 'params'].includes(key))
              && QUICK_CHAT_PARAMS.has(body.method), 'quick chat method not allowed');
            check(isPlainObject(body.params) && Object.keys(body.params).every(key => QUICK_CHAT_PARAMS.get(body.method).includes(key)),
              'invalid quick chat parameters; paths and agent tokens are not accepted');
            return json(await chatRequest(projectId, 'action', body.method, body.params));
          }
          return json({ error: 'not found' }, 404);
        }
        // Retired history never attaches a project or reaches a legacy daemon.
        if (/^\/api\/quick-explain\/(?:history|[0-9]+|start|followup|delete)(?:\/|$)/.test(url.pathname)) return json({ error: 'not found' }, 404);
        const binding = projectApi ? (prefix ? await projectHost.openRoute(prefix[1]) : await projectHost.require()) : null;
        const client = binding?.client;
        if (request.method === 'POST' && url.pathname === '/api/service/restart') {
          await emptyJson(request);
          return json(await restartProjectDaemon(binding.config));
        }
        if (request.method === 'GET') {
          if (url.pathname === '/api/settings/migration') {
            check(!url.search, 'settings migration preview accepts no query parameters');
            return json(await client.request('settings.migration.preview'));
          }
          const settingsRead = PROJECT_SETTINGS_READS.get(url.pathname);
          if (settingsRead && (url.pathname === '/api/settings/runtime' || url.searchParams.has('scope'))) {
            return json(await client.request(settingsRead[0], settingQuery(url, settingsRead[1])));
          }
          if (url.pathname.startsWith('/api/') && !CORE_READS.has(url.pathname) && !CORE_WORKER_READ.test(url.pathname) && !CORE_INPUT_READ.test(url.pathname) && !CORE_NOTICE_PREVIEW.test(url.pathname) && !CORE_DOC_READ.test(url.pathname))
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
          if (url.pathname === '/api/branch-convergence/defaults') {
            check(!url.search, 'branch convergence defaults accepts no query parameters');
            return json(await client.request('branch.convergence_defaults'));
          }
          if (url.pathname === '/api/branch-convergence' || url.pathname === '/api/branch-convergence/runs') {
            const runs = url.pathname.endsWith('/runs'), params = {};
            for (const [key, value] of url.searchParams) {
              check((runs ? ['branch','before','limit'] : ['branch']).includes(key) && !Object.hasOwn(params, key),
                'unknown or duplicate branch convergence query parameter');
              if (key === 'branch') params.branch = value;
              else {
                check(/^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))
                  && (key !== 'limit' || Number(value) <= 50), 'convergence cursor and limit must be positive integers (limit up to 50)');
                params[key] = Number(value);
              }
            }
            if (runs) {
              check(Object.hasOwn(params, 'branch'), 'convergence runs requires branch');
              return json(await client.request('branch.convergence_runs', params));
            }
            return json(await client.request(Object.hasOwn(params, 'branch') ? 'branch.convergence' : 'branch.convergence_list', params));
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
          if (url.pathname === '/api/worker-lookup') {
            check([...url.searchParams.keys()].length === 1 && url.searchParams.has('number'), 'Worker lookup requires only number');
            const number = workerNumber(url.searchParams.get('number'));
            return json(await client.request('worker.lookup', { number }));
          }
          if (url.pathname === '/api/workers') return json(await client.request('worker.page', {
            scope: url.searchParams.get('scope') ?? 'work',
            before: url.searchParams.has('before') ? Number(url.searchParams.get('before')) : null,
            limit: Number(url.searchParams.get('limit') ?? 50),
          }));
          if (url.pathname === '/api/agent/config') return json(await client.request('agent.config'));
          if (url.pathname === '/api/agent/models') return json(await client.request('agent.models', { agent: url.searchParams.get('agent') || '' }));
          if (url.pathname === '/api/agent/resources') return json(await client.request('agent.resources'));
          if (url.pathname === '/api/hooks/commands/executions') {
            const params = {};
            for (const [key, value] of url.searchParams) {
              check(['before','limit','execution_id'].includes(key) && !Object.hasOwn(params, key),
                'unknown or duplicate command history query parameter');
              if (key === 'execution_id') params[key] = value;
              else {
                check(/^[1-9]\d*$/.test(value), 'command history cursor and limit must be positive integers');
                params[key] = Number(value);
              }
            }
            return json(await client.request('hooks.command_history', params));
          }
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
          if (url.pathname === '/api/worker-graph') {
            const params = {};
            for (const [key, value] of url.searchParams) {
              check(['details','hidden_statuses','include_archived','cursor','scope'].includes(key) && !(key in params), 'unknown or duplicate Worker graph query parameter');
              if (key === 'details' || key === 'include_archived') {
                check(value === '0' || value === '1', `${key} must be 0 or 1`);
                params[key] = value === '1';
              } else if (key === 'hidden_statuses') {
                try { params[key] = JSON.parse(value); } catch { check(false, 'hidden_statuses must be a JSON array'); }
                check(Array.isArray(params[key]), 'hidden_statuses must be a JSON array');
              } else params[key] = value;
            }
            graphOptions(params);
            return json(await client.request('worker.graph', params));
          }
          if (url.pathname === '/api/version-graph') {
            const params = {};
            for (const [key, value] of url.searchParams) {
              check(['delivery','cursor','limit'].includes(key) && !(key in params), 'unknown or duplicate version graph query parameter');
              if (key !== 'cursor') check(/^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)), 'version graph delivery and limit must be positive integers');
              params[key] = key === 'cursor' ? value : Number(value);
            }
            return json(await client.request('branch.version_graph', params));
          }
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
            if (!fs.existsSync(file)) return json({ error: `worker ${workerLabel(task)} has no report yet` }, 404);
            const stat = fs.lstatSync(file);
            check(stat.isFile() && !stat.isSymbolicLink() && fs.realpathSync(file) === file && stat.size <= 8 * 1024 * 1024, 'unsafe report file');
            // 独立顶层文档（新标签打开）：不受主页面 CSP 约束，但仍显式收紧到一个自包含页面。
            return new Response(Bun.file(file), { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': REPORT_CSP } });
          }
          const runSettings = /^\/api\/worker\/(\d+)\/run-settings$/.exec(url.pathname);
          if (runSettings) {
            check(!url.search, 'run settings accept no query parameters');
            return json(await client.request('worker.run_settings', { id: Number(runSettings[1]) }));
          }
          const deletePreview = /^\/api\/worker\/(\d+)\/delete-preview$/.exec(url.pathname);
          if (deletePreview) {
            const query = [...url.searchParams];
            check(query.length === 0 || (query.length === 1 && query[0][0] === 'force' && query[0][1] === 'true'),
              'delete preview accepts only force=true');
            return json(await client.request('worker.delete_preview', { id: Number(deletePreview[1]),
              ...(query.length ? { force: true } : {}) }));
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
          const progressHistory = /^\/api\/worker\/(\d+)\/progress-history$/.exec(url.pathname);
          if (progressHistory) return json(await client.request('worker.progress_history', {
            id: Number(progressHistory[1]), before: url.searchParams.get('before'),
            limit: url.searchParams.get('limit') ?? 10,
          }));
          const inputReading = /^\/api\/worker\/(\d+)\/(reading-page|reading-record)$/.exec(url.pathname);
          if (inputReading) {
            const method = 'worker.' + inputReading[2].replace('-', '_'), params = { id: Number(inputReading[1]) };
            const allowed = inputReading[2] === 'reading-page' ? ['before_event','before_message','limit','query'] : ['kind','record_id','offset'];
            for (const [key, value] of url.searchParams) {
              check(allowed.includes(key) && !Object.hasOwn(params, key), 'unknown or duplicate reading query parameter');
              if (['query','kind'].includes(key)) params[key] = value;
              else {
                check(/^(0|[1-9]\d*)$/.test(value), 'invalid reading numeric query parameter');
                params[key] = Number(value);
              }
            }
            return json(await client.request(method, params));
          }
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
          // Static caches sit behind the same Host, Origin and authentication checks as APIs.
          const asset = staticAssets.response(url.pathname, request, headers);
          if (asset) return asset;
        }
        if (request.method === 'POST' && url.pathname === '/api/action') {
          check(request.headers.get('content-type')?.split(';')[0] === 'application/json', 'application/json required');
          const body = await request.json();
          const { method, params } = body;
          check(MUTATIONS.has(method), 'method not allowed from Web UI');
          if (method === 'system.interrupt_all' || method === 'system.resume_all') {
            check(!url.search, 'project maintenance accepts no query parameters');
            check(isPlainObject(body) && Object.keys(body).every(key => ['method','params'].includes(key)),
              'project maintenance action accepts only method and params');
            check(params === undefined || isPlainObject(params) && Object.keys(params).length === 0,
              'project maintenance params must be an empty object; paths and agent tokens are not accepted');
          }
          if (['branch.convergence_set','branch.convergence_defaults_set','branch.convergence_retry'].includes(method)) {
            check(!url.search, 'branch convergence action accepts no query parameters');
            check(isPlainObject(body) && Object.keys(body).every(key => ['method','params'].includes(key)),
              'branch convergence action accepts only method and params');
            check(isPlainObject(params) && !Object.hasOwn(params, '_token'), 'branch convergence params must be an object without agent tokens');
          }
          check(!params?._token, 'agent tokens are not accepted by Web UI');
          return json(await client.request(method, params));
        }
        return json({ error: 'not found' }, 404);
      } catch (error) { return json({ error: error.message }, 400); }
    },
  });
  const stop = server.stop.bind(server);
  server.stop = async closeActiveConnections => {
    quickChatClosing = true;
    const stopped = stop(closeActiveConnections);
    // Chat owns in-flight model requests, but may borrow the settings connection manager.
    // Wait for its shutdown before stopping that shared dependency, including lazy construction.
    await Promise.allSettled([stopped, ...[...quickChats.values()].map(pending => pending.then(service => service.close())), userServices?.close()]);
    await Promise.allSettled([deviceSettings?.stop()]);
  };
  WEB_HOSTS.set(server, projectHost);
  if (auth.version === 1) console.warn('[web] 旧版 version:1 web.json 保留全接口监听；改为 version:2 可默认仅监听回环，公网需显式 listen:"public"。');
  if (auth.hostname === '0.0.0.0') console.warn('[web] 公网 HTTP 监听已启用；直接通过 HTTP 访问会明文传输账号密码、会话和项目数据，存在窃听与篡改风险。建议由用户配置 HTTPS 反向代理或 SSH 端口转发；HTTP 不会因此被拒绝。');
  return server;
}

/** 进程正常关闭时再记一次当前项目：Web 与桌面并开时，以最后关闭的实例为准。 */
export function rememberWebProject(server) {
  try { WEB_HOSTS.get(server)?.rememberCurrent(); } catch { /* 缓存失败不能阻止进程退出 */ }
}
