import { test, expect } from 'bun:test';
import { GOAL_TITLE_LIMIT, summarizeGoal, taskTitle } from '../../src/ui/web/assets/format.js';

// 详情页顶部短标题的口径必须与后端 src/core/project/graph.js 的 summarize 一致：
// 第一行、压缩空白、超 60 字截断加省略号；空输入不崩、也不把空串当标题。

test('summarizeGoal：短文本原样保留，不截断', () => {
  expect(summarizeGoal('更清晰的项目工作台')).toBe('更清晰的项目工作台');
});

test('summarizeGoal：多行只取第一行', () => {
  expect(summarizeGoal('一句话标题\n\n目标：完整长文\n现状：已核实')).toBe('一句话标题');
});

test('summarizeGoal：超过 60 字截断并加省略号', () => {
  const long = 'a'.repeat(GOAL_TITLE_LIMIT + 20);
  const summary = summarizeGoal(long);
  expect(summary).toBe(`${'a'.repeat(GOAL_TITLE_LIMIT)}…`);
  expect(summary.length).toBe(GOAL_TITLE_LIMIT + 1);
  // 恰好 60 字不截断。
  expect(summarizeGoal('b'.repeat(GOAL_TITLE_LIMIT))).toBe('b'.repeat(GOAL_TITLE_LIMIT));
});

test('summarizeGoal：压缩首行里的连续空白并去掉首尾', () => {
  expect(summarizeGoal('  修  复\t登录   问题  \n第二行')).toBe('修 复 登录 问题');
});

test('summarizeGoal：空 / null / undefined 返回 null，不抛错', () => {
  for (const value of ['', '   ', '\n\n', null, undefined]) expect(summarizeGoal(value)).toBeNull();
});

test('taskTitle：用 goal 摘要；goal 为空时退回 任务 #id', () => {
  expect(taskTitle({ id: 42, goal: '更清晰的项目工作台' })).toBe('更清晰的项目工作台');
  expect(taskTitle({ id: 42, goal: '第一行\n第二行' })).toBe('第一行');
  expect(taskTitle({ id: 42, goal: '' })).toBe('任务 #42');
  expect(taskTitle({ id: 42 })).toBe('任务 #42');
  expect(taskTitle(null)).toBe('任务 #?');
});
