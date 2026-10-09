import { test, expect } from 'bun:test';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { openTranscriptView, closeTranscriptView } from '../../src/ui/web/assets/transcript-view.js';
import { renderAgent } from '../../src/ui/web/assets/render-agent.js';
import { appendTranscriptSteps } from '../../src/ui/web/assets/render-transcript.js';
import { openTranscriptStep, resetTranscriptReaders } from '../../src/ui/web/assets/transcript-reader.js';
import { ui, transcriptCache, transcriptOpen } from '../../src/ui/web/assets/state.js';
import { setPref, writePref } from '../../src/ui/web/assets/prefs.js';
import { until } from '../helpers.js';

const response = data => new Response(JSON.stringify(data));
const steps = [{ seq: 1, kind: 'text', file: 'a', body: '**first**' },
  { seq: 2, kind: 'tool', file: 'a', title: 'bash', body: '{"command":"echo safe"}', call_id: 'x' }];
const page = { steps, files: ['a'], next: 2, oldest: 1, has_older: false, has_more: false };

test('agent opens fullscreen rich details only on click, supports both orders, live pairing, and restores focus/scroll', async () => {
  const requests = [];
  const dom = installDom({ fetch: async url => { requests.push(String(url)); return response(page); } });
  const taskId = 998; ui.selected = taskId; writePref('transcriptOrder', 'desc');
  try {
    const agent = renderAgent({ id: taskId }, { files: ['a'], totals: {} }); dom.node('detail').append(agent);
    expect(agent.querySelector('.step')).toBeNull(); expect(requests).toHaveLength(0);
    expect(findByText(agent, '终端模式')).toBeNull();
    const trigger = findByText(agent, '打开执行详情'); trigger.focus(); dom.node('detail').scrollTop = 420;
    await trigger.onclick();
    const panel = dom.document.body.querySelector('.transcript-dialog');
    expect(ui.transcriptView.taskId).toBe(taskId); expect(transcriptOpen.has(taskId)).toBe(true);
    expect(dom.node('project-app').inert).toBe(true);
    expect(panel.querySelector('.markdown')).toBeTruthy();
    expect(deepText(panel)).toContain('echo safe');
    const list = panel.querySelector('.steps');
    expect([...list.children].map(node => node.dataset.seq)).toEqual(['2', '1']);
    const viewport = panel.querySelector('.transcript-viewport'); viewport.scrollTop = 240;
    const tool = list.children[0];
    const output = { seq: 3, kind: 'result', file: 'a', call_id: 'x', body: 'done' };
    transcriptCache.get(taskId).steps.push(output); appendTranscriptSteps(taskId, [output]);
    expect(list.children).toHaveLength(2); expect(list.children[0]).toBe(tool); expect(deepText(tool)).toContain('done');
    expect(viewport.scrollTop).toBe(240);
    const order = panel.querySelector('select'); order.value = 'asc'; order.onchange();
    await until(() => panel.querySelector('.steps') && panel.querySelector('.steps') !== list);
    expect([...panel.querySelector('.steps').children].map(node => node.dataset.seq)).toEqual(['1', '2']);
    expect(requests.at(-1)).toContain('/transcript?after=0');
    panel.onkeydown({ key: 'Escape', preventDefault() {} });
    expect(ui.transcriptView).toBeNull(); expect(transcriptOpen.has(taskId)).toBe(false);
    expect(dom.node('project-app').inert).not.toBe(true); expect(dom.document.activeElement).toBe(trigger);
    expect(dom.node('detail').scrollTop).toBe(420);
  } finally { closeTranscriptView(); transcriptCache.delete(taskId); resetTranscriptReaders(); ui.selected = null; writePref('transcriptOrder', 'desc'); dom.restore(); }
});

test('fullscreen failure retries and navigation leaves pending responses off the page', async () => {
  let calls = 0, finish;
  const dom = installDom({ fetch: async () => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ error: 'offline' }), { status: 500 });
    if (calls === 2) return response(page);
    return new Promise(resolve => { finish = resolve; });
  } });
  ui.selected = 997;
  try {
    await openTranscriptView(997);
    const panel = dom.document.body.querySelector('.transcript-dialog');
    expect(deepText(panel)).toContain('offline');
    await findByText(panel, '重试读取').onclick(); expect(panel.querySelector('.steps')).toBeTruthy();
    transcriptCache.delete(997);
    const pending = openTranscriptView(997);
    await dom.fire('hashchange'); finish(response(page)); await pending;
    expect(dom.document.body.querySelector('.transcript-dialog')).toBeNull(); expect(ui.transcriptView).toBeNull();
  } finally { closeTranscriptView(); transcriptCache.delete(997); resetTranscriptReaders(); ui.selected = null; dom.restore(); }
});

test('full raw original is read in segments beside the rich step and does not interpret HTML', async () => {
  const requests = [];
  const dom = installDom({ fetch: async url => {
    requests.push(String(url));
    return response({ step: { body: requests.length === 1 ? '<script>bad()</script>' : 'tail' }, has_more: requests.length === 1, next_offset: 24000 });
  } });
  const taskId = 996; ui.selected = taskId; transcriptCache.set(taskId, page);
  try {
    await openTranscriptView(taskId); await openTranscriptStep(taskId, 1);
    const panel = dom.document.body.querySelector('.transcript-dialog');
    expect(panel.querySelector('.transcript-full-original').querySelector('.raw-value').textContent).toContain('<script>');
    expect(panel.querySelector('script')).toBeNull();
    await findByText(panel, '继续读取原文').onclick();
    expect(requests[1]).toContain('offset=24000'); expect(deepText(panel)).toContain('已读取完整原文');
  } finally { closeTranscriptView(); transcriptCache.delete(taskId); resetTranscriptReaders(); ui.selected = null; dom.restore(); }
});

test('obsolete order responses cannot replace a newer fullscreen window', async () => {
  let finishOld;
  const dom = installDom({ fetch: async url => String(url).includes('transcript-latest')
    ? new Promise(resolve => { finishOld = resolve; }) : response(page) });
  ui.selected = 995; writePref('transcriptOrder', 'desc');
  try {
    const opening = openTranscriptView(995);
    setPref('transcriptOrder', 'asc');
    await until(() => transcriptCache.get(995)?.order === 'asc');
    finishOld(response({ ...page, steps: [{ seq: 9, kind: 'text', body: 'obsolete' }] })); await opening;
    const panel = dom.document.body.querySelector('.transcript-dialog');
    expect(transcriptCache.get(995).order).toBe('asc'); expect(deepText(panel)).not.toContain('obsolete');
  } finally { closeTranscriptView(); transcriptCache.delete(995); resetTranscriptReaders(); ui.selected = null; writePref('transcriptOrder', 'desc'); dom.restore(); }
});

test('mobile search opens on demand, keeps criteria, locates a hit and restores reading focus; Escape closes search first', async () => {
  const requests = [];
  const hit = { seq: 20, kind: 'result', tool_name: 'bash', file: 'a', body: 'error: needle', excerpt: 'needle', is_error: true };
  const dom = installDom({ fetch: async url => {
    requests.push(String(url));
    return response(String(url).includes('transcript-search') ? { steps: [hit], files: ['a'], next: 20 }
      : { step: hit, related: [], context: [] });
  } });
  const media = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia');
  let narrow = true;
  Object.defineProperty(globalThis, 'matchMedia', { value: () => ({ matches: narrow }), configurable: true });
  const taskId = 994; ui.selected = taskId; transcriptCache.set(taskId, page);
  try {
    await openTranscriptView(taskId);
    const panel = ui.transcriptView.panel, viewport = panel.querySelector('.transcript-viewport');
    const toggle = panel.querySelector('.transcript-search-toggle'), form = panel.querySelector('form');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(panel.classList.contains('transcript-search-open')).toBe(false);
    expect(toggle.getAttribute('aria-controls')).toBe(panel.querySelector('.transcript-sidebar').id);
    expect(requests).toHaveLength(0);
    await toggle.onclick();
    const query = form.querySelector('input'); query.value = 'needle';
    expect(dom.document.activeElement).toBe(query);
    form.onsubmit({ preventDefault() {} });
    await until(() => panel.querySelector('.transcript-match')?.querySelector('.step'));
    expect(panel.querySelector('.search-hit').querySelector('button').textContent).toBe('#20 · 工具输出 · bash · 失败');
    const card = panel.querySelector('.transcript-match'); let located = false;
    card.scrollIntoView = () => { located = true; if (narrow) expect(panel.classList.contains('transcript-search-open')).toBe(false); };
    await panel.querySelector('.search-hit').querySelector('button').onclick();
    expect(located).toBe(true); expect(dom.document.activeElement).toBe(viewport);
    expect(query.value).toBe('needle'); expect(ui.transcriptView.filtered).toBe(true);
    panel.onkeydown({ ctrlKey: true, shiftKey: true, key: 'f', preventDefault() {} });
    expect(toggle.getAttribute('aria-expanded')).toBe('true'); expect(dom.document.activeElement).toBe(query);
    panel.onkeydown({ key: 'Escape', preventDefault() {} });
    expect(ui.transcriptView).not.toBeNull(); expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(dom.document.activeElement).toBe(toggle);
    // Desktop hit navigation does not close the search column or steal its focus.
    await toggle.onclick(); narrow = false;
    await panel.querySelector('.search-hit').querySelector('button').onclick();
    expect(ui.transcriptView.searchOpen).toBe(true); expect(dom.document.activeElement).toBe(query);
    panel.onkeydown({ key: 'Escape', preventDefault() {} }); expect(ui.transcriptView).toBeNull();
  } finally {
    closeTranscriptView(); transcriptCache.delete(taskId); resetTranscriptReaders(); ui.selected = null;
    if (media) Object.defineProperty(globalThis, 'matchMedia', media); else delete globalThis.matchMedia;
    dom.restore();
  }
});

test('agent retains the copyable terminal follow command', async () => {
  const dom = installDom(), copied = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async text => { copied.push(text); } } }, configurable: true });
  try {
    const panel = renderAgent({ id: 77 }, { files: [] });
    expect(deepText(panel)).toContain('lush worker transcript 77 --follow');
    await findByText(panel, '复制命令').onclick(); expect(copied).toEqual(['lush worker transcript 77 --follow']);
  } finally { if (original) Object.defineProperty(globalThis, 'navigator', original); else delete globalThis.navigator; dom.restore(); }
});
