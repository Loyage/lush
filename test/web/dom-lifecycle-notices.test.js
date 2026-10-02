import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { makeWorld, NOW, iso } from './dom-world.js';

const world = makeWorld();
let failTask = false, failRead = false, releaseTask = null, deferTask = false;
const json = (value, status = 200) => ({ ok: status === 200, status, json: async () => value });
const fetchImpl = async (url, opts) => {
  const target = new URL(url, 'http://localhost');
  if (target.pathname === '/api/action') {
    const { method, params } = JSON.parse(opts.body);
    if (method === 'notice.read') {
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
const { openNotice } = await import('../../src/ui/web/assets/render-notices.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
const { overview } = await import('../../src/ui/web/assets/navigate.js');
dom.node('side-nav').replaceChildren(); await boot();
afterAll(() => dom.restore());
const info = id => ({ id, task_id: 4, kind: 'info', status: 'sent', source_event_id: id + 100,
  read_at: null, title: `Task 告知 ${id}`, body: '本轮已静息，不代表验收或合并', created_at: iso(NOW - 100) });
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
