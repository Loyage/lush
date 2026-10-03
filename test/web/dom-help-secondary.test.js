import { test, expect, afterAll } from 'bun:test';
import { installDom, allByTag, deepText } from '../dom-stub.js';
import { until } from '../helpers.js';
import { makeWorld, NOW, iso } from './dom-world.js';

// 现行 Web 面板的按钮帮助标注：在渲染后的 DOM 验证标识，不扫描休眠模块源码。
// 每个 DOM 测试文件都自给自足：先装自己的 world / DOM，再显式 boot 一次（模块注册表在文件之间共享）。
const world = makeWorld();
const baseFetch = world.fetchImpl;
// 固定静息快照，避免本文件的帮助标注用例受到热 Worker 刷新影响。
const dom = installDom({ fetch: async (url, options) => {
  const response = await baseFetch(url, options);
  if (String(url) !== '/api/snapshot') return response;
  const data = await response.json();
  data.tasks = data.tasks.map(task => ({ ...task, status: 'completed' }));
  data.status.tasks = [{ status: 'completed', count: data.tasks.length }];
  data.status.agents = [];
  return { ok: true, status: 200, json: async () => data };
} });
const { boot } = await import('../../src/ui/web/assets/app.js');
dom.node('side-nav').replaceChildren();
await boot();
afterAll(() => dom.restore());

/** 只在按钮里按文字找：页面文案常常包含同一个短语（如“未单独配置”），不能误判到说明文字。 */
const buttonOf = (root, text) => allByTag(root, 'button').find(node => node.textContent.includes(text));

test('待决提醒横幅：说明性 title 迁移到 data-help，且不标 agent-call', async () => {
  world.state.notices = [{ id: 9, task_id: 4, kind: 'question', title: '最新问题', body: '请回答', status: 'open', created_at: iso(NOW) }];
  await dom.intervalFor(1500)();
  const main = dom.node('notice-banner').querySelector('.notice-banner-main');
  expect(main).toBeTruthy();
  expect(main.getAttribute('data-help')).toContain('打开处理页');
  expect(main.title).toBe('');
  expect(main.classList.contains('agent-call')).toBe(false);
});

test('系统提醒开关：初始文本为空补 aria-label 与 data-help，且不标 agent-call', async () => {
  const { notificationControl } = await import('../../src/ui/web/assets/notice-notifications.js');
  const root = notificationControl();
  const toggle = root.querySelector('button');
  expect(toggle.getAttribute('data-help')).toContain('系统通知');
  expect(toggle.getAttribute('aria-label')).toBe('开启系统提醒');
  expect(toggle.textContent).toBe('开启系统提醒');
  expect(toggle.classList.contains('agent-call')).toBe(false);
});

test('「打开执行详情」打开只读全屏阅读器，带 data-help 且不标 agent-call', async () => {
  dom.location.hash = '#worker-1';
  await dom.fire('hashchange');
  const detail = dom.node('detail');
  await until(() => buttonOf(detail, '打开执行详情'), 2000);
  const reader = buttonOf(detail, '打开执行详情');
  expect(reader.getAttribute('data-help')).toContain('只读');
  expect(reader.classList.contains('agent-call')).toBe(false);
});

test('左栏导航与缓冲输入带帮助，发送明确标识 Agent 代价', async () => {
  // 左栏导航：title 迁移到 data-help
  const nav = dom.node('side-nav').querySelector('.nav-item');
  expect(nav.getAttribute('data-help')).toContain('在右侧打开');

  // 草稿：每条的「发送」是 Agent 触发按钮（agent-call + agentHelp 说明）；「移除」与「×」补 data-help
  const { renderDrafts } = await import('../../src/ui/web/assets/render-drafts.js');
  renderDrafts({ drafts: [{ id: 21, content: '草稿', created_at: iso(NOW),
    references: [{ kind: 'task', target: { task_id: 1 }, label: '任务 #1', quote: '引文' }] }] });
  const drafts = dom.node('drafts');
  const execute = buttonOf(drafts, '发送');
  expect(execute.classList.contains('agent-call')).toBe(true);
  expect(execute.getAttribute('data-help')).toContain('会调用 Agent');
  expect(drafts.querySelector('.pick')).toBeNull();
  expect(buttonOf(drafts, '移除').getAttribute('data-help')).toContain('不可删');
  expect(drafts.querySelector('.context-remove').getAttribute('data-help')).toContain('不改动输入原文');

});

test('设置页的 Agent / 系统按钮按标准补 data-help', async () => {
  const { openSettings } = await import('../../src/ui/web/assets/render-settings.js');
  await dom.node('agent-status-open').onclick();
  const panel = dom.node('detail');
  await panel.querySelector('button[data-agent-tab="settings"]').onclick();
  const tabOf = id => [...panel.querySelectorAll('button')].find(node => node.dataset.settingsTab === id);
  expect(buttonOf(panel, '恢复默认 Prompt').getAttribute('data-help')).toContain('保存');
  expect(buttonOf(panel, '单独配置').getAttribute('data-help')).toContain('独立配置');

  // 系统页：并发额度的「恢复环境默认」会立即改写运行参数，必须说清后果。
  openSettings(); tabOf('system').onclick();
  expect(buttonOf(panel, '恢复环境默认').getAttribute('data-help')).toContain('并发');
  tabOf('interface').onclick();
  expect(deepText(panel)).toContain('Markdown 渲染');
});
