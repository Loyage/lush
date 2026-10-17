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

// Real project-scoped authenticated HTTP -> registered user-only RPC -> SQLite clocks -> collector.
// No real model, daemon or user worktree is used.
test('performance evidence traverses real registered HTTP/RPC with all Run pages and metadata-only results', async () => {
  const f = await setup(); f.project.kick = () => {};
  try {
    await repo(f.root);
    const worker = (await f.project.order('timing evidence', 'main', [], null, false)).task;
    for (let index = 0; index < 105; index++) {
      f.store.update(worker.id, { calls: index });
      const run = f.store.startRun(f.store.task(worker.id), { agent: 'mock', model: 'PRIVATE_MODEL' });
      f.store.finishRun(run.id, 'completed', { result: 'PRIVATE_RESULT', error: 'PRIVATE_ERROR' });
    }
    const sessions = path.join(f.config.home, 'sessions'); fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, `001_lush-task-${worker.id}.jsonl`), [
      { type: 'message', timestamp: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'timing-tool', name: 'bash', arguments: { command: 'echo performance-fixture' } }] } },
      { type: 'message', timestamp: '2026-01-01T00:00:07Z', message: { role: 'toolResult', toolName: 'bash', toolCallId: 'timing-tool', content: [{ type: 'text', text: 'fixture result' }] } },
    ].map(value => JSON.stringify(value)).join('\n') + '\n');
    const host = await (await fetch(f.url + '/api/host/projects')).json();
    const projectId = host.projects.find(row => row.project === f.root).id;
    const prefix = `/p/${projectId}`, reads = [];
    const read = async (route, options) => {
      reads.push(route); const response = await fetch(f.url + prefix + route, options);
      expect(response.status).toBe(200); return response.json();
    };
    expect(USER_ONLY.has('worker.runs_page')).toBe(true);
    const data = createPerformanceData(worker.id, { read });
    const first = await data.load(); expect(first.runs).toHaveLength(100); expect(first.coverage.runs).toBe(false);
    expect(JSON.stringify(first.runs)).not.toContain('PRIVATE_');
    const full = await data.load({ all: true }); expect(full.runs).toHaveLength(105); expect(full.coverage.runs).toBe(true);
    expect(new Set(full.runs.map(run => run.id)).size).toBe(105);
    expect(full.coverage).toEqual({ history: true, runs: true, steps: true, progress: true });
    expect(reads.every(route => !/action|relations/.test(route))).toBe(true);
    // Actual page entry -> lazy registration -> authenticated bridge -> ranked output -> original step.
    const dom = installDom({ fetch: (route, options) => fetch(f.url + String(route), options) }); dom.location.pathname = `${prefix}/`;
    try {
      ui.selected = worker.id;
      await openTranscriptView(worker.id, undefined, { task: f.store.task(worker.id), mode: 'performance' });
      const panel = ui.transcriptView.panel, analysis = panel.querySelector('.performance-view');
      expect(analysis.querySelector('.performance-status').textContent).toContain('调用未读全');
      expect(deepText(analysis.querySelector('.performance-tools'))).toContain('7 秒');
      await findByText(analysis, '分析全部历史').onclick();
      expect(analysis.querySelector('.performance-status').textContent).toContain('当前采样范围已扫描完');
      expect(analysis.querySelector('.performance-calls').querySelectorAll('.performance-row')).toHaveLength(10);
      await findByText(analysis.querySelector('.performance-calls'), '展开全部 105 项').onclick();
      expect(analysis.querySelector('.performance-calls').querySelectorAll('.performance-row')).toHaveLength(105);
      await analysis.querySelector('.performance-tools').querySelector('.performance-source').onclick();
      expect(ui.transcriptView.mode).toBe('transcript'); expect(deepText(ui.transcriptView.holder)).toContain('performance-fixture');
    } finally { closeTranscriptView(); transcriptCache.delete(worker.id); ui.selected = null; dom.restore(); }
    for (const query of ['before=0', 'limit=201', 'limit=1&limit=2', 'id=1', 'token=private', 'before=-1']) {
      expect((await fetch(`${f.url}${prefix}/api/worker/${worker.id}/runs-page?${query}`)).status).toBe(400);
    }
    const crossSite = await fetch(`${f.url}${prefix}/api/worker/${worker.id}/runs-page`, { headers: { Origin: 'https://attacker.invalid' } });
    expect(crossSite.status).toBe(403);
  } finally { await f.close(); }
});
