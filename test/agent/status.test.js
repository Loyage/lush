import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverAgentStatus as queryStatus } from '../../src/agent/status.js';
// Never send fixture OAuth/API credentials over the network, even in discovery-only tests.
const discoverAgentStatus = (config, profile, options = {}) => queryStatus(config, profile, { fetch: async () => new Response('', { status: 401 }), ...options });
import { queryAccountBalance } from '../../src/agent/status-accounts.js';

function json(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
}
function world({ sdk = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-agent-status-test-'));
  const piDir = path.join(root, 'pi'), configDir = path.join(root, 'config'), home = path.join(root, '.lush');
  fs.mkdirSync(path.join(piDir, 'dist', 'core'), { recursive: true }); fs.mkdirSync(configDir); fs.mkdirSync(home);
  json(path.join(piDir, 'package.json'), { name: '@earendil-works/pi-coding-agent', version: '9.1.2' });
  const command = path.join(piDir, 'pi');
  fs.writeFileSync(command, `#!${process.execPath}
import fs from 'node:fs';
if (process.argv.slice(2).join(' ') !== '--version') { throw new Error('Unsafe CLI query'); }
if (process.env.LUSH_AGENT_TOKEN || process.env.LUSH_TASK_ID || process.env.PI_SESSION_FILE) throw new Error('Invocation leaked');
console.log('9.1.2');
`, { mode: 0o755 });
  if (sdk) {
    fs.writeFileSync(path.join(piDir, 'dist', 'core', 'auth-storage.js'), 'export class AuthStorage { static inMemory() { return {}; } static create() { throw new Error("Do not read auth"); } }');
    fs.writeFileSync(path.join(piDir, 'dist', 'core', 'model-runtime.js'), `import fs from 'node:fs';
export class ModelRuntime {
  static async create(options) {
    if (options.refreshOnCreate !== false || options.allowModelNetwork !== false || !options.credentials) throw new Error('Unsafe model runtime');
    const config = JSON.parse(fs.readFileSync(options.modelsPath, 'utf8'));
    if (JSON.stringify(config).includes('SECRET') || JSON.stringify(config).includes('!touch')) throw new Error('Secret reached SDK');
    return { getModels() { return [
      {provider:'openai-codex', id:'gpt-current', name:'GPT Current', contextWindow:200000, maxTokens:12000, reasoning:true, input:['text','image']},
      {provider:'deepseek', id:'v4', name:'DeepSeek', input:['text']},
      {provider:'anthropic', id:'expired', name:'Not Available', input:['text']},
      ...Object.entries(config.providers || {}).flatMap(([provider, value]) => (value.models || []).map(model=>({...model,provider})))
    ]; } };
  }
}`);
    fs.writeFileSync(path.join(piDir, 'dist', 'core', 'package-manager.js'), `export class DefaultPackageManager {
  constructor(options) { this.options = options; }
  listConfiguredPackages() { return [...this.options.settingsManager.getGlobalSettings().packages,
    ...this.options.settingsManager.getProjectSettings().packages].map(source=>({source,installedPath:source})); }
}`);
  }
  const config = { project: root, home, provider: 'pi', env: { PATH: process.env.PATH, LUSH_PI_COMMAND: command,
    PI_CODING_AGENT_DIR: configDir, LUSH_AGENT_TOKEN: 'INVOCATION_SECRET', LUSH_TASK_ID: '47', PI_SESSION_FILE: 'private-session' } };
  const profile = { agent: 'pi', model: 'openai-codex/gpt-current', extensions: [], skills: [] };
  return { root, piDir, configDir, config, profile, close() { fs.rmSync(root, { recursive: true, force: true }); } };
}
const oauth = (expires = Date.now() + 3600000) => ({ type: 'oauth', access: 'ACCESS_SECRET', refresh: 'REFRESH_SECRET', expires, email: 'person@example.com', accountId: 'account-secret-abc' });
const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

test('status reads the configured Pi installation, SDK metadata and resources without executing plugins or credentials', async () => {
  const f = world();
  try {
    const pkg = path.join(f.root, 'installed-package'), plugin = path.join(pkg, 'extensions', 'hello.ts'), skill = path.join(pkg, 'skills', 'hello', 'SKILL.md');
    fs.mkdirSync(path.dirname(plugin), { recursive: true }); fs.mkdirSync(path.dirname(skill), { recursive: true });
    fs.writeFileSync(plugin, 'throw new Error("Plugin was executed");');
    fs.writeFileSync(skill, '---\nname: hello\ndescription: Hello skill.\n---\n');
    json(path.join(pkg, 'package.json'), { pi: { extensions: ['./extensions'], skills: ['./skills'] } });
    json(path.join(f.configDir, 'settings.json'), { packages: [pkg], extensions: ['!touch dangerous'] });
    json(path.join(f.configDir, 'auth.json'), { 'openai-codex': oauth(), anthropic: oauth(1000),
      'custom-proxy': { type: 'api_key', key: '!touch SECRET' } });
    json(path.join(f.configDir, 'models.json'), { providers: { 'custom-proxy': { apiKey: '!touch SECRET', baseUrl: 'https://proxy.invalid/SECRET',
      headers: { Authorization: 'SECRET' }, models: [{ id: 'custom-model', name: 'Custom Model', headers: { secret: 'SECRET' } }] } } });
    f.config.env.DEEPSEEK_API_KEY = 'DEEPSEEK_SECRET';
    const authFile = path.join(f.configDir, 'auth.json'), before = fs.readFileSync(authFile, 'utf8');
    let queries = 0;
    const value = await discoverAgentStatus(f.config, f.profile, { fetch(url) { queries++; expect(url).toBe('https://chatgpt.com/backend-api/wham/usage'); throw new Error('SECRET'); } });
    expect(value.runtime).toMatchObject({ version: '9.1.2', command: f.config.env.LUSH_PI_COMMAND, real_path: f.config.env.LUSH_PI_COMMAND, config_dir: f.configDir, backend: 'pi' });
    expect(value.scope).toMatchObject({ role: 'agent', project: f.root });
    expect(value.models.source).toBe('local');
    expect(value.models.models.map(item => item.id)).toEqual(['openai-codex/gpt-current', 'deepseek/v4']);
    expect(value.models.warning).toContain('未联网验证');
    expect(value.resources.packages).toEqual([{ source: pkg, root: pkg }]);
    expect(value.resources.extensions[0].id).toBe(plugin);
    expect(value.resources.skills[0].label).toBe('hello');
    const account = value.accounts.find(item => item.provider === 'openai-codex');
    expect(account).toMatchObject({ auth_type: 'oauth', identity: 'p***@***', status: 'configured', source: 'auth.json', balance: { status: 'error', items: [], kind: null, queried: true, error_code: 'network' } });
    expect(value.accounts.find(item => item.provider === 'anthropic').status).toBe('expired');
    expect(value.accounts.find(item => item.provider === 'custom-proxy').status).toBe('unknown');
    expect(queries).toBe(1);
    expect(JSON.stringify(value)).not.toContain('SECRET'); expect(JSON.stringify(value)).not.toContain('person@example.com');
    expect(fs.readFileSync(authFile, 'utf8')).toBe(before);
    expect(fs.existsSync(authFile + '.lock')).toBe(false);
    expect(fs.readdirSync(f.configDir).sort()).toEqual(['auth.json', 'models.json', 'settings.json']);
  } finally { f.close(); }
});

test('configured packages without an existing installation do not report an installed root', async () => {
  const f = world();
  try {
    const missing = path.join(f.root, 'missing-package');
    json(path.join(f.configDir, 'settings.json'), { packages: [missing] });
    const result = await discoverAgentStatus(f.config, f.profile);
    expect(result.resources.packages).toEqual([{ source: missing, root: null }]);
  } finally { f.close(); }
});

test('public and agent role environment are hot-read and profile env wins without invocation identity', async () => {
  const f = world();
  try {
    const alternate = path.join(f.root, 'alternate'); fs.mkdirSync(alternate);
    json(path.join(alternate, 'auth.json'), { 'openai-codex': oauth() });
    fs.mkdirSync(path.join(f.config.home, 'agent'));
    fs.writeFileSync(path.join(f.config.home, 'agent', 'agent.env'), 'PI_CODING_AGENT_DIR="wrong"\nDEEPSEEK_API_KEY="COMMON_SECRET"\n');
    // Reuse the runtime's environment assembly; profile overrides are the innermost layer.
    f.profile.env = { PI_CODING_AGENT_DIR: alternate };
    const value = await discoverAgentStatus(f.config, f.profile);
    expect(value.runtime.config_dir).toBe(alternate);
    expect(value.accounts.some(account => account.provider === 'deepseek' && account.source === 'environment')).toBe(true);
    expect(JSON.stringify(value)).not.toContain('COMMON_SECRET');
    json(path.join(alternate, 'auth.json'), { 'openai-codex': oauth(1000) });
    const next = await discoverAgentStatus(f.config, f.profile);
    expect(next.accounts.find(account => account.provider === 'openai-codex').status).toBe('expired');
  } finally { f.close(); }
});

test('Pi default config directory follows the resolved role HOME, not the invoking process HOME', async () => {
  const f = world();
  try {
    const roleHome = path.join(f.root, 'role-home');
    delete f.config.env.PI_CODING_AGENT_DIR; f.profile.env = { HOME: roleHome };
    const expected = path.join(roleHome, '.pi', 'agent');
    json(path.join(expected, 'auth.json'), { 'openai-codex': oauth() });
    const value = await discoverAgentStatus(f.config, f.profile);
    expect(value.runtime.config_dir).toBe(expected); expect(value.accounts[0].status).toBe('configured');
  } finally { f.close(); }
});

test('unknown installations fall back explicitly, and unsafe CLI diagnostics never leak', async () => {
  const f = world({ sdk: false });
  try {
    fs.writeFileSync(f.config.env.LUSH_PI_COMMAND, `#!${process.execPath}\nconsole.error('STDERR_SECRET'); console.log('STDOUT_SECRET'); process.exit(1);`, { mode: 0o755 });
    const value = await discoverAgentStatus(f.config, f.profile);
    expect(value.models.source).toBe('presets'); expect(value.models.warning).toContain('不代表实际可用');
    expect(value.runtime.version).toBeNull(); expect(value.runtime.warning).toContain('无法查询');
    expect(value.resources.warning).toContain('仅显示本地目录');
    expect(JSON.stringify(value)).not.toContain('SECRET');
  } finally { f.close(); }
});

test('missing and malformed or symlinked credential files remain distinguishable without creating auth.json', async () => {
  const f = world();
  try {
    const value = await discoverAgentStatus(f.config, f.profile);
    expect(value.accounts[0]).toMatchObject({ status: 'unconfigured', identity: null, balance: { status: 'unconfigured' } });
    expect(fs.existsSync(path.join(f.configDir, 'auth.json'))).toBe(false);
    fs.writeFileSync(path.join(f.configDir, 'auth.json'), '{"ACCESS_SECRET": broken', { mode: 0o600 });
    const broken = await discoverAgentStatus(f.config, f.profile);
    expect(broken.accounts[0].status).toBe('unknown'); expect(broken.warnings).toContain('Pi 凭证文件 无法安全读取，相关状态未知。');
    expect(JSON.stringify(broken)).not.toContain('ACCESS_SECRET');
    fs.unlinkSync(path.join(f.configDir, 'auth.json'));
    const privateFile = path.join(f.root, 'real-auth'); json(privateFile, { 'openai-codex': oauth() });
    fs.symlinkSync(privateFile, path.join(f.configDir, 'auth.json'));
    const linked = await discoverAgentStatus(f.config, f.profile);
    expect(linked.accounts[0].status).toBe('unknown');
  } finally { f.close(); }
});

test('only the current provider is queried, official DeepSeek response returns true zero without exposing keys', async () => {
  const f = world();
  try {
    f.profile.model = 'deepseek/v4'; f.config.env.DEEPSEEK_API_KEY = 'DEEPSEEK_SECRET'; f.config.env.OPENROUTER_API_KEY = 'OTHER_SECRET';
    let queries = 0;
    const value = await discoverAgentStatus(f.config, f.profile, { fetch: async (url, options) => {
      queries++; expect(url).toBe('https://api.deepseek.com/user/balance');
      expect(options).toMatchObject({ method: 'GET', redirect: 'error', headers: { Authorization: 'Bearer DEEPSEEK_SECRET' } });
      return response({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '0.00', granted_balance: '0', topped_up_balance: '0' }] });
    } });
    expect(queries).toBe(1);
    expect(value.accounts.find(account => account.provider === 'deepseek').balance).toMatchObject({ status: 'available', kind: 'balance',
      items: [{ label: '账户余额', remaining: 0, total: null, used: null, unit: 'CNY' }] });
    expect(value.accounts.find(account => account.provider === 'openrouter').balance.reason).toContain('本次未联网查询');
    expect(JSON.stringify(value)).not.toContain('SECRET');
  } finally { f.close(); }
});

test('custom endpoints and unknown model configuration never send a proxy key to the official provider', async () => {
  const f = world();
  try {
    f.profile.model = 'deepseek/v4'; f.config.env.DEEPSEEK_API_KEY = 'PROXY_SECRET';
    json(path.join(f.configDir, 'models.json'), { providers: { deepseek: { baseUrl: 'https://proxy.invalid/v1', apiKey: 'PROXY_SECRET' } } });
    const options = { fetch() { throw new Error('Credential should not be sent'); } };
    let value = await discoverAgentStatus(f.config, f.profile, options);
    expect(value.accounts[0].balance.reason).toContain('自定义端点');
    fs.writeFileSync(path.join(f.configDir, 'models.json'), '{invalid SECRET');
    value = await discoverAgentStatus(f.config, f.profile, options);
    expect(value.accounts[0].balance.status).toBe('unsupported');
    expect(JSON.stringify(value)).not.toContain('SECRET');
  } finally { f.close(); }
});

test('credential commands are never executed and local JWT identity is always masked', async () => {
  const f = world();
  try {
    f.profile.model = 'deepseek/v4';
    const marker = path.join(f.root, 'executed');
    const access = `header.${Buffer.from(JSON.stringify({ email: 'alice@example.com' })).toString('base64url')}.signature`;
    json(path.join(f.configDir, 'auth.json'), { deepseek: { type: 'api_key', key: `!touch ${marker}` },
      'openai-codex': { type: 'oauth', access, refresh: 'REFRESH_SECRET', expires: Date.now() + 3600000 } });
    let queries = 0;
    const value = await discoverAgentStatus(f.config, f.profile, { fetch() { queries++; throw new Error(); } });
    expect(fs.existsSync(marker)).toBe(false); expect(queries).toBe(0);
    expect(value.accounts.find(account => account.provider === 'deepseek').status).toBe('unknown');
    expect(value.accounts.find(account => account.provider === 'openai-codex').identity).toBe('a***@***');
    expect(JSON.stringify(value)).not.toContain(access); expect(JSON.stringify(value)).not.toContain('alice@example.com');
  } finally { f.close(); }
});

test('OpenRouter key spending cap is quota, not account cash balance; unlimited cap stays null', async () => {
  const balance = await queryAccountBalance('openrouter', 'SECRET', '2026-01-01T00:00:00.000Z', { fetch: async url => {
    expect(url).toBe('https://openrouter.ai/api/v1/key');
    return response({ data: { limit: null, limit_remaining: null, usage: 14.25, label: 'SECRET' } });
  } });
  expect(balance).toMatchObject({ status: 'available', kind: 'quota', items: [{ remaining: null, total: null, used: 14.25, unit: 'USD' }] });
  expect(balance.reason).toContain('不是账户现金余额'); expect(JSON.stringify(balance)).not.toContain('SECRET');
});

test('upstream malformed, oversized, rejected redirect and timeout results never become a zero balance or raw error', async () => {
  const time = '2026-01-01T00:00:00.000Z';
  const cases = [
    async () => response({ balance_infos: [{ currency: 'CNY', total_balance: '' }], error: 'SECRET' }),
    async () => new Response('SECRET', { status: 302, headers: { Location: 'https://attacker.invalid' } }),
    async () => new Response('SECRET'.repeat(12000)),
    async () => { throw new Error('SECRET'); },
    async () => new Promise(() => {}),
  ];
  for (const fetch of cases) {
    const balance = await queryAccountBalance('deepseek', 'KEY_SECRET', time, { fetch, timeout: 15 });
    expect(balance).toMatchObject({ status: 'error', kind: null, items: [] });
    expect(JSON.stringify(balance)).not.toContain('SECRET');
  }
});

test('large UTF-8 model and resource catalogs are explicitly truncated below the RPC frame limit', async () => {
  const f = world();
  try {
    const extensions = path.join(f.configDir, 'extensions'); fs.mkdirSync(extensions);
    for (let i = 0; i < 500; i++) fs.writeFileSync(path.join(extensions, `${'扩'.repeat(60)}${i}.ts`), 'export default () => {};');
    json(path.join(f.configDir, 'auth.json'), { custom: { type: 'api_key', key: 'SECRET' } });
    json(path.join(f.configDir, 'models.json'), { providers: { custom: { models: Array.from({ length: 500 }, (_, index) => ({
      id: `model-${index}`, name: '模'.repeat(180),
    })) } } });
    f.profile.model = 'custom/model-0';
    const result = await discoverAgentStatus(f.config, f.profile);
    expect(result.resources.truncated).toBe(true); expect(result.resources.warning).toContain('已截断');
    expect(result.models.truncated).toBe(true); expect(result.models.warning).toContain('已截断');
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1024 * 1024 - 1000);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  } finally { f.close(); }
});

test('concurrent refresh requests are single-flight but the next explicit refresh reads again', async () => {
  const f = world();
  try {
    const first = discoverAgentStatus(f.config, f.profile), second = discoverAgentStatus(f.config, f.profile);
    expect(first).toBe(second); await first;
    const next = discoverAgentStatus(f.config, f.profile); expect(next).not.toBe(first); await next;
  } finally { f.close(); }
});
