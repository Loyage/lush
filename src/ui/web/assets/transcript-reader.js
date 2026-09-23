import { el, button } from './dom.js';
import { api } from './api.js';
import { STEP } from './format.js';
import { openTranscriptTerminal } from './transcript-terminal.js';
import { stepSummary } from './transcript-model.js';
import { explanationHistory } from './explanations.js';

const readers = new Map();
export function resetTranscriptReaders() {
  for (const state of readers.values()) state.version++;
  readers.clear();
}
// Compatibility entry point: search hits and clipped quick-view steps share one continuous reader.
export function openTranscriptStep(taskId, seq) { return openTranscriptTerminal(taskId, seq); }

function readerState(taskId) {
  if (readers.has(taskId)) return readers.get(taskId);
  const root = el('section', undefined, 'transcript-reader');
  root.setAttribute('aria-label', '执行记录全文查找');
  const form = el('form', undefined, 'transcript-search');
  const query = el('input'); query.placeholder = '全文关键词（包含未加载记录）'; query.setAttribute('aria-label', '执行记录全文关键词'); query.maxLength = 500;
  const kind = el('select'); kind.setAttribute('aria-label', '消息类型');
  for (const [value, label] of [['', '所有类型'], ...Object.entries(STEP)]) { const option = el('option', label); option.value = value; kind.append(option); }
  const tool = el('input'); tool.placeholder = '工具名，例如 bash'; tool.setAttribute('aria-label', '工具名'); tool.maxLength = 100;
  const errors = el('input'); errors.type = 'checkbox'; const errorLabel = el('label', '只看失败'); errorLabel.prepend(errors);
  const submit = button('搜索完整记录', () => {}, 'ghost'); submit.type = 'submit';
  form.append(query, kind, tool, errorLabel, submit, button('解释历史', () => explanationHistory(taskId), 'ghost'));
  const results = el('div');
  root.append(form, results);
  const state = { root, version: 0 }; readers.set(taskId, state);
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
