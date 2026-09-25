import { test, expect, afterAll } from 'bun:test';
import { installDom, dialogText, answerDialog, deepText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';

// 分支所有者（main/owner）的「问这条分支」入口：用户专属的只读分析，会调用 Agent，必须带
// agent-call 与 agentHelp 提示；确认后调 task.analyze 并跳到新 Task。
const world = makeWorld();
const dom = installDom({ fetch: world.fetchImpl });
const { boot } = await import('../../src/ui/web/assets/app.js');
const { renderDetail } = await import('../../src/ui/web/assets/render-detail.js');
dom.node('side-nav').replaceChildren();
await boot();
afterAll(() => dom.restore());

const buttonOf = (root, label) => root.querySelectorAll('button').find(node => node.textContent === label);
const main = { id: 1, role: 'agent', task_kind: 'main', name: 'main', goal: '管理 main 分支及子任务合并请求',
  status: 'waiting', integration: 'none', calls: 0, branch: 'main', target_branch: null,
  deps: [], dependents: [], children: [], messages: [], notices: [], reservation: null };

test('main/owner detail offers a marked read-only analysis that starts a child Task', async () => {
  renderDetail(main, null, null, null);
  const panel = dom.node('detail');
  const ask = buttonOf(panel, '问这条分支');
  expect(ask).toBeTruthy();
  expect(ask.classList.contains('agent-call')).toBe(true);
  expect(ask.getAttribute('data-help')).toContain('消耗 token');
  expect(ask.getAttribute('data-help')).toContain('不建分支');
  const pending = ask.onclick();
  // 弹窗把代价与边界说清，并且确认按钮沿用同一条 agent 标识。
  expect(dialogText(dom)).toContain('不创建分支、不产生待合并改动');
  const confirm = buttonOf(dom.node('modal'), '开始分析');
  expect(confirm.classList.contains('agent-call')).toBe(true);
  expect(world.state.actions.some(action => action.method === 'task.analyze')).toBe(false);
  await answerDialog(dom, '开始分析', '现在最大的风险是什么？');
  await pending;
  expect(world.state.actions.at(-1)).toEqual({ method: 'task.analyze', params: { id: 1, question: '现在最大的风险是什么？' } });
  expect(dom.location.hash).toBe('#task-91');
});

test('analysis Tasks are labelled read-only and offer no delivery or analysis entry', () => {
  renderDetail({ ...main, id: 91, task_kind: 'analysis', parent_id: 1, branch: null, target_branch: 'main',
    goal: '现在最大的风险是什么？', status: 'completed', result: '结论：风险集中在解锁逻辑。' }, null, null, null);
  const panel = dom.node('detail');
  expect(deepText(panel)).toContain('只读分析');
  expect(buttonOf(panel, '问这条分支')).toBeUndefined();
  expect(buttonOf(panel, '预约合并请求')).toBeUndefined();
  expect(buttonOf(panel, '预约展示')).toBeUndefined();
  expect(buttonOf(panel, '回收工作区与分支')).toBeUndefined();
});
