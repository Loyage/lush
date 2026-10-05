/** Test-only prepared connection. Never accesses real credentials or provider networks. */
export function managedPiRun(options) {
  const model = options.agent?.model?.includes('/') ? options.agent.model : 'deepseek/deepseek-chat';
  const provider = model.split('/')[0], id = 'fd6aaf48-7f92-4d10-9cca-bc8d4c44f012';
  return { ...options, agent: { ...options.agent, model, connection_id: id }, connectionRuntime: {
    connection: { id, provider, endpoint: provider === 'openai-codex' ? 'https://chatgpt.com/backend-api' : 'https://api.deepseek.com',
      auth_type: provider === 'openai-codex' ? 'oauth' : 'api_key', enabled: true, models: [model.slice(provider.length + 1)] },
    credential: provider === 'openai-codex'
      ? { type: 'oauth', access: 'FIXTURE-ACCESS', refresh: 'FIXTURE-REFRESH-NEVER-COPIED', expires: Date.now() + 3600000 }
      : { type: 'api_key', key: 'FIXTURE-MANAGED-API-KEY' },
    account_key: 'fixture-account', source_key: 'fixture-source',
  } };
}
