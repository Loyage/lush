import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { setup, fetch } from './harness.js';
import { startTestWeb } from './auth-fixture.js';
import { repo, temp, env } from '../helpers.js';
import { install, resource, digest } from '../project/agent-connection-fixture.js';
import { ConnectionManager } from '../../src/agent/connections.js';
import { PiProvider } from '../../src/agent/provider.js';
import { prunePiDiagnostics, readPiDiagnostics } from '../../src/agent/pi-diagnostics.js';
import { UIClient } from '../../src/ui/client.js';
import { Store } from '../../src/persistence/store.js';
import { writeLauncherState, projectRouteId } from '../../src/host/registry.js';
import { HostDiagnosticQuery } from '../../src/host/diagnostics-query.js';
import { diagnosticsQuery, diagnosticsRequest } from '../../src/core/diagnostics-query.js';
import { managementPolicy } from '../../src/rpc/management-policy.js';

// A single missing key flow: actual Provider process + shipped extension + scheduler + socket + HTTP + Host.
// Existing source lifecycle tests do not exercise model-event timing or the new query registration.
test('passive diagnostics persists invocation-only timing and serves bounded user-only project/Host analysis', async () => {
  const f = await setup(), offline = temp(); let network = 0, host;
  const manager = new ConnectionManager(f.config, { fetch: async () => { network++; throw Error('no probe allowed'); } });
  install(f, { manager, now: Date.now });
  const client = new UIClient(f.config), file = path.join(f.root, 'fixture-pi');
  try {
    await repo(f.root); await f.project.ensureMainTask(); f.project.kick = () => {};
    const source = await client.request('agent.connections.save', { connection: { label: 'Fixture', provider: 'deepseek', auth_type: 'api_key', models: ['deepseek-chat'] }, credential: { api_key: 'PRIVATE-TEST-SECRET' } });
    const model = 'deepseek/deepseek-chat';
    fs.writeFileSync(file, `#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { RPCClient } from ${JSON.stringify(new URL('../../src/rpc/client.js', import.meta.url).pathname)};
const rpc = new RPCClient(${JSON.stringify(f.config.socket)});
let denied = false;
try { await rpc.request('system.diagnostics.query', { _token: process.env.LUSH_AGENT_TOKEN }); } catch (error) { denied = error.message.includes('user approval'); }
if (!denied) throw Error('Agent diagnostic permission was not denied');
const handlers = new Map();
const pi = { on(name, callback) { const list = handlers.get(name) || []; list.push(callback); handlers.set(name, list); }, appendEntry() {} };
for (let i = 0; i < process.argv.length; i++) if (process.argv[i] === '--extension') (await import(process.argv[++i])).default(pi);
let clock = 0; Object.defineProperty(globalThis, 'performance', { value: { now: () => clock } });
const emit = async (name, event = {}) => { for (const callback of handlers.get(name) || []) await callback(event, {}); };
const delta = async (at, type, text = '') => { clock = at; await emit('message_update', { assistantMessageEvent: { type, contentIndex: 0, delta: text } }); };
const message = output => ({ role: 'assistant', provider: 'deepseek', model: 'deepseek-chat', stopReason: 'stop', usage: { input: 10, cacheRead: 5, cacheWrite: 0, output, cost: { total: .01 } }, content: [{ type: 'text', text: 'PRIVATE-CONTENT' }] });
await emit('session_start');
await emit('before_provider_request');
await delta(50, 'text_delta'); await delta(100, 'thinking_delta', 'PRIVATE-THOUGHT'); await delta(200, 'text_start');
await delta(300, 'text_delta', 'Hello'); await delta(500, 'text_delta', ' 🌍');
await delta(600, 'thinking_delta', 'PRIVATE-THOUGHT'); await delta(800, 'text_delta', 'x'); await delta(1000, 'text_delta', 'yz');
clock = 1200; await emit('message_end', { message: message(20) });
clock = 2000; await emit('before_provider_request'); await delta(2100, 'toolcall_delta', 'PRIVATE-TOOL');
clock = 2400; await emit('message_end', { message: message(10) });
await emit('session_shutdown');
// Old card stays compatible with original sessions. A copied unrelated row never reaches new diagnostics.
const context = JSON.parse(process.env.LUSH_RUNTIME_CONTEXT), at = new Date().toISOString();
fs.writeFileSync(path.join(context.sessions_dir, 'fixture_lush-task-' + context.task_id + '.jsonl'), [
  { type: 'message', timestamp: at, lush: { task_id: 999999, run_id: 999999 }, message: message(9999) },
  { type: 'custom', customType: 'lush.invocation', data: { task_id: context.task_id, run_id: context.run_id } },
  { type: 'message', timestamp: at, message: message(30) }
].map(row => JSON.stringify(row)).join('\\n') + '\\n');
console.log('diagnostics fixture complete');
`, { mode: 0o755 });
    f.config.env.LUSH_PI_COMMAND = file;
    f.project.provider = new PiProvider(f.config);
    const task = (await f.project.order('capture diagnostics', 'main', [], null, false, undefined,
      { agent: 'pi', config_mode: 'lush', connection_id: source.id, model })).task;
    await client.request('worker.resume', { id: task.id }); f.project.pump();
    await Promise.all([...f.project.running.values()].map(run => run.promise));
    expect(f.store.task(task.id).result).toBe('diagnostics fixture complete');
    const range = diagnosticsRequest(diagnosticsQuery({}));
    const snapshot = await client.request('system.diagnostics.query', range);
    expect(snapshot.summary).toMatchObject({ requests: 2, input_tokens: 30, output_tokens: 30, text_samples: 1, response_samples: 2,
      text_chars: 4, text_ms: 400, response_ms: 1600, text_chars_per_second: 10, response_tokens_per_second: 18.75,
      wait_mean_ms: 100, ttft_mean_ms: 300 });
    expect(snapshot.coverage).toMatchObject({ unknown_runs: 0, samples: 2, complete: true });
    expect(snapshot.groups[0]).toMatchObject({ connection_id: source.id, model });
    const hourly = await client.request('system.diagnostics.query', { to: snapshot.range.to,
      from: new Date(Date.parse(snapshot.range.to) - 3600000).toISOString() });
    expect(hourly.range.bucket_ms).toBe(60000); expect(hourly.buckets.length).toBeGreaterThanOrEqual(60);
    expect(hourly.buckets.length).toBeLessThanOrEqual(61);
    expect(hourly.buckets.reduce((sum, bucket) => sum + bucket.output_tokens, 0)).toBe(snapshot.summary.output_tokens);
    expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE-|lush-test-|agent_token/);
    expect(fs.readdirSync(path.join(f.config.home, 'sessions')).filter(name => name.startsWith('.diagnostics-'))).toEqual([]);
    expect(managementPolicy('system.diagnostics.query').access).toBe('unavailable');
    const saved = new Store(path.join(f.config.home, 'project.db'), f.root);
    try { expect(saved.diagnosticsRows(snapshot.range).samples).toHaveLength(2); } finally { saved.close(); }
    const runId = f.store.runsForTask(task.id)[0].id;
    f.store.recordDiagnosticsRun(runId, { rows: [], dropped: 0 }); // idempotent, never erases a finished capture
    expect(f.store.diagnosticsRows(snapshot.range).samples).toHaveLength(2);
    const old = await client.request('system.diagnostics');
    expect(old.windows[0].output).toBe(30); expect(old.buckets).toHaveLength(60);

    // Safe existing quota history, with failures/resets and distinct account segments. No network refresh.
    const now = Date.now(), account = digest('account'), sourceKey = digest('source');
    for (const [i, remaining, status, account_key] of [[0, 80, 'available', account], [1, 60, 'available', account],
      [2, null, 'error', account], [3, 55, 'available', account], [4, 100, 'available', account], [5, 10, 'available', digest('other-account')]]) {
      f.store.recordAgentConnectionObservation({ query_key: 'diag-' + i, connection_id: source.id, provider: 'deepseek', account_key, source_key: sourceKey,
        observation: { status, checked_at: new Date(now - 6000 + i * 500).toISOString(), source: 'usage_api', resources: [resource(remaining,
          { reset_at: new Date(now + (i === 4 ? 7200000 : 3600000)).toISOString() })] } });
    }
    const read = async route => { const response = await fetch(f.url + route); expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toContain('no-store'); return response.json(); };
    const projected = await read(`/api/diagnostics/query?connection_id=${source.id}&model=${model}`);
    expect(projected.quota.series).toHaveLength(2);
    const points = projected.quota.series.find(row => row.account_key === account).points;
    expect(points.map(point => point.remaining_change)).toEqual([null, -20, null, null, null]);
    expect(points.at(-1).reset).toBe(true);
    expect(projected.quota.model_filter_applied).toBe(false);
    for (const query of ['from=bad', 'model=a&model=b', 'unknown=1', 'project_id=0000000000000000'])
      expect((await fetch(f.url + '/api/diagnostics/query?' + query)).status).toBe(400);
    await expect(client.request('system.diagnostics.query', { unexpected: 1 })).rejects.toThrow();
    const page = await read('/api/host/diagnostics/query');
    expect(page.summary.output_tokens).toBe(30); expect(page.coverage.projects_reporting).toBe(1);
    expect((await read('/api/host/diagnostics')).windows[0].output).toBe(30);
    expect((await fetch(f.url + '/api/diagnostics/query', { anonymous: true })).status).toBe(401);
    expect((await fetch(f.url + '/api/host/diagnostics/query', { headers: { Origin: 'https://untrusted.invalid' } })).status).toBe(403);
    const weighted = new HostDiagnosticQuery(() => [1,2].map(index => ({ id: String(index).padStart(16, '0'), name: 'fixture',
      async query(params) {
        const raw = await client.request('system.diagnostics.query', params);
        if (index === 2) for (const row of [raw.summary, ...raw.buckets, ...raw.groups]) {
          row.response_tokens *= 4; row.output_tokens *= 4; row.response_ms *= 2;
        }
        raw.secret = 'PRIVATE-HOST-RAW'; return raw;
      } })));
    const combined = await weighted.read(range);
    expect(combined.summary.response_tokens_per_second).toBe(31.25);
    expect(JSON.stringify(combined)).not.toContain('PRIVATE-HOST-RAW');

    // Registered offline projects stay offline; the analysis root never calls openProject/start.
    writeLauncherState(f.root, f.config.env); writeLauncherState(offline, f.config.env);
    host = startTestWeb(null, 0, { env: env({ LUSH_GLOBAL_CONFIG: f.config.env.LUSH_GLOBAL_CONFIG }), openProject: async () => { throw Error('must not attach'); } });
    const url = `http://127.0.0.1:${host.port}`;
    const aggregate = await (await fetch(url + '/api/host/diagnostics/query')).json();
    expect(aggregate.summary.output_tokens).toBe(30); expect(aggregate.coverage).toMatchObject({ projects_total: 2, projects_reporting: 1, complete: false });
    expect(aggregate.projects.find(row => row.id === projectRouteId(offline)).state).toBe('offline');
    expect(aggregate.quota.series.every(row => row.project_id === projectRouteId(f.root))).toBe(true);
    const filtered = await (await fetch(url + '/api/host/diagnostics/query?project_id=' + projectRouteId(f.root))).json();
    expect(filtered.coverage.projects_total).toBe(1);
    expect(fs.existsSync(path.join(offline, '.lush'))).toBe(false);
    expect((await fetch(url + '/api/host/diagnostics/query?project_id=0000000000000000')).status).toBe(400);
    expect(network).toBe(0);
    // Cancellation owns the fanout sockets/timers; nothing waits on an abandoned source.
    const abort = new AbortController(); let cancelled = false;
    const queries = new HostDiagnosticQuery(() => [{ id: '0000000000000001', name: 'slow', query(_params, signal) {
      signal.addEventListener('abort', () => { cancelled = true; }); abort.abort(); return new Promise(() => {});
    } }]);
    await queries.read({}, abort.signal); expect(cancelled).toBe(true); expect(queries.active).toBe(0);

    // Source/model edits never rewrite the captured attribution; old/unsupported runs remain gaps on reload.
    await client.request('agent.connections.remove', { id: source.id });
    const missing = f.store.startRun(f.store.task(task.id), { agent: 'codex', model: 'old-model' });
    f.store.finishRun(missing.id, 'completed');
    const final = await client.request('system.diagnostics.query');
    expect(final.groups[0].connection_id).toBe(source.id); expect(final.quota.series).toHaveLength(2);
    expect(final.coverage.unknown_runs).toBeGreaterThan(0);
    expect((await client.request('system.diagnostics.query')).coverage.unknown_runs).toBe(final.coverage.unknown_runs);
    const payload = f.store.get('SELECT payload FROM diagnostic_samples LIMIT 1').payload;
    expect(payload).not.toMatch(/PRIVATE-|content|headers|credential/);
    const stale = fs.mkdtempSync(path.join(f.config.home, 'sessions', '.diagnostics-'));
    const sampleFile = path.join(stale, 'samples.json');
    fs.writeFileSync(sampleFile, '{broken', { mode: 0o600 }); expect(readPiDiagnostics(sampleFile)).toBeNull();
    fs.utimesSync(stale, new Date(0), new Date(0));
    await prunePiDiagnostics(f.config); expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(path.join(f.config.home, 'sessions', `fixture_lush-task-${task.id}.jsonl`))).toBe(true);
    f.project.startDiagnosticsRetention(); await f.project.stopDiagnosticsRetention();
    expect(f.project.diagnosticsRetentionTimer).toBeNull();
    f.store.pruneDiagnostics(Date.now() + 31 * 86400000);
    expect(f.store.get('SELECT COUNT(*) AS n FROM diagnostic_samples').n).toBe(0);
    expect(f.store.runsForTask(task.id).length).toBe(2);
    expect(f.store.get('SELECT COUNT(*) AS n FROM agent_connection_points').n).toBeGreaterThan(0);
  } finally { host?.stop(true); await f.close(); fs.rmSync(offline, { recursive: true, force: true }); }
});
