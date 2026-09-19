import { test, expect } from 'bun:test';
import {
  filterTasks, filterSpecs, filterIntents, matchTask, matchSpec, matchIntent, isFiltering,
  describeFilters, countText, parseCollapsed, serializeCollapsed, toggleCollapsed,
  parseFilters, DEFAULT_FILTERS,
} from '../src/ui/web/assets/sidebar.js';

/** 一棵三层的树 + 一个不相关的根：用来固定「命中项 + 祖先通路」这条规则。 */
const tree = [
  { id: 1, parent_id: null, role: 'worker', status: 'completed', integration: 'merged', goal: '根任务' },
  { id: 2, parent_id: 1, role: 'coordinator', status: 'completed', integration: 'merged', goal: '中间层' },
  { id: 3, parent_id: 2, role: 'worker', status: 'running', integration: 'none', goal: 'Fix LOGIN errors' },
  { id: 4, parent_id: null, role: 'research', status: 'failed', integration: 'none', goal: '调研鉴权' },
  { id: 5, parent_id: 4, role: 'worker', status: 'running', integration: 'none', goal: '子任务' },
];
const ids = rows => rows.map(row => row.id);

test('空查询原样返回：三个 filter 连数组引用都不换，默认行为与改造前一致', () => {
  expect(filterTasks(tree, {})).toBe(tree);
  expect(filterTasks(tree)).toBe(tree);
  expect(filterSpecs([])).toEqual([]);
  const specs = [{ id: 1, status: 'pending' }];
  expect(filterSpecs(specs, {})).toBe(specs);
  const intents = [{ id: 1, flow: 'develop' }];
  expect(filterIntents(intents, {})).toBe(intents);
  // 'all' / 空关键字 / mine=false 都不算条件。
  expect(filterTasks(tree, { status: 'all', role: 'all', integration: 'all', mine: false, text: '   ' })).toBe(tree);
});

test('任务树筛选：状态 / 角色 / 合并 / 关键字各自生效，且可组合', () => {
  expect(ids(filterTasks(tree, { status: 'running' }))).toEqual([1, 2, 3, 4, 5]);   // 两个命中，各自补祖先
  expect(ids(filterTasks(tree, { status: ['completed'] }))).toEqual([1, 2]);        // 子任务被筛掉，父仍可见
  expect(ids(filterTasks(tree, { role: 'research' }))).toEqual([4]);
  expect(ids(filterTasks(tree, { status: 'running', role: 'worker' }))).toEqual([1, 2, 3, 4, 5]);
  expect(ids(filterTasks(tree, { status: 'completed', role: 'coordinator' }))).toEqual([1, 2]);
  // 关键字大小写不敏感：匹配 goal 文本（命中 #3，父链 #1 / #2 作为通路保留）
  expect(ids(filterTasks(tree, { text: 'login' }))).toEqual([1, 2, 3]);
  expect(ids(filterTasks(tree, { text: 'LOGIN' }))).toEqual([1, 2, 3]);
  // 也匹配 #id 与裸 id
  expect(ids(filterTasks(tree, { text: '#4' }))).toEqual([4]);
  // 组合：状态 + 关键字
  expect(ids(filterTasks(tree, { status: 'running', text: 'login' }))).toEqual([1, 2, 3]);
});

test('任务树保留祖先：命中的后代把整条父链带出来，但不反向补被筛掉的子孙', () => {
  const pending = [
    { id: 10, parent_id: null, role: 'worker', status: 'completed', integration: 'pending', goal: '待合并' },
    { id: 11, parent_id: null, role: 'worker', status: 'completed', integration: 'merged', goal: '已合并' },
  ];
  // mine：completed + pending/review 待我批准合并，或有未答复 notice
  expect(ids(filterTasks(pending, { mine: true }))).toEqual([10]);
  expect(ids(filterTasks(pending, { mine: true, openNoticeIds: [11] }))).toEqual([10, 11]);
  // 祖先通路：只命中 #3，#1 / #2 作为通路保留
  expect(ids(filterTasks(tree, { text: 'Fix LOGIN' }))).toEqual([1, 2, 3]);
  // 父只匹配自己时，不把不匹配的子任务带出来
  expect(ids(filterTasks(tree, { text: '中间层' }))).toEqual([1, 2]);
  // 空结果就是空结果
  expect(filterTasks(tree, { text: '不存在的关键字' })).toEqual([]);
});

test('拆解队列筛选：状态 / planner / 角色 / 关键字', () => {
  const specs = [
    { id: 1, planner_task_id: 9, status: 'pending', role: 'worker', goal: '写页面', name: 'build-page' },
    { id: 2, planner_task_id: 9, status: 'planned', role: 'research', goal: '调研旧实现', name: 'study-old' },
    { id: 3, planner_task_id: 11, status: 'dropped', role: 'worker', goal: '重复', name: 'dup' },
  ];
  expect(ids(filterSpecs(specs, {}))).toEqual([1, 2, 3]);
  expect(ids(filterSpecs(specs, { status: 'pending' }))).toEqual([1]);
  expect(ids(filterSpecs(specs, { status: ['pending', 'planned'] }))).toEqual([1, 2]);
  expect(ids(filterSpecs(specs, { planner: 9 }))).toEqual([1, 2]);
  expect(ids(filterSpecs(specs, { role: 'worker' }))).toEqual([1, 3]);
  expect(ids(filterSpecs(specs, { text: 'PAGE' }))).toEqual([1]);          // 匹配 name，大小写不敏感
  expect(ids(filterSpecs(specs, { text: '调研' }))).toEqual([2]);          // 匹配 goal
  expect(ids(filterSpecs(specs, { status: 'pending', role: 'worker', text: 'page' }))).toEqual([1]);
  expect(filterSpecs(specs, { text: '没有这个' })).toEqual([]);
});

test('意图筛选：流程 / 闸门 / 状态 / 关键字', () => {
  const intents = [
    { id: 1, flow: 'develop', plan_gate: 'proposed', status: 'awaiting', content: '做左边栏' },
    { id: 2, flow: 'explain', plan_gate: 'approved', status: 'completed', content: '解释一下鉴权' },
    { id: 3, flow: 'develop', plan_gate: 'rejected', status: 'failed', content: 'Fix LOGIN' },
  ];
  expect(ids(filterIntents(intents, {}))).toEqual([1, 2, 3]);
  expect(ids(filterIntents(intents, { flow: 'develop' }))).toEqual([1, 3]);
  expect(ids(filterIntents(intents, { gate: 'proposed' }))).toEqual([1]);
  expect(ids(filterIntents(intents, { status: 'completed' }))).toEqual([2]);
  expect(ids(filterIntents(intents, { text: 'login' }))).toEqual([3]);
  expect(ids(filterIntents(intents, { flow: 'develop', text: '左边栏' }))).toEqual([1]);
  expect(ids(filterIntents(intents, { flow: 'explain', status: 'failed' }))).toEqual([]);
});

test('matchX / isFiltering：单个条目判断与「有没有生效条件」', () => {
  expect(matchTask(tree[2], { status: 'running' })).toBe(true);
  expect(matchTask(tree[2], { status: 'completed' })).toBe(false);
  expect(matchSpec({ status: 'pending', planner_task_id: 9, role: 'worker', goal: 'x' }, { planner: '9' })).toBe(true);
  expect(matchIntent({ flow: 'develop', plan_gate: 'proposed', status: 'awaiting', content: 'x' }, { gate: 'proposed' })).toBe(true);
  expect(isFiltering({})).toBe(false);
  expect(isFiltering({ status: 'all', mine: false, text: '   ', integration: 'all', gate: 'all' })).toBe(false);
  expect(isFiltering({ status: 'running' })).toBe(true);
  expect(isFiltering({ mine: true })).toBe(true);
  expect(isFiltering({ integration: 'unmerged' })).toBe(true);
  expect(isFiltering({ text: 'a' })).toBe(true);
});

test('筛选摘要：计数与条件各拼一句，顺序稳定', () => {
  expect(countText(0, 3)).toBe('匹配 0 / 共 3');
  expect(countText(2, 2)).toBe('匹配 2 / 共 2');
  expect(describeFilters({})).toBe('');
  expect(describeFilters({ status: 'running' })).toBe('状态：运行中');
  expect(describeFilters({ status: ['pending', 'planned'] })).toBe('状态：排队中/已排期');
  expect(describeFilters({ role: 'worker', integration: 'unmerged', mine: true, text: 'ab' }))
    .toBe('角色：执行 · 合并：待合并 · 只看待我处理 · 关键字“ab”');
  expect(describeFilters({ planner: 9, flow: 'develop', gate: 'proposed', text: 'X' }))
    .toBe('planner #9 · 流程：开发 · 等你批准 · 关键字“x”');
  // 文本摘要会 trim 并小写，与匹配用的关键字一致
  expect(describeFilters({ text: '  LOGIN  ' })).toBe('关键字“login”');
});

test('折叠状态：解析、序列化、切换都是纯函数且容忍坏数据', () => {
  expect([...parseCollapsed('["tasks","nope","specs"]')]).toEqual(['tasks', 'specs']);
  expect([...parseCollapsed('not json')]).toEqual([]);
  expect([...parseCollapsed('{"tasks":1}')]).toEqual([]);
  expect([...parseCollapsed(null)]).toEqual([]);
  // 序列化按区块顺序（待定事项 → 历史输入 → 规划任务 → 行动任务），结果稳定；已删掉的 drafts 区块被丢弃
  expect(serializeCollapsed(new Set(['specs', 'tasks']))).toBe('["specs","tasks"]');
  expect([...parseCollapsed('["drafts"]')]).toEqual([]);
  expect(serializeCollapsed([])).toBe('[]');
  expect([...toggleCollapsed(new Set(['tasks']), 'specs')]).toEqual(['tasks', 'specs']);
  expect([...toggleCollapsed(new Set(['tasks']), 'tasks')]).toEqual([]);
  expect([...toggleCollapsed(new Set(), 'tasks', true)]).toEqual(['tasks']);
  expect([...toggleCollapsed(new Set(['tasks']), 'tasks', false)]).toEqual([]);
});

test('筛选状态：解析出规整对象，类型不符的字段回落成默认值', () => {
  expect(parseFilters(null)).toEqual({
    tasks: { status: 'all', role: 'all', integration: 'all', mine: false, text: '' },
    specs: { status: 'all', planner: 'all', role: 'all', text: '' },
    intents: { flow: 'all', gate: 'all', status: 'all', text: '' },
  });
  const parsed = parseFilters(JSON.stringify({ tasks: { status: 'running', mine: 'yes', nope: 1 }, specs: { planner: '9' } }));
  expect(parsed.tasks).toMatchObject({ status: 'running', mine: false, role: 'all' });
  expect(parsed.specs).toMatchObject({ planner: '9', status: 'all' });
  expect(parsed.intents).toEqual(DEFAULT_FILTERS.intents);
  expect(parseFilters('nope').tasks.status).toBe('all');
  expect(parseFilters('[]').tasks.text).toBe('');
});
