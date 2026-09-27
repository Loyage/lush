import { test, expect } from 'bun:test';
import { repo } from '../helpers.js';
import { fetch, setup } from './harness.js';

test('Web exposes say and AP reads, not legacy mutations or pages', async () => {
  const f = await setup(); await repo(f.root);
  try {
    const page = await fetch(f.url);
    const html = await page.text();
    expect(html).toContain('AP 图');
    expect(html).toContain('/styles.css');
    expect((await fetch(f.url + '/styles-core.css')).status).toBe(200);
    expect(html).not.toContain('id="project-home"');
    const post = (method, params) => fetch(f.url + '/api/action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }),
    });
    const legacy = await post('input.submit', { content: 'old' });
    expect(legacy.status).toBe(400);
    expect((await fetch(f.url + '/api/overview')).status).toBe(200);
    expect((await fetch(f.url + '/api/snapshot')).status).toBe(200);
    const sent = await post('say.submit', { content: '新目标' });
    expect(sent.status).toBe(200);
    const created = await sent.json();
    expect(created.ap.ap_kind).toBe('say');
    expect((await fetch(f.url + `/api/ap/${created.ap.id}`)).status).toBe(200);
    const overview = await (await fetch(f.url + '/api/overview')).json();
    expect(overview.aps.some(ap => ap.id === created.ap.id)).toBe(true);
    const child = await post('ap.spawn', { parent: created.ap.id, goal: '独立子目标' });
    expect(child.status).toBe(200);
    expect((await child.json()).ap_kind).toBe('child');
    expect((await post('ap.reserve', { id: created.ap.id, kind: 'showcase' })).status).toBe(400);
  } finally { await f.close(); }
});
