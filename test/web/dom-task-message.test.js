import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText, allByTag, findByText } from '../dom-stub.js';

const dom = installDom({ fetch: async () => new Response('{}') });
const { renderTaskMessage } = await import('../../src/ui/web/assets/render-task-message.js');
const { renderDetail } = await import('../../src/ui/web/assets/render-detail.js');
const { initContextReferences, composerReferences } = await import('../../src/ui/web/assets/context-references.js');
afterAll(() => dom.restore());
const at = '2026-10-02T06:32:38.004Z';
const message = body => ({ id: 17, task_id: 1, sender_id: 7, created_at: at, body });
const signal = (type, payload, extra = {}) => message(JSON.stringify({ version: 1, signal: type,
  key: 'internal-key', source_task_id: 7, target_task_id: 1, payload, ...extra }));
const expand = node => { node.open = true; for (const handler of node.listeners.toggle || []) handler(); };

test('完成信号正文与关键字段直接可读；完整信封只在显式展开原文后加载', () => {
  const msg = signal('child.completed', { result: '## 已完成\n\n- 修复 **边界情况**', commit: 'abc1234' });
  const root = renderTaskMessage(msg, 1);
  const text = deepText(root);
  expect(text).toContain('来自 Worker #7');
  expect(text).toContain('子 Worker 完成');
  expect(root.querySelector('time').getAttribute('datetime')).toBe(at);
  expect(root.querySelector('h2')).toBeTruthy();
  expect(root.querySelector('strong')).toBeTruthy();
  expect(text).toContain('提交');
  expect(text).toContain('abc1234');
  expect(text).not.toContain('internal-key');
  expect(text).not.toContain('source_task_id');
  expect(root.querySelector('.message-original').querySelector('pre')).toBeNull();
  expand(root.querySelector('.message-original'));
  expect(root.querySelector('.message-original').querySelector('pre').textContent).toBe(msg.body);
});

test('常见合并信号有中文标题，显示完整哈希，保留额外字段', () => {
  for (const [type, title] of [['merge.requested', '请求合并'], ['merge.completed', '已合并'], ['merge.repair', '合并分歧']]) {
    const root = renderTaskMessage(signal(type, { branch: 'lush/example', parent_commit: 'f'.repeat(40),
      instruction: '请合入固定父提交\n不要修改父分支', attempt_id: 'attempt-22', future: { note: '未来字段' } }), 1);
    expect(deepText(root)).toContain(title);
    expect(deepText(root)).toContain('lush/example');
    expect(deepText(root)).toContain('f'.repeat(40));
    expect(deepText(root)).toContain('不要修改父分支');
    expect(deepText(root)).not.toContain('attempt-22');
    expand(root.querySelector('.message-extra'));
    expect(deepText(root)).toContain('attempt-22');
    const branch = allByTag(root.querySelector('.message-extra'), 'details')[1];
    expand(branch);
    expect(deepText(root)).toContain('未来字段');
  }
});

test('失败、取消和生成时截断如实展示，不把历史完成信号当作当前状态', () => {
  const root = renderTaskMessage(signal('child.failed', { error: '测试失败\n保留日志', result: '部分结果', result_truncated: true }), 1);
  expect(root.classList.contains('message-failed')).toBe(true);
  expect(deepText(root)).toContain('子 Worker 失败');
  expect(deepText(root)).toContain('测试失败');
  expect(deepText(root)).toContain('截断');
  expect(deepText(root)).toContain('不能恢复缺失部分');
  expect(deepText(renderTaskMessage(signal('child.cancelled', { result: null }), 1))).toContain('子 Worker 已取消');
  expect(deepText(renderTaskMessage(message(JSON.stringify({ child: 7, status: 'completed', result: '历史结果' })), 1))).toContain('历史结果');
});

test('决策答复显示问题、选项与自定义内容；忽略不代表接受推荐项', () => {
  const root = renderTaskMessage({ ...message(JSON.stringify({ notice_id: 45, title: '选择展示方式', dismissed: false,
    answer: { version: 1, answers: [{ question: '如何展示？', labels: ['语义消息卡片'], custom: '请保留完整原文' }] } })), sender_id: null }, 1);
  const text = deepText(root);
  for (const word of ['来自你', '已答复决策', '选择展示方式', '如何展示？', '语义消息卡片', '请保留完整原文']) expect(text).toContain(word);
  expect(text).not.toContain('selected');
  const dismissed = renderTaskMessage(message(JSON.stringify({ notice_id: 45, title: '选择展示方式', dismissed: true, answer: '' })), 1);
  expect(deepText(dismissed)).toContain('未做决定');
  expect(deepText(dismissed)).toContain('不代表接受推荐项');
  const plain = renderTaskMessage(message(JSON.stringify({ notice_id: 46, dismissed: false, answer: '采用方案 A' })), 1);
  expect(deepText(plain)).toContain('采用方案 A');
});

test('普通消息按 Markdown 渲染，未知／未来版本 JSON 回退结构树，损坏 JSON 原样显示', () => {
  const ordinary = renderTaskMessage(message('**正文**\n\n- 一项\n- 二项'), 1);
  expect(ordinary.querySelector('strong')).toBeTruthy();
  expect(allByTag(ordinary, 'li')).toHaveLength(2);
  for (const msg of [signal('unknown.signal', { description: '第一行\n第二行' }),
    signal('child.completed', { result: '未来版本' }, { version: 2 }),
    message('{"items":[1,2],"text":"第三行\\n第四行"}'), signal('child.completed', []),
    message('{"version":1,"signal":{"toString":null},"payload":{}}'),
    message('{"child":7,"status":{"toString":null}}')]) {
    const root = renderTaskMessage(msg, 1);
    expect(deepText(root)).toContain('结构化消息');
    expect(root.querySelector('.json-tree')).toBeTruthy();
    expand(root.querySelector('.message-original'));
    expect(root.querySelector('.message-original').querySelector('pre').textContent).toBe(msg.body);
  }
  const malformed = '{"broken":\n<script>alert(1)</script>';
  const root = renderTaskMessage(message(malformed), 1);
  expect(root.querySelector('.json-tree')).toBeNull();
  expect(root.querySelector('script')).toBeNull();
  expect(deepText(root)).toContain('alert(1)');
  expand(root.querySelector('.message-original'));
  expect(root.querySelector('.message-original').querySelector('pre').textContent).toBe(malformed);
});

test('长正文就地展开／收起；空消息和收发方向清楚', () => {
  const body = '长正文\n'.repeat(400);
  const root = renderTaskMessage(message(body), 1);
  const toggle = findByText(root, '展开完整正文');
  expect(deepText(root).length).toBeLessThan(body.length);
  toggle.onclick();
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(toggle.textContent).toBe('收起正文');
  toggle.onclick();
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(deepText(renderTaskMessage(message(''), 1))).toContain('空消息');
  expect(deepText(renderTaskMessage(message('发给父任务'), 7))).toContain('发给 Worker #1');
});

test('详情集成保留消息引用原文，刷新／追加消息保留已有阅读节点', async () => {
  const task = { id: 1, task_kind: 'main', role: 'agent', status: 'waiting', goal: '管理主分支',
    created_at: at, updated_at: at, messages: [signal('child.completed', { result: '结果正文' })] };
  renderDetail(task, {}, null, null);
  const card = dom.node('detail').querySelector('.task-message');
  initContextReferences();
  await dom.fire('contextmenu', { target: card, clientX: 10, clientY: 20, preventDefault() {} });
  await findByText(dom.node('context-menu'), '引用：Worker #1 的消息').onclick();
  const descriptor = composerReferences()[0];
  expect(descriptor.kind).toBe('message');
  expect(descriptor.target).toEqual({ task_id: 1, message_id: 17 });
  expect(descriptor.quote).toBe(task.messages[0].body);
  expand(card.querySelector('.message-original'));
  renderDetail({ ...task, messages: [...task.messages, { ...message('新增消息'), id: 18 }] }, {}, null, null);
  expect(dom.node('detail').querySelector('.task-message')).toBe(card);
  expect(card.querySelector('.message-original').open).toBe(true);
  const changed = { ...task.messages[0], body: '新的正文' };
  expect(renderTaskMessage(changed, 1, card)).not.toBe(card);
  localStorage.setItem('lush.markdown', '0');
  const plain = renderTaskMessage(message('**原样文本**\n换行'), 1);
  expect(plain.querySelector('strong')).toBeNull();
  expect(deepText(plain)).toContain('**原样文本**\n换行');
  localStorage.removeItem('lush.markdown');
});
