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
    const daemon = await cli(root, ['start']); expect(daemon.pid).not.toBe(process.pid);
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
    for (const command of ['lush --json worker list', 'lushw --json self inspect', 'lushw --json parent inspect',
      'lushw --json children list', `lush worker rename ${id} actual-cli`, "lushw --json self notice post 'user write' --kind info"]) {
      const preview = await post('worker.cli_preview', { id, command }); expect(preview.code).toBe(200);
      if (preview.value.requires_confirmation) {
        expect((await post('worker.cli_execute', { id, command, revision: preview.value.revision })).code).not.toBe(200);
      }
      const result = await post('worker.cli_execute', { id, command, revision: preview.value.revision, confirm: true });
      expect(result.code).toBe(200); expect(result.value).toMatchObject({ status: 'succeeded', exit_code: 0 });
      expect(result.value.workspace).toBe(created.value.task.workspace);
    }
    expect((await new UIClient(config).request('worker.inspect', { id })).display_title).toBe('actual-cli');
    const saved = await post('worker.cli_history', { id });
    expect(saved.value.entries).toHaveLength(6);
    expect((await post('worker.cli_history_clear', { id })).value).toEqual({ cleared: true });
    expect((await post('worker.cli_history', { id })).value).toEqual({ entries: [], before: null, has_more: false });
  } finally { if (web) await web.stop(true); await cli(root, ['stop']).catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); }
});
