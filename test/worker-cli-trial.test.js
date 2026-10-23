import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { repo, env, temp } from './helpers.js';
import { fetch } from './web/harness.js';
import { cli } from './integration/harness.js';
import { Config } from '../src/config.js';
import { UIClient } from '../src/ui/client.js';
import { startTestWeb } from './web/auth-fixture.js';

test('isolated separate daemon and authenticated HTTP bridge execute real query and confirmed mutation', async () => {
  const root = temp(); await repo(root);
  let web;
  try {
    const daemon = await cli(root, ['daemon', 'start']); expect(daemon.pid).not.toBe(process.pid);
    const config = new Config({ project: root, env: env() }); web = startTestWeb(config, 0);
    const url = `http://127.0.0.1:${web.port}/api/action`;
    const post = async (method, params, options = {}) => {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, params }), ...options });
      return { code: response.status, value: response.status === 200 ? await response.json() : null };
    };
    const created = await post('order.submit', { content: 'separate-daemon CLI', start: false });
    const id = created.value.task.id;
    expect((await post('worker.cli_preview', { id, command: 'lush status' }, { anonymous: true })).code).toBe(401);
    for (const command of ['lush --json worker list', 'lushw --json self show', 'lushw --json parent show',
      'lushw --json children list', `lush worker rename ${id} actual-cli`, "lushw --json self notice notify 'user write'"]) {
      const preview = await post('worker.cli_preview', { id, command }); expect(preview.code).toBe(200);
      if (preview.value.requires_confirmation) {
        expect((await post('worker.cli_execute', { id, command, revision: preview.value.revision })).code).not.toBe(200);
      }
      const result = await post('worker.cli_execute', { id, command, revision: preview.value.revision, confirm: true });
      expect(result.code).toBe(200); expect(result.value).toMatchObject({ status: 'succeeded', exit_code: 0 });
      expect(result.value.workspace).toBe(created.value.task.workspace);
    }
    const client = new UIClient(config);
    expect((await client.request('worker.inspect', { id })).display_title).toBe('actual-cli');
    const mainId = created.value.task.parent_id;
    expect((await client.request('worker.inspect', { id: mainId })).task_kind).toBe('main');
    const mainCommands = ['lush --json status', 'lushw --json self show', 'lushw --json children list',
      `lush worker rename ${id} main-cli`, "lushw --json self notice notify 'main user notice'", "lush --json order 'main CLI mock Agent instruction'"];
    for (const command of mainCommands) {
      const plan = await post('worker.cli_preview', { id: mainId, command }); expect(plan.code).toBe(200);
      expect(plan.value.workspace).toBe(root);
      if (plan.value.requires_confirmation) expect((await post('worker.cli_execute', { id: mainId, command, revision: plan.value.revision })).code).not.toBe(200);
      const run = await post('worker.cli_execute', { id: mainId, command, revision: plan.value.revision, confirm: true });
      expect(run.code).toBe(200); expect(run.value).toMatchObject({ status: 'succeeded', exit_code: 0, workspace: root });
      if (plan.value.kind === 'agent') {
        expect(plan.value.requires_confirmation).toBe(true);
        const submitted = JSON.parse(run.value.stdout).data;
        expect(submitted).toMatchObject({ emitted: true, parent_id: mainId, dispatch: { state: 'queued' } });
      }
      expect((await post('worker.cli_execute', { id: mainId, command, revision: plan.value.revision, confirm: true })).code).not.toBe(200);
    }
    expect((await client.request('worker.inspect', { id })).display_title).toBe('main-cli');
    const mainHistory = await post('worker.cli_history', { id: mainId });
    expect(mainHistory.value.entries.map(row => row.command)).toEqual(mainCommands);
    expect((await post('worker.cli_history_clear', { id: mainId })).value).toEqual({ cleared: true });
    expect((await post('worker.cli_history', { id: mainId })).value.entries).toHaveLength(0);
    const saved = await post('worker.cli_history', { id });
    expect(saved.value.entries).toHaveLength(6);
    expect((await post('worker.cli_history_clear', { id })).value).toEqual({ cleared: true });
    expect((await post('worker.cli_history', { id })).value).toEqual({ entries: [], before: null, has_more: false });
  } finally { if (web) await web.stop(true); await cli(root, ['daemon', 'stop']).catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); }
});
