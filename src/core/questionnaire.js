import { check, isPlainObject } from './types.js';

function object(value, keys, name) {
  check(isPlainObject(value) && Object.keys(value).every(key => keys.includes(key)), `invalid ${name} fields`);
}
function string(value, max, name, empty = false) {
  check(typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0), `invalid ${name} (max ${max} characters)`);
  return value;
}

/** Versioned envelope in the existing notice.body; no schema migration. */
export function questionnaire(body, questions) {
  string(body, 8000, 'body', true);
  check(Array.isArray(questions) && questions.length >= 1 && questions.length <= 4, 'questions must contain 1-4 questions');
  const normalized = questions.map(q => {
    object(q, ['question', 'header', 'options', 'multiSelect'], 'question');
    string(q.question, 2000, 'question'); string(q.header, 16, 'header');
    check(q.multiSelect === undefined || typeof q.multiSelect === 'boolean', 'multiSelect must be boolean');
    check(Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 4, 'each question needs 2-4 options');
    const labels = new Set();
    const options = q.options.map(o => {
      object(o, ['label', 'description', 'preview', 'previewHtml'], 'option');
      const label = string(o.label, 60, 'label').trim();
      check(!/^(other|type something\.?|其他|其它|自定义答案)$/i.test(label), 'custom answer is supplied by the UI; do not add an Other option');
      check(!labels.has(label), 'duplicate option label'); labels.add(label);
      string(o.description, 2000, 'description');
      if (o.preview !== undefined) string(o.preview, 12000, 'preview');
      if (o.previewHtml !== undefined) string(o.previewHtml, 16000, 'previewHtml');
      return { label, description: o.description, ...(o.preview !== undefined ? { preview: o.preview } : {}),
        ...(o.previewHtml !== undefined ? { previewHtml: o.previewHtml } : {}) };
    });
    return { question: q.question, header: q.header, multiSelect: q.multiSelect ?? false, options };
  });
  const result = JSON.stringify({ version: 1, body, questions: normalized });
  check(Buffer.byteLength(result) <= 64000, 'questionnaire exceeds 64000 bytes');
  return result;
}

/** Never trust labels or question text supplied by the answering client. */
export function questionnaireAnswer(body, answer) {
  const form = JSON.parse(body);
  object(answer, ['answers'], 'answer');
  check(Array.isArray(answer.answers) && answer.answers.length === form.questions.length, 'answer every question exactly once');
  const answers = form.questions.map((q, index) => {
    const a = answer.answers[index];
    object(a, ['selected', 'custom'], 'answer');
    check(Array.isArray(a.selected), 'selected must be an array');
    check(a.selected.every(i => Number.isInteger(i) && i >= 0 && i < q.options.length), 'invalid option index');
    check(new Set(a.selected).size === a.selected.length, 'duplicate selection');
    if (a.custom !== undefined) string(a.custom, 4000, 'custom', true);
    const custom = (a.custom ?? '').trim();
    check(custom ? a.selected.length === 0 : a.selected.length >= 1 && (q.multiSelect || a.selected.length === 1),
      'choose valid options or supply one custom answer');
    const selected = [...a.selected].sort((a, b) => a - b);
    return { question: q.question, header: q.header, selected,
      labels: selected.map(i => q.options[i].label), custom };
  });
  return { version: 1, answers };
}
