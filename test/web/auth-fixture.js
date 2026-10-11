import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startWeb } from '../../src/ui/web/server.js';
import { launcherWebConfig } from '../../src/host/registry.js';

const credentials = new Map(), clients = new Map();
export const rawFetch = (url, options = {}) => new Promise((resolve, reject) => {
  const request = http.request(url, { method: options.method || 'GET', headers: options.headers }, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
  });
  request.on('error', reject); request.end(options.body);
});

/** Only provision synthetic credentials under our own temporary project/device roots. */
export function provisionWebAuth(config) {
  const home = path.resolve(config.home);
  const relative = path.relative(os.tmpdir(), home);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !relative.split(path.sep)[0].startsWith('lush-test-'))
    throw new Error('Web auth fixture requires an isolated lush-test temporary root');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, 'web.json');
  if (!fs.existsSync(file)) {
    const auth = { username: 'fixture-user', password: 'synthetic-test-only-password' };
    fs.writeFileSync(file, JSON.stringify({ version: 2, ...auth }), { mode: 0o600, flag: 'wx' });
    credentials.set(file, auth);
  }
  return credentials.get(file);
}
export function registerWebClient(url, auth) {
  const origin = new URL(url).origin;
  if (auth) clients.set(origin, { auth, cookie: null, login: null });
  else clients.delete(origin);
}

/** Functional HTTP tests explicitly use this authenticated temporary Host fixture.
 * Security tests use production startWeb + rawFetch (no implicit credentials).
 */
export function startTestWeb(config, port = 0, options = {}) {
  const authConfig = options.authConfig || config || launcherWebConfig(options.env || process.env);
  const auth = provisionWebAuth(authConfig);
  const web = startWeb(config, port, { ...options, authConfig });
  const url = `http://127.0.0.1:${web.port}`;
  registerWebClient(url, auth);
  const stop = web.stop.bind(web);
  web.stop = async (...args) => { clients.delete(url); return stop(...args); };
  return web;
}

export async function fetch(url, options = {}) {
  const parsed = new URL(url), client = clients.get(parsed.origin);
  const headers = new Headers(options.headers);
  if (!client || headers.has('cookie') || ['/login', '/logout'].includes(parsed.pathname) || options.anonymous)
    return rawFetch(url, options);
  const login = async () => {
    client.login ||= rawFetch(parsed.origin + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(client.auth).toString() }).then(response => {
        if (response.status !== 303 || !response.headers.get('set-cookie')) throw new Error('fixture login failed');
        client.cookie = response.headers.get('set-cookie').split(';')[0];
      }).finally(() => { client.login = null; });
    await client.login;
  };
  if (!client.cookie) await login();
  const send = () => rawFetch(url, { ...options, headers: { ...Object.fromEntries(headers), Cookie: client.cookie } });
  const response = await send();
  // Test-only supervised Host restarts invalidate sessions; explicit-cookie tests never retry.
  if (response.status !== 401) return response;
  await login(); return send();
}
