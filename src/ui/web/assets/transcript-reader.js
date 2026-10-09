import { el, button } from './dom.js';
import { api } from './api.js';
import { STEP } from './format.js';
import { ui } from './state.js';

const readers = new Map();
export function releaseTranscriptReader(taskId) {
  const state = readers.get(taskId);
  if (state) state.version++;
  readers.delete(taskId);
}
export function pauseTranscriptReader(taskId) {
  const state = readers.get(taskId);
  if (!state) return;
  state.version++;
  state.pause?.();
}
export function searchTranscriptPath(taskId, path) {
  return readerState(taskId).searchPath(String(path));
}
export function resetTranscriptReaders() {
  for (const state of readers.values()) state.version++;
  readers.clear();
}
// Exact raw text is loaded in bounded segments, alongside the rich step rather than in a second mode.
export async function openTranscriptStep(taskId, seq, { root: scopedRoot } = {}) {
  const root = scopedRoot || (ui.transcriptView?.taskId === taskId ? ui.transcriptView.holder : document.getElementById('detail'));
  const target = root?.querySelector(`[data-result-seq="${seq}"]`) || root?.querySelector(`[data-seq="${seq}"]`);
  if (!target) {
    const { openTranscriptView } = await import('./transcript-view.js');
    return openTranscriptView(taskId, seq);
  }
  let raw = target.querySelector('.transcript-full-original');
  if (raw) { raw.open = true; raw.hidden = false; raw.scrollIntoView?.({ block: 'nearest' }); return; }
  raw = el('details', undefined, 'transcript-full-original'); raw.open = true;
  raw.append(el('summary', `完整原文 · #${seq}`));
  const content = el('div'), status = el('p', '', 'hint');
  let offset = 0;
  const more = button('继续读取原文', load, 'ghost');
  raw.append(content, status, more); target.append(raw);
  async function load() {
    more.disabled = true;
    try {
      const data = await api(`/api/worker/${taskId}/transcript-step?seq=${seq}&offset=${offset}`);
      if (!data.step) throw new Error('步骤不存在，记录可能已被清理');
      content.append(el('pre', data.step.body, 'raw-value'));
      offset = data.next_offset; more.hidden = !data.has_more;
      status.textContent = data.has_more ? '原文分段读取，后面还有内容。' : '已读取完整原文。';
    } catch (error) { status.textContent = `读取未完成：${error.message}`; more.textContent = '重试读取原文'; }
    finally { more.disabled = false; }
  }
  await load();
}

function readerState(taskId) {
  if (readers.has(taskId)) return readers.get(taskId);
  const root = el('section', undefined, 'transcript-reader');
  root.setAttribute('aria-label', '执行记录全文查找');
  const form = el('form', undefined, 'transcript-search');
  const query = el('input'); query.type = 'search'; query.placeholder = '搜索完整执行记录'; query.setAttribute('aria-label', '执行记录全文关键词'); query.maxLength = 500;
  const kind = el('select'); kind.setAttribute('aria-label', '消息类型');
  for (const [value, label] of [['', '所有类型'], ...Object.entries(STEP)]) { const option = el('option', label); option.value = value; kind.append(option); }
  const tool = el('input'); tool.placeholder = '工具名，例如 bash'; tool.setAttribute('aria-label', '工具名'); tool.maxLength = 100;
  const errors = el('input'); errors.type = 'checkbox'; const errorLabel = el('label', '只看失败'); errorLabel.prepend(errors);
  // Keep submission native; button() temporarily disables itself in onclick.
  const submit = el('button', '搜索', 'ghost'); submit.type = 'submit';
  const queryRow = el('div', undefined, 'transcript-query-row'); queryRow.append(query, submit);
  const filters = el('div', undefined, 'transcript-search-filters'); filters.append(kind, tool, errorLabel);
  const hint = el('p', 'Enter 搜索 · Ctrl/⌘+Shift+F 聚焦搜索框；包含未加载记录。', 'hint transcript-search-hint');
  form.append(queryRow, filters, hint);
  const results = el('div', undefined, 'transcript-search-results'); results.setAttribute('aria-label', '搜索命中摘要');
  root.append(form, results);
  // locate 由 render-transcript.js 注入，让命中停在富文本执行过程里。
  const state = { root, version: 0, locate: null, onPage: null, onStart: null, onError: null, onClear: null }; readers.set(taskId, state);
  const clear = button('返回全部记录', () => {
    state.version++; submit.disabled = false; root.setAttribute('aria-busy', 'false'); results.replaceChildren();
    query.value = ''; kind.value = ''; tool.value = ''; errors.checked = false;
    state.onClear?.();
  }, 'ghost');
  clear.hidden = true; root.append(clear); state.clear = clear;
  let criteria = null, cursors = [0], pageIndex = 0;
  let searching = false;
  state.pause = () => {
    submit.disabled = false; root.setAttribute('aria-busy', 'false');
    if (searching) {
      searching = false;
      results.replaceChildren(el('p', '搜索读取已暂停；回到此视图后可重新搜索。', 'hint'));
      state.onError?.(new Error('已暂停读取；请重新搜索以继续'));
    }
  };
  const search = async after => {
    const version = ++state.version; searching = true;
    root.setAttribute('aria-busy', 'true');
    submit.disabled = true; state.onStart?.(); results.replaceChildren(el('p', '正在跨会话搜索完整记录…', 'hint'));
    try {
      const params = new URLSearchParams({ ...criteria, after });
      const data = await api(`/api/worker/${taskId}/transcript-search?${params}`);
      if (version !== state.version) return;
      results.replaceChildren(el('p', `第 ${pageIndex + 1} 页 · ${data.steps.length} 条${data.has_more ? ' · 还有更多' : ''} · 范围：当前 Worker 所有完整会话记录`, 'hint'));
      if (!data.files.length) results.append(el('p', '没有可读取的会话文件，可能已被清理或后端未记录执行过程。', 'hint'));
      else if (!data.steps.length) results.append(el('p', '没有命中。未写完的记录不参与检索。', 'hint'));
      for (const step of data.steps) {
        const row = el('div', undefined, 'search-hit'); row.dataset.hitSeq = String(step.seq);
        const type = STEP[step.kind] || step.kind;
        const name = step.tool_name || step.title;
        const heading = [`#${step.seq}`, type, name && name !== type ? name : '', step.is_error ? '失败' : ''].filter(Boolean).join(' · ');
        row.append(button(heading, () => (state.locate || openTranscriptStep)(taskId, step.seq), 'ghost'));
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
      await state.onPage?.(data, () => version === state.version);
    } catch (error) { if (version === state.version) {
      results.replaceChildren(el('p', `搜索未完成：${error.message}`, 'error'));
      state.onError?.(error);
    } }
    finally { if (version === state.version) { searching = false; submit.disabled = false; root.setAttribute('aria-busy', 'false'); } }
  };
  state.searchPath = path => {
    query.value = path; kind.value = ''; tool.value = ''; errors.checked = false;
    criteria = { query: path, kind: '', tool: '', errors: 'false' };
    cursors = [0]; pageIndex = 0;
    return search(0);
  };
  form.onsubmit = event => {
    event.preventDefault(); criteria = { query: query.value.trim(), kind: kind.value, tool: tool.value.trim(), errors: String(errors.checked) };
    cursors = [0]; pageIndex = 0; void search(0);
  };
  return state;
}
export function transcriptReader(taskId, { locate, onPage, onStart, onError, onClear } = {}) {
  const state = readerState(taskId);
  if (typeof locate === 'function') state.locate = locate;
  Object.assign(state, { onPage, onStart, onError, onClear });
  state.clear.hidden = !onClear;
  return state.root;
}
