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
    const action = async (method, params) => {
      const response = await fetch(url + '/api/host/settings/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
      expect(response.status).toBe(200); return response.json();
    };
    const emptyModels = await fetch(url + '/api/host/settings/agent/registered-models');
    expect(emptyModels.headers.get('cache-control')).toContain('no-store');
    expect(await emptyModels.json()).toEqual({ version: 1, models: [], storage_scope: 'device' });
    expect(fs.existsSync(path.join(global, 'shared'))).toBe(false);
    const source = await action('agent.connections.save', { connection: { label: 'Host source', provider: 'deepseek', auth_type: 'api_key', models: ['deepseek-chat'] }, credential: { api_key: 'host-fixture-secret' } });
    const model = await action('agent.registered_models.save', { model: { name: 'host model', connection_id: source.id, model: 'deepseek/deepseek-chat' } });
    expect(await action('agent.registered_models.resolve', { selector: model.id })).toEqual({ id: model.id, name: model.name, connection_id: source.id, model: model.model });
    await action('agent.connections.remove', { id: source.id });
    const unavailable = await (await fetch(url + '/api/host/settings/agent/registered-models')).json();
    expect(unavailable.models[0]).toMatchObject({ id: model.id, selectable: false, reason: 'source_missing', source: null });
    expect(JSON.stringify(unavailable)).not.toContain('host-fixture-secret');
    await action('agent.registered_models.remove', { id: model.id });
    expect(calls).toEqual([]); // Device settings never attach a project or start its daemon.
    const selected = await fetch(url + '/api/host/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: root }) });
    expect(selected.status).toBe(200); const id = projectRouteId(fs.realpathSync(root));
    expect(await selected.json()).toMatchObject({ id, project: fs.realpathSync(root) });
    expect(calls).toEqual([fs.realpathSync(root)]);
    expect((await fetch(`${url}/p/${id}/api/snapshot`)).status).toBe(200);
  } finally { web.stop(true); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(global, { recursive: true, force: true }); }
});
