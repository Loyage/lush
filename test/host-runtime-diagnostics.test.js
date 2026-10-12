import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp, env } from './helpers.js';
import { HostRuntimeDiagnostics, diagnosticsView } from '../src/host/runtime-diagnostics.js';
import { RuntimeDiagnostics } from '../src/core/runtime-diagnostics.js';
import { createProjectHost } from '../src/host/project-host.js';
import { writeLauncherState, projectRouteId } from '../src/host/registry.js';

async function sample(now) {
  const root = temp(); fs.mkdirSync(path.join(root, 'sessions'));
  fs.writeFileSync(path.join(root, 'sessions', 'x_lush-task-2.jsonl'), JSON.stringify({ type: 'message', timestamp: new Date(now).toISOString(),
    message: { role: 'assistant', usage: { input: 60, output: 30, cacheRead: 10, cacheWrite: 5, cost: { total: 0.6 } } } }) + '\n');
  try { return await new RuntimeDiagnostics({ home: root }, { now: () => now }).read(); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const source = (id, read) => ({ id, name: id, read });

test('Host sums reporting projects and independently marks offline, unsupported, timeout and malformed sources', async () => {
  const now = Date.now(), report = await sample(now); let calls = 0, aborted = false;
  const sources = [source('a', async () => { calls++; return { ...report, credential: 'secret' }; }), source('b', async () => report),
    source('offline', async () => null), source('old', async () => { throw Object.assign(new Error('secret'), { code: -32601 }); }),
    source('slow', signal => new Promise(() => { signal.addEventListener('abort', () => { aborted = true; }); })),
    source('bad', async () => ({ ...report, windows: [] }))];
  const host = new HostRuntimeDiagnostics(() => sources, { now: () => now, timeoutMs: 15 });
  const [a, b] = await Promise.all([host.read(), host.read()]); expect(a).toEqual(b); expect(calls).toBe(1); expect(aborted).toBe(true);
  expect(a.coverage).toEqual({ projects_total: 6, projects_online: 3, projects_reporting: 2, complete: false });
  expect(a.windows[0]).toMatchObject({ input: 150, output: 60, cost: 1.2, requests: 2, unknown_cost: 4, complete: false });
  expect(a.projects.map(p => p.state)).toEqual(['online','online','offline','unsupported','unavailable','unavailable']);
  expect(JSON.stringify(a)).not.toContain('secret'); expect(a.projects.every(p => !('project' in p))).toBe(true);
});

test('Host numeric/time whitelist rejects invalid and stale data; complete projects and empty registry stay distinct', async () => {
  const now = Date.now(), report = await sample(now);
  expect(diagnosticsView(report, now)?.coverage.complete).toBe(true);
  for (const mutate of [r => r.windows[0].input = -1, r => r.windows[0].cost = Infinity, r => r.windows[0].requests = 1.5,
    r => r.windows[0].input_per_second = 0, r => r.windows[0].unknown_cost = 1,
    r => r.buckets[0].at = r.buckets[1].at, r => r.generated_at = 'invalid', r => r.currency = 'EUR']) {
    const bad = structuredClone(report); mutate(bad); expect(diagnosticsView(bad, now)).toBeNull();
  }
  expect(diagnosticsView(report, now + 15_001)).toBeNull();
  const partial = structuredClone(report); partial.coverage.complete = false;
  partial.windows[1].unknown_cost = 1; partial.windows[1].complete = false;
  partial.buckets[40].unknown_cost = 1;
  // A complete minute window can coexist with an incomplete five-minute/ten-minute range.
  expect(diagnosticsView(partial, now)?.windows[0].complete).toBe(true);
  const full = await new HostRuntimeDiagnostics(() => [source('a', async () => report)], { now: () => now }).read();
  expect(full.coverage.complete).toBe(true); expect(full.windows[0].complete).toBe(true);
  const empty = await new HostRuntimeDiagnostics(() => [], { now: () => now }).read(); expect(empty.coverage.complete).toBe(false);
  expect(empty.windows.every(w => !w.complete)).toBe(true);
});

test('Host bounded concurrency, global budget and registry cache changes prevent unbounded work or stale access', async () => {
  const now = Date.now(), report = await sample(now); let active = 0, peak = 0, calls = 0;
  let sources = Array.from({ length: 12 }, (_, i) => source(String(i), async () => {
    calls++; active++; peak = Math.max(active, peak); await Bun.sleep(10); active--; return report;
  }));
  const host = new HostRuntimeDiagnostics(() => sources, { now: () => now, concurrency: 2, budgetMs: 25 });
  const r = await host.read(); expect(peak).toBe(2); expect(calls).toBeLessThan(12); expect(r.coverage.complete).toBe(false);
  sources = [source('new', async () => report)];
  const next = await host.read(); expect(next.projects.map(p => p.id)).toEqual(['new']); expect(next.coverage.complete).toBe(true);
});

test('Host treats missing bucket alignment as unknown and rechecks a registry changed during sampling', async () => {
  const now = Math.floor(Date.now() / 10_000) * 10_000 + 9999, report = await sample(now + 1);
  const shifted = await new HostRuntimeDiagnostics(() => [source('a', async () => report)], { now: () => now }).read();
  expect(shifted.buckets[0].unknown_cost).toBe(1); expect(shifted.coverage.complete).toBe(false);
  let release; const gate = new Promise(resolve => { release = resolve; });
  let sources = [source('removed', async () => { await gate; return report; })];
  const host = new HostRuntimeDiagnostics(() => sources, { now: () => now });
  const pending = host.read(); sources = []; release();
  const safe = await pending; expect(safe.projects).toEqual([]); expect(safe.coverage.projects_total).toBe(0);
});

test('projectHost diagnostics only uses authorized registry/socket reads and never starts or attaches offline daemons', async () => {
  const root = temp(), global = temp(), projects = ['a','b','denied'].map(n => { const p = path.join(root, n); fs.mkdirSync(p); return p; });
  const environment = env({ LUSH_GLOBAL_CONFIG: global });
  for (const project of projects) writeLauncherState(project, environment);
  let opens = 0, attaches = 0;
  const host = createProjectHost(null, { env: environment, allowedProjects: projects.slice(0, 2),
    openProject: async () => { opens++; throw new Error('must not start'); }, attachProject: async () => { attaches++; throw new Error('must not attach'); } });
  try {
    const r = await host.diagnostics();
    expect(r.projects.map(p => p.id)).toEqual(projects.slice(0, 2).map(projectRouteId));
    expect(r.projects.every(p => p.state === 'offline')).toBe(true); expect(r.coverage.complete).toBe(false);
    expect(opens).toBe(0); expect(attaches).toBe(0);
    expect(projects.every(p => !fs.existsSync(path.join(p, '.lush')))).toBe(true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(global, { recursive: true, force: true }); }
});
