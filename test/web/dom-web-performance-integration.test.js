import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';

const world = makeWorld(), calls = [];
let intercept = null;
const dom = installDom({ fetch: (url, options) => {
  calls.push(String(url));
  return intercept?.(String(url), options) ?? world.fetchImpl(url, options);
} });
const { boot } = await import('../../src/ui/web/assets/app.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
const { loadDetail, disposeDetailRequests } = await import('../../src/ui/web/assets/detail.js');
const { initRefreshPolling } = await import('../../src/ui/web/assets/refresh.js');
afterAll(() => { disposeDetailRequests(); initRefreshPolling()(); dom.restore(); });

test('boot owns one visibility lifecycle; hidden timers skip reads and resume refreshes', async () => {
  await boot(); await boot();
  expect(dom.listeners.visibilitychange).toHaveLength(1);
  const before = calls.length;
  dom.document.hidden = true;
  await dom.intervalFor(1500)(); await dom.intervalFor(3000)();
  expect(calls.length).toBe(before);
  dom.document.hidden = false;
  await dom.fire('visibilitychange');
  expect(calls.length).toBeGreaterThan(before);
  expect(ui.busy).toBe(false);
});

test('boot aborts old detail reads before replacing UI state and rejects stale publication', async () => {
  let release, signal;
  const gate = new Promise(resolve => { release = resolve; });
  intercept = (url, options) => {
    if (url === '/api/worker/1') { signal = options.signal; return gate; }
  };
  const pending = loadDetail(1);
  expect(signal.aborted).toBe(false);
  const oldNumbers = ui.workerNumbers;
  dom.location.hash = '';
  intercept = null;
  await boot();
  expect(signal.aborted).toBe(true);
  expect(ui.workerNumbers).not.toBe(oldNumbers);
  expect(dom.listeners.visibilitychange).toHaveLength(1);
  release(await world.fetchImpl('/api/worker/1'));
  expect(await pending).toBe(false);
  expect(ui.view.id).toBe('overview');
  expect(deepText(dom.node('detail'))).toContain('项目概览');
});
