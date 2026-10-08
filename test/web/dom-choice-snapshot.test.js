import { test, expect } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { settledDecision } from '../../src/ui/web/assets/choice-snapshot.js';
import { noticePanel } from '../../src/ui/web/assets/render-notices.js';
import { renderDetail } from '../../src/ui/web/assets/render-detail.js';
import { resetUiState } from '../../src/ui/web/assets/state.js';

function notice(status = 'answered', answer_source = 'user') {
  return { id: 7, task_id: 22, task_worker_number: 'W2', title: '布局选择', kind: 'questionnaire', status,
    created_at: '2026-01-01T00:00:00Z', answer_source,
    body: JSON.stringify({ version: 1, body: '选择开发方向', questions: [
      { header: '布局', question: '使用哪种布局？', options: [
        { label: '侧栏', description: '分类明确', previewHtml: '<nav>目录</nav>' }, { label: '标签', description: '内容更宽' }] },
    ] }),
    answer: status === 'answered' ? JSON.stringify({ answers: [{ selected: [0], labels: ['侧栏'], custom: '' }] }) : null };
}
function noSnapshot(root) {
  expect(root.querySelector('.choice-snapshot')).toBeNull();
  for (const label of ['查看快照与重选', '重新选择', '确认新选择并创建 Worker', '继续上次重选'])
    expect(deepText(root)).not.toContain(label);
  expect(root.querySelector('textarea')).toBeNull();
}

for (const status of ['answered', 'dismissed']) for (const source of ['user', 'lush'])
  test(`${status}/${source} history remains read-only without snapshot or reselection controls`, () => {
    const requests = [], record = notice(status, source), original = structuredClone(record);
    const dom = installDom({ fetch: async url => { requests.push(url); throw new Error('must not request snapshots'); } });
    resetUiState();
    try {
      const replay = settledDecision(record), panel = noticePanel(record);
      for (const root of [replay, panel]) {
        noSnapshot(root);
        expect(deepText(root)).toContain(source === 'lush' ? 'Lush 自动选择' : '用户答复');
        expect(deepText(root)).toContain('使用哪种布局？');
        if (status === 'answered') expect(deepText(root)).toContain('已选：侧栏');
        else expect(deepText(root)).toContain('未选择任何选项');
      }
      const task = { id: 22, role: 'agent', task_kind: 'order', goal: '布局开发', status: 'completed', integration: 'merged',
        deps: [], dependents: [], children: [], messages: [], notices: [record], reservation: null };
      renderDetail(task, null, null, null);
      const fold = dom.node('detail').querySelector('.decision-record');
      expect(fold).toBeTruthy(); noSnapshot(fold);
      fold.open = true; renderDetail(task, null, null, null);
      expect(dom.node('detail').querySelector('.decision-record')).toBe(fold);
      expect(fold.open).toBe(true);
      expect(requests).toHaveLength(0);
      expect(record).toEqual(original);
    } finally { dom.restore(); }
  });
