import { test, expect, setDefaultTimeout } from 'bun:test';
import { fixture, repo } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { createSignal } from '../../src/signal.js';
import { run as automation, runWorkerHook } from '../../src/cli/commands/hooks.js';
import { run as valet } from '../../src/cli/commands/valet.js';
import { COMMANDS } from '../../src/cli/specs/automation-valet.js';
import { parseCLI, validateCLIParameters } from '../../src/cli/parser.js';
setDefaultTimeout(20000);

test('persistent notification Hook mounts, evaluates its condition and deduplicates a source event', async () => {
  const f = fixture(); f.project.kick = () => {}; await repo(f.root);
  try {
    const order = await f.project.order('job', 'main', [], null, false);
    const dispatcher = new Dispatcher(f.project, createSignal(), {});
    const client = { request: (method, params = {}) => dispatcher.dispatch(method, params) };
    const ctx = { client, json: true };
    const invoke = async (handler, root, args, context) => {
      const parsed = parseCLI([root, ...args], COMMANDS);
      validateCLIParameters(parsed.args, parsed.entry);
      parsed.args.shift();
      return handler(root, parsed.args, context);
    };
    const run = args => invoke(automation, 'automation', args, ctx);
    const runValet = (args, context = ctx) => invoke(valet, 'valet', args, context);
    expect(COMMANDS.every(entry => entry.path.startsWith('automation ') || entry.path.startsWith('valet '))).toBe(true);
    expect(COMMANDS.some(entry => /install|auto-select|permission-get|permission-set/.test(entry.path))).toBe(false);
    const directory = await run(['list']);
    const registration = { command: { name: '未挂载指令', command: 'printf unmounted' },
      hook: { name: '未挂载功能', trigger: 'worker.merge_received', mode: 'persistent', enabled: true },
      expected_revisions: { commands: directory.commands.revision, registry: directory.registry.revision }, client_request_id: 'automation-cli-register' };
    const registered = await run(['register', '--data', JSON.stringify(registration)]);
    expect(registered.registered).toBe(true);
    expect((await run(['list'])).registry.items.find(item => item.id === registered.template_id).mount_count).toBe(0);
    expect(await run(['register', '--data', JSON.stringify(registration)])).toEqual(registered);
    const saved = await run(['save', '--data', JSON.stringify({ name: '告知', trigger: 'agent.returned', mode: 'persistent', enabled: true,
      conditions: { statuses: ['paused'] }, actions: [{ type: 'notify', title: 'hook-test', body: 'done' }] }), '--revision', (await run(['list'])).registry.revision]);
    const template = saved.templates.find(item => item.name === '告知');
    await runWorkerHook(['attach', order.task.worker_number, '--data', JSON.stringify({ template_id: template.id, template_version: template.version }),
      '--revision', f.project.taskHooks(order.task.id).revision], client);
    const defaults = await run(['completion-defaults','show']);
    await run(['completion-defaults','set','off','merge','--revision',defaults.revision]);
    expect((await run(['completion-defaults','show'])).enabled).toBe(false);
    expect((await run(['command','list'])).revision).toBe((await run(['list'])).commands.revision);
    const source = f.store.event(order.task.id, 'test.returned', {});
    f.project.emitTaskHook(order.task.id, 'agent.returned', source); await f.project.hookQueue;
    f.project.emitTaskHook(order.task.id, 'agent.returned', source); await f.project.hookQueue;
    expect(f.store.get("SELECT count(*) AS n FROM notices WHERE title='hook-test'").n).toBe(1);
    f.store.update(order.task.id, { status: 'waiting' });
    f.project.emitTaskHook(order.task.id, 'agent.returned'); await f.project.hookQueue;
    expect(f.store.get("SELECT count(*) AS n FROM notices WHERE title='hook-test'").n).toBe(1);

    const signals = await run(['signal','list']);
    const afterSignal = await run(['signal','save','--data',JSON.stringify({ name: '未来信号', schedule: {
      kind: 'once', at: new Date(Date.now() + 86400000).toISOString(), timezone: 'UTC' } }), '--revision',signals.revision]);
    expect((await run(['signal','list'])).revision).toBe(afterSignal.signals.revision);
    for (const args of [['submit','核对暂停工作'], ['schedule','create','--data','{}'], ['emergency','preview']]) {
      await expect(runValet(args)).rejects.toThrow();
      await expect(valet('valet', [...args], ctx)).rejects.toThrow();
    }
    for (const args of [['upgrade','--revision','REV'], ['command','import','--data','{}','--revision','REV'], ['command','history-remove','--all']]) {
      await expect(run(args)).rejects.toThrow();
      await expect(automation('automation', [...args], ctx)).rejects.toThrow();
    }

    const calls = [], management = { client: { management: true, token: 'test-only-not-a-real-invocation',
      request(method, params) { calls.push({ method, params }); return Promise.resolve(params); } }, json: true };
    await runValet(['self','notice','notify','--body','结论','--','--body'],management);
    expect(calls.at(-1)).toMatchObject({ method: 'notice.post', params: { kind: 'info', title: '--body', body: '结论' } });
    const questions = { questions: [{ header: '取舍', question: '采用哪种方式？', options: [
      { label: '保留', description: '保持原行为。' }, { label: '调整', description: '明确改变行为。' } ] }] };
    await runValet(['self','notice','ask','决策','--questions-json',JSON.stringify(questions)],management);
    expect(calls.at(-1)).toMatchObject({ method: 'notice.post', params: { kind: 'question', questions: questions.questions } });
    const requested = calls.length;
    await expect(runValet(['self','notice','notify','结果','--questions-json',JSON.stringify(questions)],management)).rejects.toThrow();
    await expect(runValet(['receipt','show','12','--limit','1.5'],management)).rejects.toThrow();
    await expect(runValet(['self','title','冒充管家'])).rejects.toThrow();
    await expect(automation('automation',['register','--file','must-not-open'],ctx)).rejects.toThrow();
    expect(calls.length).toBe(requested);

    const temporary = await dispatcher.dispatch('hooks.temporary_create', { hook: { name: '临时创建独立工作', trigger: 'worker.parent_ready', enabled: true,
      actions: [{ type: 'create_worker', content: '只创建、不启动', start: false }] },
      expected_revisions: { registry: f.project.hooksList().registry.revision }, client_request_id: 'temporary-create-worker' });
    const main = await f.project.bootstrapMain();
    f.project.attachTaskHook(main.id, { template_id: temporary.template_id, template_version: 1 }, f.project.taskHooks(main.id).revision);
    f.project.emitTaskHook(main.id, 'worker.parent_ready'); await f.project.hookQueue;
    const history = f.project.temporaryAutomationHistory({ id: temporary.template_id });
    expect(history.usage).toMatchObject({ succeeded_total: 1, mount_count: 0, reclaimable: true });
    expect(f.store.get("SELECT count(*) AS n FROM tasks WHERE goal='只创建、不启动'").n).toBe(1);
    const created = f.store.get("SELECT id FROM tasks WHERE goal='只创建、不启动'");
    // Temporary runtime execution is a system submission, not a new user input.
    expect(f.project.inspect(created.id).goal_input_source).toEqual({ kind: 'system', worker_id: null, worker_number: null });
    expect(f.project.inspect(order.task.id).goal_input_source.kind).toBe('user');
  } finally { await f.close(); }
});
