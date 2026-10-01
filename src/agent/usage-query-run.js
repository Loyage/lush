import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { usageDigest, codexCredentialView } from './status-accounts.js';
import { resolveCodexUsageCredential } from './usage-auth-codex.js';
import { USAGE_ENDPOINTS, unavailableBalance, queryAccountBalance, queryCustomBalance } from './usage-query.js';

const validProvider = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,79}$/i.test(value);
function customIdentity(custom, env) {
  const names = new Set();
  const templates = [...Object.values(custom.headers || {}), custom.body || ''];
  for (const template of templates) if (typeof template === 'string') for (const match of template.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) names.add(match[1]);
  // A change of destination, mapping, or explicitly authorized credential starts a new history.
  return usageDigest([custom, [...names].sort().map(name => [name, env[name] || null])]);
}
export async function runUsageQueries(context, options = {}) {
  const { checked_at, currentProvider, accounts, keys, env, config_dir } = context;
  const custom = new Map((options.usageConfig?.custom || []).slice(0, 20).filter(row => validProvider(row?.provider)).map(row => [row.provider, row]));
  const selected = new Set(options.usageConfig?.providers?.length ? options.usageConfig.providers.slice(0, 20) : [currentProvider]);
  for (const provider of selected) if (validProvider(provider) && !accounts.some(account => account.provider === provider)) accounts.push({
    provider, account_key: usageDigest([config_dir, provider, 'unconfigured']), auth_type: null,
    source: 'none', identity: null, status: 'unconfigured', expires_at: null,
    balance: unavailableBalance('unconfigured', '未配置此服务商凭证。', checked_at, 'unconfigured'),
  });
  for (const provider of custom.keys()) if (!accounts.some(account => account.provider === provider)) accounts.push({
    provider, auth_type: null, source: 'custom', identity: null, status: 'unconfigured', expires_at: null,
    balance: unavailableBalance('unsupported', '自定义查询尚未执行。', checked_at),
  });
  for (const account of accounts) if (custom.has(account.provider)) {
    account.account_key = usageDigest([config_dir, account.provider, customIdentity(custom.get(account.provider), env)]);
  }
  // At most four concurrent remote calls per query, not one unbounded Promise per saved account.
  let next = 0;
  async function worker() {
    while (next < accounts.length) {
      const account = accounts[next++], mapping = custom.get(account.provider);
      if (!selected.has(account.provider)) {
        account.balance.reason = '此账号未在当前查询选择中，本次未联网查询余额/额度。';
        continue;
      }
      if (mapping) { account.balance = await queryCustomBalance(mapping, env, checked_at, options); continue; }
      if (!USAGE_ENDPOINTS[account.provider]) continue;
      // Only the original, explicitly selected official Codex account may refresh.
      // A custom HTTP mapping or a proxy model endpoint never sends its credentials to OpenAI.
      if (account.provider === 'openai-codex' && context.codexAuth?.official && account.auth_type === 'oauth') {
        const auth = await resolveCodexUsageCredential(path.join(config_dir, 'auth.json'), context.codexAuth.credential, options);
        if (auth.error_code) {
          account.balance = unavailableBalance('error', auth.error_code === 'expired'
            ? 'Codex OAuth 已过期且无法刷新，请更新登录凭证。'
            : auth.error_code === 'auth_locked' ? 'Codex 凭证正在使用或锁已变化，本次未写回凭证，请稍后重试。'
              : auth.error_code === 'auth_changed' ? 'Codex 凭证或存储已变化，本次未覆盖，请重新查询。'
                : 'Codex OAuth 刷新失败，本次未取得可用查询凭证。', checked_at, auth.error_code, true);
          continue;
        }
        Object.assign(account, codexCredentialView(config_dir, auth.credential, context.codexAuth.baseUrl));
        keys.set(account.provider, auth.credential.access);
      }
      if (keys.has(account.provider) && account.status === 'configured') {
        account.balance = await queryAccountBalance(account.provider, keys.get(account.provider), checked_at, options);
      } else if (account.status !== 'configured') {
        const code = account.status === 'expired' ? 'expired' : 'unconfigured';
        account.balance = unavailableBalance(account.status === 'unconfigured' ? 'unconfigured' : 'error',
          code === 'expired' ? '本地 OAuth 凭证已过期，请到 Pi 更新；额度查询不会自动刷新或改写凭证。'
            : '没有可安全读取的查询凭证；不会执行密钥命令或刷新 OAuth。', checked_at, code, true);
      }
      // Configured credentials at a proxy/unknown models config keep the existing safe unsupported reason.
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, accounts.length) }, worker));
  accounts.sort((a, b) => a.provider.localeCompare(b.provider));
  return { query_id: randomUUID(), checked_at, current_provider: currentProvider, accounts, warnings: context.warnings };
}
