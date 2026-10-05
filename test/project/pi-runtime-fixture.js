import { install, ManagerStub } from './agent-connection-fixture.js';

/** Only mock credentials and metadata: fake CLI tests never contact this endpoint. */
export function piRuntimeFixture(extra = {}) {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const agent = { agent: 'pi', connection_id: id, model: 'deepseek/deepseek-chat', thinking: '',
    default_prompt: '', append_prompt: '', extensions: [], skills: [], soft_budget: {}, ...extra };
  const connectionRuntime = { connection: { id, label: 'Mock Pi source', provider: 'deepseek', endpoint: 'https://api.deepseek.com',
    auth_type: 'api_key', enabled: true, models: ['deepseek-chat'], credential: { status: 'configured' } },
    credential: { type: 'api_key', key: 'MOCK-TEST-KEY' }, account_key: 'mock-account', source_key: 'mock-source' };
  return { agent, connectionRuntime };
}

/** Bind scheduler-driven fake Pi tests without loading a real credential store. */
export function configurePiFixture(fixture, extra = {}) {
  const { agent, connectionRuntime } = piRuntimeFixture(extra);
  const manager = new ManagerStub([connectionRuntime.connection]);
  install(fixture, { manager });
  fixture.project.agentSettings.save({ version: 1, default: agent, roles: {} });
  return { agent, connectionRuntime, manager };
}
