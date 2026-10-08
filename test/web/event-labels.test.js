import { test, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { EVENTS, eventLabel } from '../../src/ui/web/assets/format.js';

function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory);
    return entry.isDirectory() ? sources(path) : entry.name.endsWith('.js') ? [readFileSync(path, 'utf8')] : [];
  });
}

test('所有源码中直接写入的事件类型都有中文名称，避免新事件退回纯代码标题', () => {
  const types = new Set();
  for (const directory of ['../../src/core/', '../../src/persistence/']) {
    for (const source of sources(new URL(directory, import.meta.url))) {
      // 仅提取 event 调用的字符串类型参数；动态状态事件在下方显式覆盖。
      for (const match of source.matchAll(/\.event\([^,\n]+,\s*(['"])([^'"]+)\1/g)) types.add(match[2]);
    }
  }
  expect(types.size).toBeGreaterThan(100);
  for (const type of types) {
    expect(Object.hasOwn(EVENTS, type)).toBe(true);
    expect(eventLabel({ type })).toMatch(/[\u4e00-\u9fff]/);
  }
});

test('动态结算与批量合并状态事件也有中文名称', () => {
  for (const type of ['completed', 'failed', 'cancelled', ...['merge.run', 'merge.orchestrate'].flatMap(prefix =>
    ['started', 'paused', 'completed', 'failed', 'cancelled'].map(status => `${prefix}.${status}`)),
    ...['hook', 'completion'].flatMap(prefix => ['succeeded', 'failed', 'unknown'].map(status => `${prefix}.execution_${status}`))]) {
    expect(Object.hasOwn(EVENTS, type)).toBe(true);
    expect(eventLabel({ type })).toMatch(/[\u4e00-\u9fff]/);
  }
});

test('自动链配置、下一人工环节和过期执行有独立中文名称且不改写来源', () => {
  expect(eventLabel({ type: 'hook.completion_defaults_configured' })).toBe('调整新指令结束后自动处理默认值');
  for (const type of ['task.completion_changed', 'completion.reminder', 'completion.execution_started', 'completion.execution_superseded']) {
    const source = Object.freeze({ type });
    expect(Object.hasOwn(EVENTS, type)).toBe(true);
    expect(eventLabel(source)).toMatch(/[\u4e00-\u9fff]/);
    expect(source.type).toBe(type);
  }
  expect(eventLabel({ type: 'completion.execution_failed' })).toContain('失败');
  expect(eventLabel({ type: 'completion.execution_unknown' })).toContain('待核验');
});

test('定时提交、停机错过与动作跳过有独立名称，不冒充 Agent 已开始', () => {
  expect(eventLabel({ type: 'hook.scheduled_submitted' })).toBe('定时 Hook 已提交待执行动作');
  expect(eventLabel({ type: 'hook.schedule_missed' })).toBe('定时 Hook 已错过提交时间');
  expect(eventLabel({ type: 'hook.execution_skipped' })).toBe('Hook 动作已跳过');
});

test('命令提交、示例初始化和父侧收到合并区分触发与执行，不冒充推送成功', () => {
  expect(eventLabel({ type: 'worker.merge_received' })).toBe('此 Worker 已收到合并');
  expect(eventLabel({ type: 'hook.command_example_installed' })).toBe('初始化停用的命令 Hook 示例');
  expect(eventLabel({ type: 'hook.command_submitted' })).toBe('命令 Hook 已提交待安全执行');
  expect(eventLabel({ type: 'hook.updated' })).toBe('调整 Hook');
});

test('daemon Hook events and answer provenance have explicit labels without guessing old answers', () => {
  expect(eventLabel({ type: 'hook.daemon_configured' })).toBe('调整 daemon 自动选择 Hook');
  expect(eventLabel({ type: 'hook.daemon_failed' })).toContain('失败');
  expect(eventLabel({ type: 'notice.answered', data: { answer_source: 'lush' } })).toBe('Lush 自动选择');
  expect(eventLabel({ type: 'notice.answered', data: { answer_source: 'user' } })).toBe('用户答复');
  expect(eventLabel({ type: 'notice.answered', data: { answer: '请由 Agent 自行判断并继续。' } })).toBe('已答复');
});

test('时间信号与管理操作有独立中文标签，提交不冒充开始或业务成功，动态失败未知保留含义', () => {
  for (const type of [...['saved', 'removed', 'emitted', 'missed'].map(state => `hook.signal_${state}`),
    ...['created', 'binding_updated', 'signal_skipped', 'signal_submitted', 'invocation_started', 'action_submitted',
      'action_skipped', 'action_completed', 'settled', 'failed', 'unknown'].map(state => `management.${state}`)]) {
    const source = Object.freeze({ type });
    expect(Object.hasOwn(EVENTS, type)).toBe(true); expect(eventLabel(source)).toMatch(/[\u4e00-\u9fff]/); expect(source.type).toBe(type);
  }
  expect(eventLabel({ type: 'hook.signal_emitted' })).toBe('时间信号已发出');
  expect(eventLabel({ type: 'hook.signal_missed' })).toContain('错过');
  expect(eventLabel({ type: 'management.signal_submitted' })).toBe('管理信号已提交待执行');
  expect(eventLabel({ type: 'management.action_submitted' })).toBe('管理操作已提交待安全点');
  expect(eventLabel({ type: 'management.invocation_started' })).toBe('管理 Agent 开始调用');
  expect(eventLabel({ type: 'management.action_completed' })).toBe('管理操作已执行');
  expect(eventLabel({ type: 'management.failed' })).toContain('失败');
  expect(eventLabel({ type: 'management.unknown' })).toContain('待核验');
});

test('分支观测与未归因移动不冒充写入者证明，历史事件名称保留', () => {
  expect(eventLabel({ type: 'invocation.branch_observed' })).toBe('调用期分支变动观测');
  const source = Object.freeze({ type: 'invocation.target_branch_moved', data: Object.freeze({ reason: 'unattributed_ref_movement' }) });
  expect(eventLabel(source)).toBe('目标分支存在未归因的移动');
  expect(source.data.reason).toBe('unattributed_ref_movement');
  expect(eventLabel({ type: 'invocation.target_branch_moved' })).toBe('目标分支被越过交付直接推进');
});

test('提醒与待决问题的名称不同；未知类型不猜测语义、不读取原型属性', () => {
  expect(eventLabel({ type: 'task.reserved' })).toBe('已预约合并');
  expect(eventLabel({ type: 'notice.opened', data: { kind: 'info' } })).toBe('提醒');
  expect(eventLabel({ type: 'notice.opened', data: { kind: 'question' } })).toBe('向你提问');
  for (const type of ['future.event', 'constructor', 'toString', '__proto__']) {
    expect(eventLabel({ type })).toBe('未识别事件');
  }
});
