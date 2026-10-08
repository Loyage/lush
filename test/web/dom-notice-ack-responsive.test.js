import { test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';

const json = value => ({ ok: true, status: 200, json: async () => value });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
let requests, responses, recordResponse;
const dom = installDom({ fetch: async (url, options) => {
  if (url.endsWith('/api/action')) {
    const { method, params } = JSON.parse(options.body);
    requests.push({ method, params, url });
    return json(await responses.get(params.id).promise);
  }
  if (url.includes('/api/notices')) return json(await recordResponse.promise);
  throw new Error(`unexpected request ${url}`);
} });
const { ui, resetUiState } = await import('../../src/ui/web/assets/state.js');
const { renderNotices, readNotice, loadNoticeRecords } = await import('../../src/ui/web/assets/render-notices.js');
const { renderNoticeBanner } = await import('../../src/ui/web/assets/notice-banner.js');
const { noticeIdentity } = await import('../../src/ui/web/assets/notice-kind.js');
const { registerNavigation } = await import('../../src/ui/web/assets/navigate.js');
const info = id => ({ id, task_id: id + 10, kind: 'info', status: 'sent', source_event_id: id + 100,
  created_at: '2026-10-08T10:00:00Z', read_at: null, title: `告知 ${id}` });
const acknowledged = row => ({ ...row, read_at: '2026-10-08T11:00:00Z' });
const banner = () => dom.node('notice-banner');
const main = () => banner().querySelector('.notice-banner-info');
const known = () => banner().querySelector('.notice-banner-known');
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
let restoreNavigation, refreshGate, refreshCalls, detailCalls, detailHandler;
const paint = rows => {
  ui.lastSnapshot = { notices: rows, status: { project: '/tmp/notice-test' } };
  renderNotices(ui.lastSnapshot); renderNoticeBanner(ui.lastSnapshot);
};
beforeEach(() => {
  resetUiState(); dom.location.pathname = '/'; dom.node('error').textContent = '';
  requests = []; responses = new Map(); recordResponse = deferred();
  refreshGate = deferred(); refreshCalls = 0; detailCalls = [];
  detailHandler = async id => { ui.selected = id; ui.view = { id: 'worker', key: id }; return true; };
  restoreNavigation = registerNavigation({
    refresh: () => { refreshCalls++; return refreshGate.promise; },
    detail: id => { detailCalls.push(id); return detailHandler(id); },
    overview: async () => {}, resource: () => false,
  });
});
afterEach(async () => { refreshGate.resolve(); await tick(); restoreNavigation(); });
afterAll(() => dom.restore());

function startRead(row) {
  const gate = deferred(); responses.set(row.id, gate);
  return gate;
}

test('ACK resolves and updates cache, counts, history and next banner before slow refresh; continuous viewing is ready', async () => {
  const first = info(1), second = info(2);
  startRead(first); const ack = startRead(second);
  paint([first, second]);
  ui.noticeRecords = { rows: [first, second], status: 'all' };
  const opening = main().onclick(); await tick();
  expect(main().disabled).toBe(true); expect(known().disabled).toBe(true);
  const same = readNotice(second); expect(requests).toHaveLength(1);
  ack.resolve(acknowledged(second)); await opening; await same;
  expect(refreshCalls).toBe(1); // refreshGate is deliberately unresolved
  expect(ui.noticeReadRows.get(noticeIdentity(second)).read_at).toBeTruthy();
  expect(ui.noticeIndex.get(second.id).read_at).toBeTruthy();
  expect(ui.noticeRecords.rows.find(row => row.id === second.id).read_at).toBeTruthy();
  expect(dom.node('notice-count').textContent).toBe('0 待决 · 1 告知');
  expect(deepText(banner())).toContain('告知 1'); expect(main().disabled).toBe(false);
  const next = main().onclick(); await tick();
  expect(detailCalls).toEqual([second.task_id, first.task_id]);
  responses.get(first.id).resolve(acknowledged(first)); await next;
  expect(banner().hidden).toBe(true); expect(requests.map(row => row.params.id)).toEqual([2, 1]);
});

test('new notice can be viewed while old ACK is pending; old completion cannot unlock the new request or steal focus', async () => {
  const first = info(3), second = info(4);
  const ackFirst = startRead(first), ackSecond = startRead(second);
  paint([first]); const oldKnown = known(); oldKnown.focus();
  const oldOperation = oldKnown.onclick(); await tick();
  paint([first, second]);
  expect(main().disabled).toBe(false); expect(known().disabled).toBe(false);
  const newOperation = main().onclick(); await tick();
  expect(requests.map(row => row.params.id)).toEqual([3, 4]);
  const editor = dom.node('input'); editor.focus();
  ackFirst.resolve(acknowledged(first)); await oldOperation;
  expect(deepText(banner())).toContain('告知 4');
  expect(main().disabled).toBe(true); expect(known().disabled).toBe(true);
  expect(document.activeElement).toBe(editor);
  await main().onclick(); await known().onclick(); expect(requests).toHaveLength(2);
  ackSecond.resolve(acknowledged(second)); await newOperation;
  expect(banner().hidden).toBe(true);
});

test('late known completion does not move focus back to the banner after navigation', async () => {
  const row = info(18), next = info(19), ack = startRead(next); paint([row, next]);
  known().focus(); const reading = known().onclick(); await tick();
  ui.view = { id: 'inputs' }; document.body.focus();
  ack.resolve(acknowledged(next)); await reading;
  expect(document.activeElement).toBe(document.body); expect(known().disabled).toBe(false);
});

test('same notice opening stays single flight across a poll; a newer notice is not blocked by slow detail', async () => {
  const first = info(5), second = info(6), slowDetail = deferred();
  startRead(first); const secondACK = startRead(second);
  detailHandler = async id => {
    if (id === first.task_id) return slowDetail.promise;
    ui.selected = id; ui.view = { id: 'worker', key: id }; return true;
  };
  paint([first]); const opening = main().onclick(); await tick();
  paint([first]); expect(main().disabled).toBe(true); await main().onclick();
  expect(detailCalls).toEqual([first.task_id]);
  paint([first, second]); expect(main().disabled).toBe(false);
  const next = main().onclick(); await tick();
  secondACK.resolve(acknowledged(second)); await next;
  // The original notice becomes visible again but is still opening.
  expect(deepText(banner())).toContain('告知 5'); expect(main().disabled).toBe(true);
  slowDetail.resolve(true); await opening;
  expect(main().disabled).toBe(false); expect(requests.map(row => row.params.id)).toEqual([6]);
});

test('refresh failure is separate from successful ACK and never reports a read failure or restores the banner', async () => {
  const row = info(7), ack = startRead(row); paint([row]);
  const reading = known().onclick(); await tick(); ack.resolve(acknowledged(row)); await reading;
  expect(banner().hidden).toBe(true); expect(dom.node('error').textContent).toBe('');
  refreshGate.reject(new Error('slow refresh failed')); await tick();
  expect(dom.node('error').textContent).toContain('告知已读，但页面刷新失败：slow refresh failed');
  expect(dom.node('error').textContent).not.toContain('无法标记已知');
  await readNotice(row); expect(requests).toHaveLength(1);
  paint([row]); expect(banner().hidden).toBe(true);
});

test('refresh implementations that report offline without rejecting still show ACK-specific refresh failure', async () => {
  const row = info(8), ack = startRead(row); paint([row]);
  const reading = readNotice(row); await tick(); ack.resolve(acknowledged(row)); await reading;
  ui.offline = true; refreshGate.resolve(); await tick();
  expect(dom.node('error').textContent).toContain('告知已读，但页面刷新失败');
  expect(banner().hidden).toBe(true);
});

test('an already-busy refresh slot does not produce a false ACK refresh-failure report from old offline state', async () => {
  const row = info(15), ack = startRead(row); paint([row]);
  ui.busy = true; ui.offline = true;
  const reading = readNotice(row); await tick(); ack.resolve(acknowledged(row)); await reading; await tick();
  expect(refreshCalls).toBe(0); expect(dom.node('error').textContent).toBe('');
  expect(banner().hidden).toBe(true);
});

test('late successful detail from an old project cannot acknowledge the new-project same-ID notice', async () => {
  const row = info(16), slowDetail = deferred(); startRead(row); paint([row]);
  detailHandler = () => slowDetail.promise;
  const opening = main().onclick(); await tick();
  dom.location.pathname = '/p/abcdef0123456789/'; ui.selected = row.task_id;
  paint([{ ...row, title: '新项目同编号告知' }]);
  slowDetail.resolve(true); await opening;
  expect(requests).toHaveLength(0); expect(known().disabled).toBe(false);
  expect(deepText(banner())).toContain('新项目同编号告知');
});

test('missing read_at ACK is not success and cannot hide the notice', async () => {
  const row = info(17), ack = startRead(row); paint([row]);
  const reading = known().onclick(); await tick(); ack.resolve(row); await reading;
  expect(ui.noticeReadRows.size).toBe(0); expect(refreshCalls).toBe(0);
  expect(known().disabled).toBe(false); expect(deepText(banner())).toContain('告知 17');
});

test('failed or wrong-identity ACK retains the notice and permits retry; pending decisions are not acknowledged', async () => {
  const row = info(9), decision = { ...info(10), kind: 'question', status: 'open' };
  let ack = startRead(row); paint([row, decision]);
  const failed = known().onclick(); await tick(); ack.reject(new Error('write failed')); await failed;
  expect(deepText(banner())).toContain('告知 9'); expect(known().disabled).toBe(false);
  expect(refreshCalls).toBe(0);
  ack = startRead(row); const wrong = known().onclick(); await tick();
  ack.resolve(acknowledged({ ...row, source_event_id: 999 })); await wrong;
  expect(ui.noticeReadRows.size).toBe(0); expect(known().disabled).toBe(false);
  expect(dom.node('error').textContent).toContain('告知已读确认失败');
  ack = startRead(row); const retry = known().onclick(); await tick(); ack.resolve(acknowledged(row)); await retry;
  expect(known()).toBeNull(); expect(deepText(banner())).toContain('1 条待你处理');
  await readNotice(decision); expect(requests).toHaveLength(3);
});

test('late paginated unread response cannot undo an ACK or restore the unread record', async () => {
  const row = info(11), ack = startRead(row); paint([row]);
  ui.indexOpen = 'notices';
  ui.noticeRecords = { status: 'unread', rows: [], request: 0, selected: null, observedRevision: null, loadedPages: 0 };
  const loading = loadNoticeRecords(); const reading = readNotice(row); await tick();
  ack.resolve(acknowledged(row)); await reading;
  recordResponse.resolve({ notices: [row], has_more: false, cursor: row.id }); await loading;
  expect(deepText(dom.node('notices'))).not.toContain('告知 11');
  expect(ui.noticeIndex.get(row.id).read_at).toBeTruthy();
});

test('late old-project ACK and background failure cannot affect new-project locks, cache or messages', async () => {
  const old = info(12), oldACK = startRead(old); paint([old]);
  const oldOperation = known().onclick(); await tick();
  dom.location.pathname = '/p/abcdef0123456789/';
  const current = { ...old, title: '新项目告知' }, newACK = startRead(current);
  paint([current]); const newOperation = known().onclick(); await tick();
  oldACK.resolve(acknowledged(old)); await oldOperation;
  expect(known().disabled).toBe(true); expect(ui.noticeReadRows.size).toBe(0);
  expect(refreshCalls).toBe(0); expect(ui.noticeIndex.get(current.id).read_at).toBeNull();
  newACK.resolve(acknowledged(current)); await newOperation;
  expect(banner().hidden).toBe(true);
  dom.location.pathname = '/'; paint([{ ...info(13), title: '返回原项目' }]);
  refreshGate.reject(new Error('new project refresh failed')); await tick();
  expect(dom.node('error').textContent).toBe(''); expect(deepText(banner())).toContain('返回原项目');
});

test('deleted Worker late ACK cannot repopulate cache, record or banner', async () => {
  const row = info(14), ack = startRead(row); paint([row]);
  const operation = known().onclick(); await tick();
  ui.deletedWorkerIds.add(row.task_id); ui.noticeIndex.delete(row.id); paint([row]);
  ack.resolve(acknowledged(row)); await operation;
  expect(banner().hidden).toBe(true); expect(ui.noticeReadRows.size).toBe(0);
  expect(ui.noticeIndex.has(row.id)).toBe(false); expect(refreshCalls).toBe(0);
});
