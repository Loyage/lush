import path from 'node:path';
import fs from 'node:fs';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { webListenHost } from '../../host/web-listen.js';
import { canonicalProjectPath } from '../../host/registry.js';
import { check } from '../../core/types.js';

const AUTH_FILE = 'web.json';
const SESSION_COOKIE = 'lush_session';
const SESSION_SECONDS = 12 * 60 * 60;
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
export function loadAuth(config, { launcher = false } = {}) {
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


/** One authentication boundary per listener; routes never see an unauthenticated request. */
export function createAuthHandler(auth) {
  const sessions = new Map();
  const failures = new Map();
  return async function authenticate(context) {
    const { request, server, url, headers, json } = context;
    const host = request.headers.get('host');
    const localHosts = [`127.0.0.1:${server.port}`, `localhost:${server.port}`];
    if (!host || url.host !== host || (auth.hostname === '127.0.0.1' && !localHosts.includes(host) && !auth.origins.some(origin => new URL(origin).host === host))) return new Response('Invalid host', { status: 403 });
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
    // Trusted request-local identity for high-privilege entrance confirmations. Never accept
    // this from headers/body or return the session cookie to downstream services or models.
    context.user = Object.freeze({ kind: 'user_session', username: auth.username,
      sessionBinding: createHash('sha256').update(`lush-web-user-session:${token}`).digest('hex') });
    return null;
  };
}
