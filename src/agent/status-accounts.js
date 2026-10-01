import fs from 'node:fs';
import path from 'node:path';

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
function unavailableBalance(status, reason, checked_at) {
  return { status, kind: null, items: [], reason, checked_at };
}

/** Private keys are kept in a separate map which must never become the RPC result. */
export function readPiAccounts(configDir, env, modelsConfig, warnings, currentProvider, checkedAt) {
  const auth = readStatusJson(path.join(configDir, 'auth.json'), warnings, 'Pi 凭证文件', { privateFile: true });
  const providers = new Set();
  for (const id of Object.keys(auth || {})) if (providerName(id)) providers.add(id);
  for (const [id, value] of Object.entries(modelsConfig?.providers || {})) if (providerName(id) && object(value) && value.apiKey) providers.add(id);
  for (const [id, names] of Object.entries(ENV_KEYS)) if (names.some(name => env[name])) providers.add(id);
  if (providerName(currentProvider)) providers.add(currentProvider);
  const accounts = [], keys = new Map();
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
    const baseUrl = custom?.baseUrl;
    const officialOrigin = provider === 'deepseek' ? 'https://api.deepseek.com' : provider === 'openrouter' ? 'https://openrouter.ai' : null;
    let official = modelsConfig !== null && baseUrl === undefined;
    if (modelsConfig !== null && typeof baseUrl === 'string') { try { const url = new URL(baseUrl); official = url.origin === officialOrigin && !url.username && !url.password; } catch {} }
    if (key && official) keys.set(provider, key);
    let balance = unavailableBalance('unsupported', provider === 'openai-codex'
      ? 'ChatGPT/Codex 订阅没有可靠的公开余额/额度查询接口；订阅额度不等于现金余额。'
      : '此服务商尚无已接入的可靠官方余额/额度查询接口。', checkedAt);
    if (status === 'unconfigured') balance = unavailableBalance('unconfigured', '未配置此服务商凭证。', checkedAt);
    else if (status === 'expired') balance = unavailableBalance('unsupported', '本地 OAuth 凭证已过期；状态查询不会自动刷新凭证。', checkedAt);
    else if (status === 'unknown') balance = unavailableBalance('unsupported', '凭证状态未知或使用密钥命令；只读查询不会执行命令。', checkedAt);
    else if (officialOrigin && !official) balance = unavailableBalance('unsupported', '此账号使用自定义端点，不能将其凭证发送给服务商官方余额接口。', checkedAt);
    accounts.push({ provider, auth_type, source, identity: accountIdentity, status, expires_at, balance });
  }
  return { accounts, keys };
}

const number = value => typeof value === 'number' && Number.isFinite(value) ? value
  : typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) ? Number(value) : null;
async function responseJson(response) {
  if (!response.ok) throw new Error();
  if (Number(response.headers.get('content-length')) > 65536) throw new Error();
  const reader = response.body?.getReader(); if (!reader) throw new Error();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > 65536) throw new Error(); chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

/** Fixed official endpoints, read-only GET, no redirects, bounded body and deadline; errors are deliberately generic. */
export async function queryAccountBalance(provider, key, checkedAt, { fetch: fetcher = globalThis.fetch, timeout = 8000 } = {}) {
  const url = provider === 'deepseek' ? 'https://api.deepseek.com/user/balance'
    : provider === 'openrouter' ? 'https://openrouter.ai/api/v1/key' : null;
  if (!url) return unavailableBalance('unsupported', '此服务商尚无已接入的可靠官方余额/额度查询接口。', checkedAt);
  const controller = new AbortController(); let timer;
  try {
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error()); }, timeout); });
    const data = await Promise.race([deadline, (async () => responseJson(await fetcher(url, {
      method: 'GET', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      redirect: 'error', signal: controller.signal,
    })))()]);
    if (provider === 'deepseek') {
      if (!Array.isArray(data?.balance_infos) || !data.balance_infos.length || data.balance_infos.length > 10) throw new Error();
      const items = data.balance_infos.map(item => {
        const remaining = number(item?.total_balance);
        if (remaining === null || !/^[A-Z]{3}$/.test(item?.currency || '')) throw new Error();
        return { label: '账户余额', remaining, total: null, used: null, unit: item.currency };
      });
      return { status: 'available', kind: 'balance', items, reason: null, checked_at: checkedAt };
    }
    const quota = data?.data;
    const total = number(quota?.limit), remaining = number(quota?.limit_remaining), used = number(quota?.usage);
    if (!object(quota) || used === null || (quota.limit !== null && total === null)
      || (quota.limit_remaining !== null && remaining === null)) throw new Error();
    return { status: 'available', kind: 'quota', items: [{ label: 'API Key 消费额度', remaining, total, used, unit: 'USD' }],
      reason: total === null ? '此 API Key 未设置消费上限；显示的是 Key 用量，不是账户现金余额。' : '这是 API Key 消费额度，不是账户现金余额。', checked_at: checkedAt };
  } catch { return unavailableBalance('error', '官方余额/额度查询失败（网络、授权、超时或响应格式问题），未取得数值。', checkedAt); }
  finally { clearTimeout(timer); controller.abort(); }
}
