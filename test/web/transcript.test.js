import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { repo } from '../helpers.js';
import { fetch, pageSource, setup } from './harness.js';

// 只读 transcript 与 usage 路由。

test('web exposes the read-only agent transcript and keeps sessions out of the read models', async () => {
  const f = await setup(); await repo(f.root);
  try {
    const task = (await f.project.submit('transcript me')).task;
    f.project.stopping = true;   // 只造数据，不让 planner 真的跑
    const dir = path.join(f.config.home, 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `2026-01-01T00-00-00-000Z_lush-task-${task.id}.jsonl`);
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'message', timestamp: 1789749049638, message: { role: 'assistant', content: [
        { type: 'thinking', thinking: '先看看代码' },
        { type: 'toolCall', name: 'bash', arguments: { command: 'ls' } }] } }),
      JSON.stringify({ type: 'message', timestamp: 1789749049639, message: { role: 'toolResult', toolName: 'bash', isError: false, content: [{ type: 'text', text: 'src\nREADME.md' }] } }),
    ].join('\n') + '\n');
    const before = fs.readFileSync(file, 'utf8');
    const page = await (await fetch(`${f.url}/api/task/${task.id}/transcript`)).json();
    expect(page.steps.map(step => [step.kind, step.title])).toEqual([['thinking', '思考'], ['tool', 'bash'], ['result', 'bash']]);
    expect(page.steps[0].body).toBe('先看看代码');
    expect(page.has_more).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    // 越界游标、未知任务、超限 limit 都是 400，不当成服务器错误
    expect((await fetch(`${f.url}/api/task/${task.id}/transcript?after=-1`)).status).toBe(400);
    expect((await fetch(`${f.url}/api/task/99/transcript`)).status).toBe(400);
    // 正文优先：思考与工具默认可读，长内容在原处展开，搜索入口不再折叠。
    const app = await pageSource(f.url);
    expect(app).toContain("STEP_OPEN = new Set(['input', 'text', 'thinking', 'tool', 'result'])");
    expect(app).toContain('展开全部步骤');
    expect(app).toContain('展开剩余内容');
    expect(app).toContain("el('section', undefined, 'transcript-reader')");
    // 过程不进快照/列表，只有 transcript 路由才读会话文件；快照只带 work 层任务
    const snapshot = await (await fetch(f.url + '/api/snapshot')).json();
    expect(JSON.stringify(snapshot)).not.toContain('先看看代码');
    expect(snapshot.tasks.map(row => row.id)).not.toContain(task.id);
    expect(snapshot.inputs[0]).toMatchObject({ task_id: task.id });
  } finally { await f.close(); }
});

test('web exposes agent usage (model, context, cost) next to the transcript', async () => {
  const f = await setup(); await repo(f.root);
  try {
    const task = (await f.project.submit('usage me')).task;
    f.project.stopping = true;   // 只造数据，不让 planner 真的跑
    const dir = path.join(f.config.home, 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `2026-01-01T00-00-00-000Z_lush-task-${task.id}.jsonl`), [
      JSON.stringify({ type: 'model_change', timestamp: 1789749049000, provider: 'deepseek', modelId: 'deepseek-flash' }),
      JSON.stringify({ type: 'message', timestamp: 1789749049638, message: { role: 'assistant', provider: 'deepseek', model: 'deepseek-flash',
        content: [{ type: 'text', text: '已处理' }],
        usage: { input: 1426, output: 193, cacheRead: 2176, cacheWrite: 0, reasoning: 68, totalTokens: 3795, cost: { total: 0.000672456 } } } }),
    ].join('\n') + '\n');
    const usage = await (await fetch(`${f.url}/api/task/${task.id}/usage`)).json();
    expect(usage.model).toEqual({ provider: 'deepseek', model_id: 'deepseek-flash' });
    expect(usage.requests).toBe(1);
    expect(usage.context_tokens).toBe(3795);
    expect(usage.totals.cost).toBeCloseTo(0.000672456, 9);
    expect((await fetch(`${f.url}/api/task/99/usage`)).status).toBe(400);
    // 用量只走这条只读路由，不进快照
    expect(JSON.stringify(await (await fetch(f.url + '/api/snapshot')).json())).not.toContain('deepseek-flash');
    // 详情面板把 agent 身份、模型、上下文与花费和执行过程放在同一块里
    const app = await pageSource(f.url);
    expect(app).toContain("block('Agent'");
    for (const label of ['模型', '上下文占用', '累计 token', '预计花费', '模型请求']) expect(app).toContain(label);
  } finally { await f.close(); }
});

test('web transcript steps carry per-step tokens: exact for a billed turn, estimated for the batch in between', async () => {
  const f = await setup(); await repo(f.root);
  try {
    const task = (await f.project.submit('token me')).task;
    f.project.stopping = true;   // 只造数据，不让 planner 真的跑
    const dir = path.join(f.config.home, 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    // 两次带 usage 的请求，中间夹一条工具输出：assistant 步拿到 pi 记录的精确用量，
    // 两次请求之间的那批步骤拿到上下文差值的估算（725 = 1000+50 − 325）。
    fs.writeFileSync(path.join(dir, `2026-01-01T00-00-00-000Z_lush-task-${task.id}.jsonl`), [
      JSON.stringify({ type: 'message', timestamp: 1789749049638, message: { role: 'assistant', provider: 'mock', model: 'mock-1',
        content: [{ type: 'thinking', thinking: '先看看代码' }, { type: 'toolCall', name: 'bash', arguments: { command: 'ls' } }],
        usage: { input: 100, output: 20, cacheRead: 200, cacheWrite: 5, reasoning: 7, totalTokens: 325, cost: { total: 0.001 } } } }),
      JSON.stringify({ type: 'message', timestamp: 1789749049639, message: { role: 'toolResult', toolName: 'bash', isError: false, content: [{ type: 'text', text: 'src\nREADME.md' }] } }),
      JSON.stringify({ type: 'message', timestamp: 1789749049640, message: { role: 'assistant', provider: 'mock', model: 'mock-1',
        content: [{ type: 'text', text: '改好了' }],
        usage: { input: 1000, output: 30, cacheRead: 50, cacheWrite: 0, reasoning: 3, totalTokens: 1080, cost: { total: 0.002 } } } }),
    ].join('\n') + '\n');
    const page = await (await fetch(`${f.url}/api/task/${task.id}/transcript`)).json();
    expect(page.steps.map(step => step.kind)).toEqual(['thinking', 'tool', 'result', 'text']);
    // 同一次回复的两个 step 共享精确用量，只有首步带 first（前端据此只印一次 chip）
    expect(page.steps[0].tokens).toMatchObject({ exact: true, turn: true, first: true, total: 325, input: 100, output: 20, cache_read: 200, cache_write: 5 });
    expect(page.steps[1].tokens).toMatchObject({ exact: true, turn: true, total: 325 });
    expect(page.steps[1].tokens.first).toBeUndefined();
    // 两次请求之间的工具输出：估算，只有批首带 first
    expect(page.steps[2].tokens).toEqual({ context_added: 725, estimated: true, batch: true, first: true });
    expect(page.steps[3].tokens).toMatchObject({ exact: true, turn: true, first: true, total: 1080 });
    // 前端渲染只认 tokens.first 才画 chip，估算带 + 前缀
    const app = await pageSource(f.url);
    expect(app).toContain('step-tokens');
    expect(app).toContain('tokensView');
    expect(app).toContain("t.estimated");
  } finally { await f.close(); }
});
