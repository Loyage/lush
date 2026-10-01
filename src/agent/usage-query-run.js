import { randomUUID } from 'node:crypto';
import { usageDigest } from './status-accounts.js';
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
