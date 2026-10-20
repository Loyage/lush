import { test, expect } from 'bun:test';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { openTranscriptView, closeTranscriptView } from '../../src/ui/web/assets/transcript-view.js';
import { detailActions } from '../../src/ui/web/assets/detail-actions.js';
import { appendTranscriptSteps, paintTranscript } from '../../src/ui/web/assets/render-transcript.js';
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
    const toolbar = detailActions({ id: taskId }).root; dom.node('detail').append(toolbar);
    expect(requests).toHaveLength(0); await refreshDevicePreferences();
    const trigger = findByText(toolbar, '打开工作台'); trigger.focus(); dom.node('detail').scrollTop = 420;
    await openTranscriptView(taskId); const panel = ui.transcriptView.panel;
    expect(panel.querySelector('.transcript-back').textContent).toBe('返回 Worker');
    let list = panel.querySelector('.steps');
    expect([...list.children].map(node => node.dataset.seq)).toEqual(['2', '1']);
    const fold = panel.querySelector('[data-live="transcript-fold"]');
    expect(deepText(fold).trim()).toBe('全部收起');
    await fold.onclick();
    expect(panel.querySelector('.steps')).toBe(list);
    const tool = list.children[0], output = { seq: 3, kind: 'result', file: 'a', call_id: 'x', body: 'done' };
    transcriptCache.get(taskId).steps.push(output); appendTranscriptSteps(taskId, [output]);
    expect(list.children).toHaveLength(2); expect(list.children[0]).toBe(tool); expect(deepText(tool)).toContain('done');
    expect(tool.classList.contains('open')).toBe(false);
    expect(deepText(fold).trim()).toBe('全部展开');
    tool.querySelector('.step-head').onclick(); // Mixed state expands first, preserving loaded nodes.
    expect(deepText(fold).trim()).toBe('全部展开');
    await fold.onclick();
    expect([...list.children].every(node => node.classList.contains('open'))).toBe(true);
    expect(list.children[0]).toBe(tool); expect(deepText(fold).trim()).toBe('全部收起');
    const sort = panel.querySelector('[data-transcript-order="toggle"]');
    expect(panel.querySelector('.transcript-order').querySelectorAll('button')).toHaveLength(1);
    expect(deepText(sort).trim()).toBe('最新在前');
    expect(sort.getAttribute('data-help')).toContain('设备统一');
    await sort.onclick();
    await until(() => panel.querySelector('.steps') !== list);
    expect([...panel.querySelector('.steps').children].map(node => node.dataset.seq)).toEqual(['1', '2']);
    expect(readPref('transcriptOrder')).toBe('asc'); expect(requests.at(-1)).toContain('/transcript?after=0');
    expect(deepText(sort).trim()).toBe('最早在前');
    ui.transcriptView.filtered = true; ui.transcriptView.syncOrder();
    expect(sort.disabled).toBe(true); expect(sort.parentNode.getAttribute('data-help')).toContain('搜索结果');
    expect(sort.parentNode.tabIndex).toBe(0);
    ui.transcriptView.filtered = false;
    transcriptCache.get(taskId).steps = []; paintTranscript(taskId);
    const emptyFold = panel.querySelector('[data-live="transcript-fold"]');
    expect(emptyFold.disabled).toBe(true); expect(emptyFold.parentNode.getAttribute('data-help')).toContain('没有可展开');
    const beforeEmptyClick = requests.length; await emptyFold.onclick(); expect(requests).toHaveLength(beforeEmptyClick);
    panel.onkeydown({ key: 'Escape', preventDefault() {} });
    expect(ui.transcriptView).toBeNull(); expect(dom.document.activeElement).toBe(trigger); expect(dom.node('detail').scrollTop).toBe(420);
  } finally { closeTranscriptView(); transcriptCache.delete(taskId); resetTranscriptReaders(); ui.selected = null; writePref('transcriptOrder', 'desc'); dom.restore(); }
});
