import { test, expect, afterAll } from 'bun:test';
import { installDom, findByText, deepText, dialogText, answerDialog } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';

// 拆解队列只读展示与分组、意图面板批准 / 驳回。
// 每个 DOM 测试文件都自给自足：bun test 在文件之间共享模块注册表，只有本进程里第一个 dom 文件会走到
// app.js 顶部那次 boot()，其余文件 import 到的是缓存模块。所以这里自己建 world、装 stub，再显式装配
// 一次当前 DOM。
const world = makeWorld();
const dom = installDom({ fetch: world.fetchImpl });
const { boot } = await import('../../src/ui/web/assets/app.js');
// app.js 被加载时会自己 await boot() 一次：只有本进程里第一个 dom 文件会命中那次调用，而且它是对着
// 本文件的 stub 跑的。boot() 里 initSidebar() 是「追加」导航项（其余区块都是 replaceChildren，重复
// 装配无残留），所以再 boot() 一次之前先把左栏清空，保证每个文件都恰好装配一次。
dom.node('side-nav').replaceChildren();
await boot();

afterAll(() => dom.restore());

test('结构化 Plan 只读展示：兼容历史批次、能跳到派生工作，空队列收敛成空态', async () => {
  const specs = dom.node('specs');
  const groups = () => specs.querySelectorAll('.spec-batch').map(node => node.textContent);
  // 当前 Plan 在前，迁移前留下的历史 batch 次之。
  expect(groups()).toHaveLength(2);
  expect(groups()[0]).toContain('Plan · planner #9');
  expect(groups()[0]).toContain('runtime 编译');
  expect(groups()[1]).toContain('历史 batch #4');
  expect(groups()[1]).toContain('planner #9');
  const text = deepText(specs);
  expect(text).toContain('#1');
  expect(text).toContain('还没编排的拆解');
  expect(text).toContain('排队中');
  expect(text).toContain('#2');
  expect(text).toContain('已被调度取走的拆解');
  expect(text).toContain('已排期');
  expect(text).toContain('任务 #2');
  // 纯只读：队列里唯一的按钮是跳转，没有 spec.add / spec.drop / 编辑入口
  expect(specs.querySelectorAll('button').map(node => node.textContent)).toEqual(['查看任务']);

  // planned 那条的「查看任务」打开它派生成的任务详情
  await findByText(specs, '查看任务').onclick();
  expect(deepText(dom.node('detail'))).toContain('合并我');

  // scheduler 已退出产品模型；历史 batch 仍可在 Plan 读模型中审计，但 Intent 面板不再暴露调度任务。
  const intents = dom.node('intents');
  expect(deepText(intents)).not.toContain('调度 #4');
  expect(dom.node('tasks').querySelector('[data-id="4"]')).toBeFalsy();

  // 队列被清空后，轮询把它收敛成空态，不残留旧节点
  world.state.specs = [];
  await dom.intervalFor(1500)();
  expect(deepText(specs)).toContain('Plan 为空');
  expect(specs.querySelectorAll('.spec')).toHaveLength(0);
  expect(specs.querySelectorAll('.spec-batch')).toHaveLength(0);
});

test('Intent 面板：planner 在 control plane，批准后 runtime 直接编译 Plan', async () => {
  const intents = dom.node('intents');
  const text = deepText(intents);
  // Intent 正文与 planner 状态在这里；scheduler 已从运行模型删除。
  expect(text).toContain('demo');
  expect(text).toContain('规划 #9');
  expect(text).toContain('拆解 待编排 1 · 已编排 1');
  expect(text).not.toContain('调度 #4');
  expect(text).toContain('等你批准');
  expect(text).toContain('已批准');
  expect(dom.node('tasks').querySelector('[data-id="9"]')).toBeFalsy();
  expect(dom.node('tasks').querySelector('[data-id="11"]')).toBeFalsy();

  // 批准：闸门放行给 deterministic compiler，刷新后按钮消失、徽章变成已批准
  await findByText(intents, '批准并开发').onclick();
  expect(world.state.actions.at(-1)).toEqual({ method: 'plan.approve', params: { id: 9 } });
  expect(deepText(dom.node('intents'))).not.toContain('批准并开发');
  expect(findByText(dom.node('intents'), '已批准')).toBeTruthy();

  // 驳回：先用应用内输入框问理由，再把理由一起送给 planner 重拆（取消或空理由都不发请求）。
  world.state.intents[0].plan_gate = 'proposed';
  await dom.intervalFor(1500)();
  const pending = findByText(dom.node('intents'), '驳回').onclick();
  expect(dialogText(dom)).toContain('驳回理由');
  expect(dialogText(dom)).toContain('理由会送给 planner');
  await answerDialog(dom, '驳回并重拆', '别动架构，先加个开关');
  await pending;
  expect(world.state.actions.at(-1)).toEqual({ method: 'plan.reject', params: { id: 9, reason: '别动架构，先加个开关' } });
  expect(findByText(dom.node('intents'), '已驳回')).toBeTruthy();
});

test('Intent 面板：待验收候选给出结果入口与接受 / 要求修改，两者走 candidate.*', async () => {
  const intents = dom.node('intents');
  const text = deepText(intents);
  // 候选版本与状态画在 Intent 行上，报告入口是新标签打开 verifier 的 HTML
  expect(text).toContain('候选 v1 · ready');
  const report = findByText(intents, '打开结果报告');
  expect(report).toBeTruthy();
  expect(report.href).toBe('/api/task/12/report');
  expect(report.target).toBe('_blank');
  expect(findByText(intents, '接受并合入')).toBeTruthy();

  // 接受：精确 commit 落到目标分支
  await findByText(intents, '接受并合入').onclick();
  expect(world.state.actions.at(-1)).toEqual({ method: 'candidate.accept', params: { id: 1 } });

  // 要求修改：弹窗收集反馈后调 candidate.changes，取消或空反馈都不发请求
  const pending = findByText(dom.node('intents'), '要求修改').onclick();
  expect(dialogText(dom)).toContain('需要怎样修改');
  await answerDialog(dom, '提交修改要求', '按钮再明显一点');
  await pending;
  expect(world.state.actions.at(-1)).toEqual({ method: 'candidate.changes', params: { id: 1, feedback: '按钮再明显一点' } });
});
