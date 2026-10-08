import { test, expect } from 'bun:test';
import { fixture, gate } from '../helpers.js';
import { AgentConnectionsService } from '../../src/core/agent-connections.js';
import { THINKING_LEVELS } from '../../src/agent/settings.js';
import { install, ManagerStub, connection, observation, resource, digest, timers, iso } from './agent-connection-fixture.js';

const count = f => f.store.get('SELECT COUNT(*) AS n FROM agent_connection_queries').n;

test('managed list is local-only, whitelisted, unknown not zero; consumers require explicit active bindings', async () => {
  const f = fixture(), { manager, service } = install(f);
  try {
    let reads = 0; manager.query = () => { reads++; throw new Error('must not query'); };
    const binding = { id: 'conn-one', ...manager.identity('conn-one') };
    f.project.running.set(10,{ agent: { connection_id: 'conn-one', model: 'deepseek/chat' }, connectionBinding: binding, controller: new AbortController() });
    f.project.running.set(11,{ agent: { connection_id: 'conn-one', model: 'deepseek/chat' }, controller: new AbortController() });
    f.project.running.set(12,{ agent: { connection_id: 'conn-one', model: 'deepseek/chat' }, connectionBinding: binding, parked: true });
    const dead = new AbortController(); dead.abort();
    f.project.running.set(13,{ agent: { connection_id: 'conn-one' }, connectionBinding: binding, controller: dead });
    const list = f.project.agentConnectionsList();
    expect(list.version).toBe(1); expect(list.sampling.enabled).toBe(false);
    expect(list.connections[0].observation.status).toBe('unknown'); expect(list.connections[0].observation.resources).toEqual([]);
    expect(list.connections[0].consumers).toEqual([{task_id:10,task_worker_number:null,model:'deepseek/chat'}]);
    expect(JSON.stringify(list)).not.toContain('MUST_NOT_RETURN'); expect(reads).toBe(0); expect(count(f)).toBe(0);
    expect(() => service.history('conn-one',2)).toThrow(); expect(() => service.history('../private',7)).toThrow();
  } finally { f.project.running.clear(); await f.close(); }
});

test('default projection is a bounded whitelist and uses the Provider Pi thinking levels', async () => {
  const f = fixture(), { manager, service } = install(f);
  try {
    const raw = manager.connections[0];
    Object.assign(raw, { models: ['vendor/model'], default_model: ' vendor/model ', api_key: 'MUST_NOT_RETURN',
      revision: 'MUST_NOT_RETURN', arbitrary: { token: 'MUST_NOT_RETURN' } });
    raw.credential.access_token = 'MUST_NOT_RETURN';
    for (const level of THINKING_LEVELS.pi) {
      manager.connections = [raw];
      raw.default_thinking = level;
      const view = service.config().connections[0];
      expect(view.default_model).toBe('vendor/model'); expect(view.default_thinking).toBe(level);
      expect(Object.keys(view).sort()).toEqual(['id','label','provider','endpoint','auth_type','enabled','models','default_model','default_thinking','notify_reset','credential'].sort());
      expect(view.notify_reset).toBe(false);
      expect(JSON.stringify(service.list())).not.toContain('MUST_NOT_RETURN');
      const saved = await service.save({ ...raw, default_model: 'vendor/model' });
      expect(saved).toMatchObject({ default_model: 'vendor/model', default_thinking: level });
      expect(JSON.stringify(saved)).not.toContain('MUST_NOT_RETURN');
    }
    for (const empty of [undefined, null, '']) {
      manager.connections[0].default_model = empty; manager.connections[0].default_thinking = empty;
      expect(service.config().connections[0]).toMatchObject({ default_model: '', default_thinking: '' });
    }
  } finally { await f.close(); }
});

test('malformed defaults fail safely rather than exposing or silently changing untrusted values', async () => {
  const f = fixture(), { manager, service } = install(f);
  try {
    const invalid = [
      { default_thinking: 'MUST_NOT_RETURN' }, { default_thinking: { token: 'MUST_NOT_RETURN' } },
      { default_model: { api_key: 'MUST_NOT_RETURN' } }, { default_model: 'MUST_NOT_RETURN\n' },
      { default_model: 'MUST_NOT_RETURN\u202e' }, { default_model: 'x'.repeat(257) },
      { default_model: '中'.repeat(86) }, { models: ['allowed'], default_model: 'MUST_NOT_RETURN' },
    ];
    for (const patch of invalid) {
      manager.connections = [connection(patch)];
      expect(() => service.config()).toThrow('连接操作失败');
      expect(() => service.list()).toThrow('连接操作失败');
      const result = await service.save(connection(patch)).then(() => null, error => error);
      expect(result.message).toContain('连接操作失败'); expect(result.message).not.toContain('MUST_NOT_RETURN');
    }
  } finally { await f.close(); }
});

test('query is single-flight, persists each real observation once, and returns old success separately after failure', async () => {
  const f = fixture(), blocked = gate(), entered = gate(), { manager, service } = install(f);
  manager.onQuery = async (_id,result) => { entered.resolve(); await blocked.promise; return result; };
  try {
    const one = service.query('conn-one'), two = service.query(); await entered.promise;
    expect(manager.calls).toBe(1); blocked.resolve(); await Promise.all([one,two]); expect(count(f)).toBe(1);
    manager.onQuery = null; manager.result = observation({status:'error',checked_at:iso(0),resources:[],error_code:'network',reason:'SECRET upstream text'});
    const result = await service.query();
    expect(result.connections[0].observation.status).toBe('error'); expect(result.connections[0].last_success.checked_at).toBe(iso(-1000));
    expect(result.connections[0].last_success.observation.resources[0].remaining).toBe(70);
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(service.history('conn-one',1).series[0].points.map(point => point.status)).toEqual(['available','error']);
    expect(f.store.get('SELECT COUNT(*) AS n FROM agent_usage_queries').n).toBe(0);
    expect(service.pending.size).toBe(0); expect(service.flights.size).toBe(0);
  } finally { blocked.resolve(); await f.close(); }
});

test('save during query drops late old credentials, separates subsequent account history and invalidates display', async () => {
  const f = fixture(), blocked = gate(), entered = gate(), { manager, service } = install(f);
  try {
    await service.query();
    manager.onQuery = async (_id,result) => { entered.resolve(); await blocked.promise; return result; };
    const old = service.query(); await entered.promise;
    await service.save({ ...connection(), credential: undefined },{api_key:'replacement-secret'});
    expect(service.list().connections[0].observation.status).toBe('unknown');
    blocked.resolve(); await old; expect(count(f)).toBe(1);
    manager.onQuery = null; await service.query(); expect(count(f)).toBe(2);
    const result = service.history('conn-one'); expect(result.series).toHaveLength(2);
    expect(new Set(result.series.map(item => item.account_key)).size).toBe(2);
    expect(JSON.stringify(result)).not.toContain('replacement-secret');
  } finally { blocked.resolve(); await f.close(); }
});

test('private identity changes hide old cache immediately and prevent reused single-flight or late results', async () => {
  const f = fixture(), blocked = gate(), entered = gate(), { manager, service } = install(f);
  try {
    await service.query();
    const runtime = await service.prepareRuntime('conn-one');
    f.project.running.set(20,{ agent:{connection_id:'conn-one',model:'deepseek/chat'}, connectionBinding:{id:'conn-one',account_key:runtime.account_key,source_key:runtime.source_key} });
    expect(service.list().connections[0].consumers).toHaveLength(1);
    manager.onQuery = async (_id,result) => { entered.resolve(); await blocked.promise; return result; };
    const old = service.query(); await entered.promise;
    // Simulate a private-file change outside the service with identical public fields.
    manager.keys.set('conn-one','external-replacement-secret');
    const local = service.list().connections[0];
    expect(local.observation.status).toBe('unknown'); expect(local.last_success).toBeNull(); expect(local.consumers).toEqual([]);
    manager.onQuery = null; await service.query(); expect(manager.calls).toBe(3);
    blocked.resolve(); await old;
    expect(count(f)).toBe(2); expect(service.history('conn-one').series).toHaveLength(2);
    await expect(service.observe('conn-one',runtime.account_key,runtime.source_key,observation({source:'response_headers'}))).rejects.toThrow('identity changed');
    expect(JSON.stringify(service.list())).not.toContain('external-replacement-secret');
  } finally { blocked.resolve(); f.project.running.clear(); await f.close(); }
});

test('private API revision changes reject old queries even if account/source remain unchanged', async () => {
  const f = fixture(), blocked = gate(), entered = gate(), { manager, service } = install(f);
  manager.onQuery = async (_id,result) => { entered.resolve(); await blocked.promise; return result; };
  try {
    const old = service.query(); await entered.promise;
    manager.revisions.set('conn-one',1);
    manager.onQuery = null; await service.query(); expect(manager.calls).toBe(2);
    blocked.resolve(); await old;
    expect(count(f)).toBe(1); expect(service.history('conn-one').series[0].sample_count).toBe(1);
  } finally { blocked.resolve(); await f.close(); }
});

test('OAuth refresh revision changes preserve account/source curves and accept refreshed query/runtime identity', async () => {
  const f = fixture(), manager = new ManagerStub([connection({provider:'openai-codex',auth_type:'oauth',endpoint:'https://chatgpt.com/backend-api'})]);
  const { service } = install(f,{manager});
  try {
    await service.query(); const cached = service.list().connections[0].observation;
    manager.revisions.set('conn-one',1);
    expect(service.list().connections[0].observation).toEqual(cached);
    manager.onQuery = async (_id,result) => { manager.revisions.set('conn-one',2); return result; };
    await service.query(); expect(count(f)).toBe(2); expect(service.history('conn-one').series).toHaveLength(1);
    const original = manager.prepareRuntime.bind(manager);
    manager.prepareRuntime = async id => { const result = await original(id); manager.revisions.set(id,3); return result; };
    const runtime = await service.prepareRuntime('conn-one');
    manager.revisions.set('conn-one',4);
    expect(await service.observe('conn-one',runtime.account_key,runtime.source_key,observation({source:'response_headers'}))).toEqual({recorded:true});
    expect(service.history('conn-one').series).toHaveLength(1);
  } finally { await f.close(); }
});

test('runtime preparation rejects changing identity before exposing private credentials', async () => {
  const f = fixture(), { manager, service } = install(f), original = manager.prepareRuntime.bind(manager);
  manager.prepareRuntime = async id => { const result = await original(id); manager.keys.set(id,'replacement-secret'); return result; };
  try {
    await expect(service.prepareRuntime('conn-one')).rejects.toThrow('连接操作失败');
    expect(service.bindings.size).toBe(0); expect(count(f)).toBe(0);
    expect(JSON.stringify(service.list())).not.toContain('replacement-secret');
  } finally { await f.close(); }
});

test('removed connections keep historical curves but cannot receive a late active query result', async () => {
  const f = fixture(), entered = gate(), blocked = gate(), { manager, service } = install(f);
  try {
    await service.query();
    manager.onQuery = async (_id,result) => { entered.resolve(); await blocked.promise; return result; };
    const old = service.query(); await entered.promise; await service.remove('conn-one');
    blocked.resolve(); await old;
    expect(count(f)).toBe(1); expect(service.list().connections).toEqual([]);
    expect(service.history('conn-one').series).toHaveLength(1);
    expect(() => service.query('conn-one')).toThrow('not found');
  } finally { blocked.resolve(); await f.close(); }
});

test('partial success remains usable and missing individual metrics produce gaps instead of zero', async () => {
  const f = fixture(), { manager, service } = install(f);
  try {
    manager.result = observation({resources:[resource(),resource(10,{id:'credits',kind:'balance',unit:'USD'})]}); await service.query();
    manager.result = observation({status:'partial',checked_at:iso(0),resources:[resource(60)],error_code:'unauthorized'});
    const result = await service.query(); expect(result.connections[0].observation.status).toBe('partial');
    expect(result.connections[0].observation.resources[0].remaining).toBe(60);
    expect(result.connections[0].last_success).toBeNull();
    const series = service.history('conn-one').series;
    expect(series.find(item => item.kind === 'balance').points.at(-1).remaining).toBeNull();
    expect(series.find(item => item.kind === 'balance').points.at(-1).status).toBe('unknown');
    expect(series.find(item => item.kind === 'quota').points.at(-1).status).toBe('available');
  } finally { await f.close(); }
});

test('query fan-out is limited and one failed provider does not erase other connections', async () => {
  const f = fixture(), blocked = gate(), three = gate();
  const manager = new ManagerStub(Array.from({length:8},(_,index) => connection({id:`conn-${index}`})));
  const { service } = install(f,{manager}); let active = 0, max = 0;
  manager.onQuery = async (id,result) => {
    active++; max=Math.max(max,active); if (active===3) three.resolve();
    await blocked.promise; active--;
    if (id==='conn-2') throw new Error('SECRET provider exception');
    return result;
  };
  try {
    const query = service.query(); await three.promise; expect(manager.calls).toBe(3);
    blocked.resolve(); const result = await query;
    expect(max).toBe(3); expect(manager.calls).toBe(8); expect(count(f)).toBe(8);
    expect(result.connections.filter(item => item.observation.status==='available')).toHaveLength(7);
    expect(result.connections.find(item => item.id==='conn-2').observation.status).toBe('error');
    expect(JSON.stringify(result)).not.toContain('SECRET');
  } finally { blocked.resolve(); await f.close(); }
});

test('prepareRuntime is internal-only; passive observations reject changed account/endpoint or removed connections', async () => {
  const f = fixture(), { manager, service } = install(f);
  try {
    expect(() => service.observe('conn-one',digest('bogus'),digest('source'),observation())).toThrow('frozen');
    const runtime = await service.prepareRuntime('conn-one'); expect(runtime.credential.key).toBe('test-secret');
    const passive = observation({source:'response_headers',checked_at:iso(-500)});
    expect(await service.observe('conn-one',runtime.account_key,runtime.source_key,passive)).toEqual({recorded:true});
    expect(await service.observe('conn-one',runtime.account_key,runtime.source_key,passive)).toEqual({recorded:false});
    expect(service.list().connections[0].observation.source).toBe('response_headers');
    await service.save(connection(),{api_key:'new-secret'}); await service.query();
    await expect(service.observe('conn-one',runtime.account_key,runtime.source_key,{...passive,checked_at:iso(0)})).rejects.toThrow('identity changed');
    expect(service.list().connections[0].observation.source).toBe('usage_api');
    expect(service.history('conn-one').series).toHaveLength(2);
    const newer = await service.prepareRuntime('conn-one');
    manager.connections[0].endpoint = 'https://proxy.example.invalid/v1';
    await expect(service.observe('conn-one',newer.account_key,newer.source_key,{...passive,checked_at:iso(100)})).rejects.toThrow('identity changed');
    await service.remove('conn-one');
    expect(() => service.observe('conn-one',runtime.account_key,runtime.source_key,{...passive,checked_at:iso(500)})).toThrow('frozen');
    expect(service.list().connections).toEqual([]);
  } finally { await f.close(); }
});

test('sampling is opt-in; disabling in-flight prevents reschedule; restart only schedules future work', async () => {
  const f = fixture(), clock = timers(), entered = gate(), blocked = gate(), { manager, service } = install(f,clock);
  manager.onQuery = async (_id,result) => { entered.resolve(); await blocked.promise; return result; };
  try {
    service.start(); expect(clock.waiting.size).toBe(0);
    await service.configureSampling({enabled:true,interval_minutes:5,retention_days:90});
    expect([...clock.waiting.values()][0].ms).toBe(300000);
    const tick=clock.fire(); await entered.promise;
    await service.configureSampling({enabled:false,interval_minutes:5,retention_days:90});
    blocked.resolve(); await tick; expect(clock.waiting.size).toBe(0); expect(manager.calls).toBe(1);
    manager.onQuery=null; await service.configureSampling({enabled:true,interval_minutes:10,retention_days:90});
    const newer = new AgentConnectionsService(f.project,{...clock,manager}); newer.start();
    expect(manager.calls).toBe(1); expect(clock.waiting.size).toBe(2);
    await newer.stop(); await service.stop(); expect(clock.waiting.size).toBe(0);
    expect(() => service.query()).toThrow('stopping');
  } finally { blocked.resolve(); await f.close(); }
});

test('shutdown cancels manager work and rejects queued requests, waiting before Store closes', async () => {
  const f = fixture(), blocked = gate(), entered = gate();
  const manager = new ManagerStub(Array.from({length:8},(_,index) => connection({id:`conn-${index}`})));
  const { service } = install(f,{manager});
  manager.onQuery=async (_id,result) => { entered.resolve(); await blocked.promise; return result; };
  manager.stop=async () => { manager.stops++; blocked.resolve(); };
  try {
    const query=service.query(); const received=query.then(value=>({value}),error=>({error})); await entered.promise;
    await f.project.shutdown(); expect((await received).error.message).toContain('stopping');
    expect(service.pending.size).toBe(0); expect(service.active).toBe(0); expect(service.waiters).toHaveLength(0);
    expect(manager.calls).toBeLessThanOrEqual(3); expect(manager.stops).toBe(1);
  } finally { blocked.resolve(); await f.close(); }
});

test('login management projects only authorization metadata; callback and failures never enter events or read views', async () => {
  const f=fixture(), manager=new ManagerStub([connection({provider:'openai-codex',auth_type:'oauth',endpoint:'https://chatgpt.com/backend-api'})]);
  const { service }=install(f,{manager});
  try {
    const started=await service.loginStart('conn-one'); expect(started.login_id).toBe('test-login');
    expect(JSON.stringify(started)).not.toContain('MUST_NOT_RETURN');
    expect(await service.loginFinish('conn-one','test-login','http://localhost:1455/auth/callback?code=SECRET&state=fixture')).toMatchObject({id:'conn-one'});
    expect(JSON.stringify(service.list())).not.toContain('SECRET');
    expect(f.store.get('SELECT COUNT(*) AS n FROM events').n).toBe(0);
    manager.loginFinish=async () => { throw new Error('SECRET refresh token'); };
    await expect(service.loginFinish('conn-one','test-login','secret-callback')).rejects.toThrow('连接操作失败');
    manager.loginStart=async () => ({...started,url:'https://attacker.invalid/login?token=SECRET'});
    await expect(service.loginStart('conn-one')).rejects.toThrow('连接操作失败');
  } finally {await f.close();}
});

test('clear gate protects all mutation/query admissions and broken local config fails safely without rewriting', async () => {
  const f=fixture(), {manager,service}=install(f);
  try {
    f.project.clearing=true;
    await expect(service.save(connection(),{api_key:'SECRET'})).rejects.toThrow('clear');
    await expect(service.query()).rejects.toThrow('连接操作失败');
    f.project.clearing=false;
    manager.config=() => {throw new Error('SECRET broken json');};
    expect(() => service.list()).toThrow('连接操作失败');
    service.start(); expect(service.warning).toContain('无法安全读取');
  } finally {f.project.clearing=false; await f.close();}
});
