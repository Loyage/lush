import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, until } from '../helpers.js';
import { AgentProvider } from '../../src/agent/provider.js';
import { AgentInvocationError, piProcessFailure, safeInvocationMessage } from '../../src/agent/invocation-error.js';

const SECRET = 'PRIVATE-STDERR-AND-CREDENTIAL';
test('Pi diagnostic classification returns only fixed text, including overflow and unknown errors', () => {
  for (const [code, stderr, overflow, expected] of [
    [1, `Failed to load extension /private/${SECRET}: Cannot find module 'bun:ffi'`, false, 'pi_extension_load_failed'],
    [127, `lush-agent-guard: spawn ${SECRET} ENOENT`, false, 'pi_launch_failed'],
    [1, `No API key for ${SECRET}`, false, 'pi_model_connection_failed'],
    [1, `Model ${SECRET} not found`, false, 'pi_model_connection_failed'],
    [1, SECRET, false, 'pi_invocation_failed'],
    [1, `Failed to load extension ${SECRET}`, true, 'pi_invocation_failed'],
  ]) {
    const error = piProcessFailure(code, stderr, overflow);
    expect(error.code).toBe(expected);
    expect(error.message).not.toContain(SECRET);
    expect(error.message).toContain('建议：');
    error.message = SECRET;
    expect(safeInvocationMessage(error)).not.toContain(SECRET);
  }
  expect(safeInvocationMessage(new Error(SECRET))).toBeNull();
  expect(safeInvocationMessage({ code: 'pi_extension_load_failed', message: SECRET })).toBeNull();
  expect(new AgentInvocationError(SECRET).code).toBe('pi_invocation_failed');
});

for (const [label, stderr, summary] of [
  ['extension', `Failed to load extension /private/${SECRET}: Cannot find module 'bun:ffi'`, 'Pi 扩展加载失败'],
  ['connection', `401 Unauthorized ${SECRET}`, 'Pi 模型或来源连接不可用'],
  ['unknown', SECRET, '未获得可公开的具体原因'],
]) test(`management ${label} failure survives Provider -> Run -> inspect without raw diagnostics or replay`, async () => {
  const f = fixture();
  try {
    f.project.kick = () => {};
    const command = path.join(f.root, 'failing-pi');
    fs.writeFileSync(command, `#!/usr/bin/env bun\nprocess.stderr.write(${JSON.stringify(stderr)}); process.exit(1);\n`, { mode: 0o755 });
    f.config.env.LUSH_PI_COMMAND = command;
    f.project.provider = new AgentProvider(f.config, f.project.agentSettings);
    const connection = await f.project.agentConnections.forScope('device').save({
      label: 'failure fixture', provider: 'deepseek', auth_type: 'api_key', models: ['deepseek-chat'],
    }, { api_key: SECRET });
    const manager = f.project.submitManagementInstruction({ instruction: '诊断测试，不调用真实模型',
      profile: { agent: 'pi', config_mode: 'lush', connection_id: connection.id, model: 'deepseek/deepseek-chat' } }).task;
    f.project.pump();
    await Promise.all([...f.project.running.values()].map(run => run.promise));
    const task = f.project.inspect(manager.id);
    expect(task.status).toBe('failed');
    expect(task.calls).toBe(1);
    expect(task.error).toContain(summary);
    expect(task.error).toContain('建议：');
    expect(task.error).toContain('不自动重放');
    expect(task.management).toMatchObject({ enabled: false, can_enable: false, state: 'failed', reason: task.error });
    expect(task.management.last_execution.reason).toBe(task.error);
    expect(task.runs).toHaveLength(1);
    expect(task.runs[0]).toMatchObject({ status: 'failed' });
    expect(task.runs[0].error).toContain(summary);
    expect(task.runs[0].error).toContain('建议：');
    expect(task.agent_token_hash).toBeNull();
    const persisted = JSON.stringify({ task, events: f.store.all('SELECT data FROM events WHERE task_id=?', manager.id) });
    expect(persisted).not.toContain(SECRET);
    expect(persisted).not.toContain('/private/');
    expect(fs.readdirSync(path.join(f.config.home, 'agent-runtime'))).toEqual([]);
    f.project.pump();
    expect(f.project.running.has(manager.id)).toBe(false);
    expect(f.store.task(manager.id).calls).toBe(1);
    expect(() => f.project.updateManagementBinding(manager.id, true, task.management.revision)).toThrow('cannot be replayed');
  } finally { await f.close(); }
});

for (const interrupted of [false, true]) test(`management ${interrupted ? 'interruption' : 'untyped exception'} never persists raw exception text`, async () => {
  let entered = false;
  const f = fixture({ async run({ signal }) {
    entered = true;
    if (!interrupted) throw new Error(SECRET);
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error(SECRET)), { once: true }));
  } });
  try {
    f.project.kick = () => {};
    const manager = f.project.submitManagementInstruction({ instruction: '脱敏诊断测试' }).task;
    f.project.pump();
    await until(() => entered);
    if (interrupted) f.project.running.get(manager.id).controller.abort(new Error(SECRET));
    await Promise.all([...f.project.running.values()].map(run => run.promise));
    const task = f.project.inspect(manager.id);
    expect(task.status).toBe('failed');
    expect(task.error).toContain(interrupted ? '调用被中断' : '未记录可用的具体原因');
    expect(task.runs[0].error).toContain(interrupted ? '调用被中断' : '未记录可用的具体原因');
    expect(JSON.stringify(task)).not.toContain(SECRET);
    expect(task.management.enabled).toBe(false);
  } finally { await f.close(); }
});

test('unknown-effect occurrences keep their original diagnostic when a later Provider failure arrives', async () => {
  const f = fixture();
  try {
    f.project.kick = () => {};
    const manager = f.project.submitManagementInstruction({ instruction: '保留未知结果' }).task;
    f.project.failManagementOccurrence(manager.id, 'unknown');
    const before = f.project.inspect(manager.id);
    f.project.failManagementOccurrence(manager.id, 'failed', new AgentInvocationError('pi_extension_load_failed'));
    const after = f.project.inspect(manager.id);
    expect(after.management.state).toBe('unknown');
    expect(after.error).toBe(before.error);
    expect(after.management.reason).toBe(before.management.reason);
    expect(after.error).toContain('副作用未知');
  } finally { await f.close(); }
});
