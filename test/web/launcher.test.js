import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp, gate } from '../helpers.js';
import { fetch } from './harness.js';
import { startTestWeb } from './auth-fixture.js';
import { projectRouteId } from '../../src/host/registry.js';

test('empty workbench explicitly opens a project and routes reads by its registered identity', async () => {
  const root = temp(), global = temp(), calls = [], refreshing = gate(), release = gate();
  let sourceOffline = false;
  const notice = { id: 1, task_id: 1, title: 'Source notice', body: 'REMOVED-SOURCE-CANARY', kind: 'info', status: 'sent',
    answer: null, source_event_id: null, read_at: null, created_at: '2026-01-01T00:00:00.000Z', answer_source: null,
    task_worker_number: 'W1', lifecycle_type: null, sync_identity: 'a'.repeat(32), sync_epoch: 'b'.repeat(32), sync_revision: 1 };
  const web = startTestWeb(null, 0, { env: { ...process.env, LUSH_GLOBAL_CONFIG: global },
    openProject: async project => {
      calls.push(project);
      return { config: { project, home: path.join(project, '.lush') }, client: {
        snapshot: async () => ({ status: { project } }),
        async request(method) {
          expect(method).toBe('notice.sync');
          if (sourceOffline) { refreshing.resolve(); await release.promise; throw new Error('source offline'); }
          return { version: 1, project, epoch: notice.sync_epoch, reset: true, has_more: false, cursor: 'one',
            changes: [{ id: notice.id, identity: notice.sync_identity, deleted: false, notice }] };
        },
      } };
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
    // The same registered identity controls cached inbox reads, including a source
    // removed while an in-flight refresh is failing (not just the online branch).
    const inbox = await (await fetch(url + '/api/host/inbox')).json();
    expect(inbox.items[0].notice.body).toBe(notice.body);
    sourceOffline = true;
    const pending = fetch(`${url}/api/host/inbox/notice?project_id=${id}&id=1`);
    await refreshing.promise;
    const removed = await fetch(url + '/api/host/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    expect(removed.status).toBe(200); await removed.json(); release.resolve();
    const detail = await pending;
    expect(detail.status).toBe(400); expect(await detail.text()).not.toContain(notice.body);
    expect(calls).toEqual([fs.realpathSync(root)]);
  } finally { release.resolve(); await web.stop(true); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(global, { recursive: true, force: true }); }
});
