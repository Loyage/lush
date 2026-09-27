import { badge, block, button, el } from './dom.js';
import { INTEGRATION, short, statusOf } from './format.js';
import { detail } from './navigate.js';

/**
 * 合并冲突的处理记录：git 自己合不了的那次合并交给了哪几个专用任务，各自到哪了。
 * 已经落地的用 --ff-only 落地（落地的树＝测过的树）；superseded 表示被下一轮取代。
 */
export function renderResolutions(task) {
  const section = block('合并冲突', String(task.resolutions.length));
  section.append(el('p', '内容冲突会开一个专用任务：它在自己的 worktree 里（基线＝目标分支顶端）把已审阅的提交并进来、解冲突、跑测试；批准时用 --ff-only 落地，所以落地的就是它测过的那棵树。', 'hint'));
  for (const row of task.resolutions) {
    const line = el('div', undefined, 'row');
    line.append(el('span', `#${row.id}`, 'tid'), el('span', `${statusOf(row).icon} ${statusOf(row).label}`, `dot c-${row.status}`),
      badge(INTEGRATION[row.integration] || row.integration, row.integration === 'merged' ? 'b-completed' : 'b-awaiting'),
      button('查看', () => detail(row.id), 'link'), el('span', row.head_commit ? short(row.head_commit) : '', 'when'));
    section.append(line);
  }
  return section;
}
