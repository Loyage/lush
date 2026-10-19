import { test, expect } from 'bun:test';
import { installDom } from './project-dom.js';
import { makeWorld } from './dom-world.js';
import { ui } from '../../src/ui/web/assets/state.js';
import { openTranscriptView, closeTranscriptView } from '../../src/ui/web/assets/transcript-view.js';

test('CLI bookmark boots lazily, survives same-page navigation and disposes on leave/reboot', async () => {
  const world = makeWorld(), calls = [];
  const dom = installDom({ fetch: (url, options) => {
    calls.push(String(url));
    const id = /\/api\/worker\/([12])$/.exec(String(url))?.[1];
    if (id) return Response.json({ id: Number(id), worker_number: `W33${id}`, task_kind: 'order', workspace: `/tmp/worker-${id}` });
    return world.fetchImpl(url, options);
  } });
  try {
    const { boot } = await import('../../src/ui/web/assets/app.js');
    dom.location.hash = '#worker-1-cli'; await boot();
    expect(ui.view.id).toBe('execution'); expect(ui.selected).toBe(1); expect(ui.transcriptView.mode).toBe('cli');
    const root = ui.transcriptView.cli, input = root.querySelector('textarea');
    expect(root.tagName).toBe('SECTION'); input.value = 'lush status';
    await dom.fire('hashchange');
    expect(ui.transcriptView.cli).toBe(root); expect(input.value).toBe('lush status');
    dom.location.hash = '#worker-2-execution-cli'; await dom.fire('hashchange');
    expect(root.querySelector('.worker-cli-run').disabled).toBe(true);
    const next = ui.transcriptView.cli; expect(next).not.toBe(root);
    expect(next.querySelector('textarea').value).toBe('');
    await boot(); expect(next.querySelector('.worker-cli-run').disabled).toBe(true);
    const fresh = ui.transcriptView.cli;
    dom.location.hash = '#drafts'; await dom.fire('hashchange');
    expect(fresh.querySelector('.worker-cli-run').disabled).toBe(true); expect(ui.view.id).toBe('drafts');
    expect(world.state.actions.filter(action => action.method === 'worker.cli_history')).toHaveLength(3);
    expect(world.state.actions.some(action => ['worker.cli_preview', 'worker.cli_execute', 'worker.cli_history_clear'].includes(action.method))).toBe(false);
    expect(calls.some(path => /\/(transcript|diff|history|usage)(\?|$)/.test(path))).toBe(false);
  } finally { ui.disposeWorkerCli?.(); dom.restore(); }
});

test('new-tab reader has no Worker return entry and stays open across code/transcript and Escape', async () => {
  const world = makeWorld(), reads = [];
  const dom = installDom({ fetch: (url, options) => {
    reads.push(String(url));
    if (String(url).endsWith('/code-state')) return Response.json({ available: false, reason: 'archived' });
    return world.fetchImpl(url, options);
  } });
  try {
    const { boot } = await import('../../src/ui/web/assets/app.js');
    dom.location.hash = '#worker-1-execution-code'; await boot();
    expect(ui.view.id).toBe('execution'); expect(ui.transcriptView.mode).toBe('code');
    expect(ui.transcriptView.panel.querySelector('.transcript-back')).toBeNull();
    expect(dom.node('detail').querySelector('a')).toBeNull();
    expect(reads.some(path => path.includes('/code-state'))).toBe(true);
    expect(reads.some(path => path.includes('/transcript'))).toBe(false);
    dom.location.hash = '#worker-1-execution'; await dom.fire('hashchange');
    expect(ui.transcriptView.mode).toBe('transcript'); expect(ui.transcriptView.panel.querySelector('.steps')).toBeTruthy();
    dom.location.hash = '#drafts'; await dom.fire('hashchange');
    expect(ui.transcriptView).toBeNull(); expect(ui.view.id).toBe('drafts');
    dom.location.hash = '#worker-1-execution'; await dom.fire('hashchange');
    const reader = ui.transcriptView, media = globalThis.matchMedia;
    try {
      globalThis.matchMedia = () => ({ matches: true });
      await reader.panel.querySelector('.transcript-search-toggle').onclick(); expect(reader.searchOpen).toBe(true);
      reader.panel.onkeydown({ key: 'Escape', preventDefault() {} }); expect(reader.searchOpen).toBe(false);
      reader.panel.onkeydown({ key: 'Escape', preventDefault() {} });
      reader.panel.oncancel({ preventDefault() {} });
      expect(ui.transcriptView).toBe(reader); expect(dom.location.hash).toBe('#worker-1-execution');
      expect(reader.panel.querySelector('.transcript-back')).toBeNull();
    } finally { globalThis.matchMedia = media; }
    // Original-step/reference helpers may reopen the reader without repeating its page options.
    await openTranscriptView(1); expect(ui.transcriptView.standalone).toBe(true);
    expect(ui.transcriptView.panel.querySelector('.transcript-back')).toBeNull();
  } finally { closeTranscriptView(); dom.restore(); }
});
