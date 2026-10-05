import { Config } from '../../src/config.js';
import { UIClient } from '../../src/ui/client.js';
import { env } from '../helpers.js';

/** Fake CLI integration only: bind a project-local mock key without reading external Pi auth or contacting models. */
export async function bindMockPiSource(root) {
  const client = new UIClient(Config.fromEnv(env(), root));
  const connection = await client.request('agent.connections.save', {
    connection: { label: 'Fake CLI source', provider: 'deepseek', auth_type: 'api_key', enabled: true, models: ['deepseek-chat'] },
    credential: { api_key: 'MOCK-INTEGRATION-KEY' },
  });
  const current = await client.request('agent.config');
  await client.request('agent.configure', { config: { version: 1, default: { ...current.default,
    agent: 'pi', connection_id: connection.id, model: 'deepseek/deepseek-chat' }, roles: current.roles } });
}
