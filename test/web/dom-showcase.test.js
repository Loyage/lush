import { test, expect } from 'bun:test';
import { installDom, deepText, findByText, dialogText, answerDialog } from '../dom-stub.js';
import { reserveBranchShowcase, unreserveBranchShowcase, renderShowcase } from '../../src/ui/web/assets/render-showcase.js';
import { registerNavigation } from '../../src/ui/web/assets/navigate.js';
import { renderGraph } from '../../src/ui/web/assets/render-graph.js';
import { agentHelp } from '../../src/ui/web/assets/help.js';
import { ui } from '../../src/ui/web/assets/state.js';
import { until } from '../helpers.js';

/** 分支图节点工厂：只带分支图渲染与预约读面需要的字段。 */
const branch = (name, showcase) => ({ kind: 'branch', id: `branch:${name}`, name, head_commit: 'abc', created_from_commit: 'def', showcase });

/**
 * 可控 world：`/api/graph` 返回可变的节点表，`/api/action` 记下每次调用并按 `replies[method]` 作答。
 * 导航被替换成受控 stub，所以预约 / 取消之后的「重画分支图」记在 `graphRefreshes`，跳转记在 `details`。
 */
function setup() {
  const actions = [], details = [], graphRefreshes = [], replies = {};
  const nodes = [
    { kind: 'branch', id: 'branch:main', name: 'main', head_commit: 'def' },
    branch('feature', { allowed: false, reserve_allowed: true, reserve_reason: null, reason: '子任务尚未完成', latest_task_id: null }),
  ];
  const dom = installDom({ fetch: async (url, options) => {
    if (url === '/api/graph') return Response.json({ current_branch: 'main', nodes });
    if (url === '/api/action') {
      const body = JSON.parse(options.body); actions.push(body);
      return Response.json(replies[body.method] ?? { branch: body.params?.branch, reserved: true, task_id: null });
    }
    throw new Error(`unexpected ${url}`);
  } });
  const restore = registerNavigation({ refresh: async () => {}, detail: async id => details.push(id),
    graph: async () => { graphRefreshes.push(1); } });
  return { dom, nodes, actions, details, graphRefreshes, replies, close() { restore(); dom.restore(); } };
}

const render = (f, graph) => renderGraph({ git: true, nodes: f.nodes, edges: [], ...graph }, { force: true });
const buttons = (dom, text) => [...dom.node('detail').querySelectorAll('button')].filter(node => node.textContent === text);

test('branch rows expose reservation, not a bare start: reservable branches get the entry, gated-out ones do not', async () => {
  const f = setup();
  const oldKey = ui.graphRenderKey;
  try {
    f.nodes.push(
      // 未满足准入、但静态条件可预约：入口照样亮起，这是本 spec 要改的行为。
      branch('developing', { allowed: false, reserve_allowed: true, reserve_reason: null, reason: '开发任务尚未完成' }),
      // 不满足静态可预约条件（例如主干 / 未登记）：没有入口。
      branch('trunk', { allowed: false, reserve_allowed: false, reserve_reason: '主干分支不开放效果展示' }),
      // 已满足准入且未预约：只给一个预约入口，不再另给「效果展示」。
      branch('ready', { allowed: true, reserve_allowed: true, latest_task_id: 41 }),
      // 已预约：状态 + 取消入口，并就地说明当前阻塞原因。
      branch('waiting', { reserved: true, reserved_at: '2026-09-24T00:00:00.000Z', allowed: false, reason: '子分支尚未收拢', reserve_allowed: true }),
    );
    render(f);

    expect(findByText(f.dom.node('detail'), '预约效果展示')).toBeTruthy();
    // feature / developing / ready / waiting 四条可预约（waiting 已预约不算）；trunk 与 main 没有。
    expect(buttons(f.dom, '预约效果展示')).toHaveLength(3);
    expect(buttons(f.dom, '效果展示')).toHaveLength(0);
    const reserve = buttons(f.dom, '预约效果展示')[0];
    expect(reserve.classList.contains('ghost')).toBe(true);
    expect(reserve.classList.contains('agent-call')).toBe(true);
    expect(reserve.getAttribute('data-help')).toBe(agentHelp('预约后，等这条分支满足展示条件时自动启动专用展示 Agent；当前已满足则立即开始。'));

    const detail = f.dom.node('detail');
    expect(deepText(detail)).toContain('已预约效果展示');
    expect(deepText(detail)).toContain('子分支尚未收拢');
    expect(buttons(f.dom, '取消预约')).toHaveLength(1);
    expect(buttons(f.dom, '取消预约')[0].classList.contains('agent-call')).toBe(false);
    expect(buttons(f.dom, '取消预约')[0].getAttribute('data-help')).toContain('已开始的展示不受影响');

    // latest_task_id 仍然给只读的历史展示入口。
    expect(buttons(f.dom, '查看已有展示')).toHaveLength(1);
    await findByText(detail, '查看已有展示').onclick();
    expect(f.details).toEqual([41]);
  } finally { ui.graphRenderKey = oldKey; f.close(); }
});

test('showcase reservation fields participate in the render key, so a reserve_allowed flip repaints without other changes', () => {
  const f = setup();
  const oldKey = ui.graphRenderKey;
  try {
    f.nodes[1].showcase = { allowed: false, reserve_allowed: false, reserve_reason: '主干分支不开放效果展示' };
    render(f);
    expect(findByText(f.dom.node('detail'), '预约效果展示')).toBeFalsy();
    // 只有预约子字段变化（提交、任务、诊断都没动），表头也必须重画，否则入口永远不出现。
    f.nodes[1].showcase.reserve_allowed = true;
    f.nodes[1].showcase.reserve_reason = null;
    renderGraph({ git: true, nodes: f.nodes, edges: [] }); // 不 force：走 graphRenderKey
    expect(findByText(f.dom.node('detail'), '预约效果展示')).toBeTruthy();
  } finally { ui.graphRenderKey = oldKey; f.close(); }
});

test('reserve re-checks reserve_allowed, confirms, posts showcase.reserve and navigates when a task starts immediately', async () => {
  const f = setup();
  f.nodes[1].showcase.allowed = true;
  f.replies['showcase.reserve'] = { branch: 'feature', reserved: true, task_id: 42 };
  try {
    const pending = reserveBranchShowcase('feature');
    await until(() => dialogText(f.dom).includes('预约展示 feature'));
    // 已满足完整准入：确认键说「开始展示」，文案讲清会自动启动、不代表检验通过、不合并。
    expect(dialogText(f.dom)).toContain('开始展示');
    expect(dialogText(f.dom)).toContain('立即开始');
    expect(dialogText(f.dom)).toContain('不自动合并');
    await answerDialog(f.dom, '开始展示'); await pending;
    expect(f.actions).toEqual([{ method: 'showcase.reserve', params: { branch: 'feature' } }]);
    expect(f.details).toEqual([42]);
    expect(f.graphRefreshes).toHaveLength(0);
  } finally { f.close(); }
});

test('reserve without an immediate start stays pending: notes it and reloads the graph', async () => {
  const f = setup();
  try {
    const pending = reserveBranchShowcase('feature');
    await until(() => dialogText(f.dom).includes('预约展示 feature'));
    // 尚未满足准入：确认键说「预约」。
    expect(dialogText(f.dom)).toContain('预约');
    await answerDialog(f.dom, '预约'); await pending;
    expect(f.actions).toEqual([{ method: 'showcase.reserve', params: { branch: 'feature' } }]);
    expect(f.details).toEqual([]);
    expect(f.dom.node('error').textContent).toContain('已预约：满足展示条件后自动开始');
    expect(f.graphRefreshes).toHaveLength(1);
  } finally { f.close(); }
});

test('reserve refuses branches the fresh graph no longer allows, without opening a confirm', async () => {
  const f = setup();
  f.nodes[1].showcase = { allowed: true, reserve_allowed: false, reserve_reason: '主干分支不开放效果展示' };
  try {
    await reserveBranchShowcase('feature');
    expect(f.actions).toHaveLength(0);
    expect(f.dom.node('error').textContent).toContain('主干分支不开放效果展示');
    expect(dialogText(f.dom)).not.toContain('预约展示');
    await reserveBranchShowcase('missing');
    expect(f.actions).toHaveLength(0);
    expect(f.dom.node('error').textContent).toContain('暂不可预约');
  } finally { f.close(); }
});

test('dismissing the reserve confirm sends nothing', async () => {
  const f = setup();
  try {
    const pending = reserveBranchShowcase('feature');
    await until(() => dialogText(f.dom).includes('预约展示 feature'));
    await answerDialog(f.dom, '取消'); await pending;
    expect(f.actions).toHaveLength(0);
    expect(f.details).toHaveLength(0);
    expect(f.graphRefreshes).toHaveLength(0);
  } finally { f.close(); }
});

test('clicking the branch-row reserve button goes through the confirm and issues showcase.reserve', async () => {
  const f = setup();
  f.replies['showcase.reserve'] = { branch: 'feature', reserved: true, task_id: null };
  const oldKey = ui.graphRenderKey;
  try {
    render(f);
    const reserve = buttons(f.dom, '预约效果展示')[0];
    expect(reserve).toBeTruthy();
    const clicked = reserve.onclick();
    await until(() => dialogText(f.dom).includes('预约展示 feature'));
    await answerDialog(f.dom, '预约');
    await clicked;
    await until(() => f.actions.length === 1);
    expect(f.actions[0]).toEqual({ method: 'showcase.reserve', params: { branch: 'feature' } });
  } finally { ui.graphRenderKey = oldKey; f.close(); }
});

test('reserved branch shows status, blocker and cancel; cancel issues showcase.unreserve', async () => {
  const f = setup();
  f.nodes[1].showcase = { reserved: true, reserved_at: '2026-09-24T00:00:00.000Z', allowed: false,
    reason: '子任务尚未完成', reserve_allowed: true };
  const oldKey = ui.graphRenderKey;
  try {
    render(f);
    expect(deepText(f.dom.node('detail'))).toContain('已预约效果展示');
    expect(deepText(f.dom.node('detail'))).toContain('子任务尚未完成');
    const cancel = buttons(f.dom, '取消预约')[0];
    await cancel.onclick();
    await until(() => f.actions.length === 1);
    expect(f.actions[0]).toEqual({ method: 'showcase.unreserve', params: { branch: 'feature' } });
    expect(f.graphRefreshes).toHaveLength(1);
  } finally { ui.graphRenderKey = oldKey; f.close(); }
});

test('unreserve posts showcase.unreserve and reloads the graph', async () => {
  const f = setup();
  try {
    await unreserveBranchShowcase('feature');
    expect(f.actions).toEqual([{ method: 'showcase.unreserve', params: { branch: 'feature' } }]);
    expect(f.graphRefreshes).toHaveLength(1);
  } finally { f.close(); }
});

test('showcase detail embeds sandboxed report, renders safe loopback preview, stops it and rejects malicious URLs', async () => {
  const f = setup();
  try {
    const task = { id: 42, status: 'completed', report: '/ignored/runtime/path', showcase: { branch: 'feature', commit: 'abc', baseline_commit: 'def',
      preview: { status: 'running', url: 'http://127.0.0.1:43210/demo' } } };
    const panel = renderShowcase(task);
    expect(deepText(panel)).toContain('展示完成 ≠ 检验通过');
    expect(panel.querySelector('iframe').getAttribute('sandbox')).toBe('allow-scripts');
    expect(panel.querySelector('iframe').src).toBe('/api/task/42/report');
    expect(findByText(panel, '打开可操作预览 ↗').rel).toBe('noopener noreferrer');
    await findByText(panel, '停止预览').onclick();
    expect(f.actions.at(-1)).toEqual({ method: 'showcase.stop', params: { id: 42 } });
    task.showcase.preview.url = 'javascript:alert(1)';
    expect(findByText(renderShowcase(task), '打开可操作预览 ↗')).toBeFalsy();
    task.showcase.preview = { status: 'stopped', url: null };
    expect(deepText(renderShowcase(task))).toContain('未运行');
    task.status = 'failed';
    const partial = renderShowcase(task);
    expect(deepText(partial)).toContain('中断前写入的未确认展示页');
    expect(partial.querySelector('iframe')).toBeTruthy();
    task.report = null;
    expect(deepText(renderShowcase(task))).toContain('未生成展示页');
  } finally { f.close(); }
});
