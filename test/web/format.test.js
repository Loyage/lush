import { test, expect } from 'bun:test';
import { GOAL_TITLE_LIMIT, STATUS, statusOf, interruptReason, summarizeGoal, taskTitle } from '../../src/ui/web/assets/format.js';

test('interrupt_state is intent, not a replacement status; absent/terminal projections stay compatible', () => {
  for (const status of ['running', 'awaiting', 'waiting', 'queued']) {
    expect(statusOf({ status, interrupt_state: 'requested' })).toEqual({ label: '中断请求中', icon: STATUS[status].icon });
    expect(interruptReason({ status, interrupt_state: 'requested' })).toContain('可撤销');
    expect(statusOf({ status, interrupt_state: null })).toEqual(STATUS[status]);
    expect(statusOf({ status })).toEqual(STATUS[status]);
  }
  expect(statusOf({ status: 'queued', interrupt_state: 'resuming' }).label).toBe('继续排队中');
  expect(interruptReason({ status: 'queued', interrupt_state: 'resuming' })).toContain('旧调用释放');
  expect(statusOf({ status: 'paused', agent_wakes: 0 }).label).toBe('待开始');
  expect(statusOf({ status: 'paused', agent_wakes: 1 }).label).toBe('已暂停');
  for (const status of ['completed', 'failed', 'cancelled']) {
    expect(statusOf({ status, interrupt_state: 'requested' })).toEqual(STATUS[status]);
    expect(interruptReason({ status, interrupt_state: 'resuming' })).toBeNull();
  }
});

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
  expect(taskTitle({ id: 42, goal: '' })).toBe('Worker #42');
  expect(taskTitle({ id: 42 })).toBe('Worker #42');
  expect(taskTitle(null)).toBe('Worker #?');
});
