import { test, expect } from 'bun:test';
import { installDom } from './project-dom.js';
import { makeWorld } from './dom-world.js';
import { ui } from '../../src/ui/web/assets/state.js';

test('execution code deep link opens its reader, switches to transcript and returns to the Worker', async () => {
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
    expect(reads.some(path => path.includes('/code-state'))).toBe(true);
    expect(reads.some(path => path.includes('/transcript'))).toBe(false);
    dom.location.hash = '#worker-1-execution'; await dom.fire('hashchange');
    expect(ui.transcriptView.mode).toBe('transcript'); expect(ui.transcriptView.panel.querySelector('.steps')).toBeTruthy();
    dom.location.hash = '#drafts'; await dom.fire('hashchange');
    expect(ui.transcriptView).toBeNull(); expect(ui.view.id).toBe('drafts');
    dom.location.hash = '#worker-1-execution'; await dom.fire('hashchange');
    ui.transcriptView.panel.onkeydown({ key: 'Escape', preventDefault() {} });
    expect(ui.transcriptView).toBeNull(); expect(dom.location.hash).toBe('#worker-1');
    await dom.fire('hashchange'); expect(ui.view.id).toBe('task'); expect(ui.selected).toBe(1);
  } finally { dom.restore(); }
});
