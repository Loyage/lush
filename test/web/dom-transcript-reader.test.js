import { test, expect } from 'bun:test';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { until } from '../helpers.js';
import { structuredValue } from '../../src/ui/web/assets/structured-value.js';
import { transcriptContent, appendTranscriptSteps } from '../../src/ui/web/assets/render-transcript.js';
import { transcriptCache, ui } from '../../src/ui/web/assets/state.js';
import { transcriptReader, resetTranscriptReaders } from '../../src/ui/web/assets/transcript-reader.js';
import { initContextReferences, referenceable } from '../../src/ui/web/assets/context-references.js';
import { closeExplanationPanel } from '../../src/ui/web/assets/explanations.js';

const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

test('compact rows show content and live paired results update the same node without losing expansion', () => {
  const dom = installDom(); resetTranscriptReaders();
  try {
    const taskId = 970;
    const steps = [{ seq: 1, file: 'a', kind: 'thinking', title: '思考', body: '先检查现有实现' },
      { seq: 2, file: 'a', kind: 'tool', title: 'bash', call_id: 'x', body: '{"command":"bun run test"}' }];
    transcriptCache.set(taskId, { steps, files: ['a'], next: 2, has_more: false }); ui.selected = taskId;
    const holder = dom.document.createElement('div'); holder.className = 'transcript';
    holder.append(...transcriptContent(taskId)); dom.node('detail').append(holder);
    const list = holder.querySelector('[data-live="transcript-steps"]');
    expect(list.children[0].querySelector('.step-title').textContent).toContain('先检查现有实现');
    const tool = list.children[1]; expect(tool.querySelector('.step-title').textContent).toContain('bun run test');
    tool.querySelector('.step-head').onclick(); expect(tool.classList.contains('open')).toBe(true);
    const output = { seq: 3, file: 'a', kind: 'result', title: 'bash', call_id: 'x', body: 'all tests passed' };
    steps.push(output); appendTranscriptSteps(taskId, [output]);
    expect(list.children).toHaveLength(2); expect(list.children[1]).toBe(tool);
    expect(tool.classList.contains('open')).toBe(true); expect(deepText(tool)).toContain('all tests passed');
    expect(tool.querySelector('.step-call-status').textContent).toBe('已有结果');
  } finally { resetTranscriptReaders(); transcriptCache.delete(970); ui.selected = null; dom.restore(); }
});

test('JSON renderer lazily expands safe text, preserves exact raw and falls back for invalid JSON', () => {
  const dom = installDom();
  try {
    const text = '{"<img onerror=evil()>":[1,true,{"x":"<script>evil()</script>"}]}';
    const root = structuredValue(text), branch = root.querySelector('details');
    expect(branch.children).toHaveLength(1);
    branch.open = true; branch.listeners.toggle[0]();
    expect(deepText(root)).toContain('<img onerror=evil()>');
    expect(root.querySelector('img')).toBeNull(); expect(root.querySelector('script')).toBeNull();
    findByText(root, '查看原文').onclick(); expect(root.querySelector('.raw-value').hidden).toBe(false);
    expect(root.querySelector('.raw-value').textContent).toBe(text);
    expect(structuredValue('{broken').querySelector('.raw-value').textContent).toBe('{broken');
  } finally { dom.restore(); }
});

test('full-record search sends filters, navigates matches and opens original source independently of loaded steps', async () => {
  const calls = [], step = { seq: 88, file: 'old', line: 77, kind: 'result', title: 'bash', body: 'needle', excerpt: 'needle in old output' };
  const dom = installDom({ fetch: async url => {
    calls.push(String(url));
    if (String(url).includes('transcript-step')) return response({ step, related: [], context: [], has_more: false });
    return response({ steps: [step], files: ['old'], has_more: false, next: 88 });
  } }); resetTranscriptReaders();
  try {
    const root = transcriptReader(971), form = root.querySelector('form'), inputs = form.querySelectorAll('input');
    inputs[0].value = 'needle'; inputs[1].value = 'bash'; inputs[2].checked = true;
    form.querySelector('select').value = 'result'; form.onsubmit({ preventDefault() {} });
    await until(() => root.querySelector('.search-hit'));
    expect(calls[0]).toContain('query=needle'); expect(calls[0]).toContain('tool=bash'); expect(calls[0]).toContain('errors=true');
    await root.querySelector('.search-hit').querySelector('button').onclick();
    expect(calls[1]).toContain('seq=88'); expect(deepText(root)).toContain('old:77');
    expect(root.querySelector('mark').textContent).toBe('needle');
  } finally { resetTranscriptReaders(); dom.restore(); }
});

test('selected transcript text offers direct introduction, preserves quote and displays retained source in side panel', async () => {
  const requests = [], step = { seq: 3, title: 'bash', body: 'exit code 1' };
  const saved = { id: 72, status: 'completed', result: '命令以非零退出码结束，原因需要更多上下文。',
    source: { task_id: 972, seq: 3, quote: 'exit code 1', captured_at: '2026-01-01', goal: 'test', step, related: [] } };
  const dom = installDom({ fetch: async (url, options) => { requests.push([url, options]); return response(saved); } });
  try {
    initContextReferences();
    const target = dom.document.createElement('pre'); target.textContent = step.body;
    referenceable(target, { kind: 'transcript_step', target: { task_id: 972, seq: 3 }, quote: step.body });
    dom.setSelection('exit code 1'); await dom.fire('contextmenu', { target, preventDefault() {} });
    const introduce = findByText(dom.node('context-menu'), '介绍：'); expect(introduce).toBeTruthy();
    introduce.onclick(); await until(() => deepText(dom.document.body).includes('非零退出码'));
    expect(JSON.parse(requests[0][1].body)).toEqual({ method: 'explanation.start', params: { id: 972, seq: 3, quote: 'exit code 1' } });
    expect(deepText(dom.document.body)).toContain('当时的来源快照');
    expect(deepText(dom.document.body)).toContain('不是执行事实');
    expect(ui.composerReferences).toHaveLength(0);
  } finally { closeExplanationPanel(); dom.restore(); }
});
