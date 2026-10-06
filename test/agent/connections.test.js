import { test, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ConnectionManager } from '../../src/agent/connections.js';
import { DEFAULT_ENDPOINTS, requestJson } from '../../src/agent/connections-utils.js';
import { createRuntimeConnection, parseConnectionHeaders } from '../../src/agent/connection-runtime.js';

const fixtures = [];
afterEach(async () => { for (const f of fixtures.splice(0)) { await Promise.all(f.managers.map(m => m.stop())); fs.rmSync(f.root, { recursive: true }); } });
function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-connections-')), home = path.join(root, '.lush');
  fs.mkdirSync(home, { mode: 0o700 });
  const manager = new ConnectionManager({ home }, options);
  const f = { root, home, manager, managers: [manager] }; fixtures.push(f); return f;
}
const config = (provider = 'deepseek', values = {}) => ({ label: '测试账号', provider,
  auth_type: provider === 'openai-codex' ? 'oauth' : 'api_key', enabled: true, models: [], ...values });
const edit = (row, values = {}) => { const { credential, ...connection } = row; return { ...connection, ...values }; };
const json = data => Response.json(data);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const access = (accountId = 'account-a') => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({
  'https://api.openai.com/auth': { chatgpt_account_id: accountId }, email: 'private@example.com',
})).toString('base64url')}.signature`;
const tokens = (account = 'account-a', extra = {}) => ({ access_token: access(account), refresh_token: 'private-refresh', expires_in: 3600, ...extra });
async function login(manager, row) {
  const started = manager.loginStart(row.id), state = new URL(started.url).searchParams.get('state');
  return manager.loginFinish(row.id, started.login_id, `${started.redirect_uri}?code=private-code&state=${state}`);
}
function noSecrets(value, secrets = ['private-key','private-refresh','private-code','private@example.com','account-a']) {
  for (const secret of secrets) expect(JSON.stringify(value)).not.toContain(secret);
}

test('empty config is local, defaults sampling off and does not create credential storage', () => {
  const { manager } = fixture({ fetch: () => { throw new Error('must not fetch'); } });
  expect(manager.config()).toEqual({ version: 1, sampling: { enabled: false, interval_minutes: 5, retention_days: 90 }, connections: [] });
  expect(fs.existsSync(manager.file.dir)).toBe(false);
});
test('creates private project-owned file, returns no key prefix, preserves key on empty edit', async () => {
  const { manager } = fixture(); const row = manager.save(config(), { api_key: 'private-key' });
  expect(row.endpoint).toBe(DEFAULT_ENDPOINTS.deepseek); expect(row.credential.status).toBe('configured'); noSecrets(row);
  expect(fs.statSync(manager.file.dir).mode & 0o777).toBe(0o700);
  expect(fs.statSync(manager.file.file).mode & 0o777).toBe(0o600);
  manager.save(edit(row, { label: '另一个名字' }), { api_key: '' });
  expect((await manager.prepareRuntime(row.id)).credential.key).toBe('private-key'); noSecrets(manager.config());
});
test('two accounts of the same provider have distinct identity; update rotates identity, not connection id', async () => {
  const { manager } = fixture(); const a = manager.save(config(), { api_key: 'private-key' });
  const b = manager.save(config(), { api_key: 'other-key' });
  const ar = await manager.prepareRuntime(a.id), br = await manager.prepareRuntime(b.id);
  expect(ar.account_key).not.toBe(br.account_key); expect(ar.source_key).toBe(br.source_key);
  const changed = manager.save(edit(a), { api_key: 'new-key' }); expect(changed.id).toBe(a.id);
  expect((await manager.prepareRuntime(a.id)).account_key).not.toBe(ar.account_key);
});
test('internal identity matches query/runtime and is absent from public config', async () => {
  const {manager}=fixture({fetch:async()=>json({balance_infos:[{currency:'USD',total_balance:2}]})});
  const row=manager.save(config(),{api_key:'private-key'}),before=manager.identity(row.id);
  const runtime=await manager.prepareRuntime(row.id),query=await manager.query(row.id);
  expect(before.account_key).toBe(runtime.account_key);expect(before.source_key).toBe(runtime.source_key);
  expect(before.account_key).toBe(query.account_key);expect(before.source_key).toBe(query.source_key);
  expect(before.revision).toMatch(/^[a-f0-9]{64}$/);noSecrets(before);
  expect(manager.config().connections[0]).not.toHaveProperty('revision');
  manager.save(edit(row,{label:'renamed'}));const renamed=manager.identity(row.id);
  expect(renamed.account_key).toBe(before.account_key);expect(renamed.source_key).toBe(before.source_key);expect(renamed.revision).not.toBe(before.revision);
});
test('internal fingerprint tracks real file credential changes even without stored revision updates', async () => {
  const {manager}=fixture(),row=manager.save(config(),{api_key:'private-key'}),before=manager.identity(row.id);
  manager.file.transaction(data=>{data.connections[0].credential.key='external-key';});
  const changed=manager.identity(row.id);expect(changed.revision).not.toBe(before.revision);expect(changed.account_key).not.toBe(before.account_key);
  expect(changed.source_key).toBe(before.source_key);expect((await manager.prepareRuntime(row.id)).credential.key).toBe('external-key');noSecrets(changed,['external-key']);
});
test('deleting one connection preserves others and external files', () => {
  const f = fixture(), { manager } = f;
  const external = path.join(f.root, 'auth.json'); fs.writeFileSync(external, 'external-private');
  const a = manager.save(config(), { api_key: 'private-key' }), b = manager.save(config(), { api_key: 'other-key' });
  expect(manager.remove(a.id)).toEqual({ removed: a.id });
  expect(manager.config().connections.map(row => row.id)).toEqual([b.id]);
  expect(fs.readFileSync(external, 'utf8')).toBe('external-private'); expect(() => manager.remove(a.id)).toThrow('connection not found');
});
test('changing provider or endpoint origin clears the previous secret', async () => {
  const { manager } = fixture(); const a = manager.save(config(), { api_key: 'private-key' });
  const changed = manager.save(edit(a, { endpoint: 'https://proxy.example/v1' }));
  expect(changed.credential.status).toBe('unconfigured');
  await expect(manager.prepareRuntime(a.id)).rejects.toThrow('Connection operation unavailable');
  const another = manager.save(edit(changed, { provider: 'openrouter', endpoint: '' }), { api_key: 'other-key' });
  expect(another.provider).toBe('openrouter'); expect(another.endpoint).toBe(DEFAULT_ENDPOINTS.openrouter);
});
test('strict fields, URL and credential validation never interpolate commands or environment', () => {
  const { manager } = fixture();
  for (const value of [config('other'), config('deepseek', { auth_type: 'oauth' }), config('deepseek', { unexpected: true }),
    config('deepseek', { endpoint: 'http://localhost/v1' }), config('deepseek', { endpoint: 'https://user:pass@api.deepseek.com' }),
    config('deepseek', { endpoint: 'https://api.deepseek.com?key=private-key' }), config('deepseek', { models: ['x','x'] }),
    config('deepseek', { label: '\u202eevil' })]) expect(() => manager.save(value)).toThrow();
  for (const key of ['!read-secret','${SECRET}','bad\nkey']) expect(() => manager.save(config(), { api_key: key })).toThrow('API key is invalid');
  expect(() => manager.save(config(), { access: 'private-token' })).toThrow('credential fields are invalid');
  expect(() => manager.save(config('openai-codex'), { api_key: 'private-key' })).toThrow('OAuth credentials require the login flow');
});
test('sampling is validated and persists without replacing accounts', () => {
  const { manager } = fixture(); const row = manager.save(config(), { api_key: 'private-key' });
  expect(manager.configureSampling({ enabled: true, interval_minutes: 10, retention_days: 30 })).toEqual({ enabled: true, interval_minutes: 10, retention_days: 30 });
  expect(manager.config().connections[0].id).toBe(row.id);
  for (const sampling of [{enabled:true,interval_minutes:0,retention_days:90}, {enabled:'yes',interval_minutes:5,retention_days:90},
    {enabled:true,interval_minutes:5,retention_days:0}, {enabled:true,interval_minutes:5,retention_days:90,key:'private'}]) expect(() => manager.configureSampling(sampling)).toThrow();
});
test('rejects unsafe credential permissions without repairing or overwriting', () => {
  const { manager } = fixture(); manager.save(config(), { api_key: 'private-key' });
  const before = fs.readFileSync(manager.file.file); fs.chmodSync(manager.file.file, 0o644);
  expect(() => manager.config()).toThrow('Connection operation unavailable'); expect(() => manager.save(config())).toThrow();
  expect(fs.readFileSync(manager.file.file)).toEqual(before); expect(fs.statSync(manager.file.file).mode & 0o777).toBe(0o644);
});
test('rejects unsafe credential directory permissions', () => {
  const { manager } = fixture(); manager.save(config()); fs.chmodSync(manager.file.dir, 0o755);
  expect(() => manager.config()).toThrow('Connection operation unavailable');
});
test('rejects file symlinks and hardlinks', () => {
  const f = fixture(), { manager } = f; manager.save(config(), { api_key: 'private-key' });
  const other = path.join(f.root, 'real'); fs.renameSync(manager.file.file, other); fs.symlinkSync(other, manager.file.file);
  expect(() => manager.config()).toThrow(); fs.unlinkSync(manager.file.file); fs.linkSync(other, manager.file.file);
  expect(() => manager.config()).toThrow(); expect(fs.readFileSync(other, 'utf8')).toContain('private-key');
});
test('rejects credential directory symlink and canonical home aliases', () => {
  const f = fixture(), { manager } = f; manager.save(config()); const moved = path.join(f.root, 'moved');
  fs.renameSync(manager.file.dir, moved); fs.symlinkSync(moved, manager.file.dir); expect(() => manager.config()).toThrow();
  const alias = path.join(f.root, 'alias'); fs.symlinkSync(f.home, alias);
  expect(() => new ConnectionManager({home:alias}).config()).toThrow();
});
test('corrupt/oversized files fail closed and never echo payload', () => {
  const { manager } = fixture(); manager.save(config());
  fs.writeFileSync(manager.file.file, 'private-key not JSON');
  try { manager.config(); throw new Error('expected failure'); } catch (error) { noSecrets({message:error.message}); }
  fs.writeFileSync(manager.file.file, 'x'.repeat(1024*1024+1)); expect(() => manager.config()).toThrow();
});
test('does not steal an existing file transaction lock', () => {
  const { manager } = fixture(); manager.save(config());
  const lock = path.join(manager.file.dir, 'agent-connections.lock'); fs.mkdirSync(lock, {mode:0o700});
  expect(() => manager.save(config())).toThrow('Connection operation unavailable'); expect(fs.existsSync(lock)).toBe(true);
});

test('DeepSeek balance query sends only a dedicated GET to fixed origin', async () => {
  const requests = [], { manager } = fixture({ fetch: async (url,init) => {
    requests.push({url,init}); return json({balance_infos:[{currency:'USD',total_balance:'12.5'}]});
  } });
  const row = manager.save(config(), {api_key:'private-key'}), result = await manager.query(row.id);
  expect(result.observation.status).toBe('available'); expect(result.observation.resources[0]).toMatchObject({kind:'balance',scope:'account',remaining:12.5,unit:'USD'});
  expect(requests).toHaveLength(1); expect(requests[0].url).toBe('https://api.deepseek.com/user/balance');
  expect(requests[0].init).toMatchObject({method:'GET',redirect:'error',headers:{Authorization:'Bearer private-key'}}); noSecrets(result);
});
test('proxy endpoint never forwards its key to the official issuer', async () => {
  let calls = 0; const { manager } = fixture({fetch:async()=>{calls++;return json({});}});
  const row = manager.save(config('deepseek',{endpoint:'https://proxy.example/v1'}),{api_key:'private-key'});
  expect((await manager.query(row.id)).observation.status).toBe('unsupported'); expect(calls).toBe(0);
  expect((await manager.prepareRuntime(row.id)).credential.key).toBe('private-key');
});
test('disabled and unconfigured connections do not query the network', async () => {
  let calls = 0; const { manager } = fixture({fetch:async()=>{calls++;return json({});}});
  const missing = manager.save(config()), disabled = manager.save(config('deepseek',{enabled:false}),{api_key:'private-key'});
  expect((await manager.query(missing.id)).observation.error_code).toBe('unconfigured');
  expect((await manager.query(disabled.id)).observation.error_code).toBe('disabled'); expect(calls).toBe(0);
});
test('OpenRouter budget uses current remaining, not lifetime usage; credits independent', async () => {
  const { manager } = fixture({ now:()=>Date.parse('2026-10-03T06:00:00Z'), fetch:async url => url.endsWith('/key')
    ? json({data:{limit:100,limit_remaining:80,usage:500,usage_daily:3,limit_reset:'weekly'}})
    : json({data:{total_credits:200,total_usage:10}}) });
  const row = manager.save(config('openrouter'),{api_key:'private-key'}), result = (await manager.query(row.id)).observation;
  expect(result.status).toBe('available'); expect(result.resources.find(r=>r.id==='key-budget')).toMatchObject({used:20,total:100,remaining:80,scope:'key',reset_at:'2026-10-05T00:00:00.000Z'});
  expect(result.resources.find(r=>r.id==='account-credits')).toMatchObject({remaining:190,scope:'account',kind:'balance'});
});
test('OpenRouter credits permission failure retains Key budget without inventing balance', async () => {
  const { manager } = fixture({fetch:async url=>url.endsWith('/key')?json({data:{limit:10,limit_remaining:7}}):new Response('private-key upstream',{status:403})});
  const row=manager.save(config('openrouter'),{api_key:'private-key'}), result=await manager.query(row.id);
  expect(result.observation.status).toBe('partial'); expect(result.observation.resources.map(r=>r.id)).toEqual(['key-budget']); noSecrets(result);
});
test('OpenRouter credits can succeed even if Key accounting fails', async () => {
  const { manager }=fixture({fetch:async url=>url.endsWith('/key')?new Response(null,{status:503}):json({data:{total_credits:20,total_usage:3}})});
  const row=manager.save(config('openrouter'),{api_key:'private-key'});
  expect((await manager.query(row.id)).observation).toMatchObject({status:'partial',resources:[{id:'account-credits',remaining:17}]});
});
test('OpenRouter uncapped Key exposes consumption, not a fabricated zero remaining budget', async () => {
  const { manager }=fixture({fetch:async url=>url.endsWith('/key')?json({data:{limit:null,limit_remaining:null,usage:7}}):new Response(null,{status:403})});
  const row=manager.save(config('openrouter'),{api_key:'private-key'}), result=(await manager.query(row.id)).observation;
  expect(result.resources).toHaveLength(1); expect(result.resources[0]).toMatchObject({used:7,remaining:null,total:null});
});
test('Kimi uses explicit minute units and leaves unspecified membership window unknown', async () => {
  const { manager }=fixture({fetch:async()=>json({usage:{used:2,limit:10},limits:[{window:{duration:300,timeUnit:'TIME_UNIT_MINUTE'},detail:{used:3,limit:20,resetTime:'2026-10-03T10:00:00Z'}}]})});
  const row=manager.save(config('kimi-coding'),{api_key:'private-key'}), result=(await manager.query(row.id)).observation;
  expect(result.resources[0]).toMatchObject({window_seconds:null,remaining:8}); expect(result.resources[1]).toMatchObject({window_seconds:18000,remaining:17});
});
test('Z.AI retains absolute counters plus percentage and explicit durations, not guessed months', async () => {
  const { manager }=fixture({fetch:async()=>json({data:{limits:[{type:'CREDIT_LIMIT',percentage:20,currentValue:2,usage:10,unit:3,number:5},
    {type:'TOKENS_LIMIT',percentage:50,unit:6,number:1,nextResetTime:'2026-11-01T00:00:00Z'}]}})});
  const row=manager.save(config('zai'),{api_key:'private-key'}), result=(await manager.query(row.id)).observation;
  expect(result.resources[0]).toMatchObject({used:2,total:10,remaining:8,used_percent:20,unit:'额度单位',window_seconds:18000});
  expect(result.resources[1]).toMatchObject({used:50,unit:'%',window_seconds:null,reset_at:'2026-11-01T00:00:00.000Z'});
});
test('Z.AI exposes multiple windows of the same quota type without merging them', async () => {
  const {manager}=fixture({fetch:async()=>json({data:{limits:[{type:'TOKENS_LIMIT',percentage:20,unit:3,number:5},
    {type:'TOKENS_LIMIT',percentage:70,unit:5,number:1}]}})});
  const row=manager.save(config('zai'),{api_key:'private-key'}),result=(await manager.query(row.id)).observation;
  expect(result.status).toBe('available');expect(result.resources.map(row=>row.window_seconds)).toEqual([18000,604800]);
  expect(new Set(result.resources.map(row=>row.id)).size).toBe(2);
});
test('missing or malformed data is not replaced with zero', async () => {
  const { manager }=fixture({fetch:async()=>json({balance_infos:[{currency:'USD',total_balance:null}]})});
  const row=manager.save(config(),{api_key:'private-key'}), result=(await manager.query(row.id)).observation;
  expect(result).toMatchObject({status:'error',error_code:'invalid_response',resources:[]});
});
test('network/errors/rate limits never return raw diagnostics and do not retry', async () => {
  for (const status of [401,403,429,500,302]) {
    let calls=0; const {manager}=fixture({fetch:async()=>{calls++;return new Response('private-key provider diagnostics',{status});}});
    const row=manager.save(config(),{api_key:'private-key'}), result=await manager.query(row.id);
    expect(result.observation.status).toBe('error'); expect(calls).toBe(1); noSecrets(result);
    expect(result.observation.error_code).toBe(status===429?'rate_limited':[401,403].includes(status)?'unauthorized':'network');
  }
});
test('network exception messages do not leak credentials', async () => {
  const {manager}=fixture({fetch:()=>{throw new Error('private-key request headers');}});
  const row=manager.save(config(),{api_key:'private-key'}); noSecrets(await manager.query(row.id));
});
test('timeout includes fetch and body; hanging transports can be abandoned', async () => {
  for (const fetch of [()=>new Promise(()=>{}), async()=>new Response(new ReadableStream({start(){}}))]) {
    const {manager}=fixture({fetch,timeout:15}), row=manager.save(config(),{api_key:'private-key'});
    expect((await manager.query(row.id)).observation.error_code).toBe('timeout');
  }
});
test('oversized JSON and redirected responses fail closed', async () => {
  for (const fetch of [async()=>new Response('x'.repeat(65537)),async()=>new Response('{}',{headers:{'content-length':'65537'}}),
    async()=>{const r=json({balance_infos:[{currency:'USD',total_balance:1}]});Object.defineProperty(r,'redirected',{value:true});return r;}]) {
    const {manager}=fixture({fetch}), row=manager.save(config(),{api_key:'private-key'});
    expect((await manager.query(row.id)).observation.status).toBe('error');
  }
});
test('old query cannot attach to a changed account or deleted connection', async () => {
  for (const remove of [false,true]) {
    const entered=deferred(),release=deferred(),{manager}=fixture({fetch:async()=>{entered.resolve();await release.promise;return json({balance_infos:[{currency:'USD',total_balance:1}]});}});
    const row=manager.save(config(),{api_key:'private-key'}), pending=manager.query(row.id); await entered.promise;
    if(remove)manager.remove(row.id);else manager.save(edit(row),{api_key:'new-key'});
    release.resolve(); expect((await pending).observation.error_code).toBe('auth_changed');
  }
});

test('OAuth authorization uses PKCE/state and returns no verifier or stored credential', async () => {
  const {manager}=fixture();const row=manager.save(config('openai-codex')), started=manager.loginStart(row.id),url=new URL(started.url);
  expect(url.origin).toBe('https://auth.openai.com');expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('scope')).toContain('offline_access');expect(url.searchParams.get('state').length).toBe(64);
  expect(Object.keys(started)).toEqual(['id','login_id','url','expires_at','redirect_uri','instructions']); noSecrets(manager.config());
});
test('OAuth manual callback checks exact destination, state and duplicates before exchange', async () => {
  let calls=0;const {manager}=fixture({fetch:async()=>{calls++;return json(tokens());}}), row=manager.save(config('openai-codex'));
  const started=manager.loginStart(row.id),state=new URL(started.url).searchParams.get('state');
  for (const value of [`https://evil.example/auth/callback?code=x&state=${state}`,`${started.redirect_uri}?code=x&state=wrong`,
    `${started.redirect_uri}?code=x&state=${state}&state=${state}`,`${started.redirect_uri}?code=x&code=y&state=${state}`,
    `${started.redirect_uri}?code=x&state=${state}#evil`,'private-code',`${started.redirect_uri}/other?code=x&state=${state}`])
    await expect(manager.loginFinish(row.id,started.login_id,value)).rejects.toThrow('Connection operation unavailable');
  expect(calls).toBe(0);await manager.loginFinish(row.id,started.login_id,`${started.redirect_uri}?code=private-code&state=${state}`);expect(calls).toBe(1);
});
test('OAuth exchanges only once and persists in own file, not public responses', async () => {
  let body, calls=0;const {manager}=fixture({fetch:async(url,init)=>{calls++;expect(url).toBe('https://auth.openai.com/oauth/token');expect(init.redirect).toBe('error');body=init.body;return json(tokens());}});
  const row=manager.save(config('openai-codex')),started=manager.loginStart(row.id),state=new URL(started.url).searchParams.get('state');
  const result=await manager.loginFinish(row.id,started.login_id,`${started.redirect_uri}?code=private-code&state=${state}`);
  expect(body.get('grant_type')).toBe('authorization_code');expect(body.get('redirect_uri')).toBe(started.redirect_uri);
  expect(createHash('sha256').update(body.get('code_verifier')).digest('base64url')).toBe(new URL(started.url).searchParams.get('code_challenge'));
  expect(result.credential.status).toBe('configured');noSecrets(result);noSecrets(manager.config());
  await expect(manager.loginFinish(row.id,started.login_id,`${started.redirect_uri}?code=private-code&state=${state}`)).rejects.toThrow();expect(calls).toBe(1);
  expect((await manager.prepareRuntime(row.id)).credential.accountId).toBe('account-a');
});
test('login expires and a fresh start invalidates the previous challenge', async () => {
  let now=Date.parse('2026-10-03T06:00:00Z'),calls=0;const {manager}=fixture({now:()=>now,fetch:async()=>{calls++;return json(tokens());}});
  const row=manager.save(config('openai-codex')), first=manager.loginStart(row.id);manager.loginStart(row.id);
  await expect(manager.loginFinish(row.id,first.login_id,`${first.redirect_uri}?code=x&state=${new URL(first.url).searchParams.get('state')}`)).rejects.toThrow();
  const fresh=manager.loginStart(row.id);now+=15*60000+1;
  await expect(manager.loginFinish(row.id,fresh.login_id,`${fresh.redirect_uri}?code=x&state=${new URL(fresh.url).searchParams.get('state')}`)).rejects.toThrow();expect(calls).toBe(0);
});
test('failed OAuth exchange is consumed and never leaks upstream token data', async () => {
  let calls=0;const {manager}=fixture({fetch:async()=>{calls++;return new Response('private-refresh private-code',{status:400});}});
  const row=manager.save(config('openai-codex')),started=manager.loginStart(row.id),callback=`${started.redirect_uri}?code=private-code&state=${new URL(started.url).searchParams.get('state')}`;
  try{await manager.loginFinish(row.id,started.login_id,callback);}catch(error){noSecrets({message:error.message});}
  await expect(manager.loginFinish(row.id,started.login_id,callback)).rejects.toThrow();expect(calls).toBe(1);expect(manager.config().connections[0].credential.status).toBe('unconfigured');
});
test('OAuth exchange cannot publish after a connection edit/delete', async () => {
  for(const remove of [false,true]){
    const entered=deferred(),release=deferred(),{manager}=fixture({fetch:async()=>{entered.resolve();await release.promise;return json(tokens());}});
    const row=manager.save(config('openai-codex')),pending=login(manager,row);await entered.promise;
    if(remove)manager.remove(row.id);else manager.save(edit(row,{label:'changed'}));release.resolve();
    await expect(pending).rejects.toThrow('Connection operation unavailable');
    if(!remove)expect(manager.config().connections[0].credential.status).toBe('unconfigured');
  }
});
test('OAuth refresh is single-flight, retains stable account identity and preserves other connections', async () => {
  let now=Date.parse('2026-10-03T06:00:00Z'),refreshes=0;
  const {manager}=fixture({now:()=>now,fetch:async(_url,init)=>{if(init.body.get('grant_type')==='refresh_token')refreshes++;return json(tokens('account-a',{refresh_token:'new-refresh'}));}});
  const row=manager.save(config('openai-codex'));await login(manager,row);const initial=await manager.prepareRuntime(row.id);const other=manager.save(config(),{api_key:'other-key'});
  now+=3601*1000;expect(manager.config().connections.find(r=>r.id===row.id).credential.status).toBe('expired');
  const [a,b]=await Promise.all([manager.prepareRuntime(row.id),manager.prepareRuntime(row.id)]);
  expect(refreshes).toBe(1);expect(a.account_key).toBe(initial.account_key);expect(a).toEqual(b);expect(manager.config().connections.some(r=>r.id===other.id)).toBe(true);
});
test('runtime refreshes within five minutes while a short quota GET need not refresh early', async () => {
  let now=Date.parse('2026-10-03T06:00:00Z'),refreshes=0;
  const {manager}=fixture({now:()=>now,fetch:async(url,init)=>{
    if(url.includes('/oauth/token')){if(init.body.get('grant_type')==='refresh_token')refreshes++;return json(tokens('account-a',{refresh_token:refreshes?'rotated-refresh':'private-refresh'}));}
    return json({rate_limit:{primary_window:{used_percent:20,limit_window_seconds:18000}}});
  }});
  const row=manager.save(config('openai-codex'));await login(manager,row);const before=manager.identity(row.id);
  now+=56*60000;await manager.query(row.id);expect(refreshes).toBe(0);
  const runtime=await manager.prepareRuntime(row.id);expect(refreshes).toBe(1);expect(runtime.credential.expires-now).toBeGreaterThan(300000);
  const after=manager.identity(row.id);expect(after.account_key).toBe(before.account_key);expect(after.source_key).toBe(before.source_key);expect(after.revision).not.toBe(before.revision);
});
test('runtime refuses a newly refreshed token with insufficient five-minute validity', async () => {
  let now=Date.parse('2026-10-03T06:00:00Z'),refreshes=0;
  const {manager}=fixture({now:()=>now,fetch:async(_url,init)=>{
    const refreshing=init.body.get('grant_type')==='refresh_token';if(refreshing)refreshes++;
    return json(tokens('account-a',{expires_in:refreshing?240:3600}));
  }});
  const row=manager.save(config('openai-codex'));await login(manager,row);now+=3601*1000;
  const error=await manager.prepareRuntime(row.id).catch(error=>error);expect(error.connectionCode).toBe('expired');expect(refreshes).toBe(1);
});
test('OAuth refresh cannot overwrite file credentials changed without a revision marker', async () => {
  let now=Date.parse('2026-10-03T06:00:00Z');const entered=deferred(),release=deferred();
  const {manager}=fixture({now:()=>now,fetch:async(_url,init)=>{
    if(init.body.get('grant_type')==='refresh_token'){entered.resolve();await release.promise;}return json(tokens());
  }});
  const row=manager.save(config('openai-codex'));await login(manager,row);now+=3601*1000;
  const pending=manager.prepareRuntime(row.id);await entered.promise;
  manager.file.transaction(data=>{data.connections[0].credential.refresh='externally-replaced-refresh';});
  const changed=fs.readFileSync(manager.file.file,'utf8');release.resolve();
  const error=await pending.catch(error=>error);expect(error.connectionCode).toBe('auth_changed');expect(fs.readFileSync(manager.file.file,'utf8')).toBe(changed);
});
test('OAuth login checks the full credential fingerprint before publishing', async () => {
  const entered=deferred(),release=deferred(),{manager}=fixture({fetch:async()=>{entered.resolve();await release.promise;return json(tokens());}});
  const row=manager.save(config('openai-codex')),pending=login(manager,row);await entered.promise;
  // Simulate another trusted writer changing metadata without changing its random revision marker.
  manager.file.transaction(data=>{data.connections[0].label='external label';});release.resolve();
  const error=await pending.catch(error=>error);expect(error.connectionCode).toBe('auth_changed');expect(manager.config().connections[0].credential.status).toBe('unconfigured');
});
test('OAuth refresh coordinates across manager instances sharing one file', async () => {
  let now=Date.parse('2026-10-03T06:00:00Z'),refreshes=0;
  const options={now:()=>now,fetch:async(_url,init)=>{if(init.body.get('grant_type')==='refresh_token')refreshes++;return json(tokens());}};
  const f=fixture(options),row=f.manager.save(config('openai-codex'));await login(f.manager,row);now+=3601*1000;
  const other=new ConnectionManager({home:f.home},options);f.managers.push(other);
  const [a,b]=await Promise.all([f.manager.prepareRuntime(row.id),other.prepareRuntime(row.id)]);
  expect(refreshes).toBe(1);expect(a.account_key).toBe(b.account_key);
});
test('OAuth refresh uses a cross-process lock, not just a JS single-flight map', async () => {
  let now=Date.parse('2026-10-03T06:00:00Z');
  const f=fixture({now:()=>now,fetch:async()=>json(tokens())}),row=f.manager.save(config('openai-codex'));
  await login(f.manager,row);now+=3601*1000;
  const countFile=path.join(f.root,'refresh-count');
  const modulePath=path.resolve('src/agent/connections.js');
  const script=`import fs from 'node:fs';import {ConnectionManager} from ${JSON.stringify(modulePath)};
    const m=new ConnectionManager({home:${JSON.stringify(f.home)}},{now:()=>${now},fetch:async()=>{
      fs.appendFileSync(${JSON.stringify(countFile)},'refresh\\n');
      await new Promise(r=>setTimeout(r,40));return Response.json(${JSON.stringify(tokens())});
    }});
    try{const b=await m.prepareRuntime(${JSON.stringify(row.id)});console.log(b.account_key);}finally{await m.stop();}`;
  const spawn=()=>Bun.spawn([process.execPath,'--eval',script],{stdout:'pipe',stderr:'pipe'});
  const children=[spawn(),spawn()];
  const results=await Promise.all(children.map(async child=>({code:await child.exited,stdout:await new Response(child.stdout).text(),stderr:await new Response(child.stderr).text()})));
  expect(results.map(result=>result.code)).toEqual([0,0]);expect(results[0].stdout).toBe(results[1].stdout);
  expect(results.map(result=>result.stderr)).toEqual(['','']);expect(fs.readFileSync(countFile,'utf8')).toBe('refresh\n');
},10000);
test('OAuth refresh refuses account substitution and never overwrites the previous credential', async () => {
  let now=Date.parse('2026-10-03T06:00:00Z');const {manager}=fixture({now:()=>now,fetch:async(_url,init)=>json(tokens(init.body.get('grant_type')==='refresh_token'?'other-account':'account-a'))});
  const row=manager.save(config('openai-codex'));await login(manager,row);const before=fs.readFileSync(manager.file.file,'utf8');now+=3601*1000;
  await expect(manager.prepareRuntime(row.id)).rejects.toThrow();expect(fs.readFileSync(manager.file.file,'utf8')).toBe(before);
});
test('OAuth refresh cannot overwrite a concurrent edit and never steals a stale refresh lock', async () => {
  let now=Date.parse('2026-10-03T06:00:00Z');const entered=deferred(),release=deferred();
  const {manager}=fixture({now:()=>now,lockTimeout:0,fetch:async(_url,init)=>{if(init.body.get('grant_type')==='refresh_token'){entered.resolve();await release.promise;}return json(tokens());}});
  const row=manager.save(config('openai-codex'));await login(manager,row);now+=3601*1000;
  const pending=manager.prepareRuntime(row.id);await entered.promise;manager.save(edit(row,{label:'edited'}));release.resolve();await expect(pending).rejects.toThrow();
  expect(manager.config().connections[0].label).toBe('edited');expect(manager.config().connections[0].credential.status).toBe('expired');
  const lock=path.join(manager.file.dir,`refresh-${row.id}.lock`);fs.mkdirSync(lock,{mode:0o700});
  await expect(manager.prepareRuntime(row.id)).rejects.toThrow();expect(fs.existsSync(lock)).toBe(true);
});
test('Codex query attaches account header and preserves genuine primary duration/model limits', async () => {
  let usageRequest;const {manager}=fixture({fetch:async(url,init)=>{
    if(url.includes('/oauth/token'))return json(tokens());usageRequest=init;
    return json({rate_limit:{primary_window:{used_percent:25,limit_window_seconds:604800,reset_at:1791043200}},additional_rate_limits:[{rate_limit:{primary_window:{used_percent:50,limit_window_seconds:18000}}}]});
  }});
  const row=manager.save(config('openai-codex'));await login(manager,row);const result=await manager.query(row.id);
  expect(result.observation.resources[0]).toMatchObject({remaining:75,unit:'%',window_seconds:604800});
  expect(result.observation.resources[1]).toMatchObject({scope:'model',remaining:50});expect(usageRequest.headers['ChatGPT-Account-Id']).toBe('account-a');noSecrets(result);
});
test('managed Codex OAuth is never bound or queried through a proxy', async () => {
  let calls=0;const {manager}=fixture({fetch:async()=>{calls++;return json(tokens());}});
  const row=manager.save(config('openai-codex',{endpoint:'https://proxy.example/v1'}));await login(manager,row);expect(calls).toBe(1);
  expect((await manager.query(row.id)).observation.status).toBe('unsupported');await expect(manager.prepareRuntime(row.id)).rejects.toThrow();expect(calls).toBe(1);
});
test('shutdown cancels in-flight body, login and refresh without publishing secrets', async () => {
  const entered=deferred(),{manager}=fixture({fetch:async()=>{entered.resolve();return new Response(new ReadableStream({start(){}}));}});
  const row=manager.save(config('openai-codex')),pending=login(manager,row);await entered.promise;await manager.stop();
  await expect(pending).rejects.toThrow();expect(manager.logins.size).toBe(0);expect(manager.config().connections[0].credential.status).toBe('unconfigured');
  expect(()=>manager.save(config())).toThrow();
});
test('managed API Key snapshots compose with fixed-parent Pi runtime without leaking other accounts', async () => {
  const f=fixture(),{manager}=f;
  const expected={deepseek:'https://api.deepseek.com',openrouter:'https://openrouter.ai/api/v1',
    zai:'https://api.z.ai/api/coding/paas/v4','kimi-coding':'https://api.kimi.com/coding'};
  manager.save(config(),{api_key:'other-account-key'});
  for(const [provider,endpoint] of Object.entries(expected)){
    const row=manager.save(config(provider,{models:['test-model']}),{api_key:'private-key'});
    const runtime=await manager.prepareRuntime(row.id),privatePi=createRuntimeConnection(
      {home:f.home,project:f.root,env:{HOME:f.root}},
      {agent:'pi',model:`${provider}/test-model`,connection_id:row.id},runtime);
    try{
      const auth=JSON.parse(fs.readFileSync(path.join(privatePi.dir,'auth.json'),'utf8'));
      const models=JSON.parse(fs.readFileSync(path.join(privatePi.dir,'models.json'),'utf8'));
      expect(auth).toEqual({[provider]:{type:'api_key',key:'private-key'}});
      expect(models.providers[provider].baseUrl).toBe(endpoint);
      expect(privatePi.binding.account_key).toBe(manager.identity(row.id).account_key);
      noSecrets(privatePi.binding);
    }finally{fs.rmSync(privatePi.dir,{recursive:true});}
  }
});
test('managed OAuth composes with fixed-parent access-only runtime and passive metric IDs', async () => {
  const f=fixture({fetch:async url=>url.includes('/oauth/token')?json(tokens()):json({rate_limit:{
    primary_window:{used_percent:25,limit_window_seconds:18000},secondary_window:{used_percent:50,limit_window_seconds:604800}}})});
  const row=f.manager.save(config('openai-codex'));await login(f.manager,row);
  const runtime=await f.manager.prepareRuntime(row.id),privatePi=createRuntimeConnection(
    {home:f.home,project:f.root,env:{HOME:f.root}},{agent:'pi',model:'openai-codex/test-model',connection_id:row.id},runtime);
  try{
    const auth=JSON.parse(fs.readFileSync(path.join(privatePi.dir,'auth.json'),'utf8'));
    expect(auth['openai-codex'].refresh).toBe('');expect(auth['openai-codex'].access).toBe(access());
    const query=await f.manager.query(row.id),passive=parseConnectionHeaders('openai-codex',{
      'x-codex-primary-used-percent':'25','x-codex-secondary-used-percent':'50',
      'x-codex-primary-window-minutes':'300','x-codex-secondary-window-minutes':'10080'},200,query.observation.checked_at);
    expect(query.observation.resources.map(r=>r.id)).toEqual(passive.resources.map(r=>r.id));
    expect(query.observation.resources.map(r=>r.window_seconds)).toEqual(passive.resources.map(r=>r.window_seconds));
    expect(query.account_key).toBe(privatePi.binding.account_key);expect(query.source_key).toBe(privatePi.binding.source_key);
  }finally{fs.rmSync(privatePi.dir,{recursive:true});}
});
test('request helper never follows a redirect and aborts non-cooperative transports on stop', async () => {
  const controller=new AbortController(),pending=requestJson('https://example.invalid',{},{fetch:()=>new Promise(()=>{}),signal:controller.signal});controller.abort();
  await expect(pending).rejects.toThrow('Connection operation unavailable');
});

// 连接默认设定只服务运行设置的一键填入，不参与凭证、身份或额度历史。
test('connection default model and thinking persist within the declared range and can be cleared', async () => {
  const { manager } = fixture();
  const row = manager.save(config('deepseek', { models: ['deepseek-chat', 'deepseek-reasoner'],
    default_model: 'deepseek-chat', default_thinking: 'high' }), { api_key: 'private-key' });
  expect(row.default_model).toBe('deepseek-chat'); expect(row.default_thinking).toBe('high');
  expect(manager.config().connections[0]).toMatchObject({ default_model: 'deepseek-chat', default_thinking: 'high' });
  expect(() => manager.save(config('deepseek', { models: ['deepseek-chat'], default_model: 'deepseek-reasoner' }))).toThrow();
  expect(() => manager.save(config('deepseek', { default_thinking: 'ultra' }))).toThrow();
  expect(() => manager.save(config('deepseek', { default_setting: 'untracked' }))).toThrow();
  const cleared = manager.save(edit(row, { default_model: '', default_thinking: '' }), { api_key: '' });
  expect(cleared.default_model).toBe(''); expect(cleared.default_thinking).toBe('');
  expect((await manager.prepareRuntime(row.id)).credential.key).toBe('private-key');
  noSecrets(cleared);
});

// 额度刷新提醒是本地页面偏好：随连接保存但不参与身份/凭证/额度历史。
test('connection notify_reset is a boolean preference that persists and can be cleared', async () => {
  const { manager } = fixture();
  const row = manager.save(config('deepseek', { notify_reset: true }), { api_key: 'private-key' });
  expect(row.notify_reset).toBe(true);
  expect(manager.config().connections[0]).toMatchObject({ notify_reset: true });
  expect(() => manager.save(config('deepseek', { notify_reset: 'yes' }))).toThrow();
  expect(() => manager.save(config('deepseek', { notify_reset: 1 }))).toThrow();
  const cleared = manager.save(edit(row, { notify_reset: false }), { api_key: '' });
  expect(cleared.notify_reset).toBe(false);
});
