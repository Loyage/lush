import { test, expect } from 'bun:test';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { until } from '../helpers.js';
import { openTranscriptView, closeTranscriptView } from '../../src/ui/web/assets/transcript-view.js';
import { appendTranscriptSteps } from '../../src/ui/web/assets/render-transcript.js';
import { resetTranscriptReaders } from '../../src/ui/web/assets/transcript-reader.js';
import { ui, transcriptCache } from '../../src/ui/web/assets/state.js';

const response = data => new Response(JSON.stringify(data));
const text = (seq, body) => ({ seq, kind: 'text', title: '回答', file: 'a', body, excerpt: body });
const cached = () => ({ order: 'desc', steps: [text(1, 'unrelated full record')], files: ['a'], next: 1, oldest: 1 });
const submit = (panel, query = '') => {
  const form = panel.querySelector('.transcript-sidebar').querySelector('form');
  form.querySelector('input').value = query;
  form.onsubmit({ preventDefault() {} });
};
const cleanup = (dom, id) => { closeTranscriptView(); transcriptCache.delete(id); resetTranscriptReaders(); ui.selected = null; dom.restore(); };

test('fullscreen sidebar and rich match bodies correspond, retain pairing and raw segments, and exclude live nonmatches', async () => {
  const id = 1101, calls = [];
  const call = { seq: 2, kind: 'tool', title: 'bash', tool_name: 'bash', file: 'old', call_id: 'x', body: '{"command":"echo needle"}' };
  const result = { seq: 3, kind: 'result', title: 'bash', file: 'old', call_id: 'x', body: 'needle output' };
  const dom = installDom({ fetch: async url => {
    const path = String(url); calls.push(path);
    if (path.includes('transcript-search')) return response({ steps: [{ ...call, excerpt: 'needle' }, text(6, 'needle second')], files: ['old'], has_more: false });
    if (path.includes('seq=2')) return response({ step: call, related: [result], context: [text(4, 'neighbour hidden')] });
    return response({ step: text(6, path.includes('offset=24000') ? 'last raw segment' : 'needle second'), related: [], next_offset: 24000, has_more: !path.includes('offset=24000') });
  } });
  ui.selected = id; transcriptCache.set(id, cached());
  try {
    await openTranscriptView(id);
    const panel = dom.document.body.querySelector('.transcript-dialog'), sidebar = panel.querySelector('.transcript-sidebar');
    const holder = ui.transcriptView.holder;
    expect(sidebar.querySelector('.transcript-reader')).toBeTruthy(); expect(holder.querySelector('.transcript-reader')).toBeNull();
    const form = sidebar.querySelector('form'), inputs = form.querySelectorAll('input');
    inputs[1].value = 'bash'; inputs[2].checked = true; form.querySelector('select').value = 'tool';
    submit(panel, 'needle');
    await until(() => holder.querySelector('[data-result-seq="3"]') && holder.querySelector('[data-seq="6"]'));
    expect(calls[0]).toContain('query=needle'); expect(calls[0]).toContain('tool=bash'); expect(calls[0]).toContain('errors=true');
    expect([...sidebar.querySelectorAll('.search-hit')].map(node => node.dataset.hitSeq)).toEqual(['2', '6']);
    expect([...holder.children].map(node => node.dataset.matchSeq)).toEqual(['2', '6']);
    expect(deepText(holder)).toContain('echo needle'); expect(deepText(holder)).toContain('needle output');
    expect(deepText(holder)).not.toContain('unrelated full record'); expect(deepText(holder)).not.toContain('neighbour hidden');
    expect(panel.querySelector('select').disabled).toBe(true);
    sidebar.querySelectorAll('.search-hit')[1].querySelector('button').onclick();
    expect(sidebar.querySelectorAll('.search-hit')[1].querySelector('button').getAttribute('aria-current')).toBe('true');
    expect(holder.children[1].classList.contains('step-located')).toBe(true);
    const second = holder.children[1]; await [...second.querySelectorAll('button')].find(node => node.textContent === '读取完整原文').onclick();
    await findByText(second, '继续读取原文').onclick();
    expect(deepText(second)).toContain('last raw segment');
    const live = text(7, 'new unrelated record'); transcriptCache.get(id).steps.push(live); appendTranscriptSteps(id, [live]);
    expect(deepText(holder)).not.toContain('new unrelated record'); expect(deepText(panel)).toContain('有新记录');
    findByText(sidebar, '返回全部记录').onclick();
    expect(holder.querySelector('.transcript-match')).toBeNull(); expect(deepText(holder)).toContain('new unrelated record');
    expect(panel.querySelector('select').disabled).toBe(false);
  } finally { cleanup(dom, id); }
});

test('search pagination changes left summaries and corresponding body page together', async () => {
  const id = 1102, calls = [];
  const dom = installDom({ fetch: async url => {
    const path = String(url); calls.push(path);
    if (path.includes('transcript-search')) {
      const after = new URL(path, 'http://test').searchParams.get('after');
      return response({ steps: [text(after === '0' ? 10 : 20, 'matched body')], next: 10, has_more: after === '0', files: ['a'] });
    }
    const seq = Number(new URL(path, 'http://test').searchParams.get('seq'));
    return response({ step: text(seq, `body ${seq}`), related: [] });
  } });
  ui.selected = id; transcriptCache.set(id, cached());
  try {
    await openTranscriptView(id); const panel = ui.transcriptView.panel, holder = ui.transcriptView.holder;
    submit(panel); await until(() => holder.querySelector('[data-seq="10"]'));
    findByText(panel, '下一页').onclick(); await until(() => holder.querySelector('[data-seq="20"]'));
    expect(holder.querySelector('[data-seq="10"]')).toBeNull(); expect(panel.querySelector('.search-hit').dataset.hitSeq).toBe('20');
    expect(calls.some(path => path.includes('after=10'))).toBe(true);
    findByText(panel, '上一页').onclick(); await until(() => holder.querySelector('[data-seq="10"]'));
    expect(holder.querySelector('[data-seq="20"]')).toBeNull();
  } finally { cleanup(dom, id); }
});

test('new criteria and return-all invalidate late body and search responses', async () => {
  const id = 1103; let finishBody, finishSearch;
  const dom = installDom({ fetch: async url => {
    const path = String(url);
    if (path.includes('query=first')) return response({ steps: [text(10, 'old')], files: ['a'] });
    if (path.includes('query=pending')) return new Promise(resolve => { finishSearch = resolve; });
    if (path.includes('transcript-search')) return response({ steps: [text(20, 'new')], files: ['a'] });
    if (path.includes('seq=10')) return new Promise(resolve => { finishBody = resolve; });
    return response({ step: text(20, 'new match'), related: [] });
  } });
  ui.selected = id; transcriptCache.set(id, cached());
  try {
    await openTranscriptView(id); const panel = ui.transcriptView.panel, holder = ui.transcriptView.holder;
    submit(panel, 'first'); await until(() => finishBody);
    submit(panel, 'second'); await until(() => holder.querySelector('[data-seq="20"]'));
    finishBody(response({ step: text(10, 'obsolete'), related: [] }));
    await new Promise(resolve => setImmediate(resolve));
    expect(deepText(holder)).not.toContain('obsolete');
    submit(panel, 'pending'); await until(() => finishSearch);
    findByText(panel, '返回全部记录').onclick();
    finishSearch(response({ steps: [text(30, 'obsolete query')], files: ['a'] }));
    await new Promise(resolve => setImmediate(resolve));
    expect(deepText(holder)).toContain('unrelated full record'); expect(holder.querySelector('.transcript-match')).toBeNull();
  } finally { cleanup(dom, id); }
});

test('body hydration is bounded to four requests and closing stops queued work', async () => {
  const id = 1104, finishes = [], requests = [];
  const dom = installDom({ fetch: async url => {
    const path = String(url);
    if (path.includes('transcript-search')) return response({ steps: Array.from({ length: 8 }, (_, i) => text(i + 10, 'match')), files: ['a'] });
    requests.push(path); return new Promise(resolve => { finishes.push(resolve); });
  } });
  ui.selected = id; transcriptCache.set(id, cached());
  try {
    await openTranscriptView(id); const panel = ui.transcriptView.panel;
    submit(panel); await until(() => finishes.length === 4);
    expect(requests).toHaveLength(4); closeTranscriptView();
    for (const finish of finishes) finish(response({ step: text(10, 'late'), related: [] }));
    await new Promise(resolve => setImmediate(resolve));
    expect(requests).toHaveLength(4); expect(dom.document.body.querySelector('.transcript-dialog')).toBeNull();
  } finally { cleanup(dom, id); }
});

test('paired hits keep separate cards and raw reads and navigation stay scoped despite repeated context', async () => {
  const id = 1106;
  const call = { seq: 2, kind: 'tool', title: 'bash', file: 'a', call_id: 'x', body: '{"command":"echo match"}' };
  const result = { seq: 3, kind: 'result', title: 'bash', file: 'a', call_id: 'x', body: 'match output' };
  const dom = installDom({ fetch: async url => {
    const path = String(url);
    if (path.includes('transcript-search')) return response({ steps: [call, result], files: ['a'] });
    const isCall = path.includes('seq=2');
    return response({ step: isCall ? call : result, related: [isCall ? result : call], context: [result], has_more: true, next_offset: 24000 });
  } });
  ui.selected = id; transcriptCache.set(id, cached());
  try {
    await openTranscriptView(id); const panel = ui.transcriptView.panel, holder = ui.transcriptView.holder;
    submit(panel); await until(() => holder.children.length === 2 && holder.children[1].querySelector('[data-result-seq="3"]'));
    const first = holder.children[0], second = holder.children[1], context = first.querySelector('.transcript-match-context');
    context.open = true; context.listeners.toggle[0]();
    panel.querySelectorAll('.search-hit')[1].querySelector('button').onclick();
    expect(second.classList.contains('step-located')).toBe(true);
    expect(context.querySelector('.transcript-match').classList.contains('step-located')).toBe(false);
    await [...second.querySelectorAll('button')].find(node => node.textContent === '读取完整原文').onclick();
    expect(second.querySelector('.transcript-full-original')).toBeTruthy();
    expect(first.querySelector('.transcript-full-original')).toBeNull();
  } finally { cleanup(dom, id); }
});

test('missing files, empty matches, search errors and body retry remain explicit', async () => {
  const id = 1105; let mode = 'missing', attempts = 0;
  const dom = installDom({ fetch: async url => {
    if (String(url).includes('transcript-search')) {
      if (mode === 'error') return new Response(JSON.stringify({ error: 'scan incomplete' }), { status: 500 });
      return response({ steps: mode === 'retry' ? [text(10, 'hit')] : [], files: mode === 'missing' ? [] : ['a'] });
    }
    if (++attempts === 1) return new Response(JSON.stringify({ error: 'read offline' }), { status: 500 });
    return response({ step: text(10, '<script>inert</script>'), related: [] });
  } });
  ui.selected = id; transcriptCache.set(id, cached());
  try {
    await openTranscriptView(id); const panel = ui.transcriptView.panel, holder = ui.transcriptView.holder;
    submit(panel); await until(() => deepText(holder).includes('没有可读取'));
    mode = 'empty'; submit(panel); await until(() => deepText(holder).includes('没有命中'));
    mode = 'error'; submit(panel); await until(() => deepText(holder).includes('scan incomplete'));
    expect(deepText(holder)).not.toContain('没有命中');
    mode = 'retry'; submit(panel); await until(() => deepText(holder).includes('read offline'));
    await findByText(holder, '重试读取正文').onclick();
    expect(deepText(holder)).toContain('<script>inert</script>'); expect(holder.querySelector('script')).toBeNull();
  } finally { cleanup(dom, id); }
});
