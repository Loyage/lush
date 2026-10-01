import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { projectRouteId } from '../../src/host/registry.js';
import { fetch, pageSource, setup } from './harness.js';

test('removed showcase resources and actions stay unavailable', async () => {
  const f = await setup();
  try {
    for (const prefix of ['', `/p/${projectRouteId(f.root)}`]) {
      expect((await fetch(f.url + prefix + '/api/showcases')).status).toBe(404);
      for (const method of ['showcase.reserve', 'showcase.unreserve', 'showcase.stop']) {
        expect((await fetch(f.url + prefix + '/api/action', { method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ method, params: { id: 1 } }) })).status).toBe(400);
      }
    }
    expect((await fetch(f.url + '/render-showcase.js')).status).toBe(404);
    const source = await pageSource(f.url);
    for (const removed of ['render-showcase.js', '预约展示', '预约效果展示', 'showcase.reserve', 'showcase.stop'])
      expect(source).not.toContain(removed);
    const css = await (await fetch(f.url + '/styles.css')).text();
    expect(css).not.toContain('role-showcase');
    expect(css).not.toContain('.showcase-');
  } finally { await f.close(); }
});

test('historical showcase reports return 404 without deleting data; verifier reports retain sandbox CSP', async () => {
  const f = await setup();
  try {
    // Seed historical rows directly: this is not a public creation path for retired roles.
    const historical = f.store.create({ role: 'agent', goal: 'historical result' });
    f.store.run("UPDATE tasks SET role='showcase',task_kind='showcase',showcase='{}',status='completed',result=? WHERE id=?", 'saved result', historical.id);
    const verifier = f.store.create({ role: 'agent', goal: 'verification result' });
    f.store.run("UPDATE tasks SET role='verifier',status='completed' WHERE id=?", verifier.id);
    const reportFile = (directory, task) => path.join(f.config.home, directory, String(task.id), 'report.html');
    const oldReport = reportFile('showcase', historical), verifyReport = reportFile('verify', verifier);
    for (const file of [oldReport, verifyReport]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '<!doctype html><h1>stored report</h1>');
    }
    for (const prefix of ['', `/p/${projectRouteId(f.root)}`]) {
      expect((await fetch(`${f.url}${prefix}/api/task/${historical.id}/report`)).status).toBe(404);
      const generic = await fetch(`${f.url}${prefix}/api/task/${historical.id}`);
      expect(generic.status).toBe(200);
      expect((await generic.json()).result).toBe('saved result');
      const report = await fetch(`${f.url}${prefix}/api/task/${verifier.id}/report`);
      expect(report.status).toBe(200);
      expect(await report.text()).toContain('stored report');
      expect(report.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
      expect(report.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(report.headers.get('content-type')).toContain('text/html');
    }
    expect(fs.readFileSync(oldReport, 'utf8')).toContain('stored report');
    expect(f.store.task(historical.id).result).toBe('saved result');
    fs.unlinkSync(verifyReport);
    expect((await fetch(`${f.url}/api/task/${verifier.id}/report`)).status).toBe(404);
  } finally { await f.close(); }
});
