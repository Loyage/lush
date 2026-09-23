import { test, expect, afterAll } from 'bun:test';
import { installDom, allByTag } from '../dom-stub.js';
import { until } from '../helpers.js';
import { makeWorld, NOW, iso } from './dom-world.js';

// 主流程页面的按钮帮助与 Agent 触发标识（spec #54，依赖 spec #52 的 help.js / .help-tip /
// button.agent-call / dom.js 第 4 参数 / dialog.js 的 agent + confirmHelp）。
// 只断言「按钮该带的属性与类」，不重复验证浮层本身的交互（那在 dom-help.test.js）。
// 每个 DOM 测试文件自给自足：自己建 world、装 stub，再显式装配一次当前 DOM。
const world = makeWorld();
const dom = installDom({ fetch: world.fetchImpl });
const { boot } = await import('../../src/ui/web/assets/app.js');
const { agentHelp, AGENT_NOTE, showHelp, hideHelp } = await import('../../src/ui/web/assets/help.js');
const { openGraph } = await import('../../src/ui/web/assets/render-graph.js');
const { noticePanel } = await import('../../src/ui/web/assets/render-notices.js');
const { formDialog } = await import('../../src/ui/web/assets/dialog.js');
dom.node('side-nav').replaceChildren();
await boot();

afterAll(() => { hideHelp(); dom.restore(); });

const buttonsOf = root => allByTag(root, 'button');
const buttonByText = (root, text) => buttonsOf(root).find(node => node.textContent === text) || null;
/** 断言一个会调用 Agent 的按钮：紫色标识 + 经 agentHelp 生成的代价说明。 */
function expectAgentButton(node) {
  expect(node).toBeTruthy();
  expect(node.classList.contains('agent-call')).toBe(true);
  expect(node.getAttribute('data-help')).toContain(AGENT_NOTE);
}
const detailButton = async text => {
  const detail = dom.node('detail');
  return until(() => buttonByText(detail, text), 2000);
};

test('详情页「追加说明」是 Agent 按钮：task.message 会唤醒或继续该任务', async () => {
  await dom.intervalFor(1500)();
  dom.location.hash = '#task-1';
  await dom.fire('hashchange');
  expectAgentButton(await detailButton('追加说明'));
});

test('意图页「批准并开发」「要求修改」是 Agent 按钮，「接受并合入」只带帮助', async () => {
  const intents = dom.node('intents');
  await until(() => buttonByText(intents, '批准并开发'), 2000);
  expectAgentButton(buttonByText(intents, '批准并开发'));
  expectAgentButton(buttonByText(intents, '要求修改'));
  // 合入不可逆，但不会调用 Agent：只加 data-help。
  const accept = buttonByText(intents, '接受并合入');
  expect(accept).toBeTruthy();
  expect(accept.classList.contains('agent-call')).toBe(false);
  expect(accept.getAttribute('data-help')).toBeTruthy();
});

test('分支图决策区「批准并开发」「回复并继续任务」是 Agent 按钮', async () => {
  const saved = JSON.parse(JSON.stringify(world.state.graph));
  try {
    const one = world.state.graph.nodes.find(node => node.kind === 'task' && node.id === 1);
    one.notice = { id: 5, kind: 'question', title: '这条要不要动公共面', body: '正文', created_at: iso(NOW) };
    one.notice_count = 1;
    world.state.graph.nodes.push({
      kind: 'task', id: 21, role: 'planner', name: 'plan-21', goal: '拆解需求 21', status: 'awaiting', integration: 'none',
      branch: 'lush/demo/input-1-anchor', workspace: null, workspace_state: 'none', base_commit: null, head_commit: null,
      target_branch: null, ahead: null, behind: null, merged: null, current: false, archived: false,
      notice: { id: 7, kind: 'plan', title: '这轮拆解想先请你拍板 21', body: '计划正文', created_at: iso(NOW) }, notice_count: 1,
    });
    await openGraph();
    const decisions = dom.node('detail').querySelectorAll('div.graph-decision');
    expect(decisions.length).toBe(2);
    expectAgentButton(decisions.flatMap(node => buttonsOf(node)).find(node => node.textContent === '批准并开发'));
    expectAgentButton(decisions.flatMap(node => buttonsOf(node)).find(node => node.textContent === '回复并继续任务'));
  } finally {
    world.state.graph = saved;
    await openGraph();
  }
});

test('通知页「开始解冲突」是 Agent 按钮，data-help 含统一代价说明', () => {
  const panel = noticePanel(
    { id: 99, task_id: 5, status: 'open', kind: 'question', title: '要开解冲突任务吗？', body: '冲突文件：a.js', created_at: iso(NOW) },
    { id: 5, role: 'merger', resolves_task_id: 2, agent_wakes: 0 });
  const start = buttonByText(panel, '开始解冲突');
  expectAgentButton(start);
  // 同一处的「暂不处理」是忽略语义，只带帮助。
  const dismiss = buttonByText(panel, '暂不处理');
  expect(dismiss.classList.contains('agent-call')).toBe(false);
  expect(dismiss.getAttribute('data-help')).toBeTruthy();
});

test('禁用的「合并已被冻结」把 data-help 放在 span.help-host 上，仍能显示提示', async () => {
  try {
    world.state.freeze = [{ id: 4, task_id: 4, target_branch: 'main', resolves_task_id: null }];
    await dom.intervalFor(1500)();
    dom.location.hash = '#task-1';
    await dom.fire('hashchange');
    const detail = dom.node('detail');
    const host = await until(() => detail.querySelector('.help-host'), 2000);
    expect(host.getAttribute('data-help')).toContain('的合并冲突还没解决');
    expect(buttonByText(host, '合并已被冻结').disabled).toBe(true);
    // help.js 的委托按最近的 data-help 元素显示：外层 span 承载也能弹出提示。
    showHelp(host);
    expect(dom.node('help-tip').hidden).toBe(false);
    expect(dom.node('help-tip').textContent).toContain('的合并冲突还没解决');
    hideHelp();
  } finally {
    world.state.freeze = [];
  }
});

test('分支图「归档」只带 data-help，禁用的 branchAction 走 span.help-host', async () => {
  await openGraph();
  const detail = dom.node('detail');
  const archive = buttonByText(detail, '归档');
  expect(archive).toBeTruthy();
  expect(archive.classList.contains('agent-call')).toBe(false);
  expect(archive.getAttribute('data-help')).toBeTruthy();
  // 分歧分支的「合入父分支」在当前状态不可执行：禁用按钮包在 .help-host 里，帮助仍可读。
  const disabledAction = detail.querySelectorAll('.help-host')
    .find(node => node.querySelector('button')?.disabled === true);
  expect(disabledAction).toBeTruthy();
  expect(disabledAction.getAttribute('data-help')).toBeTruthy();
});

test('弹窗确认按钮走 agent + confirmHelp：重试与效果展示都标成 Agent 调用', async () => {
  // dialog.js 的确认按钮在 agent:true 时加 agent-call，confirmHelp 经 agentHelp 生成。
  const pending = formDialog({ title: '重试', content: null, confirmLabel: '使用这些设置重试',
    agent: true, confirmHelp: agentHelp('用上面选定的 Agent 设置重新启动这个任务。') });
  const confirm = buttonByText(dom.node('modal'), '使用这些设置重试');
  expectAgentButton(confirm);
  dom.node('modal').querySelectorAll('button').find(node => node.textContent === '取消').onclick();
  await pending;
});
