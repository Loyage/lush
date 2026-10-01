import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { USAGE_ENDPOINTS, unavailableBalance } from './usage-query.js';
export { queryAccountBalance } from './usage-query.js';

const MAX_JSON = 512 * 1024;
const providerName = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,79}$/i.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const ENV_KEYS = {
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'],
  'ant-ling': ['ANT_LING_API_KEY'], openai: ['OPENAI_API_KEY'], deepseek: ['DEEPSEEK_API_KEY'], nvidia: ['NVIDIA_API_KEY'],
  google: ['GEMINI_API_KEY'], 'github-copilot': ['COPILOT_GITHUB_TOKEN'], mistral: ['MISTRAL_API_KEY'], groq: ['GROQ_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'], xai: ['XAI_API_KEY'], openrouter: ['OPENROUTER_API_KEY'], 'vercel-ai-gateway': ['AI_GATEWAY_API_KEY'],
  zai: ['ZAI_API_KEY'], 'zai-coding-cn': ['ZAI_CODING_CN_API_KEY'], opencode: ['OPENCODE_API_KEY'], 'opencode-go': ['OPENCODE_API_KEY'],
  radius: ['RADIUS_API_KEY'], typesafe: ['TYPESAFE_API_KEY'], huggingface: ['HF_TOKEN'], fireworks: ['FIREWORKS_API_KEY'],
  together: ['TOGETHER_API_KEY'], baseten: ['BASETEN_API_KEY'], 'kimi-coding': ['KIMI_API_KEY'], meta: ['META_API_KEY'],
  minimax: ['MINIMAX_API_KEY'], 'minimax-cn': ['MINIMAX_CN_API_KEY'], moonshotai: ['MOONSHOT_API_KEY'], 'moonshotai-cn': ['MOONSHOT_API_KEY'],
  'qwen-token-plan': ['QWEN_TOKEN_PLAN_API_KEY'], 'qwen-token-plan-individual': ['QWEN_TOKEN_PLAN_API_KEY'],
  'qwen-token-plan-cn': ['QWEN_TOKEN_PLAN_CN_API_KEY'], xiaomi: ['XIAOMI_API_KEY'], 'xiaomi-token-plan-cn': ['XIAOMI_TOKEN_PLAN_CN_API_KEY'],
  'xiaomi-token-plan-ams': ['XIAOMI_TOKEN_PLAN_AMS_API_KEY'], 'xiaomi-token-plan-sgp': ['XIAOMI_TOKEN_PLAN_SGP_API_KEY'],
  'azure-openai-responses': ['AZURE_OPENAI_API_KEY'], 'cloudflare-workers-ai': ['CLOUDFLARE_API_KEY'], 'cloudflare-ai-gateway': ['CLOUDFLARE_API_KEY'],
  'google-vertex': ['GOOGLE_CLOUD_API_KEY'], 'amazon-bedrock': ['AWS_BEARER_TOKEN_BEDROCK'],
};

/** Returns null with a safe, fixed warning on malformed/oversized/unsafe files. Never include parse errors. */
export function readStatusJson(file, warnings, label, { privateFile = false } = {}) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JSON
      || (privateFile && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) throw new Error();
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!object(value)) throw new Error();
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    warnings.push(`${label} 无法安全读取，相关状态未知。`);
    return null;
  }
}

function resolveKey(value, env) {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (value.trimStart().startsWith('!')) return null;
  let missing = false;
  const expanded = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, braced, bare) => {
    const found = env[braced || bare]; if (!found) missing = true; return found || '';
  });
  if (missing || !expanded.trim() || expanded.trimStart().startsWith('!') || expanded.length > 16384 || /[\r\n\0]/.test(expanded)) return null;
  return expanded;
}
function expiry(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 8640000000000000) return null;
  return new Date(value).toISOString();
}
function masked(value) {
  if (typeof value !== 'string' || !value || value.length > 512) return null;
  const clean = value.replace(/[\x00-\x1f\x7f]/g, '');
  if (!clean) return null;
  if (clean.includes('@')) return `${clean[0]}***@***`;
  return clean.length > 8 ? `${clean.slice(0, 2)}***${clean.slice(-2)}` : '***';
}
function identity(credential) {
  if (!object(credential)) return null;
  const direct = masked(credential.email) || masked(credential.accountId);
  if (direct) return direct;
  // Local decoding is not verification. Read only known identity fields and never return the JWT itself.
  if (typeof credential.access !== 'string' || credential.access.length > 32768) return null;
  try {
    const claims = JSON.parse(Buffer.from(credential.access.split('.')[1], 'base64url').toString('utf8'));
    return masked(claims.email) || masked(claims['https://api.openai.com/auth']?.chatgpt_account_id);
  } catch { return null; }
}
export const usageDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function stableIdentity(credential) {
  if (!object(credential)) return null;
  let claims;
  try { claims = JSON.parse(Buffer.from(credential.access?.split('.')[1] || '', 'base64url').toString('utf8')); } catch {}
  for (const value of [credential.accountId, claims?.['https://api.openai.com/auth']?.chatgpt_account_id, credential.email, claims?.email])
    if (typeof value === 'string' && value.length > 0 && value.length < 1024) return value;
  return null;
}

/** Safe projection of refreshed OAuth, without exposing its access/refresh tokens. */
export function codexCredentialView(configDir, credential, baseUrl = undefined) {
  return { status: 'configured', expires_at: expiry(credential.expires), identity: identity(credential),
    account_key: usageDigest([configDir, 'openai-codex', stableIdentity(credential) || credential.access, baseUrl || 'builtin']) };
}

/** Private keys and Codex refresh metadata must never become the RPC result. */
export function readPiAccounts(configDir, env, modelsConfig, warnings, currentProvider, checkedAt) {
  const auth = readStatusJson(path.join(configDir, 'auth.json'), warnings, 'Pi 凭证文件', { privateFile: true });
  const providers = new Set();
  for (const id of Object.keys(auth || {})) if (providerName(id)) providers.add(id);
  for (const [id, value] of Object.entries(modelsConfig?.providers || {})) if (providerName(id) && object(value) && value.apiKey) providers.add(id);
  for (const [id, names] of Object.entries(ENV_KEYS)) if (names.some(name => env[name])) providers.add(id);
  if (providerName(currentProvider)) providers.add(currentProvider);
  const accounts = [], keys = new Map(); let codexAuth = null;
  for (const provider of [...providers].sort().slice(0, 100)) {
    const credential = auth?.[provider], custom = modelsConfig?.providers?.[provider];
    let source = 'none', auth_type = null, status = auth === null ? 'unknown' : 'unconfigured', expires_at = null, key = null, accountIdentity = null;
    if (credential !== undefined && (!object(credential) || !['oauth', 'api_key'].includes(credential.type))) {
      source = 'auth.json'; status = 'unknown';
    } else if (object(credential) && credential.type === 'oauth') {
      source = 'auth.json'; auth_type = 'oauth'; expires_at = expiry(credential.expires); accountIdentity = identity(credential);
      status = typeof credential.access === 'string' && credential.access && expires_at
        ? (Date.parse(expires_at) <= Date.parse(checkedAt) ? 'expired' : 'configured') : 'unknown';
    } else if (object(credential) && credential.type === 'api_key' && credential.key) {
      source = 'auth.json'; auth_type = 'api_key'; key = resolveKey(credential.key, env); status = key ? 'configured' : 'unknown';
    } else if (object(custom) && custom.apiKey) {
      source = 'models.json'; auth_type = 'api_key'; key = resolveKey(custom.apiKey, env); status = key ? 'configured' : 'unknown';
    } else {
      const name = ENV_KEYS[provider]?.find(name => env[name]);
      if (name) { source = 'environment'; auth_type = 'api_key'; key = resolveKey(env[name], {}); status = key ? 'configured' : 'unknown'; }
    }
    // Do not send a proxy's key to the provider's official host just because its provider ID matches.
    if (auth_type === 'oauth' && status === 'configured' && provider === 'openai-codex') key = resolveKey(credential.access, {});
    const baseUrl = custom?.baseUrl;
    const officialOrigin = USAGE_ENDPOINTS[provider] ? new URL(USAGE_ENDPOINTS[provider]).origin : null;
    let official = modelsConfig !== null && baseUrl === undefined;
    if (modelsConfig !== null && typeof baseUrl === 'string') { try { const url = new URL(baseUrl); official = url.origin === officialOrigin && !url.username && !url.password; } catch {} }
    if (key && official && (provider !== 'openai-codex' || auth_type === 'oauth')) keys.set(provider, key);
    if (provider === 'openai-codex' && auth_type === 'oauth') codexAuth = { credential, official, baseUrl };
    let balance = unavailableBalance('unsupported', '此服务商尚无已接入的余额/额度查询接口。', checkedAt);
    if (status === 'unconfigured') balance = unavailableBalance('unconfigured', '未配置此服务商凭证。', checkedAt);
    else if (status === 'expired') balance = unavailableBalance('unsupported', '本地 OAuth 凭证已过期；只有已选官方 Codex 查询支持独立刷新，其他账号需更新登录。', checkedAt);
    else if (status === 'unknown') balance = unavailableBalance('unsupported', '凭证状态未知或使用密钥命令；只读查询不会执行命令。', checkedAt);
    else if (officialOrigin && !official) balance = unavailableBalance('unsupported', '此账号使用自定义端点，不能将其凭证发送给服务商官方余额接口。', checkedAt);
    else if (provider === 'openai-codex' && auth_type !== 'oauth') balance = unavailableBalance('unsupported', 'Codex 订阅查询仅支持有效的本地 OAuth 凭证，不使用 API Key 代替订阅登录。', checkedAt);
    const account_key = usageDigest([configDir, provider, stableIdentity(credential) || key || credential?.access || credential?.key || custom?.apiKey || 'unconfigured', baseUrl || 'builtin']);
    accounts.push({ provider, account_key, auth_type, source, identity: accountIdentity, status, expires_at, balance });
  }
  return { accounts, keys, codexAuth };
}
