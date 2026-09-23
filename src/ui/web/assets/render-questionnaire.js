import { button, el } from './dom.js';
import { confirmDialog } from './dialog.js';
import { renderMarkdown } from './markdown.js';
import { ui } from './state.js';

function storageKey(notice) {
  return `lush.decision:${ui.lastSnapshot?.status?.project || location.pathname}:${notice.id}:${notice.created_at}`;
}
function loadDraft(notice, questions) {
  const count = questions.length;
  const key = storageKey(notice);
  let draft = ui.questionDrafts.get(key);
  if (!draft) {
    try { draft = JSON.parse(sessionStorage.getItem(key)); } catch { /* unavailable / corrupt */ }
  }
  if (draft?.body !== notice.body || !Array.isArray(draft.answers) || draft.answers.length !== count
    || !draft.answers.every((a, i) => Array.isArray(a?.selected)
      && a.selected.every(n => Number.isInteger(n) && n >= 0 && n < questions[i].options.length)
      && new Set(a.selected).size === a.selected.length && typeof a.custom === 'string' && a.custom.length <= 4000)) {
    draft = { body: notice.body, step: 0, answers: Array.from({ length: count }, () => ({ selected: [], custom: '' })) };
  }
  draft.step = Number.isInteger(draft.step) ? Math.max(0, Math.min(count, draft.step)) : 0;
  ui.questionDrafts.set(key, draft);
  return draft;
}
function preview(notice, question, option, value) {
  const pane = el('div', undefined, 'decision-preview');
  pane.append(el('small', '效果提案 · 非已实现结果', 'hint'), el('h4', value.label));
  if (value.preview) pane.append(renderMarkdown(value.preview));
  if (value.previewHtml) {
    const frame = el('iframe');
    frame.setAttribute('sandbox', '');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('title', `${value.label} · 静态效果预览`);
    frame.setAttribute('src', `/api/task/${notice.task_id}/notice/${notice.id}/preview/${question}/${option}`);
    pane.append(frame);
  }
  if (!value.preview && !value.previewHtml) pane.append(el('p', value.description));
  return pane;
}
const complete = (q, answer) => Boolean(answer.custom.trim()) || (answer.selected.length > 0
  && (q.multiSelect || answer.selected.length === 1) && answer.selected.every(i => i >= 0 && i < q.options.length));

/** Line a stored answer back up with its question: prefer position, fall back to wording. */
function answerForQuestion(answers, question, index) {
  const byIndex = answers[index];
  if (byIndex?.question === question.question) return byIndex;
  return answers.find(answer => answer?.question === question.question) || byIndex || null;
}
/** Recover selected option indices from `selected` (indices) or legacy `labels` (wording). */
function answeredIndices(question, answer) {
  const selected = answer?.selected;
  if (Array.isArray(selected) && selected.length) {
    const valid = [...new Set(selected.filter(n => Number.isInteger(n) && n >= 0 && n < question.options.length))];
    if (valid.length) return valid.sort((a, b) => a - b);
  }
  const labels = Array.isArray(answer?.labels) ? answer.labels : [];
  const found = [];
  for (const label of labels) {
    const at = question.options.findIndex(option => option.label === label);
    if (at >= 0 && !found.includes(at)) found.push(at);
  }
  return found.sort((a, b) => a - b);
}
/** Read-only replay of one answered question: same option cards and previews, no write path. */
function settledQuestion(notice, index, question, answer) {
  const box = el('div', undefined, 'decision-summary settled-question');
  box.append(el('strong', question.question), el('span', question.multiSelect ? '多选' : '单选', 'hint'));
  const custom = (answer?.custom || '').trim();
  const selected = custom ? [] : answeredIndices(question, answer);
  const recorded = custom ? [] : (Array.isArray(answer?.labels) ? answer.labels.filter(label => typeof label === 'string' && label.trim()) : []);
  if (custom) box.append(el('p', `自定义答案：${custom}`, 'decision-custom'));
  else if (selected.length) box.append(el('p', `已选：${selected.map(n => question.options[n]?.label).filter(Boolean).join('、')}`, 'decision-picked'));
  else if (recorded.length) box.append(el('p', `已选：${recorded.join('、')}（未能匹配到当前选项）`, 'decision-picked'));
  else box.append(el('p', '未选择任何选项', 'hint'));
  const hasPreview = question.options.some(option => option.preview || option.previewHtml);
  const layout = el('div', undefined, `decision-layout${hasPreview ? ' has-preview' : ''}`);
  const choices = el('div', undefined, 'decision-choices'), pane = el('div', undefined, 'decision-preview-pane');
  const show = n => { if (hasPreview && question.options[n]) pane.replaceChildren(preview(notice, index, n, question.options[n])); };
  question.options.forEach((option, n) => {
    const picked = selected.includes(n);
    const choice = button('', () => show(n), `decision-option${picked ? ' selected' : ''}`);
    choice.setAttribute('aria-pressed', String(picked));
    choice.append(el('strong', option.label), el('span', option.description));
    const row = el('div', undefined, 'decision-option-row'); row.append(choice);
    if (picked) row.append(el('span', '已选', 'decision-picked-mark'));
    choices.append(row);
  });
  layout.append(choices);
  // Only the chosen option preloads its preview; the rest stay behind a click, so a settled
  // notice does not fan out one iframe per option.
  if (hasPreview) { if (selected.length) show(selected[0]); layout.append(pane); }
  box.append(layout);
  return box;
}

/** Click-through questions; no network mutation until the final review is confirmed. */
export function questionnairePanel(notice, { settle, dismiss } = {}) {
  const root = el('div', undefined, 'questionnaire');
  let form;
  try { form = JSON.parse(notice.body); if (form.version !== 1 || !form.questions?.length) throw new Error('version'); }
  catch { root.append(el('p', '无法读取问卷，请检查 notice 原始内容。', 'error')); return root; }
  const questions = form.questions;
  if (form.body) root.append(renderMarkdown(form.body));
  const content = el('div'); root.append(content);
  if (notice.status !== 'open') {
    content.append(el('p', notice.status === 'answered' ? '已提交选择' : '已忽略 · 未选择任何选项', 'hint'));
    let answers = null, broken = false;
    if (notice.status === 'answered') {
      try { const parsed = JSON.parse(notice.answer); answers = Array.isArray(parsed?.answers) ? parsed.answers : null; }
      catch { answers = null; }
      broken = !answers;
    }
    questions.forEach((question, i) => {
      // Dismissal carries no answer: every question must read as explicitly unselected.
      const answer = answers ? answerForQuestion(answers, question, i) : null;
      content.append(settledQuestion(notice, i, question, answer));
    });
    if (broken) content.append(el('p', '无法解析已提交的答案，原始内容如下：', 'hint'), el('pre', notice.answer || ''));
    return root;
  }
  const draft = loadDraft(notice, questions);
  let busy = false, error = '';
  const save = () => {
    ui.detailDirty = true;
    try { sessionStorage.setItem(storageKey(notice), JSON.stringify(draft)); } catch { /* memory fallback */ }
  };
  const advance = () => { draft.step = Math.min(questions.length, draft.step + 1); save(); paint(); };
  const send = async discard => {
    if (busy) return;
    if (!discard && !questions.every((q, i) => complete(q, draft.answers[i]))) return;
    if (discard && !await confirmDialog({
      title: '忽略整份问卷？',
      message: '这不代表批准任何选项，任务会收到“未做决定”的消息。',
      confirmLabel: '忽略问卷',
      danger: true,
    })) return;
    busy = true; error = ''; paint();
    try {
      if (discard) await dismiss();
      else await settle({ answers: draft.answers.map(a => ({ selected: a.custom.trim() ? [] : a.selected, custom: a.custom.trim() })) });
      ui.questionDrafts.delete(storageKey(notice));
      try { sessionStorage.removeItem(storageKey(notice)); } catch { /* unavailable */ }
    } catch (e) {
      error = `未提交成功：${e.message}。选择已保留，可重试；若已在别处处理，请刷新。`;
      busy = false; paint();
    }
  };
  function paint() {
    content.replaceChildren();
    const progress = el('div', undefined, 'decision-progress');
    questions.forEach((q, i) => {
      const tab = button(`${complete(q, draft.answers[i]) ? '✓ ' : ''}${i + 1}. ${q.header}`, () => { draft.step = i; save(); paint(); }, draft.step === i ? '' : 'ghost');
      tab.setAttribute('aria-current', draft.step === i ? 'step' : 'false'); progress.append(tab);
    });
    progress.append(button('汇总确认', () => { draft.step = questions.length; save(); paint(); }, draft.step === questions.length ? '' : 'ghost'));
    content.append(progress);
    if (draft.step === questions.length) {
      content.append(el('h3', '确认你的全部选择'), el('p', '尚未发送给 agent。确认后整份问卷一次提交，原任务将继续。', 'hint'));
      questions.forEach((q, i) => {
        const a = draft.answers[i], item = el('div', undefined, 'decision-summary');
        item.append(el('strong', q.question), el('p', a.custom.trim() || a.selected.map(n => q.options[n]?.label).filter(Boolean).join('、') || '尚未回答'));
        item.append(button('修改', () => { draft.step = i; save(); paint(); }, 'ghost'));
        for (const n of a.custom.trim() ? [] : a.selected) {
          const o = q.options[n];
          if (!o) continue;
          item.append(el('p', o.description, 'hint'));
          if (o.preview || o.previewHtml) {
            const fold = el('details'); fold.append(el('summary', `查看 ${o.label} 的效果`), preview(notice, i, n, o)); item.append(fold);
          }
        }
        content.append(item);
      });
      const submit = button(busy ? '正在提交…' : '确认全部选择并继续任务', () => send(false));
      submit.disabled = !questions.every((q, i) => complete(q, draft.answers[i])); content.append(submit);
    } else {
      const i = draft.step, q = questions[i], a = draft.answers[i];
      content.append(el('h3', q.question), el('p', q.multiSelect ? '可多选 · 点选后按“下一题”' : '单选 · 点击选项即完成本题；悬停、聚焦或点“预览”先看效果', 'hint'));
      const layout = el('div', undefined, 'decision-layout'), choices = el('div', undefined, 'decision-choices'), pane = el('div');
      const hasPreview = q.options.some(o => o.preview || o.previewHtml);
      const show = n => { if (hasPreview) pane.replaceChildren(preview(notice, i, n, q.options[n])); };
      q.options.forEach((o, n) => {
        const row = el('div', undefined, 'decision-option-row');
        const choice = button('', () => {
          a.custom = '';
          if (q.multiSelect) { a.selected = a.selected.includes(n) ? a.selected.filter(v => v !== n) : [...a.selected, n]; save(); paint(); }
          else { a.selected = [n]; advance(); }
        }, `decision-option${!a.custom && a.selected.includes(n) ? ' selected' : ''}`);
        choice.setAttribute('aria-pressed', String(!a.custom && a.selected.includes(n)));
        choice.append(el('strong', o.label), el('span', o.description));
        choice.addEventListener('mouseenter', () => show(n)); choice.addEventListener('focus', () => show(n));
        row.append(choice);
        if (o.preview || o.previewHtml) row.append(button('预览', () => show(n), 'ghost decision-preview-button'));
        choices.append(row);
      });
      layout.append(choices);
      if (hasPreview) { layout.classList.add('has-preview'); layout.append(pane); show(a.selected[0] ?? 0); }
      content.append(layout);
      const custom = el('textarea'); custom.rows = 2; custom.value = a.custom;
      custom.placeholder = '自定义答案（替代以上选项）'; custom.setAttribute('aria-label', `${q.header}：自定义答案`); custom.maxLength = 4000;
      const next = button(i === questions.length - 1 ? '查看全部选择' : '下一题', advance);
      next.disabled = !complete(q, a);
      custom.addEventListener('input', () => {
        a.custom = custom.value; if (a.custom.trim()) a.selected = []; save();
        next.disabled = !complete(q, a);
        choices.querySelectorAll('.decision-option').forEach(node => { node.classList.remove('selected'); node.setAttribute('aria-pressed', 'false'); });
      });
      content.append(el('p', '也可以输入你自己的决定：', 'hint'), custom, next);
    }
    const controls = el('div', undefined, 'actions');
    if (draft.step > 0) controls.append(button('上一题', () => { draft.step--; save(); paint(); }, 'ghost'));
    controls.append(button('忽略问卷', () => send(true), 'ghost'));
    content.append(controls);
    if (error) { const message = el('p', error, 'error'); message.setAttribute('role', 'alert'); content.append(message); }
    if (busy) content.querySelectorAll('button').forEach(node => { node.disabled = true; });
  }
  paint();
  return root;
}
