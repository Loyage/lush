import { el } from './dom.js';
import { waitingDeps } from './format.js';

/** 顶部并发槽：并行不是树里的属性，而是全局资源——画出来才知道谁在占槽、谁在等槽。 */
export function slotGauge(data) {
  const limit = data.status.concurrency ?? 1, used = data.status.agents.length;
  const ready = data.tasks.filter(task => task.status === 'queued' && !waitingDeps(task).length).length;
  const node = el('span', undefined, 'slots');
  node.append(el('span', '并发槽', 'slot-label'));
  const dots = el('span', undefined, 'slot-dots');
  for (let i = 0; i < Math.min(limit, 16); i++) dots.append(el('span', '●', `slot ${i < used ? 'on' : 'off'}`));
  if (limit > 16) dots.append(el('span', `+${limit - 16}`, 'slot'));
  node.append(dots, el('span', `${used}/${limit}`, 'slot-count'));
  // 没有依赖却没在跑的 queued 任务，等的就是槽——这是「为什么还没开始」最常见的答案。
  if (ready) node.append(el('span', `排队 ${ready} 等槽`, 'slot-queue'));
  node.title = `并发上限 ${limit}：同一时刻最多 ${limit} 个 agent 在跑。没有依赖却在排队的任务就是在等槽。`;
  return node;
}
