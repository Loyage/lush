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

test('归并准备、辅助产物和资源事件都有中文标签，不冒充来源落地或独立指令验收', () => {
  for (const type of ['branch.convergence_configured', 'branch.convergence_defaults_configured', ...[
    'queue_failed', 'member_fixed', 'batch_fixed', 'baseline_refixed', 'repair_attempt_fixed',
    'integration_created', 'integration_ready', 'integration_settled', 'integration_stopped',
    'landing_prepared', 'withdrawal_requested', 'helper_reclaimed', 'helper_cleanup_failed',
  ].map(name => `convergence.${name}`)]) {
    const event = Object.freeze({ type, data: Object.freeze({ run_id: 42, generation: 2 }) });
    expect(Object.hasOwn(EVENTS, type)).toBe(true); expect(eventLabel(event)).toMatch(/[\u4e00-\u9fff]/);
    expect(event.type).toBe(type); expect(event.data.generation).toBe(2);
    expect(eventLabel(event)).not.toBe(eventLabel({ type: 'task.merge_integrated' }));
    expect(eventLabel(event)).not.toBe(eventLabel({ type: 'task.accepted' }));
  }
  expect(eventLabel({ type: 'branch.convergence_defaults_configured' })).toBe('保存未来新 Worker 归并默认设置');
  expect(eventLabel({ type: 'convergence.integration_ready' })).toContain('待实际退出');
  expect(eventLabel({ type: 'convergence.integration_settled' })).toContain('非父分支落地');
  expect(eventLabel({ type: 'convergence.integration_stopped' })).toContain('请求');
  expect(eventLabel({ type: 'convergence.landing_prepared' })).toContain('未确认落地');
  expect(eventLabel({ type: 'convergence.helper_cleanup_failed' })).toContain('未完成');
});

test('项目自动化与告知事件有中文名称，决定记录不冒充告知已发送', () => {
  expect(eventLabel({ type: 'hook.automation_settings_configured' })).toBe('保存项目自动化设置');
  expect(eventLabel({ type: 'task.acceptance_notice_changed' })).toBe('调整待验收告知设置');
  const observed = { type: 'task.acceptance_notice_observed', data: { enabled: false, notice_id: null, round: 2 } };
  expect(eventLabel(observed)).toBe('记录本轮待验收告知决定');
  expect(eventLabel(observed)).not.toContain('发送'); expect(observed.data.enabled).toBe(false);
});

test('项目维护事件只承诺接受请求，不冒充已经停止或运行', () => {
  expect(eventLabel({ type: 'maintenance.interrupted' })).toBe('接受当前项目全部中断请求');
  expect(eventLabel({ type: 'maintenance.resumed' })).toBe('接受当前项目全部继续请求');
  expect(eventLabel({ type: 'maintenance.resume_blocked' })).toContain('受阻');
});

test('中断完成信号与接受中断请求分开，不冒充继续或重启', () => {
  expect(eventLabel({ type: 'worker.interrupted' })).toBe('Worker 中断完成信号');
  expect(eventLabel({ type: 'project.interrupted' })).toBe('项目中断完成');
  expect(eventLabel({ type: 'project.interrupted' })).not.toBe(eventLabel({ type: 'maintenance.interrupted' }));
  expect(eventLabel({ type: 'maintenance.cancelled' })).toBe('维护中断批次已撤销');
  expect(eventLabel({ type: 'maintenance.unknown' })).toBe('维护中断结果待核验');
  for (const type of ['maintenance.cancelled','maintenance.unknown']) expect(eventLabel({ type })).not.toContain('完成');
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

test('统一自动化请求和目标接收事件只说明提交与既有授权，不冒充开始或完成', () => {
  const names = {
    'automation.operation_submitted': '自动化操作请求已提交',
    'completion.execution_submitted': '自动处理动作已提交待安全执行',
    'delivery.requested': '目标已接收已授权交付（未新增授权）',
  };
  for (const [type, label] of Object.entries(names)) {
    const source = Object.freeze({ type, data: Object.freeze({ tool: 'request_merge', status: 'succeeded', operation_id: 12 }) });
    expect(Object.hasOwn(EVENTS, type)).toBe(true); expect(eventLabel(source)).toBe(label);
    for (const claim of ['成功', '完成', '已开始', '已合入']) expect(eventLabel(source)).not.toContain(claim);
    expect(source.type).toBe(type); expect(source.data.operation_id).toBe(12);
  }
});

test('自动化操作结束按明确安全状态展示，成功不证明代码合入，失败和未知不重放', () => {
  const type = 'automation.operation_finished';
  expect(Object.hasOwn(EVENTS, type)).toBe(true);
  const labels = {
    succeeded: '自动化操作已完成（不代表代码合入或测试通过）',
    failed: '自动化操作失败（不自动重放）',
    unknown: '自动化操作结果待核验（未知副作用不重放）',
  };
  for (const [status, label] of Object.entries(labels)) {
    const source = Object.freeze({ type, data: Object.freeze({ status, tool: 'request_merge', error: 'PRIVATE_DIAGNOSTIC', operation_id: 12 }) });
    expect(eventLabel(source)).toBe(label); expect(eventLabel(source)).not.toContain('PRIVATE_DIAGNOSTIC');
    expect(eventLabel(source)).not.toContain('成功'); expect(eventLabel(source)).not.toContain('已合入');
    if (status !== 'succeeded') expect(eventLabel(source)).not.toContain('完成');
    expect(source.data.status).toBe(status); expect(source.data.operation_id).toBe(12);
  }
  for (const data of [undefined, {}, { result: 'succeeded' }, ...['submitted', 'waiting', 'running', 'future', 'constructor', '__proto__'].map(status => ({ status }))]) {
    const source = { type, ...(data ? { data } : {}) }, before = structuredClone(source);
    expect(eventLabel(source)).toBe(EVENTS[type]); expect(eventLabel(source)).toContain('待核验');
    expect(eventLabel(source)).not.toContain('成功'); expect(eventLabel(source)).not.toContain('完成');
    expect(source).toEqual(before);
  }
});

test('验收资源回收的开始、未完成和历史补办有独立名称，不冒充验收完成或改写来源', () => {
  const names = {
    'task.acceptance_started': '开始验收资源回收（受检）',
    'task.acceptance_failed': '验收资源回收未完成',
    'task.acceptance_reclaimed': '已补办验收资源回收',
  };
  for (const [type, label] of Object.entries(names)) {
    const source = Object.freeze({ type, data: Object.freeze({ head_commit: 'fixed-source' }) });
    expect(Object.hasOwn(EVENTS, type)).toBe(true); expect(eventLabel(source)).toBe(label);
    expect(source.type).toBe(type); expect(source.data.head_commit).toBe('fixed-source');
    expect(eventLabel(source)).not.toBe(eventLabel({ type: 'task.accepted' }));
  }
  expect(eventLabel({ type: 'task.acceptance_started' })).not.toContain('完成');
  expect(eventLabel({ type: 'task.acceptance_failed' })).toContain('未完成');
  expect(eventLabel({ type: 'task.acceptance_reclaimed' })).toContain('补办');
});

test('single-resource reclamation receipts do not claim whole-batch acceptance completion', () => {
  const event = Object.freeze({ type: 'branch.archive.outcome', data: Object.freeze({ acceptance_execution: 12 }) });
  expect(eventLabel(event)).toBe('记录单项资源回收结果（非整批验收完成）');
  expect(eventLabel(event)).not.toBe(eventLabel({ type: 'task.accepted' }));
  expect(event.type).toBe('branch.archive.outcome');
  expect(event.data.acceptance_execution).toBe(12);
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

test('快捷指令定义、导入、历史授权与实际执行分开显示，未知不冒充成功或改写来源', () => {
  const types = [...['saved','authorized','removed','pending','started','succeeded','failed','unknown'].map(state => `shortcut.command_${state}`), 'shortcut.commands_imported'];
  const labels = types.map(type => {
    const source = Object.freeze({ type, data: Object.freeze({ command_id: 'fixed-command', command_version: 3, authorized: false }) });
    const original = structuredClone(source), label = eventLabel(source);
    expect(Object.hasOwn(EVENTS, type)).toBe(true);
    expect(label).toMatch(/[\u4e00-\u9fff]/);
    expect(source).toEqual(original);
    return label;
  });
  expect(new Set(labels).size).toBe(types.length);
  expect(eventLabel({ type: 'shortcut.command_saved' })).toBe('保存快捷指令定义');
  expect(eventLabel({ type: 'shortcut.commands_imported' })).toBe('导入旧命令为快捷指令');
  for (const type of ['shortcut.command_saved', 'shortcut.commands_imported']) {
    for (const claim of ['授权', '执行', '成功']) expect(eventLabel({ type })).not.toContain(claim);
  }
  expect(eventLabel({ type: 'shortcut.command_authorized' })).toBe('历史：调整快捷指令版本授权');
  expect(eventLabel({ type: 'shortcut.command_authorized' })).toContain('历史');
  expect(eventLabel({ type: 'shortcut.command_pending' })).toBe('快捷指令已提交待执行');
  expect(eventLabel({ type: 'shortcut.command_pending' })).not.toContain('成功');
  expect(eventLabel({ type: 'shortcut.command_failed' })).toContain('失败');
  expect(eventLabel({ type: 'shortcut.command_unknown' })).toContain('待核验');
  for (const claim of ['成功', '完成']) expect(eventLabel({ type: 'shortcut.command_unknown' })).not.toContain(claim);
});

test('运行记录移除的安全审计有中文标签，不冒充指令删除、取消执行或擦除审计', () => {
  const type = 'shortcut.command_history_removed';
  expect(Object.hasOwn(EVENTS, type)).toBe(true);
  for (const data of [
    { removed_count: 1, execution_id: 'c8c8c8c8-0000-4000-8000-000000000001' },
    { removed_count: 3, clear: true },
    { removed_count: 0, clear: true },
  ]) {
    const event = { type, data }, original = structuredClone(event), label = eventLabel(event);
    expect(label).toBe('移除快捷指令运行列表记录（安全审计保留）');
    expect(label).not.toBe(eventLabel({ type: 'shortcut.command_removed' }));
    expect(label).not.toContain('取消'); expect(label).not.toContain('执行成功');
    expect(event).toEqual(original);
  }
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
  expect(eventLabel({ type: 'management.invocation_started' })).toBe('Valet 开始调用');
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

test('即时管理与受控能力新事件区分提交/授权/执行，未知不冒充失败或重放', () => {
  for (const type of ['input_submitted', 'capability_requested', 'capability_confirmation',
    'capability_started', 'capability_completed', 'capability_failed'].map(name => `management.${name}`)) {
    expect(Object.hasOwn(EVENTS, type)).toBe(true); expect(eventLabel({ type })).toMatch(/[\u4e00-\u9fff]/);
  }
  expect(eventLabel({ type: 'management.input_submitted' })).toContain('待调用');
  expect(eventLabel({ type: 'management.capability_requested' })).not.toContain('已执行');
  expect(eventLabel({ type: 'management.capability_confirmation' })).toContain('不代表已执行');
  const source = Object.freeze({ type: 'management.capability_failed', data: Object.freeze({ status: 'unknown', receipt_id: 42 }) });
  expect(eventLabel(source)).toContain('待核验'); expect(eventLabel(source)).toContain('不自动重放');
  expect(source.data.status).toBe('unknown'); expect(source.data.receipt_id).toBe(42);
});

test('条件发射七类事件中文命名区分挂载/派发，不冒充Agent执行或验收', () => {
  const types = ['emitted', 'condition_satisfied', 'dispatch_started', 'dispatch_succeeded',
    'dispatch_failed', 'emission_cancelled', 'exclusive_released'].map(type => `input.${type}`);
  for (const type of types) {
    const source = Object.freeze({ type, data: Object.freeze({ draft_id: 42, input_id: 8, worker_id: 700 }) });
    expect(Object.hasOwn(EVENTS, type)).toBe(true); expect(eventLabel(source)).toMatch(/[\u4e00-\u9fff]/);
    expect(eventLabel(source)).not.toBe(eventLabel({ type: 'invocation.inputs_delivered' }));
    expect(eventLabel(source)).not.toBe(eventLabel({ type: 'task.accepted' }));
    expect(source.type).toBe(type); expect(source.data.draft_id).toBe(42);
  }
  expect(eventLabel({ type: 'input.emitted' })).toContain('可靠挂载');
  expect(eventLabel({ type: 'input.emitted' })).toContain('不代表已创建');
  expect(eventLabel({ type: 'input.condition_satisfied' })).toContain('信号已满足');
  expect(eventLabel({ type: 'input.dispatch_started' })).toContain('准入');
  expect(eventLabel({ type: 'input.dispatch_succeeded' })).toContain('派发');
  expect(eventLabel({ type: 'input.dispatch_failed' })).toContain('失败');
  expect(eventLabel({ type: 'input.emission_cancelled' })).toContain('未执行');
  expect(eventLabel({ type: 'input.exclusive_released' })).toContain('占用已释放');
});

test('暂存和解除暂存不冒充 Agent 已收到追加输入', () => {
  expect(eventLabel({ type: 'task.input_buffered' })).toBe('追加输入已暂存，等待投递');
  expect(eventLabel({ type: 'task.input_released' })).toBe('追加输入已解除暂存，等待 Agent 接收');
  expect(eventLabel({ type: 'invocation.inputs_delivered' })).toBe('输入已交给 Agent');
});

test('提醒与待决问题的名称不同；未知类型不猜测语义、不读取原型属性', () => {
  expect(eventLabel({ type: 'task.reserved' })).toBe('已预约合并');
  expect(eventLabel({ type: 'notice.opened', data: { kind: 'info' } })).toBe('提醒');
  expect(eventLabel({ type: 'notice.opened', data: { kind: 'question' } })).toBe('向你提问');
  for (const type of ['future.event', 'constructor', 'toString', '__proto__']) {
    expect(eventLabel({ type })).toBe('未识别事件');
  }
});
