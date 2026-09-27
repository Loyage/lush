import { $, block, button, el } from './dom.js';
import { api, action } from './api.js';
import { confirmDialog } from './dialog.js';
import { agentHelp } from './help.js';
import { ui } from './state.js';
import { absolute } from './format.js';

const modeLabel = mode => mode === 'preferences' ? '参考以往选择' : '全通过／推荐';
const usageLabel = state => `项目全部 Agent：${state?.used_tokens || 0} / ${state?.budget_tokens ?? '不限'} token`;
const progressLabel = state => `已处理 ${state?.handled || 0} 项事项 · 其中 ${state?.decisions || 0} 道由管家作出选择`;

async function stop() {
  const state = await action('sleep.stop', {});
  renderSleepBanner(state);
}
async function resume() {
  if (!await confirmDialog({ title: '恢复开发调度？', message: '只恢复排队任务，不重新开启托管模式。因预算中止的任务保留现场，需要检查后逐个重试。', confirmLabel: '恢复排队任务',
    agent: true, confirmHelp: agentHelp('恢复排队任务，它们对应的 Agent 会重新开始运行。') })) return;
  renderSleepBanner(await action('sleep.resume', {}));
}

export function renderSleepBanner(state) {
  const host = $('sleep-banner');
  if (!host) return;
  const signature = JSON.stringify(state ?? null);
  if (host.dataset.sleepSignature === signature) return;
  host.dataset.sleepSignature = signature;
  host.hidden = !state?.enabled && !state?.paused;
  if (host.hidden) { host.replaceChildren(); return; }
  host.replaceChildren(el('strong', state.enabled ? '☾ 托管模式 · 管家正在值守' : '开发已暂停 · 管家已停止'),
    el('p', progressLabel(state), 'hint'),
    el('p', usageLabel(state), 'hint'));
  if (state.enabled) host.append(el('p', '（旧称「我去睡觉了」）', 'hint'));
  if (state.reason) host.append(el('p', state.reason, 'hint'));
  if (state.enabled) host.append(button('立即关闭托管模式', stop, 'danger',
    { help: '立即停止管家值守；排队中的任务不会恢复，需要你自己处理。' }));
  if (state.paused) host.append(button('恢复排队任务', resume, 'ghost',
    { agent: true, help: agentHelp('只恢复排队任务，不重新开启托管模式；它们对应的 Agent 会重新开始运行。') }));
}

export function sleepSettings() {
  const host = block('托管模式');
  const state = ui.lastSnapshot?.status?.sleep;
  const status = el('p', state?.enabled ? `已开启 · ${modeLabel(state.mode)} · ${usageLabel(state)}` : state?.paused ? '预算保护：开发已暂停' : '未开启', 'hint');
  host.append(status, el('p', '离开界面后仍持续运行，直到你主动关闭或预算保护触发。每次代理决定都会留在「待我处理 → 管家选择」。（也有人叫它「我去睡觉了」——反正它不睡。）'));
  if (state?.enabled) { host.append(button('立即关闭托管模式', async () => { await stop(); status.textContent = '已关闭；历史选择仍保留'; }, 'danger',
    { help: '立即停止管家值守；排队中的任务不会恢复，需要你自己处理。' })); return host; }
  if (state?.paused) { host.append(button('恢复排队任务', resume, undefined,
    { agent: true, help: agentHelp('只恢复排队任务，不重新开启托管模式；它们对应的 Agent 会重新开始运行。') })); return host; }
  const mode = el('select'); mode.setAttribute('aria-label', '管家模式'); mode.dataset.sleepField = 'mode';
  for (const [value, label] of [['recommended','全通过／推荐（无推荐时由管家判断）'],['preferences','参考以往选择，推断我的偏好']]) {
    const option = el('option', label); option.value = value; mode.append(option);
  }
  mode.value = 'recommended';
  const budget = el('input'); budget.type = 'number'; budget.min = '1'; budget.max = '1000000000'; budget.step = '1'; budget.placeholder = '留空＝不限额'; budget.dataset.sleepField = 'budget';
  const existing = el('input'); existing.type = 'checkbox'; existing.dataset.sleepField = 'existing';
  const merge = el('input'); merge.type = 'checkbox'; merge.dataset.sleepField = 'merge';
  const field = (text, input) => { const label = el('label', undefined, 'sleep-field'); label.append(el('span', text), input); return label; };
  host.append(field('决策方式', mode), field('整个项目的 token 预算（含输入、输出、缓存）', budget),
    field('处理开启前已经存在的 Notice', existing), field('允许自动批准交付 Notice 对应的安全合并', merge),
    el('p', '管家只处理 Notice，不擅自收拢任意分支或跳过 Candidate 验收。偏好只是推断，并不保证符合你的真实意图。', 'hint'));
  const enable = button('阅读风险并开启…', async () => {
    const value = budget.value.trim();
    const tokens = value ? Number(value) : null;
    if (tokens !== null && (!Number.isSafeInteger(tokens) || tokens <= 0 || tokens > 1000000000)) throw new Error('预算必须为 1–1000000000 的整数，或留空');
    enable.disabled = true;
    try {
      const fresh = await api('/api/sleep');
      if (!fresh.warning) throw new Error('无法读取风险说明，请更新 daemon');
      const options = { mode: mode.value, budget_tokens: tokens, include_existing: existing.checked, allow_merge: merge.checked };
      if (!await confirmDialog({ title: '确认开启「托管模式」？', danger: true,
        message: fresh.warning,
        detail: `${modeLabel(options.mode)}\n预算：${tokens ?? '不限额'} token\n已有 Notice：${options.include_existing ? '处理' : '不处理'}\n自动合并：${options.allow_merge ? '允许' : '不允许'}`,
        confirmLabel: '我了解风险，授权管家开启',
        agent: true, confirmHelp: agentHelp('授权管家代理处理 Notice，它可能自动批准计划或合并。') })) return;
      const next = await action('sleep.start', { options, confirmed: true });
      if (ui.lastSnapshot?.status) ui.lastSnapshot.status.sleep = next;
      renderSleepBanner(next);
      host.replaceChildren(el('h2', '托管模式 · 已开启'), el('p', usageLabel(next)), button('立即关闭托管模式', stop, 'danger',
        { help: '立即停止管家值守；排队中的任务不会恢复，需要你自己处理。' }));
    } finally { enable.disabled = false; }
  }, undefined, { agent: true, help: agentHelp('开启托管模式后，管家会代理你处理 Notice，可能自动批准计划或合并。') });
  host.append(enable); return host;
}

const RESULT = { applied: '已执行', failed: '执行失败', skipped: '未执行', interrupted: '中断／需检查', pending: '处理中' };
const ACTION = { approve: '批准计划', reject: '驳回计划', answer: '回答', dismiss: '忽略', merge: '批准安全合并', acknowledge: '已阅' };
export function sleepChoiceCard(choice) {
  const card = el('section', undefined, 'notice sleep-choice');
  const result = choice.result || {};
  const decision = result.decision;
  card.append(el('h3', `管家选择 #${choice.id} · ${RESULT[result.status] || result.status}`),
    el('p', `${absolute(choice.created_at)} · ${modeLabel(choice.mode)} · Notice #${choice.notice.id} · 任务 #${choice.notice.task_id}`, 'hint'),
    el('h4', choice.notice.title));
  if (choice.notice.kind === 'questionnaire') {
    try {
      const form = JSON.parse(choice.notice.body);
      if (form.body) card.append(el('p', form.body, 'notice-body'));
      form.questions.forEach((q, i) => {
        card.append(el('p', q.question, 'notice-body'));
        const answer = decision?.answer?.answers?.[i];
        const text = answer?.custom || answer?.selected?.map(index => q.options[index]?.label || String(index)).join('、');
        card.append(el('p', `管家选择：${text || '未选择'}`, 'notice-body'));
        card.append(el('p', `当时选项：${q.options.map(o => o.label).join(' / ')}`, 'hint'));
      });
    } catch { card.append(el('pre', choice.notice.body)); }
  } else {
    card.append(el('p', choice.notice.body || '无补充说明', 'notice-body'));
    if (typeof decision?.answer === 'string') card.append(el('p', `管家回答：${decision.answer}`, 'notice-body'));
  }
  if (decision) card.append(el('p', `${ACTION[decision.action] || decision.action} · 理由：${decision.reason}`, 'notice-body'));
  if (result.reason || result.error) card.append(el('p', result.reason || result.error, 'notice-body'));
  if (result.outcome?.merge) card.append(el('p', `合并结果：${result.outcome.merge.status}`, 'hint'));
  return card;
}
