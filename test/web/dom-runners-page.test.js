import { test, expect } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';
import { runnersHash } from '../../src/ui/web/assets/runner-page-route.js';

const A = 'aaaaaaaaaaaaaaaa', B = 'bbbbbbbbbbbbbbbb', NODE = '11111111-1111-4111-8111-111111111111';

test('global Runner deep link selects its source project and preserves device settings across source changes', async () => {
  const world = makeWorld(), calls = [];
  const dom = installDom({ fetch: (url, options) => {
    const path = String(url); calls.push(path);
    if (path === '/api/host/projects') return Response.json({ projects: [{ id: A, name: 'Alpha', running: true }, { id: B, name: 'Beta', running: true }] });
    if (path.endsWith('/runner/nodes')) return Response.json({ revision: 'absent', nodes: [{ id: NODE, name: '节点一', enabled: true, ssh_alias: 'lab', expected_runner_id: null, budgets: {} }] });
    if (path.endsWith('/runner/credentials')) return Response.json({ revision: 'absent', nodes: [] });
    const source = /^\/p\/([a-f0-9]{16})\/api\/runner\/project$/.exec(path)?.[1];
    if (source) return Response.json({ version: 1, revision: 0, project_id: `paired-${source}`, allowed_node_ids: [NODE], default_node_id: 'local' });
    return world.fetchImpl(url, options);
  } });
  try {
    const { boot } = await import('../../src/ui/web/assets/app.js'); dom.location.hash = runnersHash(A); await boot();
    const root = dom.node('detail'), device = root.querySelector('.runner-settings');
    expect(device).toBeTruthy(); expect(deepText(root)).toContain(`来源项目：Alpha · Host ID：${A}`);
    const select = root.querySelector('[aria-label="来源项目"]'); select.value = B; await select.onchange();
    expect(dom.location.hash).toBe(runnersHash(B)); expect(deepText(root)).toContain(`来源项目：Beta · Host ID：${B}`);
    expect(root.querySelector('.runner-settings')).toBe(device);
    expect(calls.filter(path => path.includes('/runner/project'))).toEqual([`/p/${A}/api/runner/project`, `/p/${B}/api/runner/project`]);
  } finally { dom.restore(); }
});
