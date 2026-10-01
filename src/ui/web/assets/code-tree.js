import { el, button } from './dom.js';

export function fileStatusText(entry) {
  const labels = [];
  const names = { A: 'A 新增', M: 'M 修改', D: 'D 删除', R: 'R 重命名', T: 'T 类型变化', U: 'U 冲突' };
  if (entry.status) labels.push(names[entry.status] || entry.status);
  if (entry.conflict && entry.status !== 'U') labels.push('冲突');
  if (entry.staged) labels.push('已暂存');
  if (entry.unstaged) labels.push('未暂存');
  if (entry.untracked) labels.push('未跟踪');
  if (entry.kind === 'directory' && entry.changed) labels.push('含改动');
  return labels.join(' · ');
}

/** Tree and change list share one selection. Only explicit navigation fetches directories. */
export function createCodeTree({ request, onSelect, onStale }) {
  const root = el('aside', undefined, 'code-sidebar'); root.setAttribute('aria-label', '项目文件浏览器');
  const form = el('form', undefined, 'code-tree-filter');
  const query = el('input'); query.type = 'search'; query.placeholder = '按文件名或路径筛选'; query.maxLength = 500; query.setAttribute('aria-label', '文件路径筛选');
  const submit = el('button', '筛选', 'ghost'); submit.type = 'submit';
  const queryRow = el('div', undefined, 'transcript-query-row'); queryRow.append(query, submit);
  const changed = el('input'); changed.type = 'checkbox';
  const changedLabel = el('label', '仅看改动（含未提交）'); changedLabel.prepend(changed);
  form.append(queryRow, changedLabel, el('p', '包含未改文件；不列 ignored、.git、.lush。', 'hint'));
  const scroller = el('div', undefined, 'code-tree-scroll');
  const changeGroup = el('details', undefined, 'code-change-group'); changeGroup.open = true;
  const changeTitle = el('summary', '改动文件'); const changeList = el('div'); changeGroup.append(changeTitle, changeList);
  const treeTitle = el('h2', '项目目录'), tree = el('div', undefined, 'code-tree-entries');
  scroller.append(changeGroup, treeTitle, tree); root.append(form, scroller);
  let snapshot = null, epoch = 0, selected = null, term = '', onlyChanged = false;
  const expanded = new Set(), collapsed = new Set();
  const isCurrent = version => version === epoch;
  const mark = () => {
    for (const node of root.querySelectorAll('button.code-file-entry')) node.setAttribute('aria-current', String(node.dataset.path === selected));
  };
  function fileRow(entry, full = false) {
    const row = button('', async () => { selected = entry.path; mark(); await onSelect(entry); }, 'ghost code-file-entry');
    row.dataset.path = entry.path; row.setAttribute('aria-current', String(selected === entry.path));
    row.append(el('span', full ? entry.path : entry.name || entry.path.split('/').at(-1), 'code-entry-name'));
    if (entry.previous_path) row.append(el('span', `${entry.previous_path} → ${entry.path}`, 'hint code-rename'));
    const status = fileStatusText(entry);
    if (status) row.append(el('span', status, `code-entry-status code-status-${entry.status || 'pending'}`));
    if (entry.added != null || entry.deleted != null) row.append(el('span', `+${entry.added ?? '?'} −${entry.deleted ?? '?'}`, 'code-entry-stat'));
    return row;
  }
  function pageTail(container, data, more) {
    if (data.truncated) container.append(el('p', '文件范围已达读取上限，列表不完整。', 'hint'));
    if (data.has_more) container.append(button('加载更多文件', more, 'ghost code-tree-more'));
  }
  function ensureAvailable(data) {
    if (data.availability === 'stale' || (data.revision && snapshot?.revision && data.revision !== snapshot.revision)) { onStale(data.reason); return false; }
    if (data.availability !== 'available') throw new Error(data.reason || '文件列表不可用');
    return true;
  }
  async function loadDirectory(path, container, after = 0, version = epoch, autoDepth = 0) {
    const previousMore = container.querySelector('button.code-tree-more');
    const loading = el('p', '正在读取文件列表…', 'hint'); container.append(loading);
    try {
      const data = await request('code-tree', { scope: snapshot.scope, path, query: term, changed: onlyChanged, after, limit: 100, revision: snapshot.revision });
      if (!isCurrent(version)) return;
      loading.remove();
      if (!ensureAvailable(data)) { container.append(el('p', '文件列表已经变化，请刷新后继续。', 'hint')); return; }
      previousMore?.remove();
      if (!after) container.replaceChildren();
      for (const entry of data.entries || []) {
        if (entry.kind !== 'directory') { container.append(fileRow(entry, Boolean(term))); continue; }
        const group = el('div', undefined, 'code-directory');
        const children = el('div', undefined, 'code-directory-children'); children.hidden = true;
        const toggle = button(`▸ ${entry.name || entry.path.split('/').at(-1)}${entry.changed ? ' · 含改动' : ''}`, async () => {
          const open = !expanded.has(entry.path);
          if (open) { expanded.add(entry.path); collapsed.delete(entry.path); }
          else { expanded.delete(entry.path); collapsed.add(entry.path); }
          children.hidden = !open; toggle.setAttribute('aria-expanded', String(open));
          toggle.textContent = `${open ? '▾' : '▸'} ${entry.name || entry.path.split('/').at(-1)}${entry.changed ? ' · 含改动' : ''}`;
          if (open && !children.dataset.loaded) await loadDirectory(entry.path, children, 0, epoch, autoDepth + 1);
        }, 'ghost code-directory-toggle', { help: '展开或收起目录；展开时按需读取文件列表，不读取文件正文。' });
        toggle.setAttribute('aria-expanded', 'false');
        group.append(toggle, children); container.append(group);
        // Open immediate changed directories only. Deeper expansion stays explicit and bounded.
        if (expanded.has(entry.path) || (!collapsed.has(entry.path) && !term && entry.changed && autoDepth === 0 && expanded.size < 8)) {
          expanded.add(entry.path); children.hidden = false; toggle.setAttribute('aria-expanded', 'true');
          toggle.textContent = `▾ ${entry.name || entry.path.split('/').at(-1)}${entry.changed ? ' · 含改动' : ''}`;
          // Sequential auto-expansion bounds request fanout; it never recurses just because of changed=true.
          await loadDirectory(entry.path, children, 0, version, autoDepth + 1);
          if (!isCurrent(version)) return;
        }
      }
      container.dataset.loaded = 'true';
      if (!after && !data.entries?.length) container.append(el('p', data.truncated ? '读取到限，本页未获得可显示文件；范围不完整。' : term ? '没有匹配路径。' : '此范围没有文件。', 'hint'));
      pageTail(container, data, () => loadDirectory(path, container, data.next, epoch, autoDepth));
    } catch (error) {
      if (!isCurrent(version)) return;
      loading.remove();
      container.append(el('p', error.name === 'AbortError' ? '读取已暂停。' : `读取文件列表失败：${error.message}`, 'error'),
        button('重试文件列表', () => loadDirectory(path, container, after, epoch, autoDepth), 'ghost'));
    }
  }
  async function moreChanges(after) {
    const version = epoch;
    try {
      const data = await request('code-state', { scope: snapshot.scope, after, limit: 100 });
      if (!isCurrent(version) || !ensureAvailable(data)) return;
      changeList.querySelector('button.code-tree-more')?.remove();
      for (const entry of data.files || []) changeList.append(fileRow(entry, true));
      pageTail(changeList, data, () => moreChanges(data.next));
    } catch (error) { if (isCurrent(version) && error.name !== 'AbortError') changeList.append(el('p', `改动读取失败：${error.message}`, 'error')); }
  }
  function renderChanges() {
    changeTitle.textContent = `改动与未提交文件 · ${snapshot.summary?.changed_total ?? '?'} 项净变化 / ${snapshot.summary?.pending_total ?? '?'} 项未提交`;
    changeList.replaceChildren();
    if (snapshot.availability === 'available' && !snapshot.base_commit) changeList.append(el('p', '缺少可用基线，无法判断净变化；未提交状态另见统计。', 'hint'));
    for (const entry of snapshot.files || []) changeList.append(fileRow(entry, true));
    if (!snapshot.files?.length) {
      if (snapshot.availability !== 'available') changeList.append(el('p', snapshot.reason || '改动列表不可用。', 'hint'));
      else if (snapshot.truncated) changeList.append(el('p', '尚无完整改动列表。', 'hint'));
      else if (snapshot.base_commit) changeList.append(el('p', snapshot.summary?.pending_total == null
        ? '此范围未发现净改动；未提交状态不可用。' : '此范围没有净改动或未提交文件。', 'hint'));
    }
    pageTail(changeList, snapshot, () => moreChanges(snapshot.next));
  }
  async function filter() {
    term = query.value.trim(); onlyChanged = changed.checked; epoch++; tree.replaceChildren();
    treeTitle.textContent = term ? '路径匹配结果' : '项目目录';
    if (snapshot?.availability === 'available') await loadDirectory('', tree);
  }
  form.onsubmit = event => { event.preventDefault(); void filter(); };
  changed.onchange = filter;
  return {
    root,
    async reset(data) {
      snapshot = data; epoch++;
      renderChanges(); tree.replaceChildren();
      if (data.availability === 'available') await loadDirectory('', tree);
      else tree.append(el('p', data.reason || '没有可读取的项目文件。', 'hint'));
    },
    select(path) { selected = path; mark(); },
    invalidate() { epoch++; },
  };
}
