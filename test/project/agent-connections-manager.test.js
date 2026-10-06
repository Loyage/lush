import { test, expect } from 'bun:test';
import { fixture, gate } from '../helpers.js';
import { AgentConnectionsService } from '../../src/core/agent-connections.js';
import { parseConnectionHeaders } from '../../src/agent/connection-runtime.js';
import { ConnectionManager } from '../../src/agent/connections.js';

const START = Date.parse('2026-01-10T12:00:00.000Z');
const configuration = (provider = 'deepseek', extra = {}) => ({ label: '测试账号', provider,
  auth_type: provider === 'openai-codex' ? 'oauth' : 'api_key', models: [], ...extra });
const count = f => f.store.get('SELECT COUNT(*) AS n FROM agent_connection_queries').n;
function setup(fetch) {
  const f = fixture(); let now = START;
  const service = new AgentConnectionsService(f.project, { now: () => now, managerOptions: { fetch, now: () => now } });
  f.project.agentConnections = service;
  return { ...f, service, advance(ms) { now += ms; }, now: () => now };
}
function noSecrets(value) {
  for (const secret of ['private-key', 'replacement-key', 'private-refresh', 'private-code', 'account-private'])
    expect(JSON.stringify(value)).not.toContain(secret);
}
const balance = value => Response.json({ balance_infos: [{ currency: 'USD', total_balance: value }] });
const tokens = (refresh = 'private-refresh') => ({
  access_token: `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-private' } })).toString('base64url')}.signature`,
  refresh_token: refresh, expires_in: 3600,
});

test('real Manager loads lazily; project list preserves all allowed models and labels without networking', async () => {
  let requests = 0;
  const f = setup(async () => { requests++; throw new Error('must not fetch'); });
  try {
    expect(f.service.manager).toBeNull(); expect(f.service.list().connections).toEqual([]);
    const models = Array.from({ length: 100 }, (_, i) => `model-${i}`), label = 'a'.repeat(200);
    const row = await f.service.save(configuration('deepseek', { models, label }), { api_key: 'private-key' });
    expect(row.models).toEqual(models); expect(row.label).toBe(label);
    expect(f.service.list().connections[0].models).toEqual(models);
    expect(f.service.list().connections[0].label).toBe(label);
    expect(f.service.list().connections[0].observation.status).toBe('unknown');
    expect(f.service.list().sampling.enabled).toBe(false); expect(requests).toBe(0);
    noSecrets(f.service.list());
  } finally { await f.close(); }
});

test('real Manager defaults survive service save/list/config and full-config label/enabled edits', async () => {
  let requests = 0;
  const f = setup(async () => { requests++; throw new Error('must not fetch'); });
  let reader;
  try {
    const defaults = { default_model: 'gpt-6.1-sol', default_thinking: 'xhigh' };
    const row = await f.service.save(configuration('openai-codex', { models: ['gpt-6.1-sol'], ...defaults }));
    expect(row).toMatchObject(defaults);
    expect(f.service.config().connections[0]).toMatchObject(defaults);
    expect(f.service.list().connections[0]).toMatchObject(defaults);
    // As in the editor/bulk save, send only the public configuration fields.
    const { credential, observation, last_success, consumers, ...editable } = f.service.list().connections[0];
    expect(await f.service.save({ ...editable, label: '重命名账号', enabled: false })).toMatchObject({ ...defaults, label: '重命名账号', enabled: false });
    expect(await f.service.save({ ...editable, label: '再次启用', enabled: true })).toMatchObject(defaults);
    reader = new ConnectionManager(f.project.config, { now: f.now });
    expect(reader.config().connections[0]).toMatchObject({ ...defaults, label: '再次启用', enabled: true });
    const reread = new AgentConnectionsService(f.project, { manager: reader, now: f.now });
    expect(reread.list().connections[0]).toMatchObject(defaults);
    expect(requests).toBe(0); noSecrets(f.service.list());
    expect(f.store.get('SELECT COUNT(*) AS n FROM events').n).toBe(0);
  } finally { await reader?.stop(); await f.close(); }
});

test('real Manager default-only edits preserve account/source identity and a single observation history', async () => {
  const f = setup(async () => balance(20));
  try {
    const row = await f.service.save(configuration('deepseek', { models: ['deepseek-chat', 'deepseek-reasoner'],
      default_model: 'deepseek-chat', default_thinking: 'low' }), { api_key: 'private-key' });
    await f.service.query(row.id);
    const before = f.service.manager.identity(row.id);
    const { credential, ...editable } = f.service.config().connections[0];
    expect(await f.service.save({ ...editable, default_model: 'deepseek-reasoner', default_thinking: 'high' })).toMatchObject({
      default_model: 'deepseek-reasoner', default_thinking: 'high' });
    const after = f.service.manager.identity(row.id);
    expect(after.account_key).toBe(before.account_key); expect(after.source_key).toBe(before.source_key);
    f.advance(1000); await f.service.query(row.id);
    const history = f.service.history(row.id);
    expect(history.series).toHaveLength(1); expect(history.series[0].sample_count).toBe(2);
    expect(count(f)).toBe(2); noSecrets(history); noSecrets(f.service.list());
    expect(await f.service.save({ ...editable, default_model: '', default_thinking: '' })).toMatchObject({ default_model: '', default_thinking: '' });
    expect(f.service.manager.config().connections[0]).toMatchObject({ default_model: '', default_thinking: '' });
  } finally { await f.close(); }
});

test('real private-file key edits hide cache and consumers, reject late queries and passive feedback, preserve isolated history', async () => {
  const entered = gate(), blocked = gate(); let requests = 0;
  const f = setup(async (_url, init) => {
    requests++;
    if (requests === 2) { entered.resolve(); await blocked.promise; }
    return balance(init.headers.Authorization === 'Bearer replacement-key' ? 9 : 20);
  });
  try {
    const row = await f.service.save(configuration(), { api_key: 'private-key' });
    await f.service.query(row.id); const runtime = await f.service.prepareRuntime(row.id);
    f.project.running.set(10, { agent: { model: 'deepseek/deepseek-chat' }, connectionBinding: { id: row.id,
      account_key: runtime.account_key, source_key: runtime.source_key } });
    expect(f.service.list().connections[0].consumers).toHaveLength(1);
    f.advance(1000); const old = f.service.query(row.id); await entered.promise;
    f.service.manager.file.transaction(data => { data.connections[0].credential.key = 'replacement-key'; });
    const local = f.service.list().connections[0];
    expect(local.observation.status).toBe('unknown'); expect(local.last_success).toBeNull(); expect(local.consumers).toEqual([]);
    f.advance(1000); await f.service.query(row.id); blocked.resolve(); await old;
    expect(requests).toBe(3); expect(count(f)).toBe(2);
    expect(f.service.list().connections[0].observation.resources[0].remaining).toBe(9);
    await expect(f.service.observe(row.id, runtime.account_key, runtime.source_key, {
      status: 'available', source: 'response_headers', resources: [],
    })).rejects.toThrow('identity changed');
    const history = f.service.history(row.id);
    expect(history.series).toHaveLength(2); expect(new Set(history.series.map(s => s.account_key)).size).toBe(2);
    noSecrets(history); noSecrets(f.service.list());
    f.project.running.clear(); await f.service.remove(row.id);
    expect(f.service.history(row.id).series).toHaveLength(2);
  } finally { blocked.resolve(); f.project.running.clear(); await f.close(); }
});

test('real OpenRouter partial query preserves key budget; later failure shows separately timed success', async () => {
  let failure = false, requests = 0;
  const f = setup(async url => {
    requests++;
    if (url.endsWith('/credits') || failure) return new Response('private-key upstream diagnostic', { status: 403 });
    return Response.json({ data: { limit: 100, limit_remaining: 75, usage: 400, usage_daily: 3, limit_reset: 'monthly' } });
  });
  try {
    const row = await f.service.save(configuration('openrouter'), { api_key: 'private-key' });
    const first = (await f.service.query(row.id)).connections[0];
    expect(first.observation.status).toBe('partial'); expect(first.observation.error_code).toBe('unauthorized');
    expect(first.observation.resources.find(r => r.id === 'key-budget')).toMatchObject({ remaining: 75, used: 25, scope: 'key' });
    failure = true; f.advance(1000);
    const second = (await f.service.query(row.id)).connections[0];
    expect(second.observation.status).toBe('error'); expect(second.observation.resources).toEqual([]);
    expect(second.last_success.checked_at).toBe(new Date(START).toISOString());
    expect(second.last_success.observation.status).toBe('partial'); expect(requests).toBe(4);
    expect(f.service.history(row.id).series.find(s => s.scope === 'key' && s.points[0].remaining === 75).points.map(p => p.status)).toEqual(['available', 'error']);
    noSecrets(second); noSecrets(f.service.history(row.id));
  } finally { await f.close(); }
});

test('real OAuth login and coordinated refresh retain same-account history and accept runtime header observations', async () => {
  let exchanges = 0, refreshes = 0;
  const f = setup(async (url, init) => {
    if (url === 'https://auth.openai.com/oauth/token') {
      if (init.body.get('grant_type') === 'refresh_token') refreshes++; else exchanges++;
      return Response.json(tokens(refreshes ? 'rotated-private-refresh' : undefined));
    }
    return Response.json({ rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18000, reset_after_seconds: 3600 } } });
  });
  try {
    const row = await f.service.save(configuration('openai-codex'));
    const login = await f.service.loginStart(row.id), state = new URL(login.url).searchParams.get('state');
    await f.service.loginFinish(row.id, login.login_id, `${login.redirect_uri}?code=private-code&state=${state}`);
    await f.service.query(row.id); const before = f.service.manager.identity(row.id);
    f.advance(3590 * 1000); const runtime = await f.service.prepareRuntime(row.id), after = f.service.manager.identity(row.id);
    expect(exchanges).toBe(1); expect(refreshes).toBe(1);
    expect(after.revision).not.toBe(before.revision); expect(after.account_key).toBe(before.account_key);
    expect(f.service.list().connections[0].observation.status).toBe('available');
    const observation = parseConnectionHeaders('openai-codex', { 'x-codex-primary-used-percent': '25', 'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-after-seconds': '3600' }, 200, new Date(f.now()).toISOString());
    expect(await f.service.observe(row.id, runtime.account_key, runtime.source_key, observation)).toEqual({ recorded: true });
    const history = f.service.history(row.id);
    expect(history.series).toHaveLength(1); expect(history.series[0].sample_count).toBe(2);
    expect(history.series[0].points.map(p => p.source)).toEqual(['usage_api', 'response_headers']);
    expect(f.store.get('SELECT COUNT(*) AS n FROM events').n).toBe(0);
    noSecrets(f.service.list()); noSecrets(history);
  } finally { await f.close(); }
});

test('real device login actions save once behind project write admission without querying or audit secrets', async () => {
  const requests=[];const f=setup(async (url,init)=>{
    requests.push({url,init});
    if(url.endsWith('/usercode'))return Response.json({device_auth_id:'private-device',user_code:'ABCD-EFGH',interval:5});
    if(url.endsWith('/deviceauth/token'))return Response.json({authorization_code:'private-code',code_verifier:'private-verifier'});
    return Response.json(tokens());
  });
  try {
    const row=await f.service.save(configuration('openai-codex'));
    f.project.clearing=true;await expect(f.service.deviceStart(row.id)).rejects.toThrow('clear is in progress');expect(requests).toHaveLength(0);f.project.clearing=false;
    const started=await f.project.startConnectionDeviceLogin(row.id);expect(started.user_code).toBe('ABCD-EFGH');expect(requests).toHaveLength(1);
    expect((await f.project.pollConnectionDeviceLogin(row.id,started.login_id)).status).toBe('pending');expect(requests).toHaveLength(1);
    f.advance(5000);const complete=await f.project.pollConnectionDeviceLogin(row.id,started.login_id);expect(complete.status).toBe('complete');
    const state=f.service.snapshot(row.id).state.revision;
    expect(await f.service.devicePoll(row.id,started.login_id)).toEqual(complete);expect(f.service.snapshot(row.id).state.revision).toBe(state);
    expect(requests.map(r=>r.url)).toEqual(['https://auth.openai.com/api/accounts/deviceauth/usercode','https://auth.openai.com/api/accounts/deviceauth/token','https://auth.openai.com/oauth/token']);
    expect(f.service.list().connections[0].credential.status).toBe('configured');expect(count(f)).toBe(0);
    expect(f.store.get('SELECT COUNT(*) AS n FROM events').n).toBe(0);noSecrets(complete);noSecrets(f.service.list());
    expect(await f.project.cancelConnectionDeviceLogin(row.id,started.login_id)).toEqual({id:row.id,login_id:started.login_id,status:'cancelled'});
  } finally {f.project.clearing=false;await f.close();}
});

test('real device stop aborts pending authorization without leaving project writes or saving credentials',async()=>{
  const entered=gate();let aborted=false;
  const f=setup(async(url,init)=>{
    if(url.endsWith('/usercode'))return Response.json({device_auth_id:'private-device',user_code:'ABCD-EFGH',interval:5});
    entered.resolve();return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>{aborted=true;reject(new Error('private-device'));},{once:true}));
  });
  try {
    const row=await f.service.save(configuration('openai-codex')),login=await f.service.deviceStart(row.id);f.advance(5000);
    const result=f.service.devicePoll(row.id,login.login_id).then(value=>({value}),error=>({error}));await entered.promise;
    await f.project.shutdown();expect(aborted).toBe(true);expect((await result).error.message).not.toContain('private-device');
    expect(f.project.writing).toBe(0);expect(f.service.pending.size).toBe(0);expect(f.service.manager.devices.sessions.size).toBe(0);
  } finally {await f.close();}
});

test('real Manager shutdown cancels a pending request before project Store closes', async () => {
  const entered = gate(); let aborted = false;
  const f = setup(async (_url, init) => {
    entered.resolve();
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('private-key')); }, { once: true }));
  });
  try {
    const row = await f.service.save(configuration(), { api_key: 'private-key' });
    const query = f.service.query(row.id).then(value => ({ value }), error => ({ error })); await entered.promise;
    await f.project.shutdown(); expect(aborted).toBe(true);
    expect((await query).error.message).toContain('stopping'); expect(f.service.pending.size).toBe(0);
  } finally { await f.close(); }
});
