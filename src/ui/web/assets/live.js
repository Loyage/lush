/**
 * 「页面自己变新」的核心：只做轮询决策与游标推进，不碰 DOM。
 *
 * 为什么单拎出来：详情面板过去只在 `tasks.updated_at` 变化时才重画，而 agent 跑一次调用期间
 * 事件与 pi 会话都追加在别处，`updated_at` 不动——页面看起来就是冻住的。这里固定住三件事：
 *   1. 只对热任务（running/awaiting/waiting/queued）请求；
 *   2. 执行过程只在用户已经展开、有缓存时才用 `after=<next>` 增量续读，没展开就不读整份会话文件；
 *   3. 「最近一次执行」每个 tick 都重新取 usage，相对时间因此会自己往前走。
 * DOM 更新通过 publish 回调注入，测试就能用假实现断言这套行为，不必起浏览器。
 *
 * 实时刷新的间隔不再是写死的常量：它随设置页「行为」组的轮询频率偏好（`lush.polling`）变化，
 * 标准档等于改造前的 3000ms。app.js 在 `boot()` 与偏好变更时重建定时器。
 */
import { pollingIntervals } from './prefs.js';

/** 实时刷新间隔（毫秒）：读当前「轮询频率」偏好，标准档 3000。 */
export function liveInterval() { return pollingIntervals().live; }

/** 与 app.js 的 HOT 一致：这些状态下的任务随时会有新步骤。 */
const LIVE_STATUS = new Set(['running', 'awaiting', 'waiting', 'queued']);

/** 这次 tick 该刷谁：任务不在列表里、或被切走 / 已终态时返回 null。 */
export function liveTarget(tasks, selected) {
  if (selected === null || selected === undefined) return null;
  const task = (tasks || []).find(row => row.id === selected);
  return task && LIVE_STATUS.has(task.status) ? task : null;
}

/**
 * 一个 tick：先刷 usage（最近一次执行），transcript 已展开时按游标增量续读并追加到 state。
 * @param {object} options
 * @param {object} options.task 当前展示的热任务
 * @param {object|null} options.transcript 已加载的 transcript 缓存（含 steps/next），没展开传 null
 * @param {(taskId:number)=>Promise} options.fetchUsage
 * @param {(taskId:number, after:number)=>Promise} options.fetchTranscript
 * @param {{usage?:(taskId:number, usage:object)=>void, steps?:(taskId:number, steps:Array)=>void}} options.publish
 * @returns {Promise<{usage:object|null, steps:Array}>} 本 tick 真的更新了什么（测试与调试用）
 */
export async function liveTick({ task, transcript = null, fetchUsage, fetchTranscript, publish = {} }) {
  const updated = { usage: null, steps: [] };
  const usage = await fetchUsage(task.id);
  if (usage) {
    updated.usage = usage;
    if (publish.usage) publish.usage(task.id, usage);
  }
  if (transcript) {
    const page = await fetchTranscript(task.id, transcript.next ?? 0);
    const steps = page?.steps || [];
    if (steps.length) {
      transcript.steps.push(...steps);
      transcript.next = page.next ?? transcript.next;
      transcript.has_more = page.has_more ?? false;
      transcript.truncated = Boolean(transcript.truncated || page.truncated);
      updated.steps = steps;
      if (publish.steps) publish.steps(task.id, steps);
    }
  }
  return updated;
}
