import { block, el, kv } from './dom.js';
import { CHANGE, short } from './format.js';
import { referenceable } from './context-references.js';

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
export function renderDiff(diff, taskId = null) {
  const section = block('改动概览');
  if (!diff) { section.append(el('p', '尚无工作区（规划任务或不改动代码的任务不创建 worktree）。', 'hint')); return section; }
  const grid = el('div', undefined, 'grid');
  grid.append(kv('分支', diff.branch || '—', 'mono'), kv('目标分支', diff.target_branch || '—', 'mono'));
  grid.append(kv('基准 → 提交', diff.committed ? `${short(diff.base_commit)} → ${short(diff.head_commit)}` : `${short(diff.base_commit) || '—'} → 无提交`, 'mono'));
  if (diff.base_behind) grid.append(kv('基线落后主树', `${diff.base_behind} 个提交`));
  grid.append(kv('提交文件', diff.committed ? String(diff.files_total) : '0'));
  grid.append(kv('未提交文件', String(diff.pending_total || 0)));
  section.append(grid);
  if (diff.commits?.length) {
    const list = el('ul', undefined, 'difflist');
    for (const line of diff.commits) { const item = el('li'); item.append(el('span', line, 'path')); list.append(item); }
    section.append(el('p', '提交', 'hint'), list);
  }
  if (diff.files?.length) section.append(el('p', '已提交的文件', 'hint'), fileList(diff.files, diff.files_total));
  if (diff.pending?.length) {
    section.append(el('p', '未提交的改动（agent 未提交或失败时留下的）', 'hint'), fileList(diff.pending, diff.pending_total));
  }
  if (taskId) referenceable(section, { kind: 'diff', target: { task_id: taskId }, label: `改动概览 #${taskId}`,
    quote: [...(diff.commits || []), ...(diff.files || []).map(file => `${file.path} +${file.added ?? '?'} -${file.deleted ?? '?'}`),
      ...(diff.pending || []).map(file => `${file.code || ''} ${file.path}`)].join('\n') || '尚无文件改动',
    location: { view: 'task-detail', task_id: taskId, section: 'diff' } });
  return section;
}
