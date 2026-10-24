import { test, expect } from 'bun:test';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { openTranscriptView, closeTranscriptView } from '../../src/ui/web/assets/transcript-view.js';
import { detailActions } from '../../src/ui/web/assets/detail-actions.js';
import { appendTranscriptSteps, paintTranscript } from '../../src/ui/web/assets/render-transcript.js';
import { resetTranscriptReaders, openTranscriptStep } from '../../src/ui/web/assets/transcript-reader.js';
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
    await openTranscriptView(taskId, undefined, { task: { id: taskId, worker_number: 'W410', status: 'running', task_kind: 'order', auto_title: '改进界面阅读体验' } });
    const panel = ui.transcriptView.panel;
    expect(panel.querySelector('.transcript-back').textContent).toBe('返回 Worker');
    const topic = panel.querySelector('.transcript-topic');
    expect(topic.textContent).toBe('改进界面阅读体验');
    ui.transcriptView.paintStatus({ id: taskId, status: 'waiting' });
    expect(topic.textContent).toBe('改进界面阅读体验');
    expect(panel.getAttribute('aria-label')).toContain('W410 · 改进界面阅读体验');
    ui.transcriptView.paintStatus({ id: taskId, display_title: '自定义阅读标题' });
    expect(topic.textContent).toBe('自定义阅读标题');
    ui.transcriptView.paintStatus({ id: taskId, display_title: null, auto_title: null });
    expect(topic.hidden).toBe(true);
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
    const originalFetch = globalThis.fetch; let finishOriginal;
    globalThis.fetch = () => new Promise(resolve => { finishOriginal = resolve; });
    try {
      const reading = openTranscriptStep(taskId, 2, { root: panel });
      const raw = panel.querySelector('.transcript-full-original');
      expect(deepText(raw)).toContain('正在读取原文…'); expect(raw.querySelector('button').disabled).toBe(true);
      finishOriginal(Response.json({ step: { body: '精确原文' }, next_offset: 4, has_more: false })); await reading;
      expect(deepText(raw)).toContain('已读取完整原文。'); expect(raw.querySelector('pre').textContent).toBe('精确原文');
    } finally { globalThis.fetch = originalFetch; }
    transcriptCache.get(taskId).steps = []; paintTranscript(taskId);
    const emptyFold = panel.querySelector('[data-live="transcript-fold"]');
    expect(emptyFold.disabled).toBe(true); expect(emptyFold.parentNode.getAttribute('data-help')).toContain('没有可展开');
    const beforeEmptyClick = requests.length; await emptyFold.onclick(); expect(requests).toHaveLength(beforeEmptyClick);
    panel.onkeydown({ key: 'Escape', preventDefault() {} });
    expect(ui.transcriptView).toBeNull(); expect(dom.document.activeElement).toBe(trigger); expect(dom.node('detail').scrollTop).toBe(420);
  } finally { closeTranscriptView(); transcriptCache.delete(taskId); resetTranscriptReaders(); ui.selected = null; writePref('transcriptOrder', 'desc'); dom.restore(); }
});
