import { test, expect } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { renderDetail } from '../../src/ui/web/assets/render-detail.js';
import { renderConversation } from '../../src/ui/web/assets/render-conversation.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';

const at = '2026-10-12T11:30:00Z';
const worker = { id: 7, worker_number: 'W232', role: 'agent', task_kind: 'order', status: 'running', calls: 1,
  goal: '调整详情阅读偏好', created_at: at, updated_at: at, deps: [], dependents: [], children: [],
  progress: { version: 1, items: [{ key: 'implement', label: '实现', status: 'pending' }] },
  notices: [{ id: 551, kind: 'questionnaire', status: 'answered', title: '布局决定',
    body: JSON.stringify({ version: 1, questions: [{ header: '布局', question: '保留辅助信息？',
      options: [{ label: '保留', description: '后置' }, { label: '归入 Agent', description: '集中' }] }] }),
    answer: JSON.stringify({ answers: [{ selected: [0], labels: ['保留'], custom: '' }] }) }] };
async function fixture(run) {
  const dom = installDom({ fetch: async () => new Response(JSON.stringify({ username: null })) });
  resetUiState(); ui.view = { id: 'task', key: 'task-7' }; ui.hostSession = { status: 'ready', username: '用户' };
  try { await run(dom); } finally { resetUiState(); dom.restore(); }
}
const modules = panel => [...panel.children].filter(node => node.classList.contains('block')).map(node =>
  node.classList.contains('worker-hooks') ? '自动化' : node.querySelector('h2')?.textContent);

test('detail primary modules follow the requested order, with full auxiliary diagnostics after them and bounded top alerts', () => fixture(async dom => {
  const task = { ...worker, error: '执行失败\n' + '长错误正文'.repeat(100), integration_error: '固定父提交无法合并', specs: [] };
  localStorage.setItem('lush.markdown', '0');
  renderDetail(task, { events: [] }, null, null);
  const panel = dom.node('detail');
  expect(modules(panel)).toEqual(['自动化', '计划', '时间线', 'Agent', '代码与提交', '版本迭代', '决策记录', 'Worker 关系', '状态', '错误', '合并错误', '拆解队列']);
  const summaries = panel.querySelectorAll('.task-error-summary');
  expect(summaries).toHaveLength(2); expect(summaries[0].textContent).toContain('执行失败');
  expect(summaries[0].textContent.length).toBeLessThan(280); expect(summaries[0].textContent).toContain('完整诊断见页末');
  expect(panel.children.indexOf(summaries[0])).toBeLessThan(panel.children.indexOf(panel.querySelector('.worker-hooks')));
  expect(panel.querySelector('.error-panel').querySelector('pre').textContent).toBe(task.error);
  const history = panel.querySelector('.decision-record'); history.open = false;
  const conversation = panel.querySelector('.conversation-panel'), relations = panel.querySelector('.worker-relations');
  renderDetail(task, { events: [] }, null, null);
  expect(panel.querySelector('.conversation-panel')).toBe(conversation); expect(panel.querySelector('.worker-relations')).toBe(relations);
  expect(panel.querySelector('.decision-record')).toBe(history); expect(history.open).toBe(false);
  expect(modules(panel)).toEqual(['自动化', '计划', '时间线', 'Agent', '代码与提交', '版本迭代', '决策记录', 'Worker 关系', '状态', '错误', '合并错误', '拆解队列']);
  renderDetail({ ...worker, calls: 0, progress: null, notices: [] }, { events: [] }, null, null);
  expect(modules(panel)).toEqual(['自动化', '时间线', '代码与提交', '版本迭代', 'Worker 关系', '状态']);
  expect(panel.querySelectorAll('.task-error-summary')).toHaveLength(0);
}));

for (const [category, type] of [['lifecycle', 'invocation.started'], ['delivery', 'merged'], ['failure', 'failed']]) {
  test(`hidden ${category} events remain counted and a precise reference exposes them without showing other categories`, () => fixture(async () => {
    const root = renderConversation(worker, { events: [{ id: 10, task_id: 7, type, created_at: at, data: { reason: '详细原因' } }] });
    const filters = root.querySelectorAll('.conversation-filter');
    expect(filters.map(node => node.getAttribute('aria-pressed'))).toEqual(['true', 'true', 'true', 'false', 'false', 'false', 'false', 'false']);
    const filter = filters.find(node => node.dataset.conversationFilter === category);
    expect(filter.textContent).toContain('1'); expect(root.querySelector('.conversation-event')).toBeNull();
    const event = await root.revealConversationReference({ kind: 'history_event', target: { task_id: 7, event_id: 10 } });
    expect(event.expanded).toBe(true); expect(event.entry.category).toBe(category); expect(deepText(event)).toContain('详细原因');
    expect(filter.getAttribute('aria-pressed')).toBe('true');
    for (const other of filters.filter(node => !['input', 'output', 'decision', category].includes(node.dataset.conversationFilter))) expect(other.getAttribute('aria-pressed')).toBe('false');
    root.updateConversation(worker); expect(root.querySelector('.conversation-event')).toBe(event);
  }));
}
