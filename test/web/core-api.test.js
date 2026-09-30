import { test, expect } from 'bun:test';
import { repo } from '../helpers.js';
import { fetch, setup } from './harness.js';

test('Web exposes say and task reads, not legacy mutations or pages', async () => {
  const f = await setup(); await repo(f.root);
  try {
    const page = await fetch(f.url);
    const html = await page.text();
    expect(html).toContain('<strong>任务树</strong>');
    expect(html).not.toContain('Task 图');
    const workspaceNav = html.match(/<nav class="workspace-nav"[^>]*>([\s\S]*?)<\/nav>/)[1];
    expect([...workspaceNav.matchAll(/id="([^"]+)-open"/g)].map(match => match[1]))
      .toEqual(['overview', 'task-graph']);
    expect(html).toContain('/styles.css');
    expect((await fetch(f.url + '/styles-core.css')).status).toBe(200);
    expect(html).not.toContain('id="project-home"');
    const post = (method, params) => fetch(f.url + '/api/action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }),
    });
    const legacy = await post('input.submit', { content: 'old' });
    expect(legacy.status).toBe(400);
    // 本地分支绑定按用户决定仅保留 CLI / RPC，不留 Web 动作入口。
    expect((await post('branch.bind', { branch: 'feature', commit: 'a'.repeat(40) })).status).toBe(400);
    expect((await fetch(f.url + '/api/graph')).status).toBe(404);
    expect((await fetch(f.url + '/api/overview')).status).toBe(200);
    expect((await fetch(f.url + '/api/snapshot')).status).toBe(200);
    const sent = await post('say.submit', { content: '新目标' });
    expect(sent.status).toBe(200);
    const created = await sent.json();
    expect(created.task.task_kind).toBe('say');
    expect((await fetch(f.url + `/api/task/${created.task.id}`)).status).toBe(200);
    const overview = await (await fetch(f.url + '/api/overview')).json();
    expect(overview.tasks.some(task => task.id === created.task.id)).toBe(true);
    const child = await post('task.spawn', { parent: created.task.id, goal: '独立子目标' });
    expect(child.status).toBe(200);
    expect((await child.json()).task_kind).toBe('child');
    expect((await post('task.reserve', { id: created.task.id, kind: 'showcase' })).status).toBe(400);
  } finally { await f.close(); }
});
