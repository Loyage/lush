import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';

const world = makeWorld();
const dom = installDom({ fetch: world.fetchImpl });
const { renderTaskGraph } = await import('../../src/ui/web/assets/render-task-graph.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const { branchDiagnostics } = await import('../../src/ui/web/assets/task-graph-parts.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
afterAll(() => dom.restore());

function paint(branch, extra = {}) {
  activateDetailView({ view: 'task-graph' });
  renderTaskGraph({ total: 1, nodes: [{ id: 21, task_kind: 'say', role: 'agent', status: 'waiting',
    title: 'Git 诊断测试', branch: 'feature', integration: 'pending', branch_info: branch, ...extra }] });
  return dom.node('detail').querySelector('[data-task-id="21"]');
}

test('Task 卡片诊断真实 Git 关系，不将缺失/未知冒充零；没有旧分支操作或第二套谱系', () => {
  for (const [status, label] of Object.entries({ equal: '一致', ahead: '领先', behind: '落后',
    diverged: '分歧', missing: '分支缺失', parent_archived: '父分支已归档', unknown: '关系未知' })) {
    const known = ['equal', 'ahead', 'behind', 'diverged'].includes(status);
    const card = paint({ parent: 'main', current: true, current_head: 'abcdef',
      relation: { status, ahead: known ? 2 : null, behind: known ? 3 : null } });
    const text = deepText(card);
    expect(text).toContain(`Git 关系：${label}`);
    expect(text).toContain('Git 父分支：main');
    expect(text).toContain('当前检出');
    if (known) expect(text).toContain('领先 2 / 落后 3 个提交');
    else expect(text).not.toContain('个提交');
    expect(card.querySelector('.graph-group')).toBeNull();
    expect(card.querySelector('.referenceable')).toBeNull();
    expect(text).not.toContain('绑定分支');
  }
  const text = deepText(paint({ current_head: 'abcdef' }));
  expect(text).toContain('关系未知');
  expect(text).not.toContain('Git 父分支：');
});

test('Squash 后真实 Git 分歧与改动已合入可以并存；已归档分支不报缺失', () => {
  const card = paint({ current_head: 'abc', relation: { status: 'diverged', ahead: 1, behind: 1 } }, { integration: 'merged' });
  expect(deepText(card)).toContain('已合并');
  expect(deepText(card)).toContain('Git 关系：分歧');
  expect(deepText(card)).toContain('Squash');
  ui.taskGraphShowArchived = true;
  try {
    const archived = paint({ archived: true, current_head: null, relation: null });
    expect(deepText(archived)).toContain('分支已归档');
    expect(deepText(archived)).not.toContain('分支缺失');
    expect(archived.querySelector('.task-graph-git')).toBeNull();
  } finally { ui.taskGraphShowArchived = false; }
});

test('改动诊断保留二进制/重命名/截断与会话展开状态，未提交统计独立', async () => {
  ui.taskGraphFilesExpanded = new Set();
  const branch = { name: 'feature', diagnostics: { changes: { status: 'ok', files_total: 5, added: 8, deleted: 2,
    binary_files: 1, base_commit: 'abcdef1', head_commit: 'abcdef2', truncated: true,
    files: [{ path: 'new.png', previous_path: 'old.png', added: null, deleted: null }] },
    working_tree: { status: 'dirty', path: '/tmp/feature', files_total: 1, staged: 1, unstaged: 0, untracked: 0, conflicts: 0 } } };
  let box = branchDiagnostics(branch);
  expect(deepText(box)).toContain('含 1 个二进制文件');
  expect(deepText(box)).toContain('old.png → new.png');
  expect(deepText(box)).toContain('前 1 / 5 个文件');
  expect(deepText(box)).toContain('未提交：1 个文件');
  expect(box.querySelector('.graph-change-files').hidden).toBe(true);
  await box.querySelector('button').onclick();
  box = branchDiagnostics(branch);
  expect(box.querySelector('.graph-change-files').hidden).toBe(false);
  expect(box.querySelector('button').getAttribute('aria-expanded')).toBe('true');
});

test('无基线、读取失败或未检出明确显示不可用，不推断干净', () => {
  const box = branchDiagnostics({ name: 'feature', diagnostics: {
    changes: { status: 'unavailable', reason: 'missing_baseline' }, working_tree: { status: 'not_checked_out' } } });
  const text = deepText(box);
  expect(text).toContain('没有记录创建起点');
  expect(text).toContain('未检出工作区');
  expect(text).not.toContain('工作区干净');
  expect(text).not.toContain('已提交：0');
});
