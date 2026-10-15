import { test, expect } from 'bun:test';
import { fixture, gate } from '../helpers.js';
import { AgentConnectionsService } from '../../src/core/agent-connections.js';
import { THINKING_LEVELS } from '../../src/agent/settings.js';
import { install, ManagerStub, connection, observation, resource, digest, timers, iso } from './agent-connection-fixture.js';

const count = f => f.store.get('SELECT COUNT(*) AS n FROM agent_connection_queries').n;

test('managed list is local-only, whitelisted, unknown not zero; consumers require explicit active bindings', async () => {
  const f = fixture(), { manager, service } = install(f);
  try {
    let reads = 0; manager.query = () => { reads++; throw new Error('must not query'); };
    const binding = { id: 'conn-one', ...manager.identity('conn-one') };
    f.project.running.set(10,{ agent: { connection_id: 'conn-one', model: 'deepseek/chat' }, connectionBinding: binding, controller: new AbortController() });
    f.project.running.set(11,{ agent: { connection_id: 'conn-one', model: 'deepseek/chat' }, controller: new AbortController() });
    f.project.running.set(12,{ agent: { connection_id: 'conn-one', model: 'deepseek/chat' }, connectionBinding: binding, parked: true });
    const dead = new AbortController(); dead.abort();
    f.project.running.set(13,{ agent: { connection_id: 'conn-one' }, connectionBinding: binding, controller: dead });
    const list = f.project.agentConnectionsList();
    expect(list.version).toBe(1); expect(list.sampling.enabled).toBe(false);
    expect(list.connections[0].observation.status).toBe('unknown'); expect(list.connections[0].observation.resources).toEqual([]);
    expect(list.connections[0].consumers).toEqual([{task_id:10,task_worker_number:null,model:'deepseek/chat'}]);
    expect(JSON.stringify(list)).not.toContain('MUST_NOT_RETURN'); expect(reads).toBe(0); expect(count(f)).toBe(0);
    expect(() => service.history('conn-one',2)).toThrow(); expect(() => service.history('../private',7)).toThrow();
  } finally { f.project.running.clear(); await f.close(); }
});

test('query is single-flight, persists each real observation once, and returns old success separately after failure', async () => {
  const f = fixture(), blocked = gate(), entered = gate(), { manager, service } = install(f);
  manager.onQuery = async (_id,result) => { entered.resolve(); await blocked.promise; return result; };
  try {
    const one = service.query('conn-one'), two = service.query(); await entered.promise;
    expect(manager.calls).toBe(1); blocked.resolve(); await Promise.all([one,two]); expect(count(f)).toBe(1);
    manager.onQuery = null; manager.result = observation({status:'error',checked_at:iso(0),resources:[],error_code:'network',reason:'SECRET upstream text'});
    const result = await service.query();
    expect(result.connections[0].observation.status).toBe('error'); expect(result.connections[0].last_success.checked_at).toBe(iso(-1000));
    expect(result.connections[0].last_success.observation.resources[0].remaining).toBe(70);
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(service.history('conn-one',1).series[0].points.map(point => point.status)).toEqual(['available','error']);
    expect(f.store.get('SELECT COUNT(*) AS n FROM agent_usage_queries').n).toBe(0);
    expect(service.pending.size).toBe(0); expect(service.flights.size).toBe(0);
  } finally { blocked.resolve(); await f.close(); }
});

test('save during query drops late old credentials, separates subsequent account history and invalidates display', async () => {
  const f = fixture(), blocked = gate(), entered = gate(), { manager, service } = install(f);
  try {
    await service.query();
    manager.onQuery = async (_id,result) => { entered.resolve(); await blocked.promise; return result; };
    const old = service.query(); await entered.promise;
    await service.save({ ...connection(), credential: undefined },{api_key:'replacement-secret'});
    expect(service.list().connections[0].observation.status).toBe('unknown');
    blocked.resolve(); await old; expect(count(f)).toBe(1);
    manager.onQuery = null; await service.query(); expect(count(f)).toBe(2);
    const result = service.history('conn-one'); expect(result.series).toHaveLength(2);
    expect(new Set(result.series.map(item => item.account_key)).size).toBe(2);
    expect(JSON.stringify(result)).not.toContain('replacement-secret');
  } finally { blocked.resolve(); await f.close(); }
});
