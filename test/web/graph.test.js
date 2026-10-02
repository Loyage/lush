import { test, expect } from 'bun:test';
import { repo } from '../helpers.js';
import { PARAMS, USER_ONLY, AGENT_ONLY } from '../../src/rpc/registry.js';
import { fetch, pageSource, setup } from './harness.js';

test('worker.graph remains read-only; the branch genealogy RPC remains available without a Web view', () => {
  for (const method of ['worker.graph', 'graph.get']) {
    expect(PARAMS[method]).toEqual([]);
    expect(USER_ONLY.has(method)).toBe(false);
    expect(AGENT_ONLY.has(method)).toBe(false);
  }
  expect(PARAMS['branch.archive']).toEqual(['branch', 'discard']);
  expect(USER_ONLY.has('branch.archive')).toBe(true);
  for (const method of ['branch.merge', 'branch.sync', 'branch.catchup']) expect(PARAMS[method]).toBeUndefined();
});

test('worker.graph is a project-scoped read model', async () => {
  const f = await setup();
  try {
    await repo(f.root);
    const result = await fetch(f.url + '/api/worker-graph');
    expect(result.status).toBe(200);
    const graph = await result.json();
    expect(Object.keys(graph).sort()).toEqual(['nodes','edges','truncated','total'].sort());
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect((await fetch(f.url + '/api/graph')).status).toBe(404);
  } finally { await f.close(); }
});

test('Web has no branch view entry or renderer; Task graph owns diagnostics and decisions', async () => {
  const f = await setup();
  try {
    const html = await (await fetch(f.url)).text();
    expect(html).not.toContain('id="graph-open"');
    expect(html).not.toContain('分支与合并');
    expect(html).toContain('id="task-graph-open"');
    for (const file of ['/graph-layout.js', '/render-graph.js']) expect((await fetch(f.url + file)).status).toBe(404);
    const app = await pageSource(f.url);
    expect(app).not.toContain("from './render-graph.js'");
    expect(app).not.toContain("from './graph-layout.js'");
    const parts = await fetch(f.url + '/task-graph-parts.js');
    expect(parts.status).toBe(200);
    expect(await parts.text()).toContain('export function branchDiagnostics');
  } finally { await f.close(); }
});
