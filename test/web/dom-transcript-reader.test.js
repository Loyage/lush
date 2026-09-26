import { test, expect } from 'bun:test';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { until } from '../helpers.js';
import { structuredValue } from '../../src/ui/web/assets/structured-value.js';
import { transcriptBody } from '../../src/ui/web/assets/transcript-body.js';
import { setPref, writePref } from '../../src/ui/web/assets/prefs.js';
import { transcriptContent, appendTranscriptSteps, locateTranscriptStep } from '../../src/ui/web/assets/render-transcript.js';
import { transcriptCache, transcriptOpen, ui } from '../../src/ui/web/assets/state.js';
import { transcriptReader, resetTranscriptReaders } from '../../src/ui/web/assets/transcript-reader.js';
import { initContextReferences, referenceable } from '../../src/ui/web/assets/context-references.js';
import { closeTranscriptTerminal } from '../../src/ui/web/assets/transcript-terminal.js';
import { closeExplanationPanel } from '../../src/ui/web/assets/explanations.js';

const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

test('body-first rows show operations immediately and live paired results preserve reading nodes', () => {
  const dom = installDom(); resetTranscriptReaders();
  try {
    const taskId = 970;
    const steps = [{ seq: 1, file: 'a', kind: 'thinking', title: '思考', body: '先检查现有实现' },
      { seq: 2, file: 'a', kind: 'tool', title: 'bash', call_id: 'x', body: '{"command":"bun run test"}' }];
    transcriptCache.set(taskId, { steps, files: ['a'], next: 2, has_more: false }); ui.selected = taskId;
    const holder = dom.document.createElement('div'); holder.className = 'transcript';
    holder.append(...transcriptContent(taskId)); dom.node('detail').append(holder);
    const list = holder.querySelector('[data-live="transcript-steps"]');
    expect(deepText(list.children[0].querySelector('.step-body'))).toContain('先检查现有实现');
    expect(list.children[0].querySelector('.step-body').hidden).toBe(false);
    const tool = list.children[1]; expect(tool.querySelector('.readable-value').textContent).toBe('bun run test');
    expect(tool.classList.contains('open')).toBe(true);
    const input = tool.querySelector('.step-source');
    const output = { seq: 3, file: 'a', kind: 'result', title: 'bash', call_id: 'x', body: 'all tests passed' };
    steps.push(output); appendTranscriptSteps(taskId, [output]);
    expect(list.children).toHaveLength(2); expect(list.children[1]).toBe(tool);
    expect(tool.classList.contains('open')).toBe(true); expect(deepText(tool)).toContain('all tests passed');
    expect(tool.querySelector('.step-call-status').textContent).toBe('已有结果');
    expect(tool.querySelector('.step-source')).toBe(input);
    expect(holder.querySelector('[data-live="transcript-new"]').hidden).toBe(false);
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

test('full-record search sends filters and the hit invokes the injected rich locator', async () => {
  const calls = [], located = [], step = { seq: 88, file: 'old', line: 77, kind: 'result', title: 'bash', body: 'needle', excerpt: 'needle in old output' };
  const dom = installDom({ fetch: async url => {
    calls.push(String(url));
    return response({ steps: [step], files: ['old'], has_more: false, next: 88 });
  } }); resetTranscriptReaders();
  try {
    const root = transcriptReader(971, { locate: (id, seq) => { located.push([id, seq]); } }), form = root.querySelector('form'), inputs = form.querySelectorAll('input');
    inputs[0].value = 'needle'; inputs[1].value = 'bash'; inputs[2].checked = true;
    form.querySelector('select').value = 'result'; form.onsubmit({ preventDefault() {} });
    await until(() => root.querySelector('.search-hit'));
    expect(calls[0]).toContain('query=needle'); expect(calls[0]).toContain('tool=bash'); expect(calls[0]).toContain('errors=true');
    const hit = root.querySelector('.search-hit').querySelector('button'); hit.focus();
    await hit.onclick();
    expect(located).toEqual([[971, 88]]);
    expect(root.querySelector('mark').textContent).toBe('needle');
    expect(root.tagName).toBe('SECTION');
    expect(dom.document.body.querySelector('.terminal-dialog')).toBeNull();
  } finally { closeTranscriptTerminal(); resetTranscriptReaders(); dom.restore(); }
});

test('locating a search hit loads a centered window, keeps both boundaries and reveals the step in place', async () => {
  const calls = [];
  const dom = installDom({ fetch: async url => {
    const path = String(url); calls.push(path);
    if (path.includes('transcript-latest')) return response({ steps: [{ seq: 49, file: 'a', kind: 'text', body: 'before' }, { seq: 50, file: 'a', kind: 'text', body: 'target' }], files: ['a'], next: 50, oldest: 49, has_older: true });
    return response({ steps: [{ seq: 51, file: 'a', kind: 'text', body: 'after' }, { seq: 52, file: 'a', kind: 'text', body: 'later' }], files: ['a'], next: 52, has_more: true });
  } }); resetTranscriptReaders();
  try {
    const taskId = 973;
    transcriptCache.set(taskId, { order: 'desc', steps: [{ seq: 1, file: 'a', kind: 'text', body: 'old' }], files: ['a'], next: 1, oldest: 1, has_older: false, has_more: false });
    ui.selected = taskId;
    const holder = dom.document.createElement('div'); holder.className = 'transcript';
    holder.append(...transcriptContent(taskId)); dom.node('detail').append(holder);
    await locateTranscriptStep(taskId, 50);
    const state = transcriptCache.get(taskId);
    expect(state.steps.map(step => step.seq)).toEqual([49, 50, 51, 52]);
    expect(state.has_older).toBe(true); expect(state.has_more).toBe(true);
    expect(calls.some(path => path.includes('/transcript-latest?before=51'))).toBe(true);
    expect(calls.some(path => path.includes('/transcript?after=50'))).toBe(true);
    const node = holder.querySelector('[data-seq="50"]');
    expect(node).toBeTruthy();
    expect(node.classList.contains('step-located')).toBe(true);
    expect(holder.querySelector('[data-live="transcript-older"]')).toBeTruthy();
    expect(holder.querySelector('[data-live="transcript-newer"]')).toBeTruthy();
  } finally { transcriptCache.delete(973); ui.selected = null; resetTranscriptReaders(); dom.restore(); }
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

test('semantic tool body decodes real newlines, exposes edit pairs and keeps literal escapes and HTML inert', () => {
  const dom = installDom();
  try {
    const command = 'printf "first"\nprintf "second"';
    const body = transcriptBody({ kind: 'tool', body: JSON.stringify({ command, path: 'src/example.js',
      edits: [{ oldText: 'a\nb', newText: '<script>evil()</script>\nc' }], literal: String.raw`keep\nthis` }) });
    expect(body.querySelector('.readable-value').textContent).toBe(command);
    expect(deepText(body.querySelector('.change-before'))).toContain('a\nb');
    expect(deepText(body.querySelector('.change-after'))).toContain('<script>evil()</script>\nc');
    expect(deepText(body)).toContain(String.raw`keep\nthis`);
    expect(body.querySelector('script')).toBeNull();
    const partial = '{"command":"unterminated';
    expect(transcriptBody({ kind: 'tool', body: partial }).querySelector('pre').textContent).toBe(partial);
    const prefix = '{"command":"partial"}';
    const clipped = transcriptBody({ kind: 'tool', body: prefix, body_length: 5000 });
    expect(clipped.querySelector('.tool-field')).toBeNull();
    expect(clipped.querySelector('pre').textContent).toBe(prefix);
  } finally { dom.restore(); }
});

test('long prose has an explicit local preview, expansion survives repaint, and errors default to full text', () => {
  const dom = installDom();
  const key = 'preview-test';
  try {
    writePref('markdown', false);
    const text = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join('\n');
    const step = { kind: 'thinking', body: text };
    const root = transcriptBody(step, { key });
    expect(root.querySelector('pre').textContent).toBe(text.split('\n').slice(0, 10).join('\n'));
    expect(root.querySelector('pre').classList.contains('transcript-prose')).toBe(true);
    root.querySelector('.content-expand').onclick();
    expect(root.querySelector('pre').textContent).toBe(text);
    expect(transcriptBody(step, { key }).querySelector('pre').textContent).toBe(text);
    expect(transcriptBody({ kind: 'result', is_error: true, body: text }).querySelector('pre').textContent).toBe(text);
    const command = transcriptBody({ kind: 'tool', body: JSON.stringify({ command: text }) });
    expect(command.querySelector('pre').textContent).toBe(text);
    expect(command.querySelector('.content-expand')).toBeNull();
  } finally { ui.stepToggle.delete(`${key}:body`); dom.restore(); }
});

test('structured outputs expose root fields and multiline strings without losing exact source', () => {
  const dom = installDom();
  try {
    const text = JSON.stringify({ output: 'line one\nline two', nested: { count: 2 } });
    const root = transcriptBody({ kind: 'result', body: text });
    expect(root.querySelector('.json-branch').open).toBe(true);
    expect(root.querySelector('.json-value').textContent).toBe('line one\nline two');
    expect(root.querySelectorAll('.json-branch')[1].open).not.toBe(true);
    findByText(root, '查看原文').onclick();
    expect(root.querySelector('.raw-value').textContent).toBe(text);
  } finally { dom.restore(); }
});

test('failed paired output is visible, keeps provenance, and a manual collapse survives later output', () => {
  const dom = installDom(); resetTranscriptReaders(); const taskId = 975;
  try {
    const steps = [{ seq: 1, file: 'a', kind: 'tool', title: 'bash', call_id: 'x', body: '{"command":"test"}' }];
    transcriptCache.set(taskId, { steps, files: ['a'], next: 1, has_more: false }); ui.selected = taskId;
    const holder = dom.document.createElement('div'); holder.className = 'transcript';
    holder.append(...transcriptContent(taskId)); dom.node('detail').append(holder);
    const item = holder.querySelector('.step');
    const output = { seq: 2, file: 'a', kind: 'result', title: 'bash', call_id: 'x', is_error: true, body: 'error\nreason' };
    steps.push(output); appendTranscriptSteps(taskId, [output]);
    expect(item.querySelector('.step-body').hidden).toBe(false);
    expect(item.classList.contains('step-failed')).toBe(true);
    expect(item.querySelector('.step-call-status').textContent).toBe('失败');
    const result = item.querySelector('[data-result-seq="2"]');
    expect(result.querySelector('pre').textContent).toBe('error\nreason');
    const raw = result.querySelector('.step-original'); raw.open = true; raw.listeners.toggle[0]();
    expect(raw.querySelector('.raw-value').textContent).toBe(output.body);
    expect(deepText(raw)).toContain('a');
    item.querySelector('.step-head').onclick();
    const more = { ...output, seq: 3, is_error: false, body: 'more output' };
    steps.push(more); appendTranscriptSteps(taskId, [more]);
    expect(item.querySelector('.step-body').hidden).toBe(true);
    expect(item.querySelector('.step-call-status').textContent).toBe('失败');
  } finally { resetTranscriptReaders(); transcriptCache.delete(taskId); ui.stepToggle.delete(`${taskId}:1`); ui.selected = null; dom.restore(); }
});

test('desc reading puts newest first, asc restores chronological order and pager wording', () => {
  const dom = installDom(); resetTranscriptReaders();
  try {
    const taskId = 980;
    const steps = [{ seq: 1, file: 'a', kind: 'thinking', title: '思考', body: '第一步' },
      { seq: 2, file: 'a', kind: 'text', title: '回答', body: '第二步' },
      { seq: 3, file: 'a', kind: 'text', title: '回答', body: '第三步' }];
    ui.selected = taskId;
    const render = state => {
      transcriptCache.set(taskId, { ...state, steps: [...steps] });
      const holder = dom.document.createElement('div'); holder.className = 'transcript';
      holder.append(...transcriptContent(taskId)); dom.node('detail').append(holder);
      return holder;
    };
    const desc = render({ order: 'desc', files: ['a'], next: 3, oldest: 1, has_older: true });
    const descList = desc.querySelector('[data-live="transcript-steps"]');
    expect([...descList.children].map(node => node.dataset.seq)).toEqual(['3', '2', '1']);
    expect(desc.querySelector('[data-live="transcript-older"]').textContent).toContain('加载更早');
    expect(desc.querySelector('[data-live="transcript-newer"]')).toBeNull();
    expect(findByText(desc, '有新记录 · 跳到最新')).toBeTruthy();

    transcriptCache.delete(taskId); dom.node('detail').replaceChildren();
    const asc = render({ order: 'asc', files: ['a'], next: 3, has_more: true });
    const ascList = asc.querySelector('[data-live="transcript-steps"]');
    expect([...ascList.children].map(node => node.dataset.seq)).toEqual(['1', '2', '3']);
    expect(asc.querySelector('[data-live="transcript-newer"]').textContent).toContain('加载更多');
    expect(asc.querySelector('[data-live="transcript-older"]')).toBeNull();
    expect(findByText(asc, '有新记录 · 跳到末尾')).toBeTruthy();
  } finally { transcriptCache.delete(980); ui.selected = null; resetTranscriptReaders(); dom.restore(); }
});

test('desc loads older pages with before=oldest and folds a boundary result into its call', async () => {
  const calls = [];
  const dom = installDom({ fetch: async url => { calls.push(String(url));
    // 更早的一页只有调用步：它的结果在新窗口里已经作为独立节点渲染。
    return response({ task_id: 981, files: ['a'], next: 3, oldest: 3, has_older: false, truncated: false,
      steps: [{ seq: 3, file: 'a', kind: 'tool', title: 'bash', call_id: 'x', body: '{"command":"ls"}' }] });
  } });
  resetTranscriptReaders();
  try {
    const taskId = 981;
    const steps = [{ seq: 4, file: 'a', kind: 'result', title: 'bash', call_id: 'x', body: 'src' },
      { seq: 5, file: 'a', kind: 'text', title: '回答', body: '完成' }];
    transcriptCache.set(taskId, { order: 'desc', steps, files: ['a'], next: 5, oldest: 4, has_older: true });
    ui.selected = taskId;
    const holder = dom.document.createElement('div'); holder.className = 'transcript';
    holder.append(...transcriptContent(taskId)); dom.node('detail').append(holder);
    const list = holder.querySelector('[data-live="transcript-steps"]');
    expect([...list.children].map(node => node.dataset.seq)).toEqual(['5', '4']);

    await holder.querySelector('[data-live="transcript-older"]').onclick();
    expect(calls[0]).toContain('/transcript-latest?before=4');
    expect(transcriptCache.get(taskId).steps.map(step => step.seq)).toEqual([3, 4, 5]);
    expect(transcriptCache.get(taskId).oldest).toBe(3);
    // 更早的一页追加在底部；边界上的独立结果节点被折进调用，不重复、不错配。
    expect([...list.children].map(node => node.dataset.seq)).toEqual(['5', '3']);
    const call = list.querySelector('[data-seq="3"]');
    expect(call.querySelectorAll('[data-result-seq="4"]').length).toBe(1);
    expect(call.querySelector('[data-result-seq="4"]')).toBeTruthy();
    expect(list.querySelector('[data-seq="4"]')).toBeNull();
    expect(holder.querySelector('[data-live="transcript-older"]').hidden).toBe(true);
  } finally { transcriptCache.delete(981); ui.selected = null; resetTranscriptReaders(); dom.restore(); }
});

test('desc live increments prepend new steps and preserve the call expansion state', () => {
  const dom = installDom(); resetTranscriptReaders();
  try {
    const taskId = 982;
    const steps = [{ seq: 1, file: 'a', kind: 'tool', title: 'bash', call_id: 'x', body: '{"command":"ls"}' },
      { seq: 2, file: 'a', kind: 'result', title: 'bash', call_id: 'x', body: 'old' }];
    transcriptCache.set(taskId, { order: 'desc', steps, files: ['a'], next: 2, oldest: 1, has_older: false });
    ui.selected = taskId;
    const holder = dom.document.createElement('div'); holder.className = 'transcript';
    holder.append(...transcriptContent(taskId)); dom.node('detail').append(holder);
    const list = holder.querySelector('[data-live="transcript-steps"]');
    expect(list.children).toHaveLength(1);
    const call = list.children[0];
    call.querySelector('.step-head').onclick();
    expect(call.classList.contains('open')).toBe(false);

    const result = { seq: 3, file: 'a', kind: 'result', title: 'bash', call_id: 'x', body: 'new' };
    steps.push(result); appendTranscriptSteps(taskId, [result]);
    expect(list.children).toHaveLength(1);
    expect(call.querySelector('[data-result-seq="3"]')).toBeTruthy();
    expect(call.classList.contains('open')).toBe(false);

    const text = { seq: 4, file: 'a', kind: 'text', title: '回答', body: 'done' };
    steps.push(text); appendTranscriptSteps(taskId, [text]);
    expect(list.children[0].dataset.seq).toBe('4');
    expect(list.children[1]).toBe(call);
    expect(holder.querySelector('[data-live="transcript-new"]').hidden).toBe(false);
  } finally { transcriptCache.delete(982); ui.selected = null; resetTranscriptReaders(); dom.restore(); }
});

test('switching transcriptOrder reloads an expanded process by the new direction', async () => {
  const calls = [];
  const steps = [{ seq: 1, file: 'a', kind: 'thinking', title: '思考', body: '第一步' },
    { seq: 2, file: 'a', kind: 'text', title: '回答', body: '第二步' }];
  const dom = installDom({ fetch: async url => { const path = String(url); calls.push(path);
    return path.includes('/transcript-latest')
      ? response({ task_id: 983, files: ['a'], steps, next: 2, oldest: 1, has_older: false, truncated: false })
      : response({ task_id: 983, files: ['a'], steps, next: 2, has_more: false, truncated: false });
  } });
  resetTranscriptReaders();
  try {
    const taskId = 983;
    writePref('transcriptOrder', 'asc');
    transcriptCache.set(taskId, { order: 'asc', steps: [...steps], files: ['a'], next: 2, has_more: false });
    transcriptOpen.add(taskId); ui.selected = taskId;
    const holder = dom.document.createElement('div'); holder.className = 'transcript';
    holder.append(...transcriptContent(taskId)); dom.node('detail').append(holder);
    expect([...holder.querySelector('[data-live="transcript-steps"]').children].map(node => node.dataset.seq)).toEqual(['1', '2']);

    setPref('transcriptOrder', 'desc');
    await until(() => calls.some(path => path.includes('/transcript-latest?limit=100')));
    await until(() => transcriptCache.get(taskId)?.order === 'desc');
    expect([...holder.querySelector('[data-live="transcript-steps"]').children].map(node => node.dataset.seq)).toEqual(['2', '1']);
  } finally { transcriptOpen.delete(983); writePref('transcriptOrder', 'desc');
    transcriptCache.delete(983); ui.selected = null; resetTranscriptReaders(); dom.restore(); }
});
