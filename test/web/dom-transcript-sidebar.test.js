import { test, expect } from 'bun:test';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { until } from '../helpers.js';
import { openTranscriptView, closeTranscriptView } from '../../src/ui/web/assets/transcript-view.js';
import { resetTranscriptReaders } from '../../src/ui/web/assets/transcript-reader.js';
import { ui, transcriptCache } from '../../src/ui/web/assets/state.js';
import { refreshDevicePreferences } from '../../src/ui/web/assets/prefs.js';
import { makeWorld } from './dom-world.js';

test('reader search hydrates paired tool bodies, locates a hit and returns to all records', async () => {
  const id = 1101, calls = [], world = makeWorld();
  const call = { seq: 2, kind: 'tool', title: 'bash', tool_name: 'bash', file: 'a', call_id: 'x', body: '{"command":"echo needle"}' };
  const result = { seq: 3, kind: 'result', title: 'bash', file: 'a', call_id: 'x', body: 'needle output' };
  const dom = installDom({ fetch: async url => {
    const path = String(url); calls.push(path);
    if (path === '/api/host/preferences') return world.fetchImpl(url);
    if (path.includes('transcript-search')) return Response.json({ steps: [{ ...call, excerpt: 'needle' }], files: ['a'], has_more: false });
    return Response.json({ step: call, related: [result], context: [] });
  } });
  ui.selected = id; transcriptCache.set(id, { order: 'desc', steps: [{ seq: 1, kind: 'text', file: 'a', body: 'full record' }], files: ['a'], next: 1, oldest: 1 });
  try {
    await refreshDevicePreferences(); calls.length = 0; await openTranscriptView(id);
    const panel = ui.transcriptView.panel, sidebar = panel.querySelector('.transcript-sidebar'), holder = ui.transcriptView.holder;
    const form = sidebar.querySelector('form'); form.querySelector('input').value = 'needle';
    form.onsubmit({ preventDefault() {} }); await until(() => holder.querySelector('[data-result-seq="3"]'));
    expect(calls[0]).toContain('query=needle'); expect(sidebar.querySelector('.search-hit').dataset.hitSeq).toBe('2');
    expect(deepText(holder)).toContain('echo needle'); expect(deepText(holder)).toContain('needle output');
    sidebar.querySelector('.search-hit').querySelector('button').onclick();
    expect(holder.children[0].classList.contains('step-located')).toBe(true);
    findByText(sidebar, '返回全部记录').onclick();
    expect(holder.querySelector('.transcript-match')).toBeNull(); expect(deepText(holder)).toContain('full record');
  } finally { closeTranscriptView(); transcriptCache.delete(id); resetTranscriptReaders(); ui.selected = null; dom.restore(); }
});
