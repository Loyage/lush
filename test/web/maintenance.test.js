import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { repo, until } from '../helpers.js';
import { fetch, pageSource, setup } from './harness.js';

// 校验报告作为自包含文档；task.clear 与有活动任务时的拒绝。

test('web serves the verification report as a self-contained document and nothing else', async () => {
  const f = await setup(); await repo(f.root);
  try {
    f.project.stopping = true;   // 只造数据，不让 planner 真的跑
    const worker = f.store.create({ parent_id: null, input_id: null, role: 'worker', goal: 'w', name: 'w' });
    const verifier = f.store.create({ parent_id: null, input_id: null, role: 'verifier', goal: 'v', name: 'verify-1', verifies_task_id: worker.id });
    // 还没写报告时是 404，而不是空文档
    expect((await fetch(`${f.url}/api/task/${verifier.id}/report`)).status).toBe(404);
    const file = path.join(f.config.home, 'verify', String(verifier.id), 'report.html');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '<!doctype html><title>对照</title><p>before/after</p>');
    const response = await fetch(`${f.url}/api/task/${verifier.id}/report`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await response.text()).toContain('before/after');
    // 非 verifier 任务与不存在的任务都不报文件路径，只报错
    expect((await fetch(`${f.url}/api/task/${worker.id}/report`)).status).toBe(400);
    expect((await fetch(`${f.url}/api/task/9999/report`)).status).toBe(400);
    const app = await pageSource(f.url);
    expect(app).toContain('效果展示');
    expect(app).not.toContain("action('task.verify'");
    expect(app).toContain('打开 HTML 报告');
  } finally { await f.close(); }
});

test('web clears the board through task.clear and refuses it while tasks are live', async () => {
  const f = await setup(); await repo(f.root);
  const post = (method, params) => fetch(f.url+'/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,params})});
  try {
    expect(await pageSource(f.url)).toContain('清空任务看板');
    expect((await post('input.submit',{content:'one job'})).status).toBe(200);
    // agent token 在 Web 层直接被拒；真正的「有活动任务就不许清」由 daemon 判定，见 task-clear.test.js
    expect((await post('task.clear',{_token:'forged'})).status).toBe(400);
    await until(() => f.project.running.size === 0 && f.store.activeTasks().length === 0);
    const response = await post('task.clear',{});
    expect(response.status).toBe(200);
    expect((await response.json()).cleared.tasks).toBeGreaterThan(0);
    const snapshot = await (await fetch(f.url+'/api/snapshot')).json();
    expect(snapshot.tasks).toEqual([]); expect(snapshot.inputs).toEqual([]);
    expect(snapshot.status.tasks).toEqual([]);
  } finally { await f.close(); }
});
