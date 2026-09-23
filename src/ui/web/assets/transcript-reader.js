import { el, button } from './dom.js';
import { api } from './api.js';
import { STEP } from './format.js';
import { referenceable } from './context-references.js';
import { structuredValue } from './structured-value.js';
import { stepSummary } from './transcript-model.js';
import { explanationHistory } from './explanations.js';

const readers = new Map();
export function resetTranscriptReaders() {
  for (const state of readers.values()) { state.version++; state.readVersion++; }
  readers.clear();
}
function sourceNode(taskId, step) {
  const node = el('section', undefined, 'original-step');
  node.append(el('h4', `#${step.seq} · ${STEP[step.kind] || step.kind} · ${step.title}`),
    el('p', `${step.file}:${step.line}${step.body_truncated ? ' · 摘要已截断' : ''}`, 'hint'), structuredValue(step.body));
  referenceable(node, { kind: 'transcript_step', target: { task_id: taskId, seq: step.seq }, label: `执行步骤 #${taskId}:${step.seq}`,
    quote: step.body, location: { task_id: taskId, section: 'transcript' } });
  return node;
}

export async function openTranscriptStep(taskId, seq) {
  const state = readerState(taskId), version = ++state.readVersion;
  state.root.open = true;
  state.viewer.replaceChildren(el('p', '正在读取原文与关联记录…', 'hint'));
  try {
    const data = await api(`/api/task/${taskId}/transcript-step?seq=${seq}`);
    if (version !== state.readVersion) return;
    state.viewer.replaceChildren(el('h3', '步骤原文与上下文'));
    const main = sourceNode(taskId, data.step); state.viewer.append(main);
    if (data.pairing_ambiguous) state.viewer.append(el('p', '调用 ID 重复，无法可靠配对；未合并输入输出。', 'hint'));
    if (data.related_truncated) state.viewer.append(el('p', '关联输出超过 8 条，仅展示前 8 条；其余可全文检索。', 'hint'));
    if (data.has_more) {
      let offset = data.next_offset;
      const more = button('继续读取原文', async () => {
        more.disabled = true;
        try {
          const page = await api(`/api/task/${taskId}/transcript-step?seq=${seq}&offset=${offset}`);
          if (version !== state.readVersion) return;
          // Do not join arbitrarily large output into one DOM text or pretend partial JSON is complete.
          main.append(el('pre', page.step.body, 'raw-value')); offset = page.next_offset;
          if (!page.has_more) more.remove();
        } catch (error) { if (version === state.readVersion) main.append(el('p', error.message, 'error')); }
        finally { more.disabled = false; }
      }, 'ghost');
      main.append(el('p', `原文共 ${data.step.body_length} 字符，按段读取。`, 'hint'), more);
    }
    for (const [label, entries] of [['配对输入／输出', data.related], ['前后上下文', data.context]]) {
      if (!entries.length) continue;
      state.viewer.append(el('h4', label));
      for (const step of entries) {
        const node = sourceNode(taskId, step);
        node.append(button('读取此步骤完整原文', () => openTranscriptStep(taskId, step.seq), 'ghost')); state.viewer.append(node);
      }
    }
    state.viewer.scrollIntoView?.({ block: 'nearest' });
  } catch (error) { if (version === state.readVersion) state.viewer.replaceChildren(el('p', error.message, 'error')); }
}

function readerState(taskId) {
  if (readers.has(taskId)) return readers.get(taskId);
  const root = el('details', undefined, 'transcript-reader');
  root.append(el('summary', '翻找完整记录 / 原文 / 解释历史'));
  const form = el('form', undefined, 'transcript-search');
  const query = el('input'); query.placeholder = '全文关键词（包含未加载记录）'; query.setAttribute('aria-label', '执行记录全文关键词'); query.maxLength = 500;
  const kind = el('select'); kind.setAttribute('aria-label', '消息类型');
  for (const [value, label] of [['', '所有类型'], ...Object.entries(STEP)]) { const option = el('option', label); option.value = value; kind.append(option); }
  const tool = el('input'); tool.placeholder = '工具名，例如 bash'; tool.setAttribute('aria-label', '工具名'); tool.maxLength = 100;
  const errors = el('input'); errors.type = 'checkbox'; const errorLabel = el('label', '只看失败'); errorLabel.prepend(errors);
  const submit = button('搜索完整记录', () => {}, 'ghost'); submit.type = 'submit';
  form.append(query, kind, tool, errorLabel, submit, button('解释历史', () => explanationHistory(taskId), 'ghost'));
  const results = el('div'), viewer = el('div', undefined, 'transcript-original');
  root.append(form, results, viewer);
  const state = { root, viewer, version: 0, readVersion: 0 }; readers.set(taskId, state);
  let criteria = null, cursors = [0], pageIndex = 0;
  const search = async after => {
    const version = ++state.version;
    submit.disabled = true; results.replaceChildren(el('p', '正在跨会话搜索完整记录…', 'hint'));
    try {
      const params = new URLSearchParams({ ...criteria, after });
      const data = await api(`/api/task/${taskId}/transcript-search?${params}`);
      if (version !== state.version) return;
      results.replaceChildren(el('p', `第 ${pageIndex + 1} 页 · ${data.steps.length} 条${data.has_more ? ' · 还有更多' : ''} · 范围：当前任务所有完整会话记录`, 'hint'));
      if (!data.files.length) results.append(el('p', '没有可读取的会话文件，可能已被清理或后端未记录执行过程。', 'hint'));
      else if (!data.steps.length) results.append(el('p', '没有命中。未写完的记录不参与检索。', 'hint'));
      for (const step of data.steps) {
        const row = el('div', undefined, 'search-hit');
        row.append(button(`#${step.seq} · ${STEP[step.kind] || step.kind} · ${stepSummary(step)}`, () => openTranscriptStep(taskId, step.seq), 'ghost'));
        const excerpt = el('p');
        const text = step.excerpt || '', needle = criteria.query, at = needle ? text.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase()) : -1;
        if (at < 0) excerpt.textContent = text;
        else excerpt.append(el('span', text.slice(0, at)), el('mark', text.slice(at, at + needle.length)), el('span', text.slice(at + needle.length)));
        row.append(excerpt); results.append(row);
      }
      const actions = el('div', undefined, 'actions');
      if (pageIndex) actions.append(button('上一页', () => { pageIndex--; void search(cursors[pageIndex]); }, 'ghost'));
      if (data.has_more) actions.append(button('下一页', () => { cursors[++pageIndex] = data.next; void search(data.next); }, 'ghost'));
      results.append(actions);
    } catch (error) { if (version === state.version) results.replaceChildren(el('p', `搜索未完成：${error.message}`, 'error')); }
    finally { if (version === state.version) submit.disabled = false; }
  };
  form.onsubmit = event => {
    event.preventDefault(); criteria = { query: query.value.trim(), kind: kind.value, tool: tool.value.trim(), errors: String(errors.checked) };
    cursors = [0]; pageIndex = 0; void search(0);
  };
  return state;
}
export function transcriptReader(taskId) { return readerState(taskId).root; }
