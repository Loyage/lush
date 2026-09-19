import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { RPCClient } from '../../src/rpc/client.js';
import { parseRequest, encode } from '../../src/rpc/protocol.js';
import { UIClient } from '../../src/ui/client.js';
import { fetch, setup } from './harness.js';

// 项目作用域、只读路由白名单、跨源 / 伪造 Host / 非 JSON / 任意 RPC 拒绝。

test('web is project scoped, submits immediately and exposes no Service views', async () => {
  const f = await setup();
  try {
    const page = await fetch(f.url); const html = await page.text();
    expect(html).toContain('任务树'); expect(html).not.toContain('Service');
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const submit = await fetch(f.url+'/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'input.submit',params:{content:'web request'}})});
    expect(submit.status).toBe(200);
    const snapshot = await (await fetch(f.url+'/api/snapshot')).json();
    expect(snapshot.status.project).toBe(f.root); expect(snapshot.inputs[0].content).toBe('web request');
    // 并行/串行读模型跟着快照一起下发：没有它们，界面只能说"有这些任务"，说不出谁和谁能同时跑。
    expect(Array.isArray(snapshot.timeline.tasks)).toBe(true);
    expect(snapshot.timeline.concurrency).toBeGreaterThan(0);
    expect(Array.isArray(snapshot.ladder.nodes)).toBe(true);
    const task = await (await fetch(f.url+'/api/task/1')).json(); expect(task.role).toBe('planner');
  } finally { await f.close(); }
});

test('web exposes only read-only task routes and rejects other paths', async () => {
  const f = await setup();
  try {
    await fetch(f.url+'/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'input.submit',params:{content:'read routes'}})});
    expect((await fetch(f.url+'/api/task/1/history')).status).toBe(200);
    const history = await (await fetch(f.url+'/api/task/1/history')).json();
    expect(history[0].type).toBe('created');
    expect((await fetch(f.url+'/api/task/1/history?after=9999')).status).toBe(200);
    expect(await (await fetch(f.url+'/api/task/1/diff')).json()).toBeNull();
    expect((await fetch(f.url+'/api/task/1/diff')).status).toBe(200);
    expect((await fetch(f.url+'/api/task/99/diff')).status).toBe(400);
    expect((await fetch(f.url+'/api/task/1/merge')).status).toBe(404);
    expect((await fetch(f.url+'/api/system/status')).status).toBe(404);
  } finally { await f.close(); }
});

test('web rejects cross-origin requests, forged host, non-JSON and arbitrary RPC', async () => {
  const f = await setup();
  try {
    const body = JSON.stringify({method:'input.submit',params:{content:'bad'}});
    expect((await fetch(f.url+'/api/action',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.invalid'},body})).status).toBe(403);
    expect((await fetch(f.url+'/api/snapshot',{headers:{Host:'evil.invalid'}})).status).toBe(403);
    expect((await fetch(f.url+'/api/action',{method:'POST',body})).status).toBe(400);
    expect((await fetch(f.url+'/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'system.stop',params:{}})})).status).toBe(400);
    expect(f.project.inputs()).toHaveLength(0);
  } finally { await f.close(); }
});

test('web auth config enables public hosts and protects every route with a login session', async () => {
  const password = 'correct horse battery staple';
  const f = await setup({ auth: { username: 'owner', password } });
  try {
    expect(f.web.hostname).toBe('0.0.0.0');    const config = JSON.parse(fs.readFileSync(path.join(f.config.home, 'web.json'), 'utf8'));
    expect(config.password).toBeUndefined();
    expect(config.password_hash).toStartWith('scrypt$');
    expect(fs.statSync(path.join(f.config.home, 'web.json')).mode & 0o777).toBe(0o600);

    const blocked = await fetch(f.url);
    expect(blocked.status).toBe(303);
    expect(blocked.headers.get('location')).toBe('/login?next=%2F');
    expect((await fetch(f.url + '/api/snapshot')).status).toBe(401);
    const login = await fetch(f.url + '/login');
    expect(login.status).toBe(200);
    expect(await login.text()).toContain('登录后访问项目 Web UI');

    const wrong = await fetch(f.url + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=owner&password=wrong-password&next=%2F' });
    expect(wrong.status).toBe(401);
    // 从终端或聊天窗口复制密码常带尾随空白；只有真正写错才算登录失败。
    const padded = await fetch(f.url + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `username=${encodeURIComponent(' owner ')}&password=${encodeURIComponent(` ${password}\n`)}&next=%2F` });
    expect(padded.status).toBe(303);
    const success = await fetch(f.url + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `username=owner&password=${encodeURIComponent(password)}&next=%2F` });
    expect(success.status).toBe(303);
    const cookie = success.headers.get('set-cookie').split(';')[0];
    expect(cookie).toStartWith('lush_session=');
    expect((await fetch(f.url, { headers: { Cookie: cookie } })).status).toBe(200);

    const publicHost = `lush.example:${f.web.port}`;
    expect((await fetch(f.url + '/api/snapshot', { headers: { Cookie: cookie, Host: publicHost } })).status).toBe(200);
    const mutation = JSON.stringify({ method: 'input.submit', params: { content: 'cross-site' } });
    expect((await fetch(f.url + '/api/action', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: 'https://evil.invalid' }, body: mutation })).status).toBe(403);
    expect(f.project.inputs()).toHaveLength(0);

    const logout = await fetch(f.url + '/logout', { method: 'POST', headers: { Cookie: cookie } });
    expect(logout.status).toBe(303);
    expect((await fetch(f.url + '/api/snapshot', { headers: { Cookie: cookie } })).status).toBe(401);
  } finally { await f.close(); }
});

test('web accepts a configured public origin behind a Host-rewriting proxy', async () => {
  const password = 'correct horse battery staple';
  const f = await setup({ auth: { username: 'owner', password, origin: 'https://lush.example.com' } });
  try {
    const form = 'username=owner&password=' + encodeURIComponent(password) + '&next=%2F';
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    // 代理把 Host 改写成 127.0.0.1，浏览器发出的 Origin 是对外地址：登记过就必须放行。
    expect((await fetch(f.url + '/login', { method: 'POST', headers: { ...headers, Origin: 'https://lush.example.com' }, body: form })).status).toBe(303);
    const denied = await fetch(f.url + '/login', { method: 'POST', headers: { ...headers, Origin: 'https://evil.invalid' }, body: form });
    expect(denied.status).toBe(403);
    expect(await denied.text()).toContain('.lush/web.json');   // 错误页要指向修法，而不是只甩一行 403
    // 跨站顶层导航只是「从别处点进来」，后面还有认证；跨站子请求才是 CSRF 的形状。
    const navigation = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
    expect((await fetch(f.url + '/', { headers: navigation })).status).toBe(303);
    expect((await fetch(f.url + '/api/snapshot', { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' } })).status).toBe(403);
    // 内嵌 webview / 沙箱 iframe 会报 Origin: null 却依然是同源：浏览器说不是跨站就照常登录。
    const opaque = await fetch(f.url + '/login', { method: 'POST', headers: { ...headers, Origin: 'null', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }, body: form });
    expect(opaque.status).toBe(303);
    // 但旧浏览器没有 Sec-Fetch 可依据时，null origin 仍然按跨站处理。
    expect((await fetch(f.url + '/login', { method: 'POST', headers: { ...headers, Origin: 'null' }, body: form })).status).toBe(403);
  } finally { await f.close(); }
});

test('RPC rejects invalid frames, unknown params, invalid ids and cross-project tokens', async () => {
  const f = await setup();
  try {
    expect(() => parseRequest(Buffer.from('invalid'))).toThrow('parse error');
    expect(() => parseRequest(Buffer.from('{"jsonrpc":"2.0","method":"x","id":{}}'))).toThrow('id');
    expect(() => encode({large:'x'.repeat(1048576)})).toThrow('1 MiB');
    const client = new RPCClient(f.config.socket);
    await expect(client.request('task.inspect',{id:-1})).rejects.toThrow('positive');
    await expect(client.request('task.usage',{id:-1})).rejects.toThrow('positive');
    await expect(client.request('task.usage',{id:1,after:0})).rejects.toThrow('unknown parameter');
    await expect(client.request('input.submit',{content:'x',sid:0})).rejects.toThrow('unknown parameter');
    await expect(client.request('input.list',{_token:'foreign'})).rejects.toThrow();
    // 客户端比 daemon 新时不能只说 unknown method，要给出重启这一步
    await expect(new UIClient(f.config).request('service.list',{})).rejects.toThrow('daemon restart');
    // spec.list 无参数：多带一个过滤条件也必须被参数白名单拒掉（过滤/分组在 UI 侧做）
    await expect(new UIClient(f.config).request('spec.list', { status: 'pending' })).rejects.toThrow('unknown parameter');
  } finally { await f.close(); }
});

test('web exposes batch merge through the mutation whitelist', async () => {
  const f = await setup();
  const post = (method, params) => fetch(f.url+'/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,params})});
  try {
    // 白名单通过后才会到运行时校验：空 ids 报的是「至少一个」，不是「method not allowed from Web UI」。
    const response = await post('task.merge_many', { ids: [] });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('at least one');
    // agent token 在 Web 层直接被拒；真正的 USER_ONLY 校验在 daemon，见 merge-batch.test.js
    expect((await post('task.merge_many', { ids: [1], _token: 'forged' })).status).toBe(400);
  } finally { await f.close(); }
});
