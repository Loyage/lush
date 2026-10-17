import { test, expect } from 'bun:test';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { openTranscriptView, closeTranscriptView } from '../../src/ui/web/assets/transcript-view.js';
import { renderAgent } from '../../src/ui/web/assets/render-agent.js';
import { appendTranscriptSteps } from '../../src/ui/web/assets/render-transcript.js';
import { resetTranscriptReaders } from '../../src/ui/web/assets/transcript-reader.js';
import { ui, transcriptCache } from '../../src/ui/web/assets/state.js';
import { writePref, readPref, refreshDevicePreferences } from '../../src/ui/web/assets/prefs.js';
import { until } from '../helpers.js';
import { makeWorld } from './dom-world.js';

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
    const list = panel.querySelector('.steps');
    expect([...list.children].map(node => node.dataset.seq)).toEqual(['2', '1']);
    const tool = list.children[0], output = { seq: 3, kind: 'result', file: 'a', call_id: 'x', body: 'done' };
    transcriptCache.get(taskId).steps.push(output); appendTranscriptSteps(taskId, [output]);
    expect(list.children).toHaveLength(2); expect(list.children[0]).toBe(tool); expect(deepText(tool)).toContain('done');
    await panel.querySelector('[data-transcript-order="asc"]').onclick();
    await until(() => panel.querySelector('.steps') !== list);
    expect([...panel.querySelector('.steps').children].map(node => node.dataset.seq)).toEqual(['1', '2']);
    expect(readPref('transcriptOrder')).toBe('asc'); expect(requests.at(-1)).toContain('/transcript?after=0');
    panel.onkeydown({ key: 'Escape', preventDefault() {} });
    expect(ui.transcriptView).toBeNull(); expect(dom.document.activeElement).toBe(trigger); expect(dom.node('detail').scrollTop).toBe(420);
  } finally { closeTranscriptView(); transcriptCache.delete(taskId); resetTranscriptReaders(); ui.selected = null; writePref('transcriptOrder', 'desc'); dom.restore(); }
});
