import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText } from './project-dom.js';
import { makeWorld, NOW, iso } from './dom-world.js';
import { until } from '../helpers.js';

const world = makeWorld();
let failTask = false, failRead = false, releaseTask = null, deferTask = false;
let deferRead = false, releaseRead = null, readRequests = 0;
const json = (value, status = 200) => ({ ok: status === 200, status, json: async () => value });
const fetchImpl = async (url, opts) => {
  const target = new URL(url, 'http://localhost');
  if (target.pathname === '/api/action') {
    const { method, params } = JSON.parse(opts.body);
    if (method === 'notice.read') {
      readRequests++;
      if (deferRead) await new Promise(resolve => { releaseRead = resolve; });
      if (failRead) return json({ error: 'test read failure' }, 500);
      world.state.actions.push({ method, params });
      const row = world.state.notices.find(row => row.id === params.id);
      row.read_at = iso(NOW); return json({ ...row });
    }
  }
  if (target.pathname === '/api/notices' && target.searchParams.get('status') === 'unread') {
    const notices = world.state.notices.filter(row => row.source_event_id && !row.read_at);
    return json({ notices, cursor: notices.at(-1)?.id ?? null, has_more: false });
  }
  if (target.pathname === '/api/worker/4') {
    if (failTask) return json({ error: 'test detail failure' }, 500);
    if (deferTask) await new Promise(resolve => { releaseTask = resolve; });
  }
  return world.fetchImpl(url, opts);
};
const dom = installDom({ fetch: fetchImpl });
const { boot } = await import('../../src/ui/web/assets/app.js');
const { setPref, readPref, normalizeNoticeChannels } = await import('../../src/ui/web/assets/prefs.js');
const { renderNoticeBanner } = await import('../../src/ui/web/assets/notice-banner.js');
const { renderNotices, readNotice } = await import('../../src/ui/web/assets/render-notices.js');
const { openNotice } = await import('../../src/ui/web/assets/render-notices.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
const { overview } = await import('../../src/ui/web/assets/navigate.js');
dom.node('side-nav').replaceChildren(); await boot();
afterAll(() => dom.restore());
const info = id => ({ id, task_id: 4, kind: 'info', status: 'sent', source_event_id: id + 100,
  read_at: null, lifecycle_type: 'idle', title: `Task 告知 ${id}`,  body: '本轮已静息，不代表验收或合并', created_at: iso(NOW - 100) });
const update = () => dom.intervalFor(1500)();

test('待决与未读告知分开显示；历史 info 和已读告知不进入提醒', async () => {
  const old = { ...info(11), source_event_id: null };
  const read = { ...info(12), read_at: iso(NOW) };
  world.state.notices = [info(10), old, read, { ...info(13), kind: 'question', status: 'open' }];
  await update();
  expect(deepText(dom.node('notice-banner'))).toContain('1 条待你处理');
  expect(deepText(dom.node('notice-banner'))).toContain('1 条未读告知');
  expect(dom.node('notice-count').textContent).toBe('1 待决 · 1 告知');
  expect(dom.node('notice-banner').querySelector('.notice-banner-info').getAttribute('data-help')).toContain('不会启动 Agent');
  dom.location.hash = '#notices'; await dom.fire('hashchange');
  const tab = dom.node('side-notices-body').querySelectorAll('button').find(node => node.dataset.noticeFilter === 'unread');
  await tab.onclick();
  expect(deepText(dom.node('notices'))).toContain('Task 告知 10');
  expect(deepText(dom.node('notices'))).not.toContain('Task 告知 11');
});

test('点击告知直接进入 Task，成功加载后仅标已读，保留 sent 和历史', async () => {
  world.state.notices = [info(20)]; world.state.actions = [];
  await update();
  await dom.node('notice-banner').querySelector('.notice-banner-info').onclick();
  expect(dom.location.hash).toBe('#worker-4'); expect(ui.detailTask).toBe(4);
  expect(world.state.actions).toEqual([{ method: 'notice.read', params: { id: 20 } }]);
  expect(world.state.notices[0].read_at).toBeTruthy(); expect(world.state.notices[0].status).toBe('sent');
  expect(dom.node('notice-banner').hidden).toBe(true);
  await openNotice(20); expect(world.state.actions).toHaveLength(1);
});

test('待开始告知留在原页，已知不启动；用户点击查看才进入 Worker 并标已读', async () => {
  await overview();
  const row = { ...info(25), lifecycle_type: 'created', title: 'Worker W154 待开始', body: '尚未调用 Agent，可配置后手动开始' };
  world.state.notices = [row]; world.state.actions = []; await update();
  const view = ui.view, hash = dom.location.hash;
  expect(deepText(dom.node('notice-banner'))).toContain('Worker W154 待开始');
  expect(ui.view).toBe(view); expect(dom.location.hash).toBe(hash);
  await dom.node('notice-banner').querySelector('.notice-banner-known').onclick();
  expect(ui.view).toBe(view); expect(dom.location.hash).toBe(hash);
  expect(world.state.actions).toEqual([{ method: 'notice.read', params: { id: 25 } }]);
  await until(() => !ui.busy);
  world.state.notices = [{ ...row, id: 26, source_event_id: 126, read_at: null }]; world.state.actions = []; await update();
  const channels = normalizeNoticeChannels(); channels.created.banner = false; setPref('noticeChannels', channels);
  expect(dom.node('notice-banner').querySelector('.notice-banner-info')).toBeNull();
  setPref('noticeChannels', normalizeNoticeChannels());
  await dom.node('notice-banner').querySelector('.notice-banner-info').onclick();
  expect(dom.location.hash).toBe('#worker-4'); expect(ui.detailTask).toBe(4);
  expect(world.state.actions).toEqual([{ method: 'notice.read', params: { id: 26 } }]);
});

test('打开 Task 失败不标已读，不消失；成功重试后已读', async () => {
  world.state.notices = [info(30)]; world.state.actions = []; await update();
  failTask = true;
  await expect(openNotice(30)).rejects.toThrow('test detail failure');
  expect(world.state.actions).toHaveLength(0); expect(world.state.notices[0].read_at).toBeNull();
  failTask = false; await openNotice(30);
  expect(world.state.actions).toHaveLength(1);
});

test('已读写入失败保留未读状态，允许显式重试', async () => {
  world.state.notices = [info(35)]; world.state.actions = []; await update();
  failRead = true;
  await expect(openNotice(35)).rejects.toThrow('test read failure');
  expect(world.state.notices[0].read_at).toBeNull(); expect(world.state.actions).toHaveLength(0);
  failRead = false; await openNotice(35); expect(world.state.notices[0].read_at).toBeTruthy();
});

test('迟到的 Task 加载不能覆盖新导航，也不能把未看的告知标已读', async () => {
  world.state.notices = [info(40)]; world.state.actions = []; await update();
  deferTask = true;
  const opening = openNotice(40);
  while (!releaseTask) await Promise.resolve();
  await overview();
  deferTask = false; releaseTask(); releaseTask = null; await opening;
  expect(ui.view.id).toBe('overview'); expect(world.state.actions).toHaveLength(0);
  expect(world.state.notices[0].read_at).toBeNull();
});

test('系统通知数字深链接从未缓存记录定位 Task 并已读；非法 ID 不发送读动作', async () => {
  world.state.notices = [info(50)]; world.state.actions = []; ui.noticeIndex.clear();
  dom.location.hash = '#notice-50'; await dom.fire('hashchange');
  expect(dom.location.hash).toBe('#worker-4'); expect(world.state.actions).toHaveLength(1);
  await openNotice(-1); await openNotice('50'); await openNotice(Number.MAX_SAFE_INTEGER + 1);
  expect(world.state.actions).toHaveLength(1);
});

test('首次启动 Notice 深链接能加载 Task；待决通知保留问答入口且不写已读', async () => {
  world.state.notices = [info(60)]; world.state.actions = [];
  dom.location.hash = '#notice-60'; await boot();
  expect(ui.detailTask).toBe(4); expect(world.state.actions).toHaveLength(1);
  world.state.notices = [{ ...info(61), kind: 'question', status: 'open', source_event_id: null }];
  world.state.actions = []; await update();
  dom.location.hash = '#notice-61'; await dom.fire('hashchange');
  expect(ui.noticeFocus).toBe(61); expect(world.state.actions).toHaveLength(0);
  expect(deepText(dom.node('detail'))).toContain('Task 告知 61');
});

const banner = () => dom.node('notice-banner');
const known = () => banner().querySelector('.notice-banner-known');
const event = (row, type, x, y, extra = {}) => {
  const value = { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y,
    target: row.querySelector('.notice-banner-title'), preventDefault() {}, ...extra };
  for (const handler of row.listeners[type] || []) handler(value);
};

// Setting channels only changes reminders, never the stored/list unread facts.
test('三类页面渠道独立筛选，未知分类不按标题猜测；待决和未读列表计数不变', async () => {
  const rows = [info(70), { ...info(71), lifecycle_type: 'analysis' }, { ...info(72), lifecycle_type: 'failed' },
    { ...info(73), lifecycle_type: 'future', title: '失败并分析完成' }, { ...info(74), lifecycle_type: null },
    { ...info(75), kind: 'question', status: 'open' }];
  world.state.notices = rows; world.state.actions = []; await update();
  const value = normalizeNoticeChannels(); for (const type of ['idle', 'analysis', 'failed']) value[type].banner = false;
  setPref('noticeChannels', value);
  expect(dom.node('notice-count').textContent).toBe('1 待决 · 5 告知');
  expect(deepText(banner())).toContain('2 条未读告知');
  expect(deepText(banner())).toContain('Task 告知 74');
  expect(banner().querySelectorAll('.notice-banner-known')).toHaveLength(1);
  expect(world.state.actions).toHaveLength(0);
  world.state.notices = rows.filter(row => ![73, 74].includes(row.id)); await update();
  expect(known()).toBeNull(); expect(banner().hidden).toBe(false);
  expect(deepText(banner())).toContain('1 条待你处理');
  expect(dom.node('notice-count').textContent).toBe('1 待决 · 3 告知');
  setPref('noticeChannels', normalizeNoticeChannels());
});

test('已知仅处理当前最新一条，不导航、不验收、不合并；下一条保留历史与可见按钮', async () => {
  world.state.notices = [info(80), info(81)]; world.state.actions = []; await update();
  const previousHash = dom.location.hash, previousView = ui.view;
  expect(deepText(banner())).toContain('Task 告知 81');
  known().focus(); await known().onclick();
  expect(world.state.actions).toEqual([{ method: 'notice.read', params: { id: 81 } }]);
  expect(dom.location.hash).toBe(previousHash); expect(ui.view).toBe(previousView);
  expect(deepText(banner())).toContain('Task 告知 80');
  expect(world.state.notices).toHaveLength(2); expect(world.state.notices[1].status).toBe('sent');
  expect(dom.node('notice-count').textContent).toBe('0 待决 · 1 告知');
  expect(document.activeElement).toBe(known());
});

test('已知失败不消除且报错，显式重试按钮仍可用；轮询绝不自动 ACK', async () => {
  world.state.notices = [info(90)]; world.state.actions = []; await update();
  failRead = true; const before = readRequests;
  await known().onclick();
  expect(deepText(banner())).toContain('Task 告知 90'); expect(known().disabled).toBe(false);
  expect(dom.node('error').textContent).toContain('test read failure');
  await update(); await update(); expect(readRequests).toBe(before + 1);
  expect(world.state.notices[0].read_at).toBeNull();
  failRead = false; await known().onclick(); expect(banner().hidden).toBe(true);
});

test('ACK 在途新告知/轮询/双击共用单飞，始终只标原展示条；陈旧快照不复活已读', async () => {
  world.state.notices = [info(100)]; world.state.actions = []; await update();
  const stale = structuredClone(ui.lastSnapshot); const before = readRequests;
  const original = known();
  deferRead = true; const ack = original.onclick();
  while (!releaseRead) await Promise.resolve();
  const same = readNotice(info(100));
  world.state.notices.push(info(101)); await update();
  expect(deepText(banner())).toContain('Task 告知 101'); expect(known().disabled).toBe(false);
  await original.onclick(); expect(readRequests).toBe(before + 1);
  deferRead = false; releaseRead(); releaseRead = null; await Promise.all([ack, same]);
  expect(world.state.actions).toEqual([{ method: 'notice.read', params: { id: 100 } }]);
  expect(world.state.notices[1].read_at).toBeNull(); expect(known().disabled).toBe(false);
  renderNotices(stale); renderNoticeBanner(stale); expect(banner().hidden).toBe(true);
  await readNotice(info(100)); expect(readRequests).toBe(before + 1);
  // ACK no longer waits for the background refresh; let it leave its single-flight slot.
  await new Promise(resolve => setTimeout(resolve, 0));
  await update(); expect(deepText(banner())).toContain('Task 告知 101');
});

test('横滑只已读开始时展示条，轮询不丢手势；随后合成 click 不打开下一 Worker', async () => {
  world.state.notices = [info(110), info(111)]; world.state.actions = []; await update();
  const row = banner().querySelector('.notice-banner-row'), beforeHash = dom.location.hash;
  event(row, 'pointerdown', 180, 20); event(row, 'pointermove', 80, 24);
  world.state.notices.push(info(112)); await update();
  expect(banner().querySelector('.notice-banner-row')).toBe(row);
  event(row, 'pointerup', 60, 25);
  // Use the shared promise to wait for the gesture's real write and refresh.
  await readNotice(info(111)); await Promise.resolve();
  expect(world.state.actions).toEqual([{ method: 'notice.read', params: { id: 111 } }]);
  expect(world.state.notices.find(row => row.id === 112).read_at).toBeNull();
  await banner().querySelector('.notice-banner-info').onclick({ detail: 1 });
  expect(dom.location.hash).toBe(beforeHash);
  let prevented = 0;
  for (const handler of banner().listeners.click) handler({ detail: 1, preventDefault() { prevented++; }, stopImmediatePropagation() {} });
  expect(prevented).toBe(1);
});

test('垂直/短滑/取消/选区/鼠标/多点触摸均不 ACK，仍有可见按钮', async () => {
  world.state.notices = [info(120)]; world.state.actions = []; await update();
  const scenarios = [
    ['touch', 3, 100, 'pointerup'], ['touch', 25, 1, 'pointerup'], ['touch', 120, 1, 'pointercancel'],
    ['touch', 120, 1, 'lostpointercapture'], ['mouse', 120, 1, 'pointerup'],
  ];
  for (const [pointerType, x, y, end] of scenarios) {
    const row = banner().querySelector('.notice-banner-row');
    event(row, 'pointerdown', 10, 10, { pointerType });
    event(row, 'pointermove', 10 + x, 10 + y, { pointerType });
    event(row, end, 10 + x, 10 + y, { pointerType, target: end === 'lostpointercapture' ? row : row.querySelector('.notice-banner-title') });
  }
  const original = dom.window.getSelection;
  dom.window.getSelection = () => ({ toString: () => '正在选中文本' });
  let row = banner().querySelector('.notice-banner-row');
  event(row, 'pointerdown', 10, 10); event(row, 'pointermove', 130, 10); event(row, 'pointerup', 130, 10);
  dom.window.getSelection = original;
  row = banner().querySelector('.notice-banner-row');
  event(row, 'pointerdown', 10, 10); event(row, 'pointerdown', 10, 10, { pointerId: 2, isPrimary: false });
  event(row, 'pointermove', 130, 10); event(row, 'pointerup', 130, 10);
  await Promise.resolve(); expect(world.state.actions).toHaveLength(0);
  expect(known().textContent).toBe('已知'); expect(known().classList.contains('agent-call')).toBe(false);
});

test('项目切换前不把旧告知请求发给新项目，ACK 返回后也不污染新项目缓存', async () => {
  world.state.notices = [info(130)]; await update();
  const before = readRequests; const queued = readNotice(info(130));
  dom.location.pathname = '/p/abcdef0123456789/';
  await expect(queued).rejects.toThrow('项目已切换'); expect(readRequests).toBe(before);
  dom.location.pathname = '/';
  const cachedReads = ui.noticeReadRows.size;
  deferRead = true; const inFlight = readNotice(info(130));
  while (!releaseRead) await Promise.resolve();
  dom.location.pathname = '/p/abcdef0123456789/';
  const newNotice = { ...info(130), title: '新项目同 ID 告知' };
  ui.noticeIndex = new Map([[130, newNotice]]);
  renderNoticeBanner({ notices: [newNotice], status: { project: '/tmp/new-project' } });
  deferRead = false; releaseRead(); releaseRead = null; await inFlight;
  expect(ui.noticeIndex.get(130).read_at).toBeNull();
  expect(deepText(banner())).toContain('新项目同 ID 告知');
  expect(ui.noticeReadRows.size).toBe(cachedReads);
  dom.location.pathname = '/'; setPref('noticeChannels', normalizeNoticeChannels());
});

const infoRow = () => banner().querySelector('.notice-banner-row');
function pointer(row, type, x, y = 10, extra = {}) {
  const event = { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y,
    target: row.querySelector('.notice-banner-title'), prevented: false, preventDefault() { this.prevented = true; }, ...extra };
  for (const handler of row.listeners[type] || []) handler(event);
  return event;
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

test('已知仅 ACK 当前最新一条，不导航/调用 Agent/验收/合并；随后展示下一条并保留历史', async () => {
  ui.noticeReadRows.clear();
  world.state.notices = [info(70), info(71)]; world.state.actions = []; await update();
  const view = ui.view, hash = dom.location.hash;
  const ack = known(); ack.focus();
  expect(ack.getAttribute('data-help')).toContain('不验收或合并');
  expect(ack.classList.contains('agent-call')).toBe(false);
  await ack.onclick();
  expect(world.state.actions).toEqual([{ method: 'notice.read', params: { id: 71 } }]);
  expect(ui.view).toBe(view); expect(dom.location.hash).toBe(hash);
  expect(world.state.notices).toHaveLength(2); expect(world.state.notices[1].status).toBe('sent');
  expect(infoRow().dataset.noticeId).toBe(70);
  expect(document.activeElement).toBe(known());
  await known().onclick(); expect(banner().hidden).toBe(true);
  expect(world.state.actions.map(row => row.params.id)).toEqual([71, 70]);
});

test('已知失败保留同一条并报告错误，按钮可重试；待决没有已知按钮', async () => {
  world.state.notices = [info(80), { ...info(81), kind: 'question', status: 'open' }]; world.state.actions = []; await update();
  failRead = true; await known().onclick(); failRead = false;
  expect(dom.node('error').textContent).toContain('test read failure');
  expect(infoRow().dataset.noticeId).toBe(80); expect(known().disabled).toBe(false);
  await known().onclick();
  expect(world.state.actions).toEqual([{ method: 'notice.read', params: { id: 80 } }]);
  expect(known()).toBeNull(); expect(deepText(banner())).toContain('1 条待你处理');
});

test('ACK 单飞，轮询不重复 ACK、不复活旧告知；请求期间有新告知也只处理原来那条', async () => {
  world.state.notices = [info(90)]; world.state.actions = []; await update();
  const oldSnapshot = structuredClone(ui.lastSnapshot), before = readRequests;
  deferRead = true;
  const ack = known().onclick();
  while (!releaseRead) await Promise.resolve();
  const shared = readNotice(info(90));
  await update(); expect(readRequests).toBe(before + 1); expect(known().disabled).toBe(true);
  world.state.notices.push(info(91)); await update();
  expect(infoRow().dataset.noticeId).toBe(91); expect(known().disabled).toBe(false);
  deferRead = false; releaseRead(); releaseRead = null; await Promise.all([ack, shared]);
  expect(world.state.actions.map(row => row.params.id)).toEqual([90]);
  expect(infoRow().dataset.noticeId).toBe(91); expect(known().disabled).toBe(false);
  renderNotices(oldSnapshot); renderNoticeBanner(oldSnapshot);
  expect(banner().hidden).toBe(true);
  await readNotice(info(90)); expect(readRequests).toBe(before + 1);
});

test('渠道设置即时过滤告知条，但不改变未读列表/计数或待决；未知分类可见，标题不参与分类', async () => {
  setPref('noticeChannels', normalizeNoticeChannels());
  world.state.notices = [info(100), { ...info(101), lifecycle_type: 'analysis' },
    { ...info(102), lifecycle_type: 'failed', title: '只读分析完成（标题不分类）' },
    { ...info(103), lifecycle_type: 'future' }, { ...info(104), lifecycle_type: null },
    { ...info(105), kind: 'question', status: 'open' }]; await update();
  setPref('noticeChannels', { idle: { banner: false }, analysis: { banner: false }, failed: { banner: false } });
  expect(deepText(banner())).toContain('2 条未读告知'); expect(infoRow().dataset.noticeId).toBe(104);
  expect(dom.node('notice-count').textContent).toBe('1 待决 · 5 告知');
  expect(ui.noticeIndex.size).toBeGreaterThanOrEqual(6);
  world.state.notices = world.state.notices.filter(row => row.lifecycle_type !== null && row.lifecycle_type !== 'future'); await update();
  expect(known()).toBeNull(); expect(banner().hidden).toBe(false);
  const channels = readPref('noticeChannels'); channels.failed.banner = true; setPref('noticeChannels', channels);
  expect(infoRow().dataset.noticeId).toBe(102);
  setPref('noticeChannels', normalizeNoticeChannels());
});

test('水平触摸左右滑只已知当前一条；刷新保留手势；合成 click 不打开下一条 Worker', async () => {
  world.state.notices = [info(110), info(111)]; world.state.actions = []; await update();
  const row = infoRow(), beforeHash = dom.location.hash;
  pointer(row, 'pointerdown', 20); pointer(row, 'pointermove', 120);
  await update(); expect(infoRow()).toBe(row);
  pointer(row, 'pointerup', 120); await flush();
  expect(world.state.actions.map(row => row.params.id)).toEqual([111]);
  expect(infoRow().dataset.noticeId).toBe(110);
  let prevented = false, stopped = false;
  banner().listeners.click[0]({ detail: 1, preventDefault() { prevented = true; }, stopImmediatePropagation() { stopped = true; } });
  expect(prevented && stopped).toBe(true);
  await banner().querySelector('.notice-banner-info').onclick({ detail: 1 });
  expect(dom.location.hash).toBe(beforeHash);
  pointer(infoRow(), 'pointerdown', 150); pointer(infoRow(), 'pointermove', 20); pointer(infoRow(), 'pointerup', 20);
  await flush(); expect(world.state.actions.map(row => row.params.id)).toEqual([111, 110]);
});

test('垂直滚动、短滑、取消、失去捕获、鼠标和文本选择都不 ACK', async () => {
  world.state.notices = [info(120)]; world.state.actions = []; await update();
  let row = infoRow(); pointer(row, 'pointerdown', 20); pointer(row, 'pointermove', 25, 100); pointer(row, 'pointerup', 150, 110);
  row = infoRow(); pointer(row, 'pointerdown', 20); pointer(row, 'pointermove', 45); pointer(row, 'pointerup', 45);
  for (const end of ['pointercancel', 'lostpointercapture']) {
    row = infoRow(); pointer(row, 'pointerdown', 20); pointer(row, 'pointermove', 150); pointer(row, end, 150, 10, { target: row });
  }
  row = infoRow(); pointer(row, 'pointerdown', 20, 10, { pointerType: 'mouse' }); pointer(row, 'pointermove', 150); pointer(row, 'pointerup', 150);
  const previous = dom.window.getSelection;
  dom.window.getSelection = () => ({ toString: () => '选中的告知标题' });
  pointer(row, 'pointerdown', 20); pointer(row, 'pointermove', 150); pointer(row, 'pointerup', 150);
  dom.window.getSelection = previous;
  await flush(); expect(world.state.actions).toEqual([]); expect(known().disabled).toBe(false);
});
