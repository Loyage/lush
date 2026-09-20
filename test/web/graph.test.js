import { test, expect } from 'bun:test';
import { repo } from '../helpers.js';
import { PARAMS, USER_ONLY, AGENT_ONLY } from '../../src/rpc/registry.js';
import { fetch, pageSource, setup } from './harness.js';

// graph.get 的权限、/api/graph 的形状，以及页面确实带上了分支图入口与模块。

test('graph.get is read-only and readable by both user and agent', async () => {
  expect(PARAMS['graph.get']).toEqual([]);
  expect(USER_ONLY.has('graph.get')).toBe(false);
  expect(AGENT_ONLY.has('graph.get')).toBe(false);
  expect(PARAMS['branch.merge']).toEqual(['branch']);
  expect(PARAMS['branch.sync']).toEqual(['branch']);
  expect(USER_ONLY.has('branch.merge')).toBe(true);
  expect(USER_ONLY.has('branch.sync')).toBe(true);
  const f = await setup();
  try {
    await repo(f.root);
    const response = await fetch(f.url + '/api/graph');
    expect(response.status).toBe(200);
    const graph = await response.json();
    expect(Object.keys(graph).sort()).toEqual(['current_branch', 'edges', 'error', 'generated_at', 'git', 'nodes', 'truncated'].sort());
    expect(graph.git).toBe(true);
    expect(graph.error).toBeNull();
    expect(graph.current_branch).toBe('main');
    expect(graph.truncated).toBe(false);
    expect(Array.isArray(graph.nodes)).toBe(true);
    expect(Array.isArray(graph.edges)).toBe(true);
  } finally { await f.close(); }
});

test('web serves the branch-graph modules and wires the header entry', async () => {
  const f = await setup();
  try {
    const html = await (await fetch(f.url)).text();
    expect(html).toContain('id="graph-open"');
    expect(html).toContain('分支图');
    for (const file of ['/graph-layout.js', '/render-graph.js']) {
      const response = await fetch(f.url + file);
      expect(response.status).toBe(200);
    }
    expect(await (await fetch(f.url + '/graph-layout.js')).text()).toContain('export function graphLayout');
    const app = await pageSource(f.url);
    expect(app).toContain("from './render-graph.js'");
    expect(app).toContain("from './graph-layout.js'");
  } finally { await f.close(); }
});
