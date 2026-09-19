import path from 'node:path';
import fs from 'node:fs';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { UIClient } from '../client.js';
import { check } from '../../core/types.js';
const ASSETS = fileURLToPath(new URL('./assets/', import.meta.url));
const AUTH_FILE = 'web.json';
const SESSION_COOKIE = 'lush_session';
const SESSION_SECONDS = 12 * 60 * 60;
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
const MUTATIONS = new Set(['input.submit','input.flow','draft.add','draft.remove','draft.update','draft.commit','task.message','task.cancel','task.retry','task.merge','task.merge_many','task.cleanup','task.verify','task.clear','notice.answer','notice.dismiss','plan.approve','plan.reject']);
/** 检验报告是 agent 写的自包含 HTML：只允许内联样式/脚本与 data: 图片，禁止任何外部加载与表单提交。
 *  主页面 CSP 不会作用于这个独立文档，所以这里必须自己收紧。 */
const REPORT_CSP = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'";
const PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
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
/** web.json 出现即表示显式开启公网模式；首次启动会把临时明文密码原地换成 scrypt hash。 */
function loadAuth(config) {
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
  const plaintext = typeof value.password === 'string';
  const hashed = typeof value.password_hash === 'string';
  check(plaintext !== hashed, `${file} must contain exactly one of password or password_hash`);
  let password_hash = value.password_hash;
  if (plaintext) {
    // 首尾空白一律忽略：从终端或聊天窗口复制密码时很容易带上换行，它不该变成登录失败。
    const secret = value.password.trim();
    check(secret.length >= 12 && secret.length <= 1024, `${file} password must be 12-1024 characters`);
    password_hash = passwordHash(secret);
    const replacement = JSON.stringify({ version: 1, username: value.username, password_hash }, null, 2) + '\n';
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, replacement, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, file);
      fs.chmodSync(file, 0o600);
    } finally { fs.rmSync(temporary, { force: true }); }
  } else check(/^scrypt\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/.test(password_hash), `${file} has an invalid password_hash`);
  return { username: value.username, password_hash };
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
function sameOrigin(request, url) {
  if (request.headers.get('sec-fetch-site') === 'cross-site') return false;
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try { return new URL(origin).host === url.host; } catch { return false; }
}

export function startWeb(config, port = 4318) {
  check(Number.isInteger(port) && port >= 0 && port <= 65535, 'invalid web port');
  const auth = loadAuth(config);
  const client = new UIClient(config);
  const sessions = new Map();
  const failures = new Map();
  return Bun.serve({
    hostname: auth ? '0.0.0.0' : '127.0.0.1', port, maxRequestBodySize: 128 * 1024,
    async fetch(request, server) {
      const url = new URL(request.url);
      const host = request.headers.get('host');
      const localHosts = [`127.0.0.1:${server.port}`, `localhost:${server.port}`];
      if (!host || url.host !== host || (!auth && !localHosts.includes(host))) return new Response('Invalid host', { status: 403 });
      if (!sameOrigin(request, url)) return new Response('Cross-site access denied', { status: 403 });
      const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': PAGE_CSP };
      const json = (body, status = 200, extra = {}) => Response.json(body, { status, headers: { ...headers, ...extra } });
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
        if (url.pathname.startsWith('/api/')) return json({ error: 'authentication required' }, 401);
        return new Response(null, { status: 303, headers: { Location: `/login?next=${encodeURIComponent(url.pathname + url.search)}`, ...headers } });
      }
      if (request.method === 'POST' && url.pathname === '/logout') {
        if (token) sessions.delete(token);
        return new Response(null, { status: 303, headers: { Location: '/login', 'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`, ...headers } });
      }

      try {
        if (request.method === 'GET') {
          if (url.pathname === '/api/snapshot') return json(await client.snapshot());
          const report = /^\/api\/task\/(\d+)\/report$/.exec(url.pathname);
          if (report) {
            const task = await client.request('task.inspect', { id: Number(report[1]) });
            check(task.role === 'verifier', `task #${task.id} is not a verification`);
            const file = path.join(config.home, 'verify', String(task.id), 'report.html');
            if (!fs.existsSync(file)) return json({ error: `verification #${task.id} has no report yet` }, 404);
            // 独立顶层文档（新标签打开）：不受主页面 CSP 约束，但仍显式收紧到一个自包含页面。
            return new Response(Bun.file(file), { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': REPORT_CSP } });
          }
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
}
