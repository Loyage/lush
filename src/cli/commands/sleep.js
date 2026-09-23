import { check } from '../../core/types.js';
import { sleepOptions, SLEEP_WARNING } from '../../core/sleep-policy.js';
import { exact, option } from '../args.js';

export async function run(command, args, { client, json }) {
  check(!client.token, 'sleep mode is user-only');
  const verb = args.shift() || 'status';
  if (verb === 'on') {
    const mode = option(args, '--mode', 'recommended');
    const budget = option(args, '--budget');
    const existing = option(args, '--existing');
    const merge = option(args, '--merge');
    const confirmed = args.includes('--confirm');
    if (confirmed) args.splice(args.indexOf('--confirm'), 1);
    exact(args, 0);
    console.error(`警告：${SLEEP_WARNING}`);
    check(confirmed, '阅读风险后添加 --confirm 才会正式开启');
    check(['yes','no'].includes(existing) && ['yes','no'].includes(merge), '必须明确指定 --existing yes|no 和 --merge yes|no');
    const options = sleepOptions({ mode, budget_tokens: budget === null ? null : Number(budget), include_existing: existing === 'yes', allow_merge: merge === 'yes' });
    const state = await client.request('sleep.start', { options, confirmed: true });
    if (json) return state;
    printState(state); return;
  }
  if (verb === 'choices') {
    const before = option(args, '--before'); exact(args, 0);
    return client.request('sleep.choices', { before: before === null ? null : Number(before) });
  }
  check(['off','status','resume'].includes(verb), 'sleep expects on/off/status/resume/choices');
  exact(args, 0);
  const state = await client.request({ off: 'sleep.stop', status: 'sleep.status', resume: 'sleep.resume' }[verb]);
  if (json) return state;
  printState(state);
}
function printState(state) {
  console.log(`我去睡觉了：${state.enabled ? '已开启' : '已关闭'}${state.paused ? ' · 开发已暂停' : ''}`);
  console.log(`项目累计 token：${state.used_tokens || 0} / ${state.budget_tokens ?? '不限'}`);
  if (state.reason) console.log(state.reason);
  console.log('立即关闭：bun run lush sleep off');
  if (state.paused) console.log('恢复排队任务：bun run lush sleep resume（中止任务请检查后手动 retry）');
  console.log('查看管家选择：bun run lush sleep choices');
}
