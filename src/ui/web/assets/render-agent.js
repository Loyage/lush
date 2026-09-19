import { $, block, button, el, kv } from './dom.js';
import { lastView, money, relative, tokens } from './format.js';
import { detail } from './navigate.js';
import { transcriptContent, loadTranscript } from './render-transcript.js';
import { transcriptCache, transcriptOpen, ui } from './state.js';

/** 折叠态的执行过程只摆这一行：相对时间 + 类型/标题 + 正文单行预览，全文在 title。 */
function lastStepRow(last) {
  const view = lastView(last);
  const row = el('p', undefined, 'last-step');
  row.dataset.live = 'last';
  row.append(el('span', view.value));
  row.title = view.title;
  return row;
}
/** 轮询里只重画这一行：不展开执行过程时，「最近一条步骤」不必等整个详情面板重建。 */
export function paintUsageLast(taskId, usage) {
  if (ui.selected !== taskId) return;
  const row = $('detail').querySelector('[data-live="last"]');
  if (!row) return;
  const view = lastView(usage?.last ?? null);
  (row.querySelector('span') || row).textContent = view.value;
  row.title = view.title;
}
/** 一个 agent 的全部信息：身份与唤醒次数（Lush 侧）+ 模型、上下文、花费（pi 会话记录侧）。
 *  执行过程就在同一块里——它就是 agent 这个身份干过的事，不是另一类数据。 */
export function renderAgent(task, usage) {
  const section = block('Agent');
  const grid = el('div', undefined, 'grid');
  if (task.agent) {
    grid.append(kv('agent', `${task.agent.id} · ${task.agent.active ? `运行中 · pid ${task.agent.pid ?? '待上报'}` : '空闲'}`));
    grid.append(kv('唤醒', `累计 ${task.agent.wakes} 次${task.agent.last_seen_at ? ` · 上次动手 ${relative(task.agent.last_seen_at)}` : ''}`));
  }
  if (usage?.files?.length) {
    grid.append(kv('模型', usage.model ? [usage.model.provider, usage.model.model_id].filter(Boolean).join('/') : '—', 'mono'));
    if (usage.thinking_level) grid.append(kv('思考等级', usage.thinking_level));
    // 还没等到模型回复就结束的会话（被杀、启动失败）没有用量，不摆一排 0 充数。
    if (usage.requests) {
      // 上下文占用＝最近一次请求真的送进去又收回来的 token（输入 + 缓存 + 输出），当作那一刻的上下文大小。
      const context = kv('上下文占用', `${tokens(usage.context_tokens)} tokens（最近一次请求）`);
      context.title = '最近一次模型请求的输入 + 缓存读 + 缓存写 + 输出。来自 pi 会话记录，不是估算。';
      const spent = [`输入 ${tokens(usage.totals.input)}`, `输出 ${tokens(usage.totals.output)}`, `缓存读 ${tokens(usage.totals.cache_read)}`];
      if (usage.totals.cache_write) spent.push(`缓存写 ${tokens(usage.totals.cache_write)}`);
      if (usage.totals.reasoning) spent.push(`推理 ${tokens(usage.totals.reasoning)}`);
      const cumulative = kv('累计 token', spent.join(' · '));
      cumulative.title = '这个任务的全部会话文件累计；重试不会清空 agent 的历史。';
      const cost = kv('预计花费', money(usage.totals.cost));
      cost.title = 'pi 按模型单价对每次请求算出的 cost.total 累加；模型换过就按各自单价分别计。';
      grid.append(context, cumulative, cost);
    }
    grid.append(kv('模型请求', `${usage.requests} 次${usage.last_at ? ` · 最近 ${relative(usage.last_at)}` : ''}`));
    grid.append(kv('会话记录', `${usage.files.length} 个文件${usage.compacted ? ` · 上下文压缩 ${usage.compacted} 次` : ''}`, 'mono'));
  }
  section.append(grid);

  const process = block('执行过程');
  const holder = el('div', undefined, 'transcript');
  const cached = transcriptCache.get(task.id);
  if (cached) holder.replaceChildren(...transcriptContent(task.id));
  // 会话文件不存在就别摆一个点了没用的按钮，直接说清楚为什么没东西可看。
  else if (!usage?.files?.length) holder.append(el('p', '这个任务还没有 pi 会话记录（可能从未被唤醒，或会话文件已被清理）。', 'hint'));
  else if (transcriptOpen.has(task.id)) holder.append(el('p', '正在读取会话记录…', 'hint'));
  else {
    // 不展开时「只显示最近一条信息」（用户原话）：那一步就是执行过程的最后一条。
    if (usage.last) holder.append(lastStepRow(usage.last));
    else holder.append(el('p', '思考、工具调用与工具输出保存在 pi 会话记录里，默认不展开。', 'hint'));
    const actions = el('div', undefined, 'actions');
    actions.append(button('查看执行过程', async () => {
      transcriptOpen.add(task.id);
      try { await loadTranscript(task.id); } catch (error) { transcriptOpen.delete(task.id); throw error; }
      if (ui.selected === task.id) await detail(task.id);
    }, 'ghost'));
    holder.append(actions);
  }
  process.append(holder);
  section.append(process);
  return section;
}
