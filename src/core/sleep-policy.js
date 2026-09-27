import { check, isPlainObject } from './types.js';
import { questionnaireAnswer } from './questionnaire.js';

export const SLEEP_WARNING = '管家会替你回答问题、批准开发计划，可能误解偏好、作出错误选择并持续消耗整个项目的 token。允许自动合并时会修改目标分支。关闭浏览器不停止此模式，daemon 重启后仍保留授权。预算包含输入、输出和缓存 token，按已记录响应检查，并非供应商硬限额，在途请求可能超额；到限会暂停调度并中止当前调用，工作区保留，中止任务需检查后手动重试。关闭模式不会撤销已执行的决定或已经开始的 Git 操作。';

export function sleepOptions(value) {
  check(isPlainObject(value) && Object.keys(value).every(k => ['mode','budget_tokens','include_existing','allow_merge'].includes(k)), 'invalid sleep options');
  check(['recommended','preferences'].includes(value.mode), 'sleep mode must be recommended or preferences');
  check(typeof value.include_existing === 'boolean' && typeof value.allow_merge === 'boolean', 'choose include_existing and allow_merge explicitly');
  const budget = value.budget_tokens ?? null;
  check(budget === null || (Number.isSafeInteger(budget) && budget > 0 && budget <= 1000000000), 'budget_tokens must be 1..1000000000 or null');
  return { mode: value.mode, budget_tokens: budget, include_existing: value.include_existing, allow_merge: value.allow_merge };
}

export function recommendedChoice(notice) {
  if (notice.kind === 'plan') return { action: 'approve', reason: '按开启时的授权批准计划。' };
  if (notice.kind !== 'questionnaire') return null;
  const form = JSON.parse(notice.body);
  const answers = form.questions.map(q => {
    const indices = q.options.flatMap((o, i) => /[（(](?:recommended|推荐)[）)]/i.test(o.label) ? [i] : []);
    return indices.length === 1 ? { selected: indices } : null;
  });
  return answers.every(Boolean) ? { action: 'answer', answer: { answers }, reason: '选择每道题唯一标注的推荐项。' } : null;
}

export function validateSleepChoice(notice, value) {
  check(isPlainObject(value) && Object.keys(value).every(k => ['action','answer','reason'].includes(k)), 'invalid butler decision fields');
  check(typeof value.reason === 'string' && value.reason.trim() && value.reason.length <= 4000, 'butler must give a bounded reason');
  const actions = notice.kind === 'plan' ? ['approve','reject'] : notice.kind === 'info' ? ['acknowledge','merge'] : ['answer','dismiss'];
  check(actions.includes(value.action), 'invalid butler action for this notice');
  if (value.action === 'answer') {
    if (notice.kind === 'questionnaire') questionnaireAnswer(notice.body, value.answer);
    else check(typeof value.answer === 'string' && value.answer.trim() && value.answer.length <= 32000, 'invalid butler answer');
  }
  return value;
}
