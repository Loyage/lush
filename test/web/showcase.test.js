import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { repo, until } from '../helpers.js';
import { fetch, setup } from './harness.js';

const post = (f, method, params) => fetch(`${f.url}/api/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });

test('Web starts a showcase, serves sandboxed report and rejects symlink files and agent-only preview API', async () => {
  const f = await setup();
  try {
    await repo(f.root);
    f.project.provider = { async run({ context }) { fs.writeFileSync(context.showcase.report_path, '<!doctype html><h1>效果展示</h1>'); return 'shown'; } };
    const response = await post(f, 'showcase.start', { branch: 'main', baseline: 'main' });
    expect(response.status).toBe(200);
    const task = await response.json();
    await until(() => f.store.task(task.id).status === 'completed');
    const report = await fetch(`${f.url}/api/task/${task.id}/report`);
    expect(report.status).toBe(200);
    const csp = report.headers.get('content-security-policy');
    expect(csp).toContain('sandbox allow-scripts'); expect(csp).not.toContain('allow-same-origin');
    expect(csp).toContain("default-src 'none'"); expect(csp).toContain("frame-ancestors 'self'");
    expect(await report.text()).toContain('效果展示');
    const overview = await (await fetch(`${f.url}/api/overview`)).json();
    expect(overview.showcases[0].id).toBe(task.id);
    expect((await (await fetch(`${f.url}/api/showcases?branch=main`)).json())[0].has_report).toBe(true);
    expect((await post(f, 'showcase.preview', { command: ['echo', 'unsafe'] })).status).toBe(400);
    expect((await post(f, 'showcase.start', { branch: 'main', baseline: 'main', _token: 'forged' })).status).toBe(400);
    const file = f.project.reportPath(task.id);
    fs.unlinkSync(file); fs.symlinkSync(path.join(f.root, 'file.txt'), file);
    expect((await fetch(`${f.url}/api/task/${task.id}/report`)).status).toBe(400);
    fs.unlinkSync(file);
    expect((await fetch(`${f.url}/api/task/${task.id}/report`)).status).toBe(404);
    expect((await post(f, 'showcase.stop', { id: task.id })).status).toBe(200);
  } finally { await f.close(); }
});
