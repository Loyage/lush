import { test, expect, beforeEach, afterEach } from 'bun:test';
import { HOOK_ACTIONS } from '../../src/core/hooks.js';
import { installDom, deepText, dialogButton } from '../dom-stub.js';
import { until } from '../helpers.js';
import { renderPushAutomation } from '../../src/ui/web/assets/automation-push.js';
import { closeDialog } from '../../src/ui/web/assets/dialog.js';
let dom, catalogue, node, calls, reads, owned, intercept;
const command = () => ({ id: 'push-command', name: '推送', kind: 'shell', command: 'git push', version: 7, authorized: false });
// Short state labels are shared with Worker detail; confirmations keep full action labels.
const btn = label => node.querySelectorAll('button').find(item => item.textContent === ({ '启用 Hook': '开启', '停用 Hook': '关闭' }[label] || label));
const mount = () => catalogue.command_example.hooks.mounts[0];
beforeEach(() => {
  calls = []; reads = []; owned = true; intercept = null;
  catalogue = { actions: structuredClone(HOOK_ACTIONS), commands: { version: 1, revision: 'commands-r', items: [command()] },
    command_example: { worker_id: 37, hook_id: 'persisted-push', hooks: { version: 1, worker_id: 37, revision: 'hooks-r', mounts: [
      { id: 'persisted-push', name: 'A renamed actual main mount', enabled: false, editable: true, trigger: 'worker.merge_received', mode: 'persistent',
        actions: [{ type: 'command', command_id: 'push-command', command_version: 1 }] }] } } };
  dom = installDom({ fetch: async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    if (body) calls.push(body); else reads.push(String(url));
    const result = intercept?.(url, body); if (result) return result;
    if (body) { mount().enabled = body.params.enabled; catalogue.command_example.hooks.revision = 'saved-r'; return Response.json(catalogue.command_example.hooks); }
    return Response.json(catalogue);
  } });
});
afterEach(() => { node?.dispose(); closeDialog(); dom.restore(); });
async function start() { node = renderPushAutomation({ catalogue: structuredClone(catalogue), ownsPage: () => owned }); dom.node('detail').replaceChildren(node); await node.ready; }

for (const [name, change, reason] of [
  ['inline Shell', c => mount().actions = [{ type: 'command', command: 'git push' }], '显式导入'],
  ['deleted reference', c => c.commands.items = [], '已删除'],
  ['missing directory', c => delete c.commands, '目录不可用'],
  ['malformed directory', c => c.commands.items[0].version = 0, '目录不可用'],
  ['kind mismatch', c => c.commands.items = [{ ...command(), kind: 'prompt', prompt: '检查', command: undefined }], '类型不匹配'],
  ['invalid prompt trigger/mode', c => { mount().actions = [{ type: 'prompt_command', command_id: 'push-command' }]; c.commands.items = [{ ...command(), kind: 'prompt', prompt: '检查' }]; }, '一次性'],
  ['missing action directory', c => delete c.actions, '动作目录不可用'],
  ['malformed action directory', c => c.actions = [null], '动作目录不可用'],
  ['malformed mount list', c => c.command_example.hooks.mounts = {}, '读面不可用'],
  ['malformed mount actions', c => mount().actions = [null], '读面不可用'],
  ['unknown action', c => mount().actions = [{ type: 'unknown-action' }], '未知动作'],
  ['identity mismatch', c => c.command_example.hooks.worker_id = 1, '读面不可用'],
  ['tombstone with same-title replacement', c => mount().id = 'different-hook', '已删除'],
]) test(`project main push refuses ${name}, including direct callbacks; never creates, imports or replays`, async () => {
  change(catalogue); await start(); const enable = btn('启用 Hook');
  expect(enable.disabled).toBe(true); expect(enable.parentNode.classList.contains('help-host')).toBe(true);
  expect(enable.parentNode.getAttribute('data-help')).toContain(reason); await enable.onclick(); expect(enable.disabled).toBe(true);
  expect(calls).toHaveLength(0); expect(dom.node('modal').querySelector('[role="dialog"]')).toBeNull();
  expect(btn('查看 main Worker 自动化')).toBeTruthy(); await btn('展开推送高级设置').onclick();
  expect(node.querySelector('a[href="#hook-tools"]')).toBeNull(); expect(deepText(node)).toContain('Web 指令定义／模板编辑入口已移除'); expect(node.querySelector('.push-history')).toBeNull(); expect(reads).toHaveLength(0);
});

for (const invalid of ['inline', 'deleted', 'directory']) test(`stopping remains possible with ${invalid}, without command authorization or history removal`, async () => {
  mount().enabled = true; mount().state = 'unknown'; mount().reason = '需核对安全现场'; mount().last_execution = { id: 8, output: 'PRIVATE_OUTPUT' };
  if (invalid === 'inline') mount().actions = [{ type: 'command', command: 'git push' }];
  if (invalid === 'deleted') catalogue.commands.items = [];
  if (invalid === 'directory') catalogue.commands = null;
  await start(); expect(btn('停用 Hook').disabled).toBe(false); expect(deepText(node)).toContain('结果未知'); expect(deepText(node)).toContain('需核对安全现场');
  expect(deepText(node)).not.toContain('PRIVATE_OUTPUT'); await btn('停用 Hook').onclick();
  expect(calls).toEqual([{ method: 'worker.hook_update', params: { id: 37, hook_id: 'persisted-push', enabled: false, expected_revision: 'hooks-r' } }]);
  expect(mount().last_execution.id).toBe(8); expect(btn('启用 Hook').disabled).toBe(true); expect(reads).toHaveLength(0);
});

test('valid latest Shell ignores retired authorization/version grants; cancel, failure and reread do not replay', async () => {
  await start(); expect(btn('启用 Hook').disabled).toBe(false); expect(btn('启用 Hook').classList.contains('agent-call')).toBe(false);
  let pending = btn('启用 Hook').onclick(); expect(deepText(dom.node('modal'))).toContain('不是沙箱'); expect(deepText(dom.node('modal'))).toContain('当前 v7');
  await dialogButton(dom, '取消').onclick(); await pending; expect(calls).toHaveLength(0);
  intercept = (_url, body) => body ? Response.json({ error: 'revision conflict' }, { status: 409 }) : null;
  pending = btn('启用 Hook').onclick(); await dialogButton(dom, '确认启用推送').onclick(); await pending;
  expect(calls[0].params.expected_revision).toBe('hooks-r'); expect(btn('启用 Hook').disabled).toBe(true); expect(deepText(node)).toContain('revision conflict');
  await btn('启用 Hook').onclick(); expect(calls).toHaveLength(1);
  intercept = null; await btn('重新读取推送设置').onclick(); expect(btn('启用 Hook').disabled).toBe(false); expect(calls).toHaveLength(1);
});

for (const type of ['prompt_command', 'request_merge', 'integrate_deliveries', 'message', 'retry_worker', 'resume_worker', 'create_worker']) {
  test(`registered ${type} requires both reference and Agent safety confirmations before mutation`, async () => {
    const action = type === 'prompt_command' ? { type, command_id: 'prompt-command' } : { type, start: true };
    if (type === 'prompt_command') { catalogue.commands.items.push({ id: 'prompt-command', name: '提示词', kind: 'prompt', prompt: '检查代码', version: 2 }); mount().actions = [action]; mount().mode = 'once'; mount().trigger = 'worker.parent_ready'; }
    else mount().actions.push(action);
    await start(); const enable = btn('启用 Hook'); expect(enable.classList.contains('agent-call')).toBe(true); expect(enable.getAttribute('data-help')).toContain('token');
    const pending = enable.onclick(); expect(dialogButton(dom, '启用指令 Hook').classList.contains('agent-call')).toBe(true);
    await dialogButton(dom, '启用指令 Hook').onclick(); await until(() => dialogButton(dom, '授权并挂载'));
    expect(calls).toHaveLength(0); const confirm = dialogButton(dom, '授权并挂载'); expect(confirm.classList.contains('agent-call')).toBe(true); expect(confirm.getAttribute('data-help')).toContain('token');
    await confirm.onclick(); await pending; expect(calls).toHaveLength(1); expect(calls[0].params).toEqual({ id: 37, hook_id: 'persisted-push', enabled: true, expected_revision: 'hooks-r' });
  });
}

test('create without start is not labeled as an Agent invocation', async () => {
  mount().actions.push({ type: 'create_worker', start: false }); await start(); expect(btn('启用 Hook').classList.contains('agent-call')).toBe(false);
  const pending = btn('启用 Hook').onclick(); await dialogButton(dom, '确认启用推送').onclick(); await pending;
  expect(calls).toHaveLength(1); expect(dialogButton(dom, '授权并挂载')).toBeNull();
});

for (const exit of ['cancel', 'leave']) test(`Agent confirmation ${exit} does not submit a main mutation`, async () => {
  mount().actions.push({ type: 'request_merge' }); await start(); const pending = btn('启用 Hook').onclick();
  await dialogButton(dom, '启用指令 Hook').onclick(); await until(() => dialogButton(dom, '授权并挂载'));
  if (exit === 'leave') owned = false;
  await dialogButton(dom, exit === 'cancel' ? '取消' : '授权并挂载').onclick(); await pending; expect(calls).toHaveLength(0);
});
