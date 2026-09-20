import { test, expect, afterAll } from 'bun:test';
import { installDom, findByText, deepText } from '../dom-stub.js';
import { makeWorld, NOW, iso } from './dom-world.js';

// 批量合并：候选过滤、冻结不可选、依赖顺序确认、逐条结果。
// 每个 DOM 测试文件都自给自足：bun test 在文件之间共享模块注册表，只有本进程里第一个 dom 文件会走到
// app.js 顶部那次 boot()，其余文件 import 到的是缓存模块。所以这里自己建 world、装 stub，再显式装配
// 一次当前 DOM。
const world = makeWorld();
const dom = installDom({ fetch: world.fetchImpl });
const { boot } = await import('../../src/ui/web/assets/app.js');
const { noticePanel } = await import('../../src/ui/web/assets/render-notices.js');
// 概览已改成以分支为中心，不再挂交付队列；render-ladder 仍然可用（当前没有常驻视图），
// 所以这里直接把队列挂进 #detail 来测批量合并本身，而不是依赖概览渲染它。
const { renderLadder } = await import('../../src/ui/web/assets/render-ladder.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
// app.js 被加载时会自己 await boot() 一次：只有本进程里第一个 dom 文件会命中那次调用，而且它是对着
// 本文件的 stub 跑的。boot() 里 initSidebar() 是「追加」导航项（其余区块都是 replaceChildren，重复
// 装配无残留），所以再 boot() 一次之前先把左栏清空，保证每个文件都恰好装配一次。
dom.node('side-nav').replaceChildren();
await boot();

afterAll(() => dom.restore());

test('resolver 的首次 notice 使用明确动作，不再让“任意回复”承担批准语义', async () => {
  const panel = noticePanel({ id: 99, task_id: 5, title: '要开解冲突任务吗？', body: '冲突文件：a.js', created_at: iso(NOW) },
    { id: 5, role: 'merger', resolves_task_id: 2, agent_wakes: 0 });
  expect(panel.querySelector('textarea')).toBeNull();
  expect(findByText(panel, '开始解冲突')).toBeTruthy();
  expect(findByText(panel, '暂不处理')).toBeTruthy();
});

test('批量合并：只列出能合的任务，冻结的不给选，按依赖顺序确认，并逐条展示结果', async () => {
  const detail = dom.node('detail');
  // 交付队列现在没有常驻视图，测试自己把它挂进 #detail（每次 refresh 重画概览后都要重挂）。
  const mount = () => detail.replaceChildren(renderLadder(ui.lastSnapshot));
  mount();
  // 只有 completed + pending/review 的 #2、#3 有勾选框；running 的 #1 不在候选里。
  const boxes = () => detail.querySelectorAll('input.pick');
  expect(boxes()).toHaveLength(2);
  // 当前检出 main：main 可选，release 明确显示需要切分支。
  expect(boxes().filter(box => box.disabled)).toHaveLength(1);

  // main 出现未解决冲突，同时用户切到 release：main 被冻结，release 变成当前可交付分支。
  world.state.freeze = [{ id: 4, task_id: 4, target_branch: 'main', resolves_task_id: null }];
  world.state.currentBranch = 'release';
  await dom.intervalFor(1500)();
  mount();
  const frozen = boxes().find(box => box.disabled);
  expect(frozen).toBeTruthy();
  // 被冻结的任务在界面上就是不可勾的（浏览器里 disabled 的勾选框不会触发 onchange）。
  expect(deepText(detail)).toContain('#4 的冲突冻结了 main');

  // 只选没被冻结的 #3（它在 release 上，不受 main 的冲突冻结影响）。
  const pick = boxes().filter(box => !box.disabled);
  expect(pick).toHaveLength(1);
  pick[0].checked = true;
  pick[0].onchange();
  const mergeSelected = findByText(detail, '合并本分支选中 (1)');
  expect(mergeSelected).toBeTruthy();
  expect(mergeSelected.disabled).toBe(false);

  await mergeSelected.onclick();
  // mergeBatch 内部会 refresh()（概览重画），重新挂一次队列才能看到逐条结果。
  mount();
  // 确认框把目标分支、代码基线顺序与“可能部分成功”说清楚。
  expect(dom.confirms.at(-1)).toContain('向 release 依次交付 1 个变更');
  expect(dom.confirms.at(-1)).toContain('#3');
  // 请求只带勾选的 id；顺序由运行时按依赖决定。
  expect(world.state.actions).toEqual([{ method: 'task.merge_many', params: { ids: [3] } }]);
  // 结果逐条展示，刷新后仍在页面上。
  expect(deepText(detail)).toContain('批量交付结果');
  expect(findByText(detail, '已进入目标分支')).toBeTruthy();
  expect(findByText(detail, '全部交付成功：1 个 → release。')).toBeTruthy();
  expect(findByText(detail, '#3')).toBeTruthy();
});
