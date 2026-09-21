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

test('拆解队列只读展示：按批次分组、能跳到派生的任务，scheduler 显示成调度，空队列收敛成空态', async () => {
  const specs = dom.node('specs');
  const groups = () => specs.querySelectorAll('.spec-batch').map(node => node.textContent);
  // 两条分组标题：还没编排的在前，已被 scheduler 取走的次之
  expect(groups()).toHaveLength(2);
  expect(groups()[0]).toContain('等 scheduler 编排');
  expect(groups()[0]).toContain('planner #9');
  expect(groups()[1]).toContain('已被 scheduler #4');
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

  // 意图面板把 scheduler 显示成「调度 #4 · 排队」；点它可展开这一批 spec 与依赖（scheduler 不在任务树里）
  const intents = dom.node('intents');
  expect(deepText(intents)).toContain('调度 #4 · 排队');
  expect(dom.node('tasks').querySelector('[data-id="4"]')).toBeFalsy();
  await findByText(intents, '调度 #4 · 排队').onclick();
  const detail = dom.node('detail');
  expect(deepText(detail)).toContain('拆解队列');
  expect(deepText(detail)).toContain('本任务这一批取走的 spec');
  expect(deepText(detail)).toContain('还没编排的拆解');
  expect(deepText(detail)).toContain('已被调度取走的拆解');
  expect(deepText(detail)).toContain('依赖 spec #1');

  // 队列被清空后，轮询把它收敛成空态，不残留旧节点
  world.state.specs = [];
  await dom.intervalFor(1500)();
  expect(deepText(specs)).toContain('规划任务空');
  expect(specs.querySelectorAll('.spec')).toHaveLength(0);
  expect(specs.querySelectorAll('.spec-batch')).toHaveLength(0);
});

test('意图面板：planner/scheduler 不进任务树，批准/驳回走 plan.approve|reject', async () => {
  const intents = dom.node('intents');
  const text = deepText(intents);
  // 意图正文 + 意图层状态：规划 #9（planner）与调度 #4（scheduler）都在这里，不在任务树里
  expect(text).toContain('demo');
  expect(text).toContain('规划 #9');
  expect(text).toContain('拆解 待编排 1 · 已编排 1');
  expect(text).toContain('调度 #4 · 排队');
  expect(text).toContain('等你批准');
  expect(text).toContain('已批准');
  expect(dom.node('tasks').querySelector('[data-id="9"]')).toBeFalsy();
  expect(dom.node('tasks').querySelector('[data-id="11"]')).toBeFalsy();

  // 批准：闸门放行交给 scheduler，刷新后按钮消失、徽章变成已批准
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
