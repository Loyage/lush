import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp } from '../helpers.js';
import { fetch } from './harness.js';
import { startTestWeb } from './auth-fixture.js';
import { projectRouteId } from '../../src/host/registry.js';

test('empty workbench explicitly opens a project and routes reads by its registered identity', async () => {
  const root = temp(), global = temp(), calls = [];
  const web = startTestWeb(null, 0, { env: { ...process.env, LUSH_GLOBAL_CONFIG: global },
    openProject: async project => {
      calls.push(project);
      return { config: { project, home: path.join(project, '.lush') }, client: { snapshot: async () => ({ status: { project } }) } };
    } });
  const url = `http://127.0.0.1:${web.port}`;
  try {
    expect(await (await fetch(url + '/api/host')).json()).toMatchObject({ project: null, projects: [] });
    expect(await (await fetch(url + '/')).text()).toContain('id="projects-open"');
    const selected = await fetch(url + '/api/host/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: root }) });
    expect(selected.status).toBe(200); const id = projectRouteId(fs.realpathSync(root));
    expect(await selected.json()).toMatchObject({ id, project: fs.realpathSync(root) });
    expect(calls).toEqual([fs.realpathSync(root)]);
    expect((await fetch(`${url}/p/${id}/api/snapshot`)).status).toBe(200);
  } finally { web.stop(true); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(global, { recursive: true, force: true }); }
});
