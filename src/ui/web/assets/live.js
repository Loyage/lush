/**
 * 「页面自己变新」的核心：只做轮询决策与游标推进，不碰 DOM。
 *
 * 为什么单拎出来：详情面板过去只在 `tasks.updated_at` 变化时才重画，而 agent 跑一次调用期间
 * 事件与 pi 会话都追加在别处，`updated_at` 不动——页面看起来就是冻住的。这里固定住三件事：
 *   1. 对热任务（running/awaiting/waiting/queued）刷新，已打开的终态记录补读最后尾部；
 *   2. 执行过程仅显式展开、有缓存后用 `after=<next>` 增量续读，不重建阅读正文；
 *   3. 「最近一次执行」每个 tick 都重新取 usage，相对时间因此会自己往前走。
 * DOM 更新通过 publish 回调注入，测试就能用假实现断言这套行为，不必起浏览器。
 *
 * 实时刷新的间隔不再是写死的常量：它随设置页「行为」组的轮询频率偏好（`lush.polling`）变化，
 * 标准档等于改造前的 3000ms。app.js 在 `boot()` 与偏好变更时重建定时器。
 */
import { pollingIntervals } from './prefs.js';

/** Failure-only bounded backoff; healthy visible polling retains its configured cadence. */
export function createPollBackoff({ now = () => Date.now(), base = 1500, max = 30000 } = {}) {
  let failures = 0, retryAt = 0;
  return {
    ready: () => now() >= retryAt,
    failed() { retryAt = now() + Math.min(max, base * 2 ** Math.min(failures++, 8)); },
    reset() { failures = 0; retryAt = 0; },
  };
}

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
 * 一个 tick：usage 与正文并发，正文可先发布；DOM 调用方可不等待慢统计，独立 single-flight。
 * @param {object} options
 * @param {object} options.task 当前展示的热任务
 * @param {object|null} options.transcript 已加载的 transcript 缓存（含 steps/next），没展开传 null
 * @param {(taskId:number)=>Promise} options.fetchUsage
 * @param {(taskId:number, after:number)=>Promise} options.fetchTranscript
 * @param {{usage?:(taskId:number, usage:object)=>void, steps?:(taskId:number, steps:Array)=>void}} options.publish
 * @param {()=>boolean} options.current Worker / 页面 / 缓存仍归本请求所有
 * @param {boolean} options.detachUsage DOM 驱动单独管理统计 single-flight，不占正文 tick
 * @returns {Promise<{usage:object|null, steps:Array}>} 本 tick 真的更新了什么（测试与调试用）
 */
export async function liveTick({ task, transcript = null, fetchUsage, fetchTranscript, publish = {},
  current = () => true, detachUsage = false }) {
  const updated = { usage: null, steps: [] };
  // Catch inside each independent channel: failed usage must neither block nor discard a good tail.
  const usageRead = Promise.resolve().then(() => fetchUsage(task.id)).then(usage => {
    if (usage && current()) {
      if (!detachUsage) updated.usage = usage;
      publish.usage?.(task.id, usage);
    }
  }).catch(() => {});
  const transcriptRead = (async () => {
    if (!transcript || transcript.error) return;
    const after = transcript.next ?? 0;
    const page = await fetchTranscript(task.id, after);
    // A competing tick/manual page/reload may win. It must be retried, not treated as a final tail.
    if (!current() || (transcript.next ?? 0) !== after) return;
    const known = new Set(transcript.steps.map(step => step.seq));
    const steps = [];
    for (const step of page?.steps || []) {
      if (!(step.seq > after) || known.has(step.seq)) continue;
      known.add(step.seq); steps.push(step);
    }
    if (steps.length) {
      transcript.steps.push(...steps);
      transcript.next = Math.max(after, page.next ?? 0, ...steps.map(step => step.seq));
      updated.steps = steps;
    }
    // Update paging metadata before publication: transcript chrome consumes these fields.
    // desc 的向旧翻页边界不由增量改变；空成功页也应更新 asc 的 has_more。
    if (transcript.order !== 'desc') transcript.has_more = page?.has_more ?? false;
    transcript.truncated = Boolean(transcript.truncated || page?.truncated);
    if (steps.length) publish.steps?.(task.id, steps);
    // Internal success marker, kept non-enumerable for the existing return-value contract.
    Object.defineProperty(updated, 'tailRead', { value: !page?.has_more });
  })();
  if (detachUsage) await transcriptRead;
  else {
    const results = await Promise.allSettled([usageRead, transcriptRead]);
    if (results[1].status === 'rejected') throw results[1].reason;
  }
  return updated;
}
