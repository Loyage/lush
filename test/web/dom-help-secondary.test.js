import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import { installDom, allByTag, deepText } from '../dom-stub.js';
import { until } from '../helpers.js';
import { makeWorld, NOW, iso } from './dom-world.js';

// 其余 Web 面板的按钮帮助标注（spec #176 基础设施之后的逐按钮应用）。
// 本范围没有 Agent 启动按钮：只断言 data-help / aria-label，不出现 agent-call。
// 每个 DOM 测试文件都自给自足：先装自己的 world / DOM，再显式 boot 一次（模块注册表在文件之间共享）。
const world = makeWorld();
const baseFetch = world.fetchImpl;
// 把快照里的任务都改成终态，概览才进「维护与安全回收」分支、画出「清空任务看板」。
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
const { ui } = await import('../../src/ui/web/assets/state.js');
dom.node('side-nav').replaceChildren();
await boot();
afterAll(() => dom.restore());

/** 只在按钮里按文字找：页面文案常常包含同一个短语（如“未单独配置”），不能误判到说明文字。 */
const buttonOf = (root, text) => allByTag(root, 'button').find(node => node.textContent.includes(text));

/** 本 spec 负责的文件：帮助标注只加在这里，且不得出现 Agent 触发标识。 */
const SCOPE = [
  'render-overview.js', 'render-drafts.js', 'render-ladder.js', 'render-tree.js', 'render-history.js',
  'render-agent.js', 'render-transcript.js', 'transcript-reader.js', 'transcript-terminal.js', 'transcript-body.js',
  'structured-value.js', 'render-settings.js', 'render-docs.js', 'render-specs.js', 'render-verify.js',
  'render-resolutions.js', 'notice-banner.js', 'notice-notifications.js', 'render-statistics.js',
  'project-picker.js', 'filters-ui.js', 'sidebar-init.js',
];

test('「清空任务看板」是破坏性动作，带 data-help 且不标 agent-call', async () => {
  await dom.intervalFor(1500)();
  const clear = buttonOf(dom.node('detail'), '清空任务看板');
  expect(clear).toBeTruthy();
  expect(clear.getAttribute('data-help')).toContain('不可撤销');
  expect(clear.classList.contains('agent-call')).toBe(false);
});

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

test('「终端模式」打开只读全宽阅读器，带 data-help 且不标 agent-call', async () => {
  dom.location.hash = '#task-1';
  await dom.fire('hashchange');
  const detail = dom.node('detail');
  await until(() => buttonOf(detail, '终端模式'), 2000);
  const terminal = buttonOf(detail, '终端模式');
  expect(terminal.getAttribute('data-help')).toContain('只读');
  expect(terminal.classList.contains('agent-call')).toBe(false);
});

test('左栏导航、待提交意图与批量交付的标注：迁移 title、补符号按钮与 aria-label', async () => {
  // 左栏导航：title 迁移到 data-help
  const nav = dom.node('side-nav').querySelector('.nav-item');
  expect(nav.getAttribute('data-help')).toContain('在右侧打开');

  // 待提交意图：勾选框与「移除」迁移 title；「×」是符号按钮，补 data-help
  const { renderDrafts } = await import('../../src/ui/web/assets/render-drafts.js');
  renderDrafts({ drafts: [{ id: 21, content: '草稿', created_at: iso(NOW),
    references: [{ kind: 'task', target: { task_id: 1 }, label: '任务 #1', quote: '引文' }] }] });
  const drafts = dom.node('drafts');
  expect(drafts.querySelector('.pick').getAttribute('data-help')).toContain('提交并规划');
  expect(buttonOf(drafts, '移除').getAttribute('data-help')).toContain('不可删');
  expect(drafts.querySelector('.context-remove').getAttribute('data-help')).toContain('不改动输入原文');

  // 批量交付：文字由 sync() 补上，再给两个合并按钮补 aria-label；勾选框的说明迁移为 data-help
  const { renderLadder } = await import('../../src/ui/web/assets/render-ladder.js');
  const ladder = renderLadder(ui.lastSnapshot);
  expect(buttonOf(ladder, '合并本分支选中').getAttribute('aria-label')).toContain('勾选');
  expect(buttonOf(ladder, '合并本分支全部可交付').getAttribute('aria-label')).toContain('全部');
  expect(ladder.querySelector('input.pick').getAttribute('data-help')).toBeTruthy();
  expect(buttonOf(ladder, '清空选择').getAttribute('data-help')).toBeNull();
});

test('设置页的 Agent / 系统按钮按标准补 data-help', async () => {
  world.state.agentConfig.roles.worker = { agent: 'pi', model: '', thinking: '', default_prompt: '', append_prompt: '', extensions: [], skills: [] };
  world.state.agentConfig.resolved.worker = { ...world.state.agentConfig.resolved.worker, ...world.state.agentConfig.roles.worker };
  const { openSettings } = await import('../../src/ui/web/assets/render-settings.js');
  openSettings();
  const panel = dom.node('detail');
  const tabOf = id => [...panel.querySelectorAll('button')].find(node => node.dataset.settingsTab === id);
  expect(buttonOf(panel, '恢复默认 Prompt').getAttribute('data-help')).toContain('保存');
  expect(buttonOf(panel, '恢复继承默认').getAttribute('data-help')).toContain('继承项目默认');
  expect(buttonOf(panel, '单独配置').getAttribute('data-help')).toContain('独立配置');

  // 系统页：并发额度的「恢复环境默认」会立即改写运行参数，必须说清后果。
  tabOf('system').onclick();
  expect(buttonOf(panel, '恢复环境默认').getAttribute('data-help')).toContain('并发');
  // 模块级的 activeTab 是跨测试文件共享的：看完成系统页要切回 Agent，别让后续文件从错误页签开始。
  tabOf('agent').onclick();
  expect(deepText(panel)).toContain('按任务行为覆盖');
});

test('本范围没有 Agent 触发标识：文件里不出现 agent-call / agentHelp', async () => {
  const dir = new URL('../../src/ui/web/assets/', import.meta.url);
  const read = file => fs.readFileSync(new URL(file, dir), 'utf8');
  for (const file of SCOPE) {
    const source = read(file);
    expect(/\bagent-call\b/.test(source)).toBe(false);
    expect(/\bagentHelp\b/.test(source)).toBe(false);
  }
  // 无法方便地在 DOM 里单独装配、但已按标准补上的帮助文案（环境变量显示 / 删除、符号按钮、步骤头）。
  expect(read('render-settings.js')).toContain('以明文显示这条环境变量的值');
  expect(read('render-settings.js')).toContain('从编辑列表移除这条变量');
  expect(read('render-drafts.js')).toContain('从这条待提交意图移除该引用');
  expect(read('render-transcript.js')).toContain('点击展开／收起这一步的正文');
  expect(read('sidebar-init.js')).toContain('在右侧打开');
});
