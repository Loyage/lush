import { test, expect } from 'bun:test';
import { fixture, gate } from '../helpers.js';
import { AgentSelectionService } from '../../src/core/agent-selection.js';
import { install, ManagerStub, connection, iso, timers } from './agent-connection-fixture.js';

function catalog(id, extra = {}) {
  return { version: 1, id, checked_at: iso(0), status: 'fresh', source: 'listing', models: [
    { id: 'deepseek/deepseek-chat', name: 'deepseek-chat', thinking_levels: null, context: null, max_output: null, images: null, reasoning: null }],
    warning: null, error_code: null, ...extra };
}

/** ManagerStub plus the catalog provider seam; no network, no model request. */
class CatalogStub extends ManagerStub {
  constructor(connections = [connection()]) { super(connections); this.catalogs = new Map(); this.catalogCalls = 0; this.onCatalog = null; }
  catalog(id) { return this.catalogs.get(id) ?? null; }
  async catalogRefresh(id) {
    this.catalogCalls++;
    if (this.onCatalog) return this.onCatalog(id);
    const value = catalog(id); this.catalogs.set(id, value); return value;
  }
}

test('models read face is local, validated and falls back to an explicit unknown state', async () => {
  const f = fixture(), manager = new CatalogStub([
    connection({ models: ['deepseek-chat'] }), connection({ id: 'conn-two' }) ]);
  install(f, { manager });
  try {
    const service = f.project.agentConnections;
    let fetches = 0; manager.catalogRefresh = async () => { fetches++; return null; };
    const restricted = service.models('conn-one');
    expect(restricted).toMatchObject({ version: 1, id: 'conn-one', status: 'unknown', source: 'none', models: [] });
    expect(fetches).toBe(0);
    // A stub without the catalog seam degrades to the documented unknown face instead of throwing.
    const plain = new ManagerStub(); const plainService = install(fixture(), { manager: plain }).service;
    expect(plainService.models('conn-one')).toMatchObject({ status: 'unknown', source: 'none', models: [] });
    expect(() => service.models('../private')).toThrow();
    expect(service.catalogList().catalogs.map(row => row.id)).toEqual(['conn-one', 'conn-two']);
  } finally { await f.close(); }
});

test('refresh is single-flight, tracks the current identity and stores only a safe catalog', async () => {
  const f = fixture(), entered = gate(), blocked = gate(), manager = new CatalogStub();
  install(f, { manager });
  try {
    const service = f.project.agentConnections;
    manager.onCatalog = async id => { entered.resolve(); await blocked.promise; return catalog(id); };
    const one = service.modelsRefresh('conn-one'), two = service.modelsRefresh('conn-one');
    await entered.promise;
    expect(manager.catalogCalls).toBe(1);
    blocked.resolve(); await Promise.all([one, two]);
    manager.onCatalog = null;
    const value = await service.modelsRefresh('conn-one');
    expect(value).toMatchObject({ id: 'conn-one', status: 'fresh', source: 'listing' });
    expect(value.models[0].id).toBe('deepseek/deepseek-chat');
    expect(JSON.stringify(value)).not.toContain('test-secret');
    expect(service.catalogFlights.size).toBe(0); expect(service.pending.size).toBe(0);
  } finally { await f.close(); }
});

test('a discarded late refresh returns the current fallback instead of a stale catalog', async () => {
  const f = fixture(), entered = gate(), blocked = gate(), manager = new CatalogStub();
  install(f, { manager });
  try {
    const service = f.project.agentConnections;
    manager.onCatalog = async () => { entered.resolve(); await blocked.promise; return null; };
    const pending = service.modelsRefresh('conn-one');
    await entered.promise;
    manager.connections[0].models = ['changed-model'];
    blocked.resolve();
    expect(await pending).toMatchObject({ id: 'conn-one', status: 'unknown', source: 'none', models: [] });
    expect(manager.catalogs.has('conn-one')).toBe(false);
  } finally { await f.close(); }
});

test('modelsRefresh(null) refreshes every enabled connection and skips disabled ones', async () => {
  const f = fixture(), manager = new CatalogStub([
    connection(), connection({ id: 'conn-off', enabled: false }) ]);
  install(f, { manager });
  try {
    const service = f.project.agentConnections;
    const result = await service.modelsRefresh();
    expect(manager.catalogCalls).toBe(1);
    expect(result.catalogs.map(row => row.id)).toEqual(['conn-one', 'conn-off']);
    expect(result.catalogs[1].status).toBe('unknown');
  } finally { await f.close(); }
});

test('catalog cache is per connection identity; selection resources expose it read-only', async () => {
  const f = fixture(), manager = new CatalogStub([
    connection({ id: 'conn-one' }), connection({ id: 'conn-two' }) ]);
  install(f, { manager });
  try {
    const service = f.project.agentConnections;
    manager.catalogs.set('conn-one', catalog('conn-one'));
    manager.catalogs.set('conn-two', catalog('conn-two', { source: 'manual', models: [{ id: 'deepseek/other', name: 'other' }] }));
    const resources = new AgentSelectionService(f.project).resources();
    expect(resources.connections.map(row => row.model_catalog.id)).toEqual(['conn-one', 'conn-two']);
    expect(resources.connections[0].model_catalog.models[0].id).toBe('deepseek/deepseek-chat');
    expect(resources.connections[1].model_catalog.models[0].id).toBe('deepseek/other');
    expect(service.models('conn-one').status).toBe('fresh');
    expect(JSON.stringify(resources)).not.toContain('test-secret');
  } finally { await f.close(); }
});

test('background catalog sync is opt-in to the provider seam, reschedules and stops cleanly', async () => {
  const clock = timers(), f = fixture(), manager = new CatalogStub();
  install(f, { manager, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  try {
    const service = f.project.agentConnections;
    service.start();
    expect(clock.waiting.size).toBe(1);
    await clock.fire();
    expect(manager.catalogCalls).toBe(1);
    expect(clock.waiting.size).toBe(1);
    await service.stop();
    expect(clock.waiting.size).toBe(0);
    expect(manager.stops).toBe(1);
  } finally { await f.close(); }
});

test('save schedules a deferred, background-only catalog sync and never networks inside the save', async () => {
  const clock = timers(), f = fixture(), manager = new CatalogStub();
  install(f, { manager, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  try {
    const service = f.project.agentConnections;
    service.start();
    await service.save({ ...connection(), credential: undefined }, { api_key: 'secret-key' });
    expect(manager.catalogCalls).toBe(0);
    await clock.fire();
    expect(manager.catalogCalls).toBe(1);
    expect(JSON.stringify(service.models('conn-one'))).not.toContain('secret-key');
    // A service that was never started stays local-only after an edit.
    const idle = fixture(), idleManager = new CatalogStub();
    install(idle, { manager: idleManager, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
    await idle.project.agentConnections.save({ ...connection(), credential: undefined }, { api_key: 'secret-key' });
    expect(idleManager.catalogCalls).toBe(0);
    await idle.close();
    const plainFixture = fixture(); install(plainFixture, { manager: new ManagerStub() });
    const plain = plainFixture.project.agentConnections;
    plain.start();
    await plain.save({ ...connection(), credential: undefined }, { api_key: 'secret-key' });
    expect(plain.models('conn-one').status).toBe('unknown');
    expect(clock.waiting.size).toBe(1);
    await plainFixture.close();
  } finally { await f.close(); }
});
