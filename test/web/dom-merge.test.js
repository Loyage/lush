import { test, expect, afterAll } from 'bun:test';
import { installDom, findByText, deepText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';

// 批量合并：候选过滤、冻结不可选、依赖顺序确认、逐条结果。
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

test('批量合并：只列出能合的任务，冻结的不给选，按依赖顺序确认，并逐条展示结果', async () => {
  const detail = dom.node('detail');
  // 只有 completed + pending/review 的 #2、#3 有勾选框；running 的 #1 不在候选里。
  const boxes = () => detail.querySelectorAll('input.pick');
  expect(boxes()).toHaveLength(2);
  expect(boxes().every(box => box.disabled === false)).toBe(true);

  // 同一目标分支上出现未解决冲突：另一个任务被冻结，不能再勾。
  world.state.freeze = [{ id: 4, task_id: 4, target_branch: 'main', resolves_task_id: null }];
  await dom.intervalFor(1500)();
  const frozen = boxes().find(box => box.disabled);
  expect(frozen).toBeTruthy();
  // 被冻结的任务在界面上就是不可勾的（浏览器里 disabled 的勾选框不会触发 onchange）。
  expect(deepText(detail)).toContain('合并被冻结：#4');

  // 只选没被冻结的 #3（它在 release 上，不受 main 的冲突冻结影响）。
  const pick = boxes().filter(box => !box.disabled);
  expect(pick).toHaveLength(1);
  pick[0].checked = true;
  pick[0].onchange();
  const mergeSelected = findByText(detail, '合并选中 (1)');
  expect(mergeSelected).toBeTruthy();
  expect(mergeSelected.disabled).toBe(false);

  await mergeSelected.onclick();
  // 确认框把即将合并的东西与「依赖优先」说清楚。
  expect(dom.confirms.at(-1)).toContain('按依赖顺序合并 1 个任务');
  expect(dom.confirms.at(-1)).toContain('#3');
  // 请求只带勾选的 id；顺序由运行时按依赖决定。
  expect(world.state.actions).toEqual([{ method: 'task.merge_many', params: { ids: [3] } }]);
  // 结果逐条展示，刷新后仍在页面上。
  expect(deepText(detail)).toContain('批量合并结果');
  expect(findByText(detail, '已进入目标分支')).toBeTruthy();
  expect(findByText(detail, '全部合并成功：1 个。')).toBeTruthy();
  expect(findByText(detail, '#3')).toBeTruthy();
});
