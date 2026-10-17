import { test, expect } from 'bun:test';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { openTranscriptView, closeTranscriptView } from '../../src/ui/web/assets/transcript-view.js';
import { renderAgent } from '../../src/ui/web/assets/render-agent.js';
import { appendTranscriptSteps, paintTranscript, loadTranscript, transcriptMatch } from '../../src/ui/web/assets/render-transcript.js';
import { resetTranscriptReaders } from '../../src/ui/web/assets/transcript-reader.js';
import { ui, transcriptCache } from '../../src/ui/web/assets/state.js';
import { writePref, readPref, refreshDevicePreferences } from '../../src/ui/web/assets/prefs.js';
import { until } from '../helpers.js';
import { makeWorld } from './dom-world.js';

for (const order of ['asc', 'desc']) test(`bulk fold stays consistent across older/newer pages, live steps and reload (${order})`, async () => {
  const id = 1198, requests = [];
  const text = (seq, kind = 'text') => ({ seq, kind, file: 'a', body: `record ${seq}` });
  const tool = seq => ({ ...text(seq, 'tool'), call_id: `call-${seq}`, tool_name: 'bash', body: '{"command":"echo fold"}' });
  const result = seq => ({ ...text(seq, 'result'), call_id: `call-${seq - 1}` });
  const initial = [tool(20), result(21), text(22), text(23, 'meta')];
  const older = [tool(10), result(11), text(12), text(13, 'meta')];
  const newer = [text(30), text(31, 'meta')];
  const state = { order, steps: [...initial], files: ['a'], next: 23, oldest: 20, has_older: true, has_more: true };
  const dom = installDom({ fetch: async url => {
    const path = String(url); requests.push(path);
    if (path.includes('before=20')) return Response.json({ steps: older, oldest: 10, has_older: true });
    if (path.includes('before=10')) return Response.json({ steps: [text(1, 'input'), text(2, 'meta')], oldest: 1, has_older: false });
    if (path.endsWith('after=23')) return Response.json({ steps: newer, next: 31, has_more: false });
    return Response.json({ ...state, steps: initial });
  } });
  ui.selected = id; transcriptCache.set(id, state);
  const holder = dom.document.createElement('section'); holder.classList.add('transcript'); dom.node('detail').append(holder);
  const fold = () => holder.querySelector('[data-live="transcript-fold"]');
  const node = seq => holder.querySelector(`[data-seq="${seq}"]`);
  const expectOpen = (seq, open) => {
    expect(node(seq).classList.contains('open')).toBe(open);
    expect(node(seq).querySelector('.step-head').getAttribute('aria-expanded')).toBe(String(open));
    expect(node(seq).querySelector('.step-body').hidden).toBe(!open);
  };
  const append = values => { state.steps.push(...values); appendTranscriptSteps(id, values); };
  try {
    paintTranscript(id);
    expectOpen(20, true); expectOpen(23, false);
    expect(fold().textContent).toBe('展开全部步骤');
    // A new bulk action replaces even unloaded per-step overrides, not another
    // Worker's choices or independent long-content preview preferences.
    ui.stepToggle.set(`${id}:10`, false); ui.stepToggle.set(`${id}:22:body`, true);
    ui.stepToggle.set('1199:10', false);
    fold().onclick(); expectOpen(23, true);
    expect(ui.stepToggle.has(`${id}:10`)).toBe(false);
    expect(ui.stepToggle.get(`${id}:22:body`)).toBe(true);
    expect(ui.stepToggle.get('1199:10')).toBe(false);
    fold().onclick(); expectOpen(20, false);
    const original = node(20);
    await holder.querySelector('[data-live="transcript-older"]').onclick();
    for (const seq of [10, 12, 13]) expectOpen(seq, false);
    expect(node(20)).toBe(original);
    expect(node(11)).toBeNull(); expect(node(10).querySelector('[data-result-seq="11"]')).toBeTruthy();
    await holder.querySelector('[data-live="transcript-newer"]').onclick();
    expectOpen(30, false); expectOpen(31, false);
    append([tool(40)]); const liveTool = node(40);
    append([result(41), text(42)]);
    expectOpen(40, false); expectOpen(42, false); expect(node(40)).toBe(liveTool);
    expect(node(41)).toBeNull(); expect(liveTool.querySelector('[data-result-seq="41"]')).toBeTruthy();
    expect(fold().textContent).toBe('展开全部步骤');
    // Search bodies are explicitly open, but must not override the bulk default.
    const match = transcriptMatch(id, older[2]);
    expect(match.querySelector('.step').classList.contains('open')).toBe(true);
    paintTranscript(id); expectOpen(12, false);
    node(12).querySelector('.step-head').onclick(); expectOpen(12, true);
    append([text(43)]); expectOpen(43, false); expectOpen(12, true);
    fold().onclick(); expectOpen(43, true); expectOpen(23, true);
    append([text(44, 'meta')]); expectOpen(44, true);
    await holder.querySelector('[data-live="transcript-older"]').onclick();
    expectOpen(1, true); expectOpen(2, true);
    // The control follows single-step changes and reads the current list when
    // clicked, instead of a stale initial-page snapshot.
    node(12).querySelector('.step-head').onclick();
    expect(fold().textContent).toBe('展开全部步骤');
    fold().onclick(); expectOpen(12, true); expect(fold().textContent).toBe('收起全部步骤');
    append([text(45)]); expectOpen(45, true);
    node(22).querySelector('.step-head').onclick();
    paintTranscript(id); expectOpen(22, false); expectOpen(45, true);
    await loadTranscript(id); expectOpen(22, false); expectOpen(23, true);
    expect(requests).toContain(`/api/worker/${id}/transcript-latest?before=20&limit=100`);
    expect(requests).toContain(`/api/worker/${id}/transcript?after=23`);
  } finally { transcriptCache.delete(id); ui.selected = null; dom.restore(); }
});

test('bulk control appears when live steps make a single-step reader foldable', () => {
  const dom = installDom(), id = 1197;
  const first = { seq: 1, kind: 'text', body: 'first' };
  const state = { order: 'desc', steps: [first], files: [], next: 1 };
  ui.selected = id; transcriptCache.set(id, state);
  const holder = dom.document.createElement('section'); holder.classList.add('transcript'); dom.node('detail').append(holder);
  try {
    paintTranscript(id);
    const control = holder.querySelector('[data-live="transcript-fold"]');
    expect(control.hidden).toBe(true);
    const second = { seq: 2, kind: 'text', body: 'second' };
    state.steps.push(second); appendTranscriptSteps(id, [second]);
    expect(control.hidden).toBe(false); expect(control.textContent).toBe('收起全部步骤');
    holder.querySelector('[data-seq="2"]').querySelector('.step-head').onclick();
    expect(control.textContent).toBe('展开全部步骤');
    control.onclick();
    expect(holder.querySelector('[data-seq="2"]').classList.contains('open')).toBe(true);
  } finally { transcriptCache.delete(id); ui.selected = null; dom.restore(); }
});

const steps = [{ seq: 1, kind: 'text', file: 'a', body: '**first**' },
  { seq: 2, kind: 'tool', file: 'a', title: 'bash', body: '{"command":"echo reader"}', call_id: 'x' }];
const page = { steps, files: ['a'], next: 2, oldest: 1, has_older: false, has_more: false };

test('execution reader switches order, pairs live results and returns to Worker focus', async () => {
  const world = makeWorld(), requests = [];
  const dom = installDom({ fetch: async (url, options) => {
    requests.push(String(url));
    return String(url) === '/api/host/preferences' ? world.fetchImpl(url, options) : Response.json(page);
  } });
  const taskId = 998; ui.selected = taskId; writePref('transcriptOrder', 'desc');
  try {
    const agent = renderAgent({ id: taskId }, { files: ['a'], totals: {} }); dom.node('detail').append(agent);
    expect(requests).toHaveLength(0); await refreshDevicePreferences();
    const trigger = findByText(agent, '打开执行详情'); trigger.focus(); dom.node('detail').scrollTop = 420;
    await openTranscriptView(taskId); const panel = ui.transcriptView.panel;
    expect(panel.querySelector('.transcript-back').textContent).toBe('返回 Worker');
    let list = panel.querySelector('.steps');
    expect([...list.children].map(node => node.dataset.seq)).toEqual(['2', '1']);
    panel.querySelector('[data-live="transcript-fold"]').onclick();
    list = panel.querySelector('.steps');
    const tool = list.children[0], output = { seq: 3, kind: 'result', file: 'a', call_id: 'x', body: 'done' };
    transcriptCache.get(taskId).steps.push(output); appendTranscriptSteps(taskId, [output]);
    expect(list.children).toHaveLength(2); expect(list.children[0]).toBe(tool); expect(deepText(tool)).toContain('done');
    expect(tool.classList.contains('open')).toBe(false);
    expect(panel.querySelector('[data-live="transcript-fold"]').textContent).toBe('展开全部步骤');
    await panel.querySelector('[data-transcript-order="asc"]').onclick();
    await until(() => panel.querySelector('.steps') !== list);
    expect([...panel.querySelector('.steps').children].map(node => node.dataset.seq)).toEqual(['1', '2']);
    expect(readPref('transcriptOrder')).toBe('asc'); expect(requests.at(-1)).toContain('/transcript?after=0');
    panel.onkeydown({ key: 'Escape', preventDefault() {} });
    expect(ui.transcriptView).toBeNull(); expect(dom.document.activeElement).toBe(trigger); expect(dom.node('detail').scrollTop).toBe(420);
  } finally { closeTranscriptView(); transcriptCache.delete(taskId); resetTranscriptReaders(); ui.selected = null; writePref('transcriptOrder', 'desc'); dom.restore(); }
});
