import { test, expect, spyOn } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { RPCClient } from '../../src/rpc/client.js';
import { parseRequest, encode } from '../../src/rpc/protocol.js';
import { PARAMS, USER_ONLY } from '../../src/rpc/registry.js';
import { UIClient } from '../../src/ui/client.js';
import { repo } from '../helpers.js';
import { fetch, setup } from './harness.js';

// 项目作用域、只读路由白名单、跨源 / 伪造 Host / 非 JSON / 任意 RPC 拒绝。

test('web is project scoped, submits immediately and exposes no Service views', async () => {
  const f = await setup(); await repo(f.root);
  try {
    const page = await fetch(f.url); const html = await page.text();
    expect(html).toContain('Worker 列表'); expect(html).not.toContain('Service');
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const submit = await fetch(f.url+'/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'order.submit',params:{content:'web request'}})});
    expect(submit.status).toBe(200);
    const snapshot = await (await fetch(f.url+'/api/snapshot')).json();
    expect(snapshot.status.project).toBe(f.root);
    // 概览读模型只投影 order/child/main/owner：旧 inputs / timeline / ladder 都不再下发。
    const order = snapshot.tasks.find(task => task.task_kind === 'order');
    expect(order.goal).toBe('web request');
    expect(snapshot.inputs).toEqual([]);
    expect(snapshot.ladder.nodes).toBeUndefined();
    const task = await (await fetch(f.url+`/api/worker/${order.id}`)).json(); expect(task.task_kind).toBe('order');
  } finally { await f.close(); }
});

test('web saves project Agent profiles through the narrow mutation whitelist', async () => {
  const f = await setup(); await repo(f.root);
  try {
    const config = { version: 1,
      default: { agent: 'codex', model: 'gpt-5.4-mini', thinking: 'high', default_prompt: '', append_prompt: 'Keep changes reviewable.' },
      roles: { merger: { agent: 'pi', model: 'openai-codex/gpt-5.4', thinking: 'xhigh', default_prompt: '', append_prompt: '只解决分歧。' } },
    };
    const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'agent.configure', params: { config } }) });
    expect(response.status).toBe(200);
    const saved = await response.json();
    expect(saved.resolved.worker.agent).toBe('codex');
    expect(saved.resolved.merger).toMatchObject({ agent: 'pi', thinking: 'xhigh' });
    const snapshot = await (await fetch(f.url + '/api/snapshot')).json();
    expect(snapshot.status.provider).toBe('mock');
    const configView = await (await fetch(f.url + '/api/agent/config')).json();
    expect(configView.default.model).toBe('gpt-5.4-mini');
    expect(fs.existsSync(path.join(f.config.home, 'agent.json'))).toBe(true);

    const fakePi = path.join(f.root, 'fake-pi-models');
    fs.writeFileSync(fakePi, `#!/usr/bin/env bun\nconsole.log('provider  model  context  max-out  thinking  images');\nconsole.log('demo      current  100K     10K      yes       no');\n`, { mode: 0o755 });
    f.config.env.LUSH_PI_COMMAND = fakePi;
    const catalog = await (await fetch(f.url + '/api/agent/models?agent=pi')).json();
    expect(catalog.source).toBe('presets');
    expect(catalog.warning).toContain('尚未配置');
    expect(catalog.models.map(row => row.id)).not.toContain('demo/current');
    const resources = await (await fetch(f.url + '/api/agent/resources')).json();
    expect(resources.agent).toBe('pi');
    expect(Array.isArray(resources.extensions)).toBe(true);
    expect(Array.isArray(resources.skills)).toBe(true);
  } finally { await f.close(); }
});

test('web reads and saves per-target Agent environment through user-only narrow methods', async () => {
  const f = await setup(); await repo(f.root);
  const post = (method, params) => fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
  try {
    expect(PARAMS['agent.environment']).toEqual(['target', 'scope']);
    expect(PARAMS['agent.environment.configure']).toEqual(['target', 'values', 'scope']);
    expect(USER_ONLY.has('agent.environment')).toBe(true);
    expect(USER_ONLY.has('agent.environment.configure')).toBe(true);

    let response = await fetch(f.url + '/api/agent/environment?target=common');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ target: 'common', exists: false, values: {} });

    response = await post('agent.environment.configure', { target: 'common', values: { API_KEY: 'top secret', HTTP_PROXY: 'http://proxy' } });
    expect(response.status).toBe(200);
    const saved = await response.json();
    expect(saved).toMatchObject({ target: 'common', exists: true, values: { API_KEY: 'top secret', HTTP_PROXY: 'http://proxy' } });
    expect(fs.statSync(saved.file).mode & 0o777).toBe(0o600);
    expect((await (await fetch(f.url + '/api/agent/environment?target=common')).json()).values.API_KEY).toBe('top secret');

    const reserved = await post('agent.environment.configure', { target: 'worker', values: { LUSH_PROJECT: '/tmp/other' } });
    expect(reserved.status).toBe(400);
    expect((await reserved.json()).error).toContain('reserved by Lush');
    expect((await fetch(f.url + '/api/agent/environment?target=unknown')).status).toBe(400);
    expect((await post('agent.environment.configure', { target: 'common', values: {}, _token: 'forged' })).status).toBe(400);
  } finally { await f.close(); }
});

test('web exposes only read-only worker routes and rejects other paths', async () => {
  const f = await setup(); await repo(f.root);
  try {
    await fetch(f.url+'/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'order.submit',params:{content:'read routes'}})});
    expect((await fetch(f.url+'/api/worker/1/history')).status).toBe(200);
    const history = await (await fetch(f.url+'/api/worker/1/history')).json();
    expect(history[0].type).toBe('created');
    expect((await fetch(f.url+'/api/worker/1/history?after=9999')).status).toBe(200);
    expect(await (await fetch(f.url+'/api/worker/1/diff')).json()).toBeNull();
    expect((await fetch(f.url+'/api/worker/1/diff')).status).toBe(200);
    expect((await fetch(f.url+'/api/worker/99/diff')).status).toBe(400);
    expect((await fetch(f.url+'/api/worker/1/merge')).status).toBe(404);
    expect((await fetch(f.url+'/api/system/status')).status).toBe(404);
    // Removed SSH APIs and managed environment paths must not become local-project aliases.
    for (const route of ['/api/environments', '/e/0123456789abcdef0123456789abcdef/',
      '/e/0123456789abcdef0123456789abcdef/api/host', '/e/0123456789abcdef0123456789abcdef/p/aaaaaaaaaaaaaaaa/api/snapshot']) {
      expect((await fetch(f.url + route)).status).toBe(404);
    }
    for (const action of ['inspect', 'connect', 'disconnect', 'cancel']) {
      expect((await fetch(f.url + '/api/environments/ssh/' + action, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(404);
    }
  } finally { await f.close(); }
});

test('web rejects cross-origin requests, forged host, non-JSON and arbitrary RPC', async () => {
  const f = await setup(); await repo(f.root);
  try {
    const body = JSON.stringify({method:'input.submit',params:{content:'bad'}});
    expect((await fetch(f.url+'/api/action',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.invalid'},body})).status).toBe(403);
    expect((await fetch(f.url+'/api/snapshot',{headers:{Host:'evil.invalid'}})).status).toBe(403);
    expect((await fetch(f.url+'/api/snapshot',{headers:{Host:`127.0.0.1:${f.web.port === 65535 ? 65534 : f.web.port + 1}`}})).status).toBe(403);
    expect((await fetch(f.url+'/api/action',{method:'POST',body})).status).toBe(400);
    expect((await fetch(f.url+'/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'system.stop',params:{}})})).status).toBe(400);
    expect(f.project.inputs()).toHaveLength(0);
  } finally { await f.close(); }
});

test('public HTTP warns without blocking startup and retains login, cookies and Origin protection', async () => {
  const password = 'correct horse battery staple';
  const warning = spyOn(console, 'warn').mockImplementation(() => {});
  let f, warnings;
  try {
    f = await setup({ auth: { username: 'owner', password, origin: 'http://lush.example:8080' } });
    warnings = warning.mock.calls.flat().join('\n');
  } finally { warning.mockRestore(); }
  await repo(f.root);
  try {
    expect(warnings).toContain('公网 HTTP 监听已启用');
    expect(warnings).toContain('明文传输账号密码、会话和项目数据');
    expect(warnings).toContain('窃听与篡改风险');
    expect(f.web.hostname).toBe('0.0.0.0');
    const config = JSON.parse(fs.readFileSync(path.join(f.config.home, 'web.json'), 'utf8'));
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
    const sessionCookie = success.headers.get('set-cookie');
    expect(sessionCookie).toContain('; HttpOnly; SameSite=Strict;');
    expect(sessionCookie).not.toContain('; Secure');
    const cookie = sessionCookie.split(';')[0];
    expect(cookie).toStartWith('lush_session=');
    const proxied = await fetch(f.url + '/login', { method: 'POST', headers: {
      'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-Proto': 'https', Origin: 'http://lush.example:8080',
    }, body: `username=owner&password=${encodeURIComponent(password)}` });
    expect(proxied.status).toBe(303);
    expect(proxied.headers.get('set-cookie')).toContain('; Secure');
    expect((await fetch(f.url, { headers: { Cookie: cookie } })).status).toBe(200);

    const publicHost = `lush.example:${f.web.port}`;
    expect((await fetch(f.url + '/api/snapshot', { headers: { Cookie: cookie, Host: publicHost, Origin: `http://${publicHost}` } })).status).toBe(200);
    expect((await fetch(f.url + '/api/snapshot', { headers: { Cookie: cookie, Origin: 'http://lush.example:8080' } })).status).toBe(200);
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
  const f = await setup({ auth: { username: 'owner', password, origin: 'https://lush.example.com' } }); await repo(f.root);
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
    // 旧浏览器没有 Sec-Fetch 时 null origin 同样放行：null 是「无法判定」不是「跨站」。
    expect((await fetch(f.url + '/login', { method: 'POST', headers: { ...headers, Origin: 'null' }, body: form })).status).toBe(303);
    // 同一台设备登进来的写操作（无 Sec-Fetch + Origin: null）也不能误杀。
    const noop = await fetch(f.url + '/login', { method: 'POST', headers: { ...headers, Origin: 'null' }, body: form });
    const noopCookie = noop.headers.get('set-cookie')?.split(';')[0];
    expect((await fetch(f.url + '/api/action', { method: 'POST', headers: { Cookie: noopCookie, 'Content-Type': 'application/json', Origin: 'null' }, body: JSON.stringify({ method: 'order.submit', params: { content: 'test' } }) })).status).toBe(200);
  } finally { await f.close(); }
});

test('login lock is shared by the socket source, ignores forwarding headers and preserves existing sessions', async () => {
  const password = 'test-only-password';
  const f = await setup({ auth: { username: 'owner', password, origin: 'https://lush.example.com' } });
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://lush.example.com' };
  const form = value => new URLSearchParams({ username: 'owner', password: value }).toString();
  try {
    const login = await fetch(f.url + '/login', { method: 'POST', headers, body: form(password) });
    expect(login.status).toBe(303);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    // Real loopback socket, simulated proxy metadata only. Changing client-IP
    // claims must not change the bucket or bypass the five-failure lock.
    for (let index = 0; index < 5; index++) {
      const rejected = await fetch(f.url + '/login', { method: 'POST',
        headers: { ...headers, 'X-Forwarded-For': `192.0.2.${index + 1}` }, body: form('wrong-password') });
      expect(rejected.status).toBe(401);
    }
    const blocked = await fetch(f.url + '/login', { method: 'POST', headers: { ...headers,
      'X-Forwarded-For': '198.51.100.1', 'Forwarded': 'for=198.51.100.1;proto=https', 'X-Real-IP': '198.51.100.1' },
      body: form(password) });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('set-cookie')).toBeNull();
    expect(await blocked.text()).toContain('登录尝试过多，请一分钟后再试。');
    expect((await fetch(f.url + '/api/snapshot', { headers: { Cookie: cookie } })).status).toBe(200);
  } finally { await f.close(); }
});

test('explicit Origin cannot be overridden by same-site metadata and denied logout preserves the session', async () => {
  const password = 'test-only-password';
  const f = await setup({ auth: { username: 'owner', password, origin: 'https://lush.example.com' } });
  const form = new URLSearchParams({ username: 'owner', password }).toString();
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const origins = [f.url.replace('http:', 'https:'), 'http://localhost:' + f.web.port,
    'http://127.0.0.1:' + (f.web.port === 65535 ? f.web.port - 1 : f.web.port + 1),
    'https://evil.invalid', 'garbage', f.url + '/path', 'file:///tmp/opaque'];
  try {
    const login = await fetch(f.url + '/login', { method: 'POST', headers: { ...headers, Origin: f.url }, body: form });
    expect(login.status).toBe(303);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    for (const site of ['same-site', 'same-origin', 'none']) {
      for (const origin of origins) {
        const untrusted = { Origin: origin, 'Sec-Fetch-Site': site, Cookie: cookie };
        expect((await fetch(f.url + '/login', { method: 'POST', headers: { ...headers, ...untrusted }, body: form })).status).toBe(403);
        expect((await fetch(f.url + '/logout', { method: 'POST', headers: untrusted })).status).toBe(403);
        expect((await fetch(f.url + '/api/action', { method: 'POST', headers: { ...untrusted, 'Content-Type': 'application/json' },
          body: JSON.stringify({ method: 'draft.add', params: { content: 'must not be stored' } }) })).status).toBe(403);
      }
    }
    expect(f.store.get('SELECT count(*) AS n FROM drafts').n).toBe(0);
    expect((await fetch(f.url + '/api/snapshot', { headers: { Cookie: cookie } })).status).toBe(200);
    for (const origin of [f.url, 'https://lush.example.com', 'null', undefined]) {
      const compatible = { ...headers, 'Sec-Fetch-Site': 'same-site', ...(origin ? { Origin: origin } : {}) };
      expect((await fetch(f.url + '/login', { method: 'POST', headers: compatible, body: form })).status).toBe(303);
    }
    expect((await fetch(f.url + '/login', { method: 'POST', headers: { ...headers, Origin: 'https://lush.example.com', 'Sec-Fetch-Site': 'cross-site' }, body: form })).status).toBe(403);
    expect((await fetch(f.url + '/logout', { method: 'POST', headers: { Cookie: cookie, Origin: f.url, 'Sec-Fetch-Site': 'same-origin' } })).status).toBe(303);
    expect((await fetch(f.url + '/api/snapshot', { headers: { Cookie: cookie } })).status).toBe(401);
  } finally { await f.close(); }
});

test('login next stays on origin after URL normalization, including backslash and control variants', async () => {
  const password = 'test-only-password';
  const f = await setup({ auth: { username: 'owner', password } });
  const cases = [
    ['/', '/'],
    ['/p/abcdef0123456789/?q=one%20two#worker-1', '/p/abcdef0123456789/?q=one%20two#worker-1'],
    ['/\\audit.invalid/', '/'], ['/\\\\audit.invalid/', '/'],
    ['/a/../settings?q=yes#theme', '/settings?q=yes#theme'],
    ['//audit.invalid/', '/'], ['https://audit.invalid/', '/'],
    ['/\t/audit.invalid/', '/'], ['/\n/audit.invalid/', '/'], ['/\r/audit.invalid/', '/'],
    ['/\u0000audit.invalid/', '/'], ['/safe\u007fpath', '/'],
    ['/a/..//audit.invalid/', '/'], ['/%2e%2e//audit.invalid/', '/'],
  ];
  try {
    for (const [next, expected] of cases) {
      const response = await fetch(f.url + '/login', { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: 'owner', password, next }).toString() });
      expect(response.status).toBe(303);
      const location = response.headers.get('location');
      expect(new URL(location, f.url).origin).toBe(new URL(f.url).origin);
      expect(location).toBe(expected);
      const login = await fetch(f.url + '/login?next=' + encodeURIComponent(next));
      expect(await login.text()).toContain(`name="next" value="${expected}"`);
    }
  } finally { await f.close(); }
});

test('RPC rejects invalid frames, unknown params, invalid ids and cross-project tokens', async () => {
  const f = await setup(); await repo(f.root);
  try {
    expect(() => parseRequest(Buffer.from('invalid'))).toThrow('parse error');
    expect(() => parseRequest(Buffer.from('{"jsonrpc":"2.0","method":"x","id":{}}'))).toThrow('id');
    expect(() => encode({large:'x'.repeat(1048576)})).toThrow('1 MiB');
    const client = new RPCClient(f.config.socket);
    await expect(client.request('worker.inspect',{id:-1})).rejects.toThrow('positive');
    await expect(client.request('worker.usage',{id:-1})).rejects.toThrow('positive');
    await expect(client.request('worker.usage',{id:1,after:0})).rejects.toThrow('unknown parameter');
    await expect(client.request('order.submit',{content:'x',sid:0})).rejects.toThrow('unknown parameter');
    await expect(client.request('input.list',{_token:'foreign'})).rejects.toThrow();
    // 客户端比 daemon 新时不能只说 unknown method，要给出重启这一步
    await expect(new UIClient(f.config).request('service.list',{})).rejects.toThrow('daemon restart');
    // worker.inspect 只收 id：多带一个过滤条件也必须被参数白名单拒掉（过滤在 UI 侧做）
    await expect(new UIClient(f.config).request('worker.inspect', { id: 1, status: 'pending' })).rejects.toThrow('unknown parameter');
  } finally { await f.close(); }
});
test('web exposes branch batch merge through the mutation whitelist', async () => {
  const f = await setup(); await repo(f.root);
  const post = (method, params) => fetch(f.url+'/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,params})});
  try {
    // 越过 Web 白名单后由 runtime 校验分支：用不存在的分支只验证不是白名单拒绝。
    const body = await (await post('worker.reserve_all', { branch: 'no-such-branch' })).json();
    expect(body.error ?? '').not.toContain('method not allowed from Web UI');
    // agent token 在 Web 层直接被拒。
    expect((await post('worker.reserve_all', { branch: 'main', _token: 'forged' })).status).toBe(400);
  } finally { await f.close(); }
});

test('web forwards auto-merge settings but rejects tokens and unrelated mutations', async () => {
  const f = await setup();
  const post = (method, params) => fetch(f.url + '/api/action', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
  try {
    // This test owns the Web seam; runtime may reject an unknown Worker (or an older daemon the method).
    const response = await post('worker.auto_merge', { id: 999, enabled: true });
    expect((await response.json()).error ?? '').not.toContain('method not allowed from Web UI');
    const token = await post('worker.auto_merge', { id: 999, enabled: false, _token: 'forged' });
    expect(token.status).toBe(400);
    expect((await post('system.stop', {})).status).toBe(400);
  } finally { await f.close(); }
});

test('web exposes branch archive through the mutation whitelist', async () => {
  const f = await setup(); await repo(f.root);
  const post = (method, params) => fetch(f.url+'/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,params})});
  try {
    // 加的是白名单里的一条具体动作，不是把 /api/action 放宽成通用代理：白名单外的动作仍被同一句话拒绝。
    const blocked = await post('system.stop', {});
    expect(blocked.status).toBe(400);
    expect((await blocked.json()).error).toBe('method not allowed from Web UI');
    // branch.archive 已越过 Web 白名单、被转发给 daemon：基线上 daemon 还不认识它（unknown method），
    // 归档 RPC 合并后则是分支不存在的运行时错误或成功结果——两者都不该是上面那句白名单拒绝。
    const response = await post('branch.archive', { branch: 'lush/x/1-a', discard: true });
    expect((await response.json()).error ?? '').not.toContain('method not allowed from Web UI');
  } finally { await f.close(); }
});
test('web serves core architecture as Markdown and has no standalone documentation HTML route', async () => {
  const f = await setup(); await repo(f.root);
  try {
    const index = await (await fetch(f.url+'/api/docs')).json();
    const entry = index.docs.find(doc => doc.id === 'docs-core-architecture');
    expect(entry).toMatchObject({ format: 'markdown', group: '总览', path: 'docs/core-architecture.md' });
    const response = await fetch(f.url+'/api/docs/docs-core-architecture');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.markdown).toContain('新 `order` 保存 Input');
    expect(body.markdown).toContain('```mermaid');
    // 文档系统不再暴露 authored HTML；运行时 verifier 报告仍走独立的 task report 路由。
    expect((await fetch(f.url+'/api/docs/docs-core-architecture/html')).status).toBe(404);
    expect((await fetch(f.url+'/api/docs/readme/html')).status).toBe(404);
    const mermaid = await fetch(f.url+'/mermaid.min.js');
    expect(mermaid.status).toBe(200);
    expect(mermaid.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(mermaid.headers.get('content-security-policy')).toContain("img-src 'self' blob:");
  } finally { await f.close(); }
});
