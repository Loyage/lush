import { test, expect } from 'bun:test';
import { installDom, deepText, findByText, allByTag } from '../dom-stub.js';
import { until } from '../helpers.js';
import { createCodeView } from '../../src/ui/web/assets/code-view.js';
import { openTranscriptView, closeTranscriptView } from '../../src/ui/web/assets/transcript-view.js';
import { resetTranscriptReaders } from '../../src/ui/web/assets/transcript-reader.js';
import { transcriptCache, transcriptOpen, ui } from '../../src/ui/web/assets/state.js';
import { setPref } from '../../src/ui/web/assets/prefs.js';
import { initContextReferences } from '../../src/ui/web/assets/context-references.js';

const response = data => new Response(JSON.stringify(data));
const click = (root, text) => {
  const node = allByTag(root, 'button').find(node => node.textContent === text);
  if (!node) throw new Error(`missing button ${text}`);
  return node.onclick();
};
const changedFile = { path: 'src/reader.js', name: 'reader.js', kind: 'file', status: 'M', changed: true,
  staged: true, unstaged: true, untracked: false, conflict: false, added: 2, deleted: 1, previous_path: null };
const plainFile = { path: 'README.md', name: 'README.md', kind: 'file', status: null, changed: false };
const deletedFile = { path: 'gone.js', name: 'gone.js', kind: 'file', status: 'D', changed: true };
const hunk = { old_start: 3, old_count: 2, new_start: 3, new_count: 3, lines: [
  { kind: 'context', old_line: 3, new_line: 3, text: 'function read() {' },
  { kind: 'delete', old_line: 4, new_line: null, text: '  return old();' },
  { kind: 'add', old_line: null, new_line: 4, text: '  const value = "<script>bad()</script>";' },
  { kind: 'add', old_line: null, new_line: 5, text: '  return value;' },
  { kind: 'meta', old_line: null, new_line: null, text: '\\ No newline at end of file' },
] };
function fixture() {
  const calls = [], options = [];
  let revision = 'r1';
  const common = scope => ({ version: 1, task_id: 72, scope: scope || 'task', availability: 'available', reason: null,
    source: 'workspace', branch: 'lush/task-72', base_commit: 'aaaaaaab', head_commit: 'bbbbbbbc', sampled_at: '2026-10-01T10:00:00Z', revision, truncated: false });
  const state = scope => ({ ...common(scope), files: [changedFile, deletedFile], next: 2, has_more: false,
    summary: { files_total: 3, changed_total: 2, pending_total: 1, added: 2, deleted: 2, conflicts: 0 } });
  const file = params => {
    const path = params.get('path'), offset = Number(params.get('offset') || 0), view = params.get('view') || 'diff', side = params.get('side') || 'new';
    return { ...common(params.get('scope')), path, previous_path: null, kind: 'file', status: path === 'gone.js' ? 'D' : path === 'README.md' ? null : 'M',
      file_revision: `file-${revision}`, old: { exists: true, kind: 'file', size: 50, mode: '100644' },
      new: { exists: path !== 'gone.js', kind: 'file', size: 80, mode: '100644' }, view,
      ...(view === 'content' ? { content: { side, text: offset ? 'tail\n' : 'first\n<script>literal()</script>\n', offset, next_offset: offset ? 36 : 30, has_more: offset === 0, line_start: offset ? 3 : 1 } }
        : { diff: { hunks: [hunk], next_offset: 1, has_more: false, too_large: false, reason: null } }) };
  };
  let custom = null;
  const fetch = async (raw, opts) => {
    const url = new URL(String(raw), 'http://local'); calls.push(url); options.push(opts);
    const overridden = await custom?.(url, opts);
    if (overridden !== undefined) return overridden;
    if (url.pathname.endsWith('/code-state')) return response(state(url.searchParams.get('scope')));
    if (url.pathname.endsWith('/code-tree')) {
      const path = url.searchParams.get('path') || '', query = url.searchParams.get('query');
      return response({ ...common(url.searchParams.get('scope')), path, query, entries: query ? [changedFile]
        : path === 'src' ? [changedFile] : [{ path: 'src', name: 'src', kind: 'directory', changed: true }, plainFile, deletedFile], next: 3, has_more: false });
    }
    if (url.pathname.endsWith('/code-file')) return response(file(url.searchParams));
    if (url.pathname.endsWith('/transcript-search')) return response({ steps: [], files: ['a'], next: 0, has_more: false });
    return response({ steps: [], files: ['a'], next: 0, has_more: false, oldest: 0, has_older: false });
  };
  return { calls, options, fetch, common, state, file, setRevision(value) { revision = value; }, override(fn) { custom = fn; } };
}
function findFile(root, path) { return root.querySelectorAll('button.code-file-entry').find(node => node.dataset.path === path); }

test('code reader is opt-in and shows all files, diff/status, content paging and safe literal text', async () => {
  const f = fixture(), dom = installDom({ fetch: f.fetch }); const code = createCodeView(72); dom.document.body.append(code.root);
  try {
    expect(f.calls).toHaveLength(0);
    await code.setActive(true);
    expect(f.calls[0].pathname).toBe('/api/worker/72/code-state');
    expect(f.calls[0].searchParams.get('scope')).toBe('task');
    expect(f.calls.every(url => url.pathname.startsWith('/api/worker/72/'))).toBe(true);
    expect(findFile(code.root, 'README.md')).toBeTruthy();
    expect(deepText(code.root)).toContain('已暂存 · 未暂存');
    expect(deepText(code.root)).toContain('aaaaaaab → 当前工作区');
    const summary = code.root.querySelector('.code-summary');
    expect(summary.children.map(node => node.textContent)).toEqual(['净变化 2 文件', '未提交 1 文件', '+2 −2', '冲突 0']);
    const sampling = code.root.querySelector('.code-sample-details');
    expect(sampling.open).not.toBe(true); expect(deepText(sampling)).toContain('2026-10-01T10:00:00Z');
    expect(f.calls.filter(url => url.pathname.endsWith('/code-tree')).map(url => url.searchParams.get('path'))).toEqual(['', 'src']);
    await findFile(code.root, changedFile.path).onclick();
    expect(code.root.querySelectorAll('.code-hunk')).toHaveLength(1);
    expect(deepText(code.root)).toContain('return old();');
    expect(deepText(code.root)).toContain('No newline at end of file');
    expect(code.root.querySelector('script')).toBeNull();
    const layout = code.root.querySelector('select[aria-label="差异布局"]'); layout.value = 'unified'; layout.onchange();
    expect(code.root.querySelector('.code-file-view').dataset.layout).toBe('unified');
    await click(code.root, '展开更多上下文'); expect(f.calls.at(-1).searchParams.get('context')).toBe('20');
    await findFile(code.root, 'README.md').onclick();
    expect(f.calls.at(-1).searchParams.get('view')).toBe('content');
    expect(code.root.querySelectorAll('.code-content-segment')).toHaveLength(1);
    await click(code.root, '继续读取文件');
    expect(code.root.querySelectorAll('.code-content-segment')).toHaveLength(2);
    expect(f.calls.at(-1).searchParams.get('offset')).toBe('30');
    expect(deepText(code.root)).toContain('已到文件末尾');
    const sides = code.root.querySelector('select[aria-label="文件版本"]'); sides.value = 'old'; await sides.onchange();
    expect(f.calls.at(-1).searchParams.get('side')).toBe('old');
    expect(f.calls.at(-1).searchParams.get('offset')).toBe('0');
    expect(code.root.querySelector('.agent-call')).toBeNull();
    sampling.open = true; await code.refresh(); expect(sampling.open).toBe(true);
  } finally { code.dispose(); dom.restore(); }
});

test('polling is foreground-only and single-flight, preserves file nodes until explicit refresh, and respects preference', async () => {
  const f = fixture(), dom = installDom({ fetch: f.fetch }); const code = createCodeView(72); dom.document.body.append(code.root);
  try {
    await code.setActive(true); await findFile(code.root, changedFile.path).onclick();
    const original = code.root.querySelector('.code-hunk');
    code.root.querySelector('.code-viewport').scrollTop = 432;
    f.setRevision('r2');
    let finish;
    f.override(url => url.pathname.endsWith('/code-state') ? new Promise(resolve => { finish = resolve; }) : undefined);
    const probe = dom.intervalFor(3000); probe(); probe();
    await until(() => Boolean(finish));
    const count = f.calls.length; probe(); expect(f.calls).toHaveLength(count);
    finish(response(f.state()));
    await until(() => code.root.querySelector('.code-update-banner').hidden === false);
    expect(code.root.querySelector('.code-hunk')).toBe(original);
    expect(code.root.querySelector('.code-viewport').scrollTop).toBe(432);
    expect(f.calls.filter(url => url.pathname.endsWith('/code-file'))).toHaveLength(1);
    f.override(null); await click(code.root, '加载最新');
    expect(code.root.querySelector('.code-hunk')).not.toBe(original);
    expect(code.root.querySelector('.code-update-banner').hidden).toBe(true);
    setPref('polling', 'power'); expect(dom.intervals.at(-1).ms).toBe(10000);
    const beforeHidden = f.calls.length;
    dom.document.visibilityState = 'hidden'; await dom.fire('visibilitychange'); probe();
    expect(f.calls).toHaveLength(beforeHidden);
    dom.document.visibilityState = 'visible';
    await code.setActive(false); probe(); expect(f.calls).toHaveLength(beforeHidden);
  } finally { code.dispose(); dom.restore(); }
});

test('path search and changed filter are explicit; directory and state pagination preserve revision', async () => {
  const f = fixture(), dom = installDom({ fetch: f.fetch }); const code = createCodeView(72); dom.document.body.append(code.root);
  try {
    f.override(url => {
      if (url.pathname.endsWith('/code-state')) return response({ ...f.state(), has_more: !url.searchParams.get('after') || url.searchParams.get('after') === '0', next: 100 });
      return undefined;
    });
    await code.setActive(true);
    await click(code.root.querySelector('.code-change-group'), '加载更多文件');
    expect(f.calls.at(-1).searchParams.get('after')).toBe('100');
    const input = code.root.querySelector('input[aria-label="文件路径筛选"]'); input.value = 'reader';
    const before = f.calls.length; expect(f.calls).toHaveLength(before);
    code.root.querySelector('form').onsubmit({ preventDefault() {} });
    await until(() => f.calls.at(-1).searchParams.get('query') === 'reader');
    expect(f.calls.at(-1).searchParams.get('revision')).toBe('r1');
    await until(() => code.root.querySelector('.code-tree-entries').querySelector('button.code-file-entry'));
    const checkbox = code.root.querySelectorAll('input').find(node => node.type === 'checkbox'); checkbox.checked = true; await checkbox.onchange();
    expect(f.calls.at(-1).searchParams.get('changed')).toBe('true');
    expect(deepText(code.root)).toContain('路径匹配结果');
  } finally { code.dispose(); dom.restore(); }
});

test('stale pagination never appends a different file revision and errors retry without losing old text', async () => {
  const f = fixture(), dom = installDom({ fetch: f.fetch }); const code = createCodeView(72); dom.document.body.append(code.root);
  try {
    await code.setActive(true); await findFile(code.root, 'README.md').onclick();
    const original = code.root.querySelector('.code-content-segment');
    f.override(url => url.pathname.endsWith('/code-file') && url.searchParams.get('offset') === '30'
      ? response({ ...f.file(url.searchParams), file_revision: 'changed-under-read' }) : undefined);
    await click(code.root, '继续读取文件');
    expect(code.root.querySelectorAll('.code-content-segment')).toHaveLength(1);
    expect(code.root.querySelector('.code-content-segment')).toBe(original);
    expect(deepText(code.root)).toContain('保留当前正文');
    f.override(url => url.pathname.endsWith('/code-file') ? new Response(JSON.stringify({ error: 'offline' }), { status: 500 }) : undefined);
    await click(code.root, '加载最新'); expect(deepText(code.root)).toContain('offline');
    f.override(null); await click(code.root, '重试读取文件');
    expect(code.root.querySelector('.code-content-segment')).not.toBe(original);
  } finally { code.dispose(); dom.restore(); }
});

test('archive, unavailable, deleted and oversized differences are explicit rather than empty success', async () => {
  const f = fixture(), dom = installDom({ fetch: f.fetch }); const code = createCodeView(72); dom.document.body.append(code.root);
  try {
    f.override(url => url.pathname.endsWith('/code-state') ? response({ ...f.state(), source: 'commit', reason: '现场已归档，只读原始提交。', truncated: true }) : undefined);
    await code.setActive(true); expect(deepText(code.root)).toContain('已提交版本'); expect(deepText(code.root)).toContain('范围不完整');
    await findFile(code.root, 'gone.js').onclick(); await click(code.root, '文件内容');
    const side = code.root.querySelector('select[aria-label="文件版本"]'); side.value = 'new'; await side.onchange();
    expect(deepText(code.root)).toContain('当前版本不存在，不是空文件');
    f.override(url => url.pathname.endsWith('/code-file') ? response({ ...f.file(url.searchParams), diff: { hunks: [], too_large: true, reason: '差异过大', has_more: false, next_offset: 0 } }) : undefined);
    await findFile(code.root, changedFile.path).onclick(); expect(deepText(code.root)).toContain('差异过大'); expect(findByText(code.root, '查看文件内容')).toBeTruthy();
    f.override(url => url.pathname.endsWith('/code-state') ? response({ ...f.state(), availability: 'unavailable', source: 'none', reason: '原始 Git 对象已回收', files: [] }) : undefined);
    await code.refresh(); expect(deepText(code.root)).toContain('原始 Git 对象已回收');
  } finally { code.dispose(); dom.restore(); }
});

test('explicitly collapsed changed directories stay collapsed across refresh and tab return', async () => {
  const f = fixture(), dom = installDom({ fetch: f.fetch }); const code = createCodeView(72); dom.document.body.append(code.root);
  const directory = () => code.root.querySelector('button.code-directory-toggle');
  const childReads = () => f.calls.filter(url => url.pathname.endsWith('/code-tree') && url.searchParams.get('path') === 'src').length;
  try {
    await code.setActive(true); expect(directory().getAttribute('aria-expanded')).toBe('true');
    await directory().onclick(); expect(directory().getAttribute('aria-expanded')).toBe('false');
    const reads = childReads(); await code.refresh();
    expect(directory().getAttribute('aria-expanded')).toBe('false'); expect(childReads()).toBe(reads);
    await code.setActive(false); await code.setActive(true);
    expect(directory().getAttribute('aria-expanded')).toBe('false'); expect(childReads()).toBe(reads);
    await directory().onclick(); expect(directory().getAttribute('aria-expanded')).toBe('true');
    await code.refresh(); expect(directory().getAttribute('aria-expanded')).toBe('true'); expect(childReads()).toBe(reads + 2);
  } finally { code.dispose(); dom.restore(); }
});

test('empty content envelopes for binary and over-limit files do not claim empty text or EOF', async () => {
  const f = fixture(), dom = installDom({ fetch: f.fetch }); const code = createCodeView(72); dom.document.body.append(code.root);
  let mode = 'binary';
  try {
    f.override(url => {
      if (!url.pathname.endsWith('/code-file')) return undefined;
      const oldSide = url.searchParams.get('side') === 'old';
      return response({ ...f.file(url.searchParams), kind: mode === 'binary' ? 'binary' : 'file',
        reason: oldSide || mode === 'empty' ? null : mode === 'binary' ? '二进制或非 UTF-8 文件仅显示元信息' : '文件超过 8 MiB 安全读取上限',
        truncated: !oldSide && mode === 'large',
        old: { exists: true, kind: 'file', size: 8, mode: '100644' },
        new: { exists: true, kind: mode === 'binary' ? 'binary' : 'file', size: mode === 'empty' ? 0 : mode === 'large' ? 9 * 1024 * 1024 : 40, mode: '100644' },
        content: { side: oldSide ? 'old' : 'new', text: oldSide ? 'old text' : '', offset: 0, next_offset: oldSide ? 8 : 0, has_more: false, line_start: 1 } });
    });
    await code.setActive(true); await findFile(code.root, 'README.md').onclick();
    expect(deepText(code.root)).toContain('二进制或非 UTF-8'); expect(code.root.querySelector('.code-content-segment')).toBeNull();
    expect(deepText(code.root)).not.toContain('此段为空'); expect(deepText(code.root)).not.toContain('已到文件末尾');
    const side = code.root.querySelector('select[aria-label="文件版本"]'); side.value = 'old'; await side.onchange();
    expect(deepText(code.root)).toContain('old text'); expect(deepText(code.root)).toContain('已到文件末尾');
    mode = 'large'; side.value = 'new'; await side.onchange();
    expect(deepText(code.root)).toContain('超过 8 MiB'); expect(code.root.querySelector('.code-content-segment')).toBeNull();
    expect(deepText(code.root)).not.toContain('此段为空'); expect(deepText(code.root)).not.toContain('已到文件末尾');
    mode = 'empty'; await side.onchange();
    expect(deepText(code.root)).toContain('此段为空'); expect(deepText(code.root)).toContain('已到文件末尾');
  } finally { code.dispose(); dom.restore(); }
});

test('missing baseline never labels an empty change list as no changes', async () => {
  const f = fixture(), dom = installDom({ fetch: f.fetch }); const code = createCodeView(72); dom.document.body.append(code.root);
  try {
    f.override(url => url.pathname.endsWith('/code-state') ? response({ ...f.state(), base_commit: null,
      reason: '基线对象不可用；只能查看当前文件，不能计算净差异', files: [],
      summary: { changed_total: null, pending_total: 0, added: null, deleted: null, conflicts: 0 } }) : undefined);
    await code.setActive(true);
    expect(deepText(code.root.querySelector('.code-change-group'))).toContain('无法判断净变化');
    expect(deepText(code.root.querySelector('.code-change-group'))).not.toContain('没有净改动');
    expect(findFile(code.root, 'README.md')).toBeTruthy();
  } finally { code.dispose(); dom.restore(); }
});

test('line_continued joins long source lines without extra newline or duplicate line number', async () => {
  const f = fixture(), dom = installDom({ fetch: f.fetch }); const code = createCodeView(72); dom.document.body.append(code.root);
  try {
    f.override(url => {
      if (!url.pathname.endsWith('/code-file')) return undefined;
      const offset = Number(url.searchParams.get('offset'));
      const content = offset === 0 ? { text: 'first\npar', offset: 0, next_offset: 9, line_start: 1, has_more: true }
        : offset === 9 ? { text: 'tial\nsec', offset: 9, next_offset: 17, line_start: 2, line_continued: true, has_more: true }
          : { text: 'ond', offset: 17, next_offset: 20, line_start: 3, line_continued: true, has_more: false };
      return response({ ...f.file(url.searchParams), content: { side: 'new', ...content } });
    });
    await code.setActive(true); await findFile(code.root, 'README.md').onclick();
    const firstLine = code.root.querySelector('.code-content-line');
    await click(code.root, '继续读取文件'); await click(code.root, '继续读取文件');
    const rows = code.root.querySelectorAll('.code-content-line');
    expect(rows).toHaveLength(3); expect(rows[0]).toBe(firstLine);
    expect(rows.map(row => row.querySelector('.code-line-number').textContent)).toEqual(['1', '2', '3']);
    expect(rows.map(row => row.querySelector('.code-line-text').codeSourceText)).toEqual(['first\n', 'partial\n', 'second']);
    expect(rows.map(row => row.querySelector('.code-line-text').codeSourceText).join('')).toBe('first\npartial\nsecond');
    expect(code.root.querySelectorAll('.code-content-segment')).toHaveLength(2);
    expect(code.root.querySelectorAll('.code-content-segment').map(node => node.codeContent.text).join('')).toBe('first\npartial\nsecond');
  } finally { code.dispose(); dom.restore(); }
});

test('inconsistent continued line offsets are rejected before changing already read text', async () => {
  const f = fixture(), dom = installDom({ fetch: f.fetch }); const code = createCodeView(72); dom.document.body.append(code.root);
  try {
    f.override(url => {
      if (!url.pathname.endsWith('/code-file')) return undefined;
      const more = Number(url.searchParams.get('offset')) > 0;
      return response({ ...f.file(url.searchParams), content: { side: 'new', text: more ? 'bad' : 'part',
        offset: more ? 5 : 0, next_offset: more ? 8 : 4, line_start: 1, line_continued: more, has_more: !more } });
    });
    await code.setActive(true); await findFile(code.root, 'README.md').onclick(); await click(code.root, '继续读取文件');
    expect(code.root.querySelector('.code-line-text').codeSourceText).toBe('part');
    expect(deepText(code.root)).toContain('续行位置与已读取正文不一致');
    expect(code.root.querySelectorAll('.code-content-line')).toHaveLength(1);
  } finally { code.dispose(); dom.restore(); }
});

test('truncated empty lists and content never claim complete absence or end of file', async () => {
  const f = fixture(), dom = installDom({ fetch: f.fetch }); const code = createCodeView(72); dom.document.body.append(code.root);
  try {
    await code.setActive(true);
    f.override(url => url.pathname.endsWith('/code-file') ? response({ ...f.file(url.searchParams), truncated: true,
      content: { side: 'new', text: 'partial', offset: 0, next_offset: 7, has_more: false, line_start: 1 } }) : undefined);
    await findFile(code.root, 'README.md').onclick();
    expect(deepText(code.root)).toContain('无法确认文件末尾'); expect(deepText(code.root)).not.toContain('已到文件末尾');
    f.override(url => url.pathname.endsWith('/code-tree') ? response({ ...f.common(), truncated: true, entries: [], next: 0, has_more: false }) : undefined);
    const query = code.root.querySelector('input[aria-label="文件路径筛选"]'); query.value = 'unread';
    code.root.querySelector('form').onsubmit({ preventDefault() {} });
    await until(() => deepText(code.root).includes('本页未获得可显示文件'));
    expect(deepText(code.root)).not.toContain('没有匹配路径');
  } finally { code.dispose(); dom.restore(); }
});

test('deactivation aborts requests and obsolete file/scope responses never repaint', async () => {
  const f = fixture(), dom = installDom({ fetch: f.fetch }); const code = createCodeView(72); dom.document.body.append(code.root);
  try {
    await code.setActive(true);
    let finish, signal;
    f.override((url, options) => url.pathname.endsWith('/code-file') ? new Promise(resolve => { finish = () => resolve(response(f.file(url.searchParams))); signal = options.signal; }) : undefined);
    const pending = findFile(code.root, changedFile.path).onclick(); await until(() => Boolean(finish));
    await code.setActive(false); expect(signal.aborted).toBe(true);
    finish(); await pending; expect(code.root.querySelector('.code-hunk')).toBeNull();
    f.override(null); await code.setActive(true); expect(code.root.querySelector('.code-hunk')).toBeTruthy();
    const scope = code.root.querySelector('select[aria-label="代码比较范围"]'); scope.value = 'working'; await scope.onchange();
    expect(f.calls.filter(url => url.pathname.endsWith('/code-file')).at(-1).searchParams.get('scope')).toBe('working');
    code.dispose(); const before = f.calls.length; dom.intervalFor(3000)(); expect(f.calls).toHaveLength(before);
  } finally { code.dispose(); dom.restore(); }
});

test('scope changes cannot be overwritten by an earlier state sample and unusual paths are sent literally', async () => {
  const f = fixture(), dom = installDom({ fetch: f.fetch }); const code = createCodeView(72); dom.document.body.append(code.root);
  let finish;
  try {
    f.override(url => {
      if (url.pathname.endsWith('/code-state') && url.searchParams.get('scope') === 'task') return new Promise(resolve => { finish = () => resolve(response({ ...f.state(), branch: 'OBSOLETE' })); });
      if (url.pathname.endsWith('/code-tree')) return response({ ...f.common('working'), entries: [{ ...plainFile, path: 'space #?\tfile.js', name: 'space #?\tfile.js' }], has_more: false, next: 1 });
      return undefined;
    });
    const opening = code.setActive(true); await until(() => Boolean(finish));
    const scope = code.root.querySelector('select[aria-label="代码比较范围"]'); scope.value = 'working'; await scope.onchange();
    finish(); await opening;
    expect(deepText(code.root)).not.toContain('OBSOLETE');
    await findFile(code.root, 'space #?\tfile.js').onclick();
    expect(f.calls.at(-1).searchParams.get('path')).toBe('space #?\tfile.js');
    expect(f.calls.at(-1).searchParams.get('scope')).toBe('working');
  } finally { code.dispose(); dom.restore(); }
});

test('code selections keep bounded path, version and sampling provenance as text references', async () => {
  const f = fixture(), dom = installDom({ fetch: f.fetch }); const code = createCodeView(72); dom.document.body.append(code.root);
  const previousReferences = ui.composerReferences; ui.composerReferences = [];
  try {
    initContextReferences(); await code.setActive(true); await findFile(code.root, 'README.md').onclick();
    dom.setSelection('literal()');
    await dom.fire('contextmenu', { target: code.root.querySelector('.code-line-text'), clientX: 1, clientY: 1, preventDefault() {} });
    const choice = allByTag(dom.node('context-menu'), 'button').find(node => node.textContent.includes('所选文字'));
    expect(choice).toBeTruthy(); await choice.onclick();
    const reference = ui.composerReferences.at(-1);
    expect(reference.kind).toBe('text'); expect(reference.target).toEqual({}); expect(reference.quote).toBe('literal()');
    expect(reference.location.path).toBe('README.md'); expect(reference.location.section).toContain('工作区'); expect(reference.location.section).toContain('2026-10-01');
    expect(reference.label).toContain('README.md');
  } finally { ui.composerReferences = previousReferences; code.dispose(); dom.restore(); }
});

test('a clean refresh clears obsolete dirty badges and special files remain metadata, not executable previews', async () => {
  const f = fixture(), dom = installDom({ fetch: f.fetch }); const code = createCodeView(72); dom.document.body.append(code.root);
  try {
    await code.setActive(true); await findFile(code.root, changedFile.path).onclick();
    expect(deepText(code.root.querySelector('.code-file-heading'))).toContain('已暂存');
    f.override(url => {
      if (url.pathname.endsWith('/code-state')) return response({ ...f.state(), files: [], summary: { changed_total: 0, pending_total: 0 } });
      if (url.pathname.endsWith('/code-file')) return response({ ...f.file(url.searchParams), kind: 'symlink', status: 'T',
        old: { exists: true, kind: 'file', size: 5, mode: '100644' }, new: { exists: true, kind: 'symlink', size: 5, mode: '120000' },
        diff: { hunks: [], has_more: false, next_offset: 0, too_large: false } });
      return undefined;
    });
    await code.refresh();
    expect(deepText(code.root.querySelector('.code-file-heading'))).not.toContain('已暂存');
    expect(deepText(code.root)).toContain('符号链接'); expect(deepText(code.root)).toContain('模式 120000');
    expect(deepText(code.root)).toContain('不展示普通文本差异');
  } finally { code.dispose(); dom.restore(); }
});

test('execution tabs retain transcript and code scroll/content, stop hidden transcript reads, and path search resets filters', async () => {
  const f = fixture(), dom = installDom({ fetch: f.fetch }); const id = 1072; ui.selected = id;
  transcriptCache.set(id, { order: 'desc', steps: [{ seq: 1, kind: 'text', body: 'original record', file: 'a' }], files: ['a'], next: 1, oldest: 1 });
  try {
    await openTranscriptView(id);
    const panel = dom.document.body.querySelector('.transcript-dialog');
    expect(f.calls).toHaveLength(0);
    const transcript = panel.querySelector('.transcript-viewport'); transcript.scrollTop = 240;
    await click(panel, '代码与改动');
    expect(transcriptOpen.has(id)).toBe(false); expect(panel.querySelector('.transcript-layout').hidden).toBe(true);
    await findFile(panel, changedFile.path).onclick();
    const original = panel.querySelector('.code-hunk'), viewport = panel.querySelector('.code-viewport'); viewport.scrollTop = 315;
    await click(panel, '执行记录'); expect(transcriptOpen.has(id)).toBe(true); expect(transcript.scrollTop).toBe(240);
    const filterTool = panel.querySelectorAll('input').find(node => node.getAttribute('aria-label') === '工具名'); filterTool.value = 'bash';
    await click(panel, '代码与改动'); expect(panel.querySelector('.code-hunk')).toBe(original); expect(viewport.scrollTop).toBe(315);
    await click(panel, '在执行记录中搜索此路径');
    const search = f.calls.find(url => url.pathname.endsWith('/transcript-search'));
    expect(search.searchParams.get('query')).toBe(changedFile.path); expect(search.searchParams.get('tool')).toBe('');
    expect(ui.transcriptView.mode).toBe('transcript'); expect(ui.transcriptView.searchOpen).toBe(true);
    await click(panel, '代码与改动');
    panel.onkeydown({ key: 'F', ctrlKey: true, shiftKey: true, preventDefault() {} });
    expect(ui.transcriptView.mode).toBe('transcript'); expect(dom.document.activeElement.type).toBe('search');
  } finally { closeTranscriptView(); transcriptCache.delete(id); resetTranscriptReaders(); ui.selected = null; dom.restore(); }
});
