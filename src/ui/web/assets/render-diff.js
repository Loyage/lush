import { block, button, el, kv } from './dom.js';
import { openTranscriptView } from './transcript-view.js';
import { CHANGE, short } from './format.js';
import { referenceable } from './context-references.js';
import { workerLabel } from './worker-label.js';

function fileList(rows, total) {
  const list = el('ul', undefined, 'difflist');
  for (const file of rows) {
    const item = el('li'), stat = el('span', undefined, 'stat');
    if (file.code) item.append(el('span', CHANGE[file.code] || file.code, 'change'));
    if (file.added === null && file.deleted === null) stat.append(el('span', file.code === '??' ? '' : '二进制', 'plus'));
    else stat.append(el('span', `+${file.added}`, 'plus'), el('span', ` −${file.deleted}`, 'minus'));
    item.append(el('span', file.path, 'path'), stat); list.append(item);
  }
  if (total > rows.length) list.append(el('li', `… 另有 ${total - rows.length} 个文件`, 'path'));
  return list;
}
/** 「N 个文件 · +A −D」的口径：总体行数来自服务端对全部文件的汇总，不受列表截断影响。 */
const lineStats = (added, deleted) => `+${added ?? 0} −${deleted ?? 0}`;
function filesDisclosure(diff) {
  const files = diff.files || [], pending = diff.pending || [];
  const total = (diff.files_total || 0) + (diff.pending_total || 0);
  const added = (diff.added || 0) + (diff.pending_added || 0);
  const deleted = (diff.deleted || 0) + (diff.pending_deleted || 0);
  const details = el('details', undefined, 'diff-files');
  const label = `共 ${total} 个文件 · ${lineStats(added, deleted)}`;
  const summary = el('summary');
  summary.append(el('span', `展开文件明细（${label}）`, 'diff-open-label'), el('span', `收起文件明细（${label}）`, 'diff-close-label'));
  details.append(summary);
  if (files.length) details.append(el('p', '已提交的文件', 'hint'), fileList(files, diff.files_total));
  if (pending.length) details.append(el('p', '未提交的改动（agent 未提交或失败时留下的）', 'hint'), fileList(pending, diff.pending_total));
  return details;
}
export function renderDiff(diff, taskId = null, task = null, { loading = false, unavailable = false } = {}) {
  const section = block('代码与提交');
  if (task) {
    const context = el('div', undefined, 'code-context');
    context.append(kv(task.task_kind === 'management' || task.role === 'manager' ? '目录路径（管理工作目录）' : '目录路径', task.workspace || '无专属工作区', 'mono'),
      button('打开代码阅读器', () => openTranscriptView(taskId, undefined, { mode: 'code' }), 'ghost code-reader-open',
        { help: '只读打开完整目录树（含未改文件）、文件正文与差异；点击才加载，不运行代码、不调用 Agent。归档后按现有提交可用性降级。' }));
    section.append(context);
  }
  const body = el('div', undefined, 'detail-diff-body'); section.append(body);
  const grid = el('div', undefined, 'grid');
  grid.append(kv('分支', diff?.branch || task?.branch || '—', 'mono'), kv('目标分支', diff?.target_branch || task?.target_branch || '—', 'mono'));
  grid.append(kv('基线 → 提交', diff ? (diff.committed ? `${short(diff.base_commit)} → ${short(diff.head_commit)}` : `${short(diff.base_commit) || '—'} → 无提交`)
    : `${short(task?.base_commit) || '—'} → ${short(task?.head_commit) || '未读取'}`, 'mono'));
  if (!diff) {
    body.append(grid, el('p', loading ? '改动加载中…' : unavailable ? '改动不可用；读取失败。' : '改动不可用：尚无可读取的工作区。', loading ? 'hint detail-diff-status' : 'hint detail-diff-unavailable'));
    return section;
  }
  if (diff.base_behind) grid.append(kv('基线落后主树', `${diff.base_behind} 个提交`));
  grid.append(kv('提交文件', diff.committed ? `${diff.files_total} 个 · ${lineStats(diff.added, diff.deleted)}` : '0'));
  grid.append(kv('未提交文件', `${diff.pending_total || 0} 个 · ${lineStats(diff.pending_added, diff.pending_deleted)}`));
  body.append(grid);
  if (diff.commits?.length) {
    const list = el('ul', undefined, 'difflist');
    for (const line of diff.commits) { const item = el('li'); item.append(el('span', line, 'path')); list.append(item); }
    body.append(el('p', '提交', 'hint'), list);
  }
  if (diff.files?.length || diff.pending?.length) body.append(filesDisclosure(diff));
  if (taskId) referenceable(body, { kind: 'diff', target: { task_id: taskId }, label: `代码与提交 ${workerLabel(taskId)}`,
    quote: [...(diff.commits || []), ...(diff.files || []).map(file => `${file.path} +${file.added ?? '?'} -${file.deleted ?? '?'}`),
      ...(diff.pending || []).map(file => `${file.code || ''} ${file.path}`)].join('\n') || '尚无文件改动',
    location: { view: 'task-detail', task_id: taskId, section: 'diff' } });
  return section;
}
