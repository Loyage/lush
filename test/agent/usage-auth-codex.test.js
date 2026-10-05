import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCodexUsageCredential } from '../../src/agent/usage-auth-codex.js';
import { discoverAgentUsage } from '../../src/agent/status.js';
import { fixture } from '../helpers.js';

const id = 'mock-account-a';
const access = (account = id, salt = 'new') => `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: account }, salt })).toString('base64url')}.mock`;
const expired = () => ({ type: 'oauth', access: access(id, 'old'), refresh: 'MOCK_PRIVATE_REFRESH', expires: 1, accountId: id, preserved: { metadata: true } });
const reply = (patch = {}) => new Response(JSON.stringify({ access_token: access(), refresh_token: 'MOCK_PRIVATE_ROTATED', expires_in: 3600, ...patch }));
const quota = () => new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 10 } } }));
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function world({ projectPi = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-codex-auth-test-'));
  const configDir = projectPi ? path.join(root, '.lush', 'pi') : root;
  if (projectPi) fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const file = path.join(configDir, 'auth.json');
  const credential = expired();
  const data = { 'openai-codex': credential, deepseek: { type: 'api_key', key: 'MOCK_OTHER_PRIVATE' }, unknown: { nested: ['preserve'] } };
  fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
  return { root, configDir, file, credential, data, read: () => JSON.parse(fs.readFileSync(file, 'utf8')), close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('independent Codex refresh uses fixed public-client wire format and atomically preserves unrelated auth data', async () => {
  const f = world(), originalInode = fs.statSync(f.file).ino;
  try {
    const result = await resolveCodexUsageCredential(f.file, f.credential, { authFetch: async (url, init) => {
      expect(url).toBe('https://auth.openai.com/oauth/token');
      expect(init.method).toBe('POST'); expect(init.redirect).toBe('error');
      expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      expect(Object.fromEntries(init.body)).toEqual({ grant_type: 'refresh_token', refresh_token: 'MOCK_PRIVATE_REFRESH', client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' });
      expect(fs.statSync(f.file + '.lock').isDirectory()).toBe(true);
      return reply();
    } });
    expect(result.error_code).toBeUndefined(); expect(result.credential.access).toBe(access());
    expect(f.read()).toMatchObject({ deepseek: f.data.deepseek, unknown: f.data.unknown,
      'openai-codex': { type: 'oauth', accountId: id, preserved: f.credential.preserved, refresh: 'MOCK_PRIVATE_ROTATED' } });
    expect(f.read()['openai-codex'].expires).toBeGreaterThan(Date.now());
    expect(fs.statSync(f.file).mode & 0o777).toBe(0o600); expect(fs.statSync(f.file).ino).not.toBe(originalInode);
    expect(fs.readdirSync(f.root)).toEqual(['auth.json']);
  } finally { f.close(); }
});

test('same-process callers share a refresh; a later old snapshot reuses the already refreshed same-account token', async () => {
  const f = world(), hold = gate(); let calls = 0;
  try {
    const options = { authFetch: async () => { calls++; await hold.promise; return reply(); } };
    const a = resolveCodexUsageCredential(f.file, f.credential, options), b = resolveCodexUsageCredential(f.file, f.credential, options);
    expect(a).toBe(b); hold.resolve(); await Promise.all([a,b]);
    expect(calls).toBe(1);
    const reused = await resolveCodexUsageCredential(f.file, f.credential, options);
    expect(calls).toBe(1); expect(reused.credential.access).toBe(access());
  } finally { hold.resolve(); f.close(); }
});

test('two real processes sharing the auth store coordinate refresh with the original directory lock', async () => {
  const f = world(), helper = path.join(f.root, 'refresh.mjs'), counter = path.join(f.root, 'calls');
  const module = new URL('../../src/agent/usage-auth-codex.js', import.meta.url).pathname;
  fs.writeFileSync(helper, `import fs from 'node:fs';
import { resolveCodexUsageCredential } from ${JSON.stringify(module)};
const result = await resolveCodexUsageCredential(${JSON.stringify(f.file)}, ${JSON.stringify(f.credential)}, { authFetch: async () => {
  fs.appendFileSync(${JSON.stringify(counter)}, 'request\\n');
  await new Promise(resolve => setTimeout(resolve, 200));
  return new Response(${JSON.stringify(JSON.stringify({ access_token: access(), refresh_token: 'MOCK_PRIVATE_ROTATED', expires_in: 3600 }))});
}});
console.log(result.error_code || 'success');
`);
  try {
    const children = [0,1].map(() => Bun.spawn([process.execPath, helper], { stdout: 'pipe', stderr: 'pipe' }));
    const results = await Promise.all(children.map(async child => [await child.exited, await new Response(child.stdout).text(), await new Response(child.stderr).text()]));
    expect(results).toEqual([[0,'success\n',''],[0,'success\n','']]);
    expect(fs.readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(fs.existsSync(f.file + '.lock')).toBe(false);
  } finally { f.close(); }
});

test('a changed valid login never becomes a stale caller\'s selected account, including while waiting for a lock', async () => {
  for (const when of ['before-query', 'during-lock-wait']) {
    const f = world(); let calls = 0, timer;
    const replacement = { ...expired(), accountId: 'mock-account-b', access: access('mock-account-b'), expires: Date.now() + 3600000 };
    try {
      const replace = () => fs.writeFileSync(f.file, JSON.stringify({ ...f.data, 'openai-codex': replacement }));
      if (when === 'before-query') replace();
      else {
        fs.mkdirSync(f.file + '.lock');
        timer = setTimeout(() => { replace(); fs.rmdirSync(f.file + '.lock'); }, 20);
      }
      const result = await resolveCodexUsageCredential(f.file, f.credential, { authLockTimeout: 200, authFetch: async () => { calls++; return reply(); } });
      expect(result).toEqual({ error_code: 'auth_changed' }); expect(calls).toBe(0);
      expect(f.read()['openai-codex']).toEqual(replacement); expect(fs.existsSync(f.file + '.lock')).toBe(false);
    } finally { clearTimeout(timer); f.close(); }
  }
});

test('external locks including stale ones are never removed or stolen', async () => {
  const f = world(); let calls = 0;
  try {
    fs.mkdirSync(f.file + '.lock'); fs.utimesSync(f.file + '.lock', new Date(0), new Date(0));
    const stat = fs.statSync(f.file + '.lock'), before = fs.readFileSync(f.file, 'utf8');
    const result = await resolveCodexUsageCredential(f.file, f.credential, { authLockTimeout: 10, authFetch: async () => { calls++; return reply(); } });
    expect(result).toEqual({ error_code: 'auth_locked' }); expect(calls).toBe(0);
    expect(fs.statSync(f.file + '.lock').ino).toBe(stat.ino); expect(fs.statSync(f.file + '.lock').mtimeMs).toBe(stat.mtimeMs);
    expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
  } finally { f.close(); }
});

test('held directory heartbeat stays fresh for compatibility with Pi synchronous 10-second stale checks', async () => {
  const f = world();
  try {
    let before;
    const result = await resolveCodexUsageCredential(f.file, f.credential, { authFetch: async () => {
      before = fs.statSync(f.file + '.lock').mtimeMs;
      await new Promise(resolve => setTimeout(resolve, 1150));
      const after = fs.statSync(f.file + '.lock').mtimeMs;
      expect(after).toBeGreaterThan(before); expect(Date.now() - after).toBeLessThan(2000);
      return reply();
    } });
    expect(result.error_code).toBeUndefined(); expect(fs.existsSync(f.file + '.lock')).toBe(false);
  } finally { f.close(); }
});

test('external credential or unrelated-provider writes while refreshing are not overwritten', async () => {
  for (const change of [data => { data['openai-codex'] = { ...expired(), accountId: 'different-login' }; }, data => { data.deepseek.key = 'MOCK_NEW_PRIVATE'; }]) {
    const f = world();
    try {
      let external;
      const result = await resolveCodexUsageCredential(f.file, f.credential, { authFetch: async () => {
        const data = f.read(); change(data); external = JSON.stringify(data); fs.writeFileSync(f.file, external); return reply();
      } });
      expect(result).toEqual({ error_code: 'auth_changed' }); expect(fs.readFileSync(f.file, 'utf8')).toBe(external);
      expect(fs.existsSync(f.file + '.lock')).toBe(false);
    } finally { f.close(); }
  }
});

test('compromised/replaced lock is not removed and refresh results are never written', async () => {
  for (const compromise of [file => fs.utimesSync(file, new Date(0), new Date(0)), file => {
    fs.rmdirSync(file); fs.mkdirSync(file); fs.writeFileSync(path.join(file, 'foreign'), 'foreign owner');
  }]) {
    const f = world(), before = fs.readFileSync(f.file, 'utf8');
    try {
      const result = await resolveCodexUsageCredential(f.file, f.credential, { authFetch: async () => { compromise(f.file + '.lock'); return reply(); } });
      expect(result).toEqual({ error_code: 'auth_locked' }); expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
      expect(fs.existsSync(f.file + '.lock')).toBe(true);
    } finally { f.close(); }
  }
});

test('failed or malformed refresh never writes auth and returns fixed errors without upstream secrets', async () => {
  for (const [fetcher, code] of [
    [async () => new Response('MOCK_PRIVATE_UPSTREAM', {status:401}), 'unauthorized'],
    [async () => new Response('MOCK_PRIVATE_UPSTREAM', {status:403}), 'unauthorized'],
    [async () => new Response('MOCK_PRIVATE_UPSTREAM', {status:429}), 'rate_limited'],
    [async () => new Response('MOCK_PRIVATE_UPSTREAM', {status:400}), 'refresh_failed'],
    [async () => new Response('MOCK_PRIVATE_UPSTREAM'), 'invalid_response'],
    [async () => new Response('x'.repeat(65537)), 'invalid_response'],
    [async () => reply({ expires_in: 0 }), 'invalid_response'],
    [async () => reply({ access_token: 'invalid-token' }), 'invalid_response'],
    [async () => reply({ refresh_token: '' }), 'invalid_response'],
    [async () => reply({ access_token: access('different-account') }), 'auth_changed'],
    [async () => { throw new Error('MOCK_PRIVATE_NETWORK'); }, 'network'],
    [async () => new Promise(() => {}), 'timeout'],
  ]) {
    const f = world(), before = fs.readFileSync(f.file, 'utf8');
    try {
      const result = await resolveCodexUsageCredential(f.file, f.credential, { authFetch: fetcher, authTimeout: 15 });
      expect(result).toEqual({ error_code: code }); expect(JSON.stringify(result)).not.toContain('PRIVATE');
      expect(fs.readFileSync(f.file, 'utf8')).toBe(before); expect(fs.readdirSync(f.root)).toEqual(['auth.json']);
    } finally { f.close(); }
  }
});

test('unsafe file permissions/symlink/hardlink and aliased parent paths reject writes before network calls', async () => {
  for (const mode of ['permissions','symlink','hardlink','parent-alias']) {
    const f = world(); let calls = 0;
    try {
      let authFile = f.file;
      if (mode === 'permissions') fs.chmodSync(f.file, 0o644);
      if (mode === 'symlink') { fs.renameSync(f.file, f.file + '.real'); fs.symlinkSync(f.file + '.real', f.file); }
      if (mode === 'hardlink') fs.linkSync(f.file, f.file + '.link');
      if (mode === 'parent-alias') { fs.symlinkSync(f.root, f.root + '-alias'); authFile = path.join(f.root + '-alias', 'auth.json'); }
      const result = await resolveCodexUsageCredential(authFile, f.credential, { authFetch: async () => { calls++; return reply(); } });
      expect(result).toEqual({ error_code: 'auth_changed' }); expect(calls).toBe(0);
      expect(fs.existsSync(f.file + '.lock')).toBe(false);
    } finally { try { fs.unlinkSync(f.root + '-alias'); } catch {} f.close(); }
  }
});

test('selected Lush-owned Codex refreshes once then uses new bearer without exposing refresh metadata in discovery', async () => {
  const f = world({ projectPi: true }); let authCalls = 0, usageCalls = 0;
  const config = { project: f.root, home: path.join(f.root, '.lush'), env: { PI_CODING_AGENT_DIR: f.root } }, profile = { model:'openai-codex/test', agent:'pi' };
  try {
    const value = await discoverAgentUsage(config, profile, { authFetch: async () => { authCalls++; return reply(); }, fetch: async (url, init) => {
      usageCalls++; expect(url).toBe('https://chatgpt.com/backend-api/wham/usage'); expect(init.headers.Authorization).toBe(`Bearer ${access()}`); return quota();
    } });
    const account = value.accounts.find(row => row.provider === 'openai-codex');
    expect(authCalls).toBe(1); expect(usageCalls).toBe(1); expect(account.status).toBe('configured');
    expect(account.balance.status).toBe('available'); expect(Date.parse(account.expires_at)).toBeGreaterThan(Date.now());
    expect(JSON.stringify(value)).not.toContain('MOCK_PRIVATE'); expect(JSON.stringify(value)).not.toContain(access());
    expect(value.codexAuth).toBeUndefined();
  } finally { f.close(); }
});

test('unselected/proxy/custom/API-key accounts never trigger Codex OAuth refresh', async () => {
  for (const mode of ['unselected','proxy','custom','api-key']) {
    const f = world({ projectPi: true }); let authCalls = 0, usageCalls = 0;
    const config = { project:f.root, home:path.join(f.root,'.lush'), env:{ PI_CODING_AGENT_DIR:f.root } }, profile = { model:'openai-codex/test', agent:'pi' };
    try {
      const usageConfig = { providers:mode === 'unselected' ? ['unknown'] : ['openai-codex'], custom:[] };
      if (mode === 'proxy') fs.writeFileSync(path.join(f.configDir,'models.json'),JSON.stringify({providers:{'openai-codex':{baseUrl:'https://proxy.invalid/'}}}));
      if (mode === 'api-key') fs.writeFileSync(f.file,JSON.stringify({'openai-codex':{type:'api_key',key:'MOCK_PRIVATE_KEY'}}));
      if (mode === 'custom') usageConfig.custom.push({provider:'openai-codex',label:'Custom',url:'https://custom.invalid/',method:'GET',headers:{},body:null,kind:'quota',items:[{id:'remaining',label:'Remaining',unit:'credits',remaining:'remaining'}]});
      const before = fs.readFileSync(f.file,'utf8');
      const value = await discoverAgentUsage(config,profile,{usageConfig,authFetch:async()=>{authCalls++;return reply();},fetch:async()=>{usageCalls++;return new Response('{"remaining":10}');}});
      expect(authCalls).toBe(0); expect(usageCalls).toBe(mode==='custom'?1:0); expect(fs.readFileSync(f.file,'utf8')).toBe(before);
      expect(JSON.stringify(value)).not.toContain('MOCK_PRIVATE');
    } finally { f.close(); }
  }
});

test('explicit read-only discovery neither refreshes expired credentials nor shares an automatic-refresh request', async () => {
  const f = world({ projectPi: true }); let authCalls = 0, usageCalls = 0;
  const config = {project:f.root,home:path.join(f.root,'.lush'),env:{PI_CODING_AGENT_DIR:f.root}}, profile = {model:'openai-codex/test',agent:'pi'};
  const options = { authFetch:async()=>{authCalls++;return reply();}, fetch:async()=>{usageCalls++;return quota();} };
  try {
    const before = fs.readFileSync(f.file,'utf8');
    const readOnly = await discoverAgentUsage(config,profile,{...options,refreshCodex:false});
    expect(authCalls).toBe(0); expect(usageCalls).toBe(0);
    expect(readOnly.accounts.find(row=>row.provider==='openai-codex').balance.error_code).toBe('expired');
    expect(fs.readFileSync(f.file,'utf8')).toBe(before); expect(fs.existsSync(f.file+'.lock')).toBe(false);
    const independentRead = discoverAgentUsage(config,profile,{...options,refreshCodex:false});
    const automatic = discoverAgentUsage(config,profile,options);
    expect(independentRead).not.toBe(automatic);
    const [old,newResult] = await Promise.all([independentRead,automatic]);
    expect(old.accounts.find(row=>row.provider==='openai-codex').balance.status).toBe('error');
    expect(newResult.accounts.find(row=>row.provider==='openai-codex').balance.status).toBe('available');
    expect(authCalls).toBe(1); expect(usageCalls).toBe(1);
  } finally { f.close(); }
});

test('OAuth unauthorized usage does not trigger a second refresh or retry', async () => {
  const f = world({ projectPi: true }); let authCalls = 0, usageCalls = 0;
  try {
    const config = {project:f.root,home:path.join(f.root,'.lush'),env:{PI_CODING_AGENT_DIR:f.root}};
    const value = await discoverAgentUsage(config,{model:'openai-codex/test',agent:'pi'}, {authFetch:async()=>{authCalls++;return reply();},fetch:async()=>{usageCalls++;return new Response('MOCK_PRIVATE',{status:403});}});
    expect(authCalls).toBe(1); expect(usageCalls).toBe(1); expect(value.accounts.find(row=>row.provider==='openai-codex').balance.error_code).toBe('unauthorized');
  } finally { f.close(); }
});

test('project shutdown drains an in-flight independent refresh and its sanitized observation', async () => {
  const f = fixture(), hold = gate(), entered = gate();
  const configDir = path.join(f.config.home, 'pi'); fs.mkdirSync(configDir, { mode: 0o700 });
  const authFile = path.join(configDir, 'auth.json'); fs.writeFileSync(authFile,JSON.stringify({'openai-codex':expired()}),{mode:0o600});
  f.config.env.PI_CODING_AGENT_DIR = f.root;
  f.project.agentUsage.discoverUsage = (config,profile,options) => discoverAgentUsage(config,{...profile,model:'openai-codex/test'}, {...options,
    authFetch:async()=>{entered.resolve();await hold.promise;return reply();},fetch:async()=>quota()});
  try {
    const pending = f.project.agentUsage.query(false); await entered.promise;
    let stopped = false; const stop = f.project.shutdown().then(()=>{stopped=true;}); await Promise.resolve(); expect(stopped).toBe(false);
    hold.resolve(); await pending; await stop; expect(stopped).toBe(true);
    expect(f.store.get('SELECT COUNT(*) AS n FROM agent_usage_queries').n).toBe(1);
    expect(fs.existsSync(authFile+'.lock')).toBe(false); expect(JSON.parse(fs.readFileSync(authFile,'utf8'))['openai-codex'].access).toBe(access());
  } finally { hold.resolve(); await f.close(); }
});
