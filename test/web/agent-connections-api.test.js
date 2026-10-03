import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { RPCClient } from '../../src/rpc/client.js';
import { PARAMS, USER_ONLY, assertAllowed } from '../../src/rpc/registry.js';
import { startWeb } from '../../src/ui/web/server.js';
import { projectRouteId } from '../../src/host/registry.js';
import { temp } from '../helpers.js';
import { setup, fetch } from './harness.js';
import { install, connection, ManagerStub } from '../project/agent-connection-fixture.js';

const post=(url,body,headers={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
const action=(url,method,params={},headers={})=>post(url+'/api/action',{method,params},headers);
const methods={
  'agent.connections.list':[], 'agent.connections.save':['connection','credential'], 'agent.connections.remove':['id'],
  'agent.connections.sampling':['sampling'], 'agent.connections.query':['id'], 'agent.connections.history':['id','days'],
  'agent.connections.login.start':['id'], 'agent.connections.login.finish':['id','login_id','redirect_url'],
};

test('connection RPC surface is narrow and entirely user-only, with no secret read or passive write methods',()=>{
  for(const [method,params] of Object.entries(methods)){
    expect(PARAMS[method]).toEqual(params);expect(USER_ONLY.has(method)).toBe(true);
    expect(assertAllowed(method,{},null)).toBeNull();
    expect(()=>assertAllowed(method,{},99)).toThrow('requires user approval');
    expect(()=>assertAllowed(method,{command:'SECRET'},null)).toThrow('unknown parameter');
  }
  for(const method of ['agent.connections.observe','agent.connections.prepareRuntime','agent.connections.credentials']){
    expect(()=>assertAllowed(method,{},null)).toThrow('unknown method');
  }
});

test('local list/history are no-store and do not query; explicit actions manage/query connections without returning keys',async()=>{
  const f=await setup(),{manager}=install(f);
  try {
    const client=new RPCClient(f.config.socket);
    const initial=await client.request('agent.connections.list');expect(initial.connections).toHaveLength(1);expect(manager.calls).toBe(0);
    const list=await fetch(f.url+'/api/agent/connections');expect(list.status).toBe(200);expect(list.headers.get('cache-control')).toBe('no-store');
    expect(JSON.stringify(await list.json())).not.toContain('test-secret');
    const history=await fetch(f.url+'/api/agent/connections/history?id=conn-one&days=7');expect(history.status).toBe(200);
    expect(history.headers.get('cache-control')).toBe('no-store');expect((await history.json()).series).toEqual([]);expect(manager.calls).toBe(0);
    const saved=await action(f.url,'agent.connections.save',{connection:{id:'conn-one',label:'Second',provider:'deepseek',auth_type:'api_key',enabled:true},credential:{api_key:'SECRET-NEW-KEY'}});
    expect(saved.status).toBe(200);expect(JSON.stringify(await saved.json())).not.toContain('SECRET');
    expect(manager.keys.get('conn-one')).toBe('SECRET-NEW-KEY');
    const query=await action(f.url,'agent.connections.query',{id:'conn-one'});expect(query.status).toBe(200);expect(manager.calls).toBe(1);
    expect(JSON.stringify(await query.json())).not.toContain('SECRET');
    expect((await (await fetch(f.url+'/api/agent/connections/history?id=conn-one&days=7')).json()).series).toHaveLength(1);
    const sampling=await action(f.url,'agent.connections.sampling',{sampling:{enabled:false,interval_minutes:10,retention_days:30}});
    expect(sampling.status).toBe(200);expect((await sampling.json()).retention_days).toBe(30);
    const removed=await action(f.url,'agent.connections.remove',{id:'conn-one'});expect(removed.status).toBe(200);
    expect((await (await fetch(f.url+'/api/agent/connections')).json()).connections).toEqual([]);
    expect((await (await fetch(f.url+'/api/agent/connections/history?id=conn-one')).json()).series).toHaveLength(1);
    expect(f.store.get('SELECT COUNT(*) AS n FROM events').n).toBe(0);
  } finally {await f.close();}
});

test('connection HTTP rejects unknown/duplicate parameters, wrong methods and cross-origin reads/writes',async()=>{
  const f=await setup();install(f);
  try {
    for(const suffix of ['?secret=x','/history?id=conn-one&id=conn-two','/history?id=conn-one&days=7&days=30','/history?id=conn-one&token=x','/history?id=../private','/history?id=conn-one&days=2','/history']){
      expect((await fetch(f.url+'/api/agent/connections'+suffix)).status).toBe(400);
    }
    expect((await action(f.url,'agent.connections.list')).status).toBe(400);
    expect((await action(f.url,'agent.connections.observe',{id:'conn-one'})).status).toBe(400);
    expect((await fetch(f.url+'/api/agent/connections',{headers:{Origin:'https://attacker.invalid'}})).status).toBe(403);
    expect((await action(f.url,'agent.connections.query',{}, {Origin:'https://attacker.invalid'})).status).toBe(403);
    expect((await action(f.url,'agent.connections.save',{connection:connection(),credential:{api_key:'SECRET'},shell:'unsafe'})).status).toBe(400);
    expect((await fetch(f.url+'/api/agent/connections/credentials')).status).toBe(404);
  } finally {await f.close();}
});

test('connection login actions preserve URL metadata but never callback codes or raw exceptions',async()=>{
  const f=await setup(),manager=new ManagerStub([connection({provider:'openai-codex',auth_type:'oauth',endpoint:'https://chatgpt.com/backend-api'})]);
  install(f,{manager});
  try {
    const started=await action(f.url,'agent.connections.login.start',{id:'conn-one'});expect(started.status).toBe(200);
    const metadata=await started.json();expect(metadata.url).toStartWith('https://auth.openai.com/');expect(metadata.login_id).toBe('test-login');
    const finished=await action(f.url,'agent.connections.login.finish',{id:'conn-one',login_id:'test-login',redirect_url:'http://localhost:1455/auth/callback?code=SECRET-CODE'});
    expect(finished.status).toBe(200);expect(JSON.stringify(await finished.json())).not.toContain('SECRET');
    manager.loginFinish=()=>{throw new Error('SECRET-CODE SECRET-TOKEN');};
    const failure=await action(f.url,'agent.connections.login.finish',{id:'conn-one',login_id:'test-login',redirect_url:'SECRET-CODE'});
    expect(failure.status).toBe(400);expect(await failure.text()).not.toContain('SECRET');
    expect(f.store.get('SELECT COUNT(*) AS n FROM events').n).toBe(0);
  } finally {await f.close();}
});

test('all connection reads and writes require the existing Web login session',async()=>{
  const f=await setup({auth:{username:'owner',password:'test-only-password'}});install(f);
  try {
    expect((await fetch(f.url+'/api/agent/connections')).status).toBe(401);
    expect((await fetch(f.url+'/api/agent/connections/history?id=conn-one')).status).toBe(401);
    expect((await action(f.url,'agent.connections.query')).status).toBe(401);
    expect((await action(f.url,'agent.connections.login.start',{id:'conn-one'})).status).toBe(401);
    const login=await fetch(f.url+'/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'username=owner&password=test-only-password&next=%2F'});
    const Cookie=login.headers.get('set-cookie').split(';')[0];
    expect((await fetch(f.url+'/api/agent/connections',{headers:{Cookie}})).status).toBe(200);
    expect((await action(f.url,'agent.connections.query',{}, {Cookie})).status).toBe(200);
  } finally {await f.close();}
});

test('global connection routes preserve project identity for reads/query/login/write actions',async()=>{
  const a=temp(),b=temp(),global=temp(),calls=[];
  const web=startWeb(null,0,{env:{...process.env,LUSH_GLOBAL_CONFIG:global},openProject:async project=>({
    config:{project,home:path.join(project,'.lush')},client:{async request(method,params={}){calls.push({project,method,params});return {project,method,params};}},
  })});
  const url=`http://127.0.0.1:${web.port}`,idA=projectRouteId(fs.realpathSync(a)),idB=projectRouteId(fs.realpathSync(b));
  try {
    expect((await post(url+'/api/host/select',{project:a})).status).toBe(200);expect((await post(url+'/api/host/select',{project:b})).status).toBe(200);calls.length=0;
    expect((await (await fetch(`${url}/p/${idA}/api/agent/connections`)).json()).project).toBe(fs.realpathSync(a));
    expect((await (await fetch(`${url}/p/${idB}/api/agent/connections/history?id=conn-one&days=7`)).json()).project).toBe(fs.realpathSync(b));
    expect((await action(`${url}/p/${idA}`,'agent.connections.query',{id:'conn-one'})).status).toBe(200);
    expect((await action(`${url}/p/${idB}`,'agent.connections.login.start',{id:'conn-two'})).status).toBe(200);
    expect(calls).toEqual([
      {project:fs.realpathSync(a),method:'agent.connections.list',params:{}},
      {project:fs.realpathSync(b),method:'agent.connections.history',params:{id:'conn-one',days:7}},
      {project:fs.realpathSync(a),method:'agent.connections.query',params:{id:'conn-one'}},
      {project:fs.realpathSync(b),method:'agent.connections.login.start',params:{id:'conn-two'}},
    ]);
    expect((await fetch(url+'/api/agent/connections')).status).toBe(400);
    expect((await fetch(`${url}/p/${'0'.repeat(16)}/api/agent/connections`)).status).toBe(400);
  } finally {web.stop(true);for(const dir of [a,b,global])fs.rmSync(dir,{recursive:true,force:true});}
});
