import { test, expect } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import { fixture } from './helpers.js';
import { RPCServer } from '../src/rpc/server.js';
import { RPCClient } from '../src/rpc/client.js';
import { Dispatcher, parseRequest, encode } from '../src/rpc/protocol.js';
import { createSignal } from '../src/signal.js';
import { startWeb } from '../src/ui/web/server.js';

// node:http does not inherit machine-wide proxies for these loopback tests.
const fetch = (url, options = {}) => new Promise((resolve, reject) => {
  const request = http.request(url, { method: options.method || 'GET', headers: options.headers }, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
  });
  request.on('error', reject); request.end(options.body);
});
async function setup() {
  const f = fixture(), signal = createSignal();
  const rpc = new RPCServer(f.config.socket,new Dispatcher(f.project,signal,{})); await rpc.start();
  const web = startWeb(f.config,0);
  return { ...f, rpc, web, url:`http://127.0.0.1:${web.port}`, async close() {
    web.stop(true); await rpc.close(); await f.close(); fs.rmSync(f.config.socket,{force:true});
  } };
}

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
    const task = await (await fetch(f.url+'/api/task/1')).json(); expect(task.role).toBe('planner');
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

test('RPC rejects invalid frames, unknown params, invalid ids and cross-project tokens', async () => {
  const f = await setup();
  try {
    expect(() => parseRequest(Buffer.from('invalid'))).toThrow('parse error');
    expect(() => parseRequest(Buffer.from('{"jsonrpc":"2.0","method":"x","id":{}}'))).toThrow('id');
    expect(() => encode({large:'x'.repeat(1048576)})).toThrow('1 MiB');
    const client = new RPCClient(f.config.socket);
    await expect(client.request('task.inspect',{id:-1})).rejects.toThrow('positive');
    await expect(client.request('input.submit',{content:'x',sid:0})).rejects.toThrow('unknown parameter');
    await expect(client.request('input.list',{_token:'foreign'})).rejects.toThrow();
  } finally { await f.close(); }
});

test('large results do not inflate task listings and event history stays paginated', async () => {
  const f = await setup();
  try {
    f.project.stopping = true;
    const task = f.project.submit('large').task;
    f.store.update(task.id,{result:'x'.repeat(250000),status:'completed'});
    for (let i=0;i<10;i++) f.store.event(task.id,'output',{result:'x'.repeat(250000)});
    const client = new RPCClient(f.config.socket);
    const tasks = await client.request('task.list'); expect(tasks[0].result).toBeUndefined();
    const first = await client.request('task.history',{id:task.id});
    expect(first.length).toBeLessThan(11);
    const second = await client.request('task.history',{id:task.id,after:first.at(-1).id});
    expect(second[0].id).toBeGreaterThan(first.at(-1).id);
    expect((await client.request('task.inspect',{id:task.id})).result.length).toBe(250000);
  } finally { await f.close(); }
});

test('web buffers drafts, commits the whole batch and keeps agents out of the composer', async () => {
  const f = await setup();
  const post = (method, params) => fetch(f.url+'/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,params})});
  try {
    const html = await (await fetch(f.url)).text();
    expect(html).toContain('加入缓存');
    expect(html).toContain('提交并规划');
    expect(html).toContain('待提交缓存');
    expect((await post('draft.add',{content:'第一条'})).status).toBe(200);
    expect((await post('draft.add',{content:'第二条'})).status).toBe(200);
    let snapshot = await (await fetch(f.url+'/api/snapshot')).json();
    expect(snapshot.drafts.map(draft => draft.content)).toEqual(['第一条','第二条']);
    expect(snapshot.status.drafts).toBe(2);
    expect((await post('draft.remove',{id:snapshot.drafts[0].id})).status).toBe(200);
    expect((await post('draft.commit',{})).status).toBe(200);
    snapshot = await (await fetch(f.url+'/api/snapshot')).json();
    expect(snapshot.drafts).toEqual([]);
    expect(snapshot.status.drafts).toBe(0);
    expect(snapshot.inputs[0].content).toBe('第二条');
    expect(snapshot.tasks[0].role).toBe('planner');
    // 已提交的输入不能被删；agent token 与非白名单方法都被拒
    expect((await post('draft.remove',{id:1})).status).toBe(400);
    expect((await post('draft.add',{content:'sneak',_token:'forged'})).status).toBe(400);
    expect((await post('draft.clear',{})).status).toBe(400);
    expect((await post('input.submit',{content:'raw',_token:'forged'})).status).toBe(400);
  } finally { await f.close(); }
});
