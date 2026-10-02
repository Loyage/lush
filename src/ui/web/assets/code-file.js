import { el, button } from './dom.js';
import { renderCodeDiff, appendCodeContent } from './code-diff.js';
import { fileStatusText } from './code-tree.js';
import { referenceable } from './context-references.js';

const KINDS = { file: '文本文件', binary: '二进制文件', symlink: '符号链接', submodule: '子模块', directory: '目录' };
const short = value => value ? String(value).slice(0, 10) : '未知';
function select(label, values, value) {
  const node = el('select'); node.setAttribute('aria-label', label);
  for (const [id, text] of values) { const option = el('option', text); option.value = id; node.append(option); }
  node.value = value; return node;
}
function versionText(side, name) {
  if (!side) return `${name}：未知`;
  if (!side.exists) return `${name}：不存在`;
  return `${name}：${KINDS[side.kind] || side.kind || '文件'} · ${side.size == null ? '大小未知' : `${side.size} 字节`}${side.mode ? ` · 模式 ${side.mode}` : ''}`;
}

/** Selected-file DOM survives state probes and view switches. Explicit actions alone replace its text. */
export function createCodeFile({ request, onSearch, onStale, taskId }) {
  const root = el('section', undefined, 'code-file-view');
  const heading = el('header', undefined, 'code-file-heading');
  const title = el('h2', '选择文件查看代码'); const status = el('p', '', 'hint');
  const controls = el('div', undefined, 'code-file-controls');
  const diffButton = button('差异', () => changeView('diff'), 'ghost');
  const contentButton = button('文件内容', () => changeView('content'), 'ghost');
  const sideSelect = select('文件版本', [['new', '当前版本'], ['old', '基线版本']], 'new');
  const layoutSelect = select('差异布局', [['split', '并排差异'], ['unified', '统一差异']], 'split');
  const search = button('在执行记录中搜索此路径', () => onSearch?.(entry.path), 'ghost', { help: '搜索当前 Worker 全部执行记录中提及此路径的文字；命中不代表该步骤修改了这个文件。' });
  controls.append(diffButton, contentButton, sideSelect, layoutSelect, search);
  heading.append(title, status, controls);
  const metadata = el('div', undefined, 'code-file-metadata');
  const message = el('p', '', 'hint'); message.setAttribute('role', 'status');
  const navigation = el('div', undefined, 'code-diff-navigation');
  const previous = button('上一个改动', () => locate(-1), 'ghost');
  const next = button('下一个改动', () => locate(1), 'ghost');
  const expand = button('展开更多上下文', async () => { context = Math.min(100, context === 3 ? 20 : context * 2); await load(false); }, 'ghost', { help: '扩大每个差异块周围的未修改行；完整文件可切换到文件内容继续阅读。' });
  navigation.append(previous, next, expand);
  const body = el('div', undefined, 'code-file-body');
  const footer = el('div', undefined, 'code-file-footer');
  root.append(heading, metadata, message, navigation, body, footer);
  root.dataset.layout = 'split';
  let entry = null, snapshot = null, epoch = 0, view = 'diff', side = 'new', context = 3;
  let offset = 0, fileRevision = null, readingRevision = null, busy = false, interrupted = false, hunkIndex = -1;
  controls.hidden = true; metadata.hidden = true; navigation.hidden = true;
  body.append(el('p', '左侧列出当前 Worker 的项目文件。选择改动文件审阅差异，或选择任意文件阅读正文。', 'hint'),
    el('p', '工作区净变化不等于此 Agent 独自创作；已合入子 Worker 和父分支同步也可能包含其中。', 'hint'));
  function syncControls() {
    controls.hidden = !entry; metadata.hidden = !entry;
    diffButton.setAttribute('aria-pressed', String(view === 'diff')); contentButton.setAttribute('aria-pressed', String(view === 'content'));
    sideSelect.hidden = view !== 'content'; sideSelect.value = side;
    layoutSelect.hidden = view !== 'diff'; navigation.hidden = view !== 'diff' || !entry;
    expand.hidden = context >= 100;
    root.dataset.layout = layoutSelect.value;
  }
  function locate(direction) {
    const hunks = body.querySelectorAll('.code-hunk');
    if (!hunks.length) { message.textContent = '当前没有已加载的差异块。'; return; }
    if (hunkIndex < 0 && direction < 0) hunkIndex = 0;
    hunkIndex = (hunkIndex + direction + hunks.length) % hunks.length;
    hunks[hunkIndex].scrollIntoView?.({ block: 'start' }); hunks[hunkIndex].focus?.({ preventScroll: true });
  }
  function markReference(node, text, data) {
    const range = view === 'diff' ? `差异 ${short(data.base_commit)} → ${data.source === 'workspace' ? '工作区' : short(data.head_commit)}` : side === 'old' ? `基线 ${short(data.base_commit)}` : `当前 ${data.source === 'workspace' ? '工作区' : short(data.head_commit)}`;
    const section = `code · ${range} · ${data.sampled_at || '采样时间未知'}`;
    referenceable(node, { kind: 'text', target: {}, label: `${entry.path} · ${range}`,
      quote: text || `${entry.path} · ${range}`, location: { task_id: taskId, path: entry.path.slice(0, 500), section } });
    // Selection references use the same bounded provenance, not an invented persistent code target.
    node.dataset.codeReference = 'true';
  }
  function stale(reason) {
    message.textContent = reason || '文件或工作区已变化，保留当前正文；请加载最新后继续。';
    onStale(message.textContent);
  }
  async function load(append = false) {
    if (!entry || !snapshot || busy && append) return;
    const version = ++epoch, currentEntry = entry;
    busy = true; interrupted = false;
    const requestedOffset = append ? offset : 0;
    message.textContent = append ? '正在继续读取…' : '正在读取文件…';
    if (!append) { offset = 0; fileRevision = null; readingRevision = snapshot.revision; hunkIndex = -1; }
    try {
      const data = await request('code-file', { scope: snapshot.scope, path: entry.path, view, side, context,
        offset: requestedOffset, limit: view === 'diff' ? 20 : 24000, revision: readingRevision });
      if (version !== epoch || currentEntry !== entry) return;
      if (data.availability === 'stale' || (data.revision && readingRevision && data.revision !== readingRevision)
        || (append && fileRevision && data.file_revision !== fileRevision)) { stale(data.reason); return; }
      if (data.availability !== 'available') {
        message.textContent = data.reason || '此文件不可读取。';
        if (!append) { body.replaceChildren(); footer.replaceChildren(); }
        return;
      }
      fileRevision = data.file_revision; readingRevision = data.revision;
      title.textContent = data.previous_path ? `${data.previous_path} → ${entry.path}` : entry.path;
      status.textContent = `${fileStatusText({ ...entry, status: data.status }) || (data.base_commit ? '未标记净变化' : '净变化不可判断（基线不可用）')} · ${data.kind ? KINDS[data.kind] || data.kind : ''}`
        + (entry.added != null || entry.deleted != null ? ` · +${entry.added ?? '?'} −${entry.deleted ?? '?'}` : '')
        + (entry.statusKnown === false ? ' · 未提交状态未完整读取' : '');
      metadata.replaceChildren(el('p', versionText(data.old, '基线版本'), 'hint'), el('p', versionText(data.new, '当前版本'), 'hint'),
        el('p', `正文采样：${data.sampled_at || '未知'} · ${short(data.base_commit)} → ${data.source === 'workspace' ? `工作区（HEAD ${short(data.head_commit)}）` : short(data.head_commit)}`, 'hint'));
      if (!append) body.replaceChildren();
      footer.replaceChildren(); message.textContent = data.reason || '';
      if (data.truncated) message.textContent = `${message.textContent} 本次读取达到限额，内容不完整。`.trim();
      if (view === 'content') {
        const content = data.content;
        const sideInfo = data[side];
        if (sideInfo?.exists === false) body.append(el('p', `${side === 'old' ? '基线' : '当前'}版本不存在，不是空文件。`, 'hint'));
        else if (sideInfo?.kind && sideInfo.kind !== 'file') {
          body.append(el('p', data.reason || `${KINDS[sideInfo.kind] || sideInfo.kind}不提供普通文本正文；请查看上方元信息。`, 'hint'));
          if (content?.text && ['symlink', 'submodule'].includes(sideInfo.kind)) {
            body.append(el('p', sideInfo.kind === 'symlink' ? '链接目标（只读，不跟随）' : '子模块登记提交（不进入目录）', 'hint'), el('p', content.text, 'mono'));
          }
        } else if (content && !content.text && (data.truncated || (content.offset === 0 && (sideInfo?.size > 0 || (sideInfo?.size == null && data.reason))))) {
          body.append(el('p', data.reason || '正文未能展示；这不表示文件为空或已经读完。', 'hint'));
        } else if (content) {
          for (const segment of appendCodeContent(body, content, entry.path)) markReference(segment, segment.codeContent.text, data);
          offset = content.next_offset;
          if (content.has_more) footer.append(button('继续读取文件', () => load(true), 'ghost'));
          else footer.append(el('p', data.truncated ? '本次读取到限，无法确认文件末尾。' : '已到文件末尾。', 'hint'));
        } else body.append(el('p', data.reason || '此类型不提供普通文本正文；请查看上方文件元信息。', 'hint'));
      } else {
        const diff = data.diff;
        if (diff?.hunks?.length) {
          const chunk = renderCodeDiff(diff.hunks, entry.path);
          markReference(chunk, diff.hunks.flatMap(h => h.lines.map(line => `${line.kind === 'add' ? '+' : line.kind === 'delete' ? '-' : ' '}${line.text}`)).join('\n'), data);
          body.append(chunk);
        }
        if (diff?.too_large || diff?.reason) body.append(el('p', diff.reason || '差异过大，无法完整显示；可切换文件内容分段阅读两侧原文。', 'hint'));
        else if (!diff?.hunks?.length && !append) body.append(el('p', data.truncated ? '读取不完整，本页没有可显示的差异，不能据此判断无改动。'
          : ['binary', 'symlink', 'submodule'].includes(data.kind) ? '此类型不展示普通文本差异；请查看元信息。'
            : '此范围无文本差异；权限、类型与未提交状态另见上方。', 'hint'));
        offset = diff?.next_offset ?? 0;
        if (diff?.has_more) footer.append(button('继续读取差异', () => load(true), 'ghost'));
        if (diff?.too_large || diff?.reason) footer.append(button('查看文件内容', () => changeView('content'), 'ghost'));
      }
      syncControls();
    } catch (error) {
      if (version !== epoch) return;
      if (error.name === 'AbortError') { interrupted = true; return; }
      message.textContent = `文件读取失败：${error.message}`;
      footer.replaceChildren(button('重试读取文件', () => load(append), 'ghost'));
    } finally { if (version === epoch) busy = false; }
  }
  async function changeView(nextView) { if (!entry) return; view = nextView; syncControls(); await load(false); }
  sideSelect.onchange = async () => { side = sideSelect.value; await load(false); };
  layoutSelect.onchange = () => { root.dataset.layout = layoutSelect.value; };
  return {
    root,
    async open(nextEntry, nextSnapshot) {
      entry = nextEntry; snapshot = nextSnapshot; view = entry.changed || entry.conflict ? 'diff' : 'content'; side = entry.status === 'D' ? 'old' : 'new'; context = 3;
      title.textContent = entry.path; status.textContent = fileStatusText(entry); syncControls();
      metadata.replaceChildren(); body.replaceChildren(); footer.replaceChildren(); await load(false);
    },
    async reload(nextSnapshot) {
      snapshot = nextSnapshot;
      if (entry) {
        const updated = nextSnapshot.files?.find(value => value.path === entry.path);
        entry = updated || { path: entry.path, kind: entry.kind, changed: false, status: null,
          statusKnown: !nextSnapshot.has_more && !nextSnapshot.truncated, added: null, deleted: null };
        await load(false);
      }
    },
    invalidate() { interrupted = busy; busy = false; epoch++; },
    async resume() { if (interrupted && entry) { interrupted = false; await load(false); } },
  };
}
