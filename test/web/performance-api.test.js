import { expect, test } from 'bun:test';
import { setup, fetch } from './harness.js';
import { repo } from '../helpers.js';
import { createPerformanceData } from '../../src/ui/web/assets/performance-data.js';
import { USER_ONLY } from '../../src/rpc/registry.js';
import fs from 'node:fs';
import path from 'node:path';
import { installDom, findByText, deepText } from '../dom-stub.js';
import { openTranscriptView, closeTranscriptView } from '../../src/ui/web/assets/transcript-view.js';
import { ui, transcriptCache } from '../../src/ui/web/assets/state.js';

// Real page -> authenticated project HTTP -> registered user-only RPC -> SQLite/session evidence.
// No paid model, user daemon or live user worktree.
test('Shell analysis reads real complete identities, ranks long/repeated failures and locates original command/output', async () => {
  const f = await setup(); f.project.kick = () => {};
  try {
    await repo(f.root);
    const worker = (await f.project.order('timing evidence', 'main', [], null, false)).task;
    for (let index = 0; index < 105; index++) {
      f.store.update(worker.id, { calls: index });
      const run = f.store.startRun(f.store.task(worker.id), { agent: 'mock', model: 'PRIVATE_MODEL' });
      f.store.finishRun(run.id, 'completed', { result: 'PRIVATE_RESULT', error: 'PRIVATE_ERROR' });
    }
    const records = [], time = ms => new Date(Date.parse('2026-01-01T00:00:00Z') + ms).toISOString();
    for (let index = 0; index < 53; index++) {
      const start = index * 20000, failed = index < 2, elapsed = failed ? 7000 : index === 52 ? 12000 : index === 51 ? 1000 : 2000;
      const command = index === 52 ? 'sleep 12' : 'echo performance-fixture', timeout = index === 51 ? 21 : 20;
      records.push({ type: 'message', timestamp: time(start), message: { role: 'assistant', content: [{ type: 'toolCall', id: `timing-${index}`, name: 'bash', arguments: { command, timeout } }] } },
        { type: 'message', timestamp: time(start + elapsed), message: { role: 'toolResult', toolName: 'bash', toolCallId: `timing-${index}`, isError: failed,
          content: [{ type: 'text', text: failed ? 'recorded failed attempt' : 'recorded successful attempt' }] } });
    }
    const sessions = path.join(f.config.home, 'sessions'); fs.mkdirSync(sessions, { recursive: true });
    const session = path.join(sessions, `001_lush-task-${worker.id}.jsonl`), original = records.map(value => JSON.stringify(value)).join('\n') + '\n'; fs.writeFileSync(session, original);
    const host = await (await fetch(f.url + '/api/host/projects')).json(), projectId = host.projects.find(row => row.project === f.root).id;
    const prefix = `/p/${projectId}`, reads = [];
    const read = async (route, options) => { reads.push(route); const response = await fetch(f.url + prefix + route, options); expect(response.status).toBe(200); return response.json(); };
    // Existing metadata-only Run adapter remains safe and correctly paginated for other readers.
    expect(USER_ONLY.has('worker.runs_page')).toBe(true);
    const data = createPerformanceData(worker.id, { read });
    const first = await data.load(); expect(first.runs).toHaveLength(100); expect(first.coverage.runs).toBe(false); expect(JSON.stringify(first.runs)).not.toContain('PRIVATE_');
    const full = await data.load({ all: true }); expect(full.runs).toHaveLength(105); expect(new Set(full.runs.map(run => run.id)).size).toBe(105);
    expect(full.steps.find(step => step.kind === 'tool').shell).toMatchObject({ command: 'echo performance-fixture', identity_complete: true });
    expect(full.steps.find(step => step.kind === 'tool').shell.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(full.steps.find(step => step.kind === 'result')).toMatchObject({ is_error: true, error_known: true });
    expect(full.coverage).toEqual({ history: true, runs: true, steps: true, progress: true });
    const pageReads = [], dom = installDom({ fetch: (route, options) => { pageReads.push(String(route)); return fetch(f.url + String(route), options); } }); dom.location.pathname = `${prefix}/`;
    try {
      ui.selected = worker.id;
      await openTranscriptView(worker.id, undefined, { task: f.store.task(worker.id), mode: 'performance' });
      const analysis = ui.transcriptView.panel.querySelector('.performance-view');
      expect(analysis.querySelector('.performance-status').textContent).toContain('尚非全部历史');
      await findByText(analysis, '分析全部历史').onclick();
      expect(analysis.querySelector('.performance-status').textContent).toContain('当前采样范围已扫描完');
      expect(pageReads.some(route => /reading-page|runs-page|progress-history|action/.test(route))).toBe(false);
      const slow = analysis.querySelector('.performance-slow'), repeated = analysis.querySelector('.performance-retries');
      expect(slow.querySelectorAll('.performance-command-row')).toHaveLength(3); expect(slow.querySelector('.performance-command').textContent).toBe('sleep 12');
      expect(repeated.querySelectorAll('.performance-command-row')).toHaveLength(1);
      expect(deepText(repeated)).toContain('14 秒'); expect(deepText(repeated)).toContain('明确成功'); expect(deepText(repeated)).toContain('2 / 51');
      const sort = analysis.querySelector('[aria-label="慢指令排序"]'); sort.value = 'total_ms'; sort.onchange();
      expect(slow.querySelector('.performance-command').textContent).toBe('echo performance-fixture');
      const attempts = repeated.querySelector('.performance-attempts'); attempts.open = true;
      expect(attempts.querySelectorAll('.performance-attempt')).toHaveLength(5);
      await attempts.querySelector('.performance-source').onclick();
      expect(ui.transcriptView.mode).toBe('transcript'); expect(deepText(ui.transcriptView.holder)).toContain('performance-fixture');
      expect(deepText(ui.transcriptView.holder)).toContain('recorded failed attempt');
    } finally { closeTranscriptView(); transcriptCache.delete(worker.id); ui.selected = null; dom.restore(); }
    for (const query of ['before=0', 'limit=201', 'limit=1&limit=2', 'id=1', 'token=private', 'before=-1']) {
      expect((await fetch(`${f.url}${prefix}/api/worker/${worker.id}/runs-page?${query}`)).status).toBe(400);
    }
    expect((await fetch(`${f.url}${prefix}/api/worker/${worker.id}/runs-page`, { headers: { Origin: 'https://attacker.invalid' } })).status).toBe(403);
    expect(fs.readFileSync(session, 'utf8')).toBe(original);
  } finally { await f.close(); }
});
