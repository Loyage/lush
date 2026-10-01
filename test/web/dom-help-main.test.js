import { test, expect, afterAll } from 'bun:test';
import { installDom, allByTag, answerDialog } from '../dom-stub.js';
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
const { renderTaskGraph } = await import('../../src/ui/web/assets/render-task-graph.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
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

const followupTask = { id: 900, role: 'agent', task_kind: 'say', parent_id: 1, parent_task_kind: 'main',
  goal: '需要追加输入', status: 'waiting', integration: 'none', calls: 0, deps: [], dependents: [],
  children: [], messages: [], notices: [], branch: 'feature/followup', workspace: '/tmp/followup' };

test('详情页「追加输入」位于操作栏首位，点击才显示多行输入与 Agent 发送按钮', async () => {
  const { renderDetail } = await import('../../src/ui/web/assets/render-detail.js');
  renderDetail(followupTask, null, null, null);
  const panel = dom.node('detail');
  const entry = panel.querySelector('.task-actions').children[0];
  expect(entry.textContent).toBe('追加输入');
  expectAgentButton(entry);
  expect(panel.querySelector('textarea')).toBeNull();
  expect(buttonByText(panel, '追加说明')).toBeNull();
  const before = world.state.actions.length;
  const pending = entry.onclick();
  const input = dom.node('modal').querySelector('textarea');
  expect(input).toBeTruthy();
  expect(dom.document.activeElement).toBe(input);
  expectAgentButton(buttonByText(dom.node('modal'), '发送输入'));
  input.value = '先补充测试\n再调整实现';
  // 后台重画详情不会冲掉独立弹窗中的草稿。
  renderDetail(followupTask, null, null, null);
  expect(dom.node('modal').querySelector('textarea')).toBe(input);
  expect(world.state.actions.length).toBe(before);
  await answerDialog(dom, '发送输入'); await pending;
  expect(world.state.actions.slice(before)).toEqual([
    { method: 'task.message', params: { id: 900, body: '先补充测试\n再调整实现' } },
  ]);
});

test('追加输入取消或空白不发送；空白校验后仍可输入并提交', async () => {
  const { renderDetail } = await import('../../src/ui/web/assets/render-detail.js');
  const before = world.state.actions.length;
  renderDetail(followupTask, null, null, null);
  let pending = buttonByText(dom.node('detail'), '追加输入').onclick();
  dom.node('modal').querySelector('textarea').value = '不发送的草稿';
  await answerDialog(dom, '取消'); await pending;
  expect(world.state.actions.length).toBe(before);
  pending = buttonByText(dom.node('detail'), '追加输入').onclick();
  dom.node('modal').querySelector('textarea').value = '  \n ';
  await answerDialog(dom, '发送输入');
  expect(world.state.actions.length).toBe(before);
  expect(dom.node('modal').hidden).toBe(false);
  dom.node('modal').querySelector('textarea').value = '继续完善测试';
  await answerDialog(dom, '发送输入'); await pending;
  expect(world.state.actions.at(-1)).toEqual({ method: 'task.message', params: { id: 900, body: '继续完善测试' } });
});

test('暂停任务可追加输入但不会自动继续；终态与其他类型没有入口', async () => {
  const { renderDetail } = await import('../../src/ui/web/assets/render-detail.js');
  renderDetail({ ...followupTask, task_kind: 'child', status: 'paused' }, null, null, null);
  const before = world.state.actions.length;
  const pending = buttonByText(dom.node('detail'), '追加输入').onclick();
  expect(dom.node('modal').querySelector('.modal-message').textContent).toContain('开始 / 继续');
  dom.node('modal').querySelector('textarea').value = '下一步检查边界情况';
  await answerDialog(dom, '发送输入'); await pending;
  expect(world.state.actions.slice(before)).toEqual([
    { method: 'task.message', params: { id: 900, body: '下一步检查边界情况' } },
  ]);
  for (const status of ['completed', 'failed', 'cancelled']) {
    renderDetail({ ...followupTask, status }, null, null, null);
    expect(buttonByText(dom.node('detail'), '追加输入')).toBeNull();
  }
  for (const task_kind of ['main', 'owner', 'analysis', 'merge']) {
    renderDetail({ ...followupTask, task_kind }, null, null, null);
    expect(buttonByText(dom.node('detail'), '追加输入')).toBeNull();
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

test('Task 图「归档」只带 data-help，旧分支动作入口不再渲染', async () => {
  activateDetailView({ view: 'task-graph' });
  renderTaskGraph({ total: 1, nodes: [{ id: 2, task_kind: 'say', role: 'agent', status: 'completed',
    title: '已完成任务', branch: 'feature', branch_info: { archivable: true, current_head: 'abc' } }] });
  const detail = dom.node('detail');
  const archive = buttonByText(detail, '归档');
  expect(archive).toBeTruthy();
  expect(archive.classList.contains('agent-call')).toBe(false);
  expect(archive.getAttribute('data-help')).toBeTruthy();
  // 合并 / 同步等旧分支动作已随公开 API 下线，不再有禁用的 .graph-branch-action 占位。
  expect(detail.querySelectorAll('button.graph-branch-action').length).toBe(0);
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
