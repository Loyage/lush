import { test, expect, beforeEach, afterEach } from 'bun:test';
import { installDom, deepText, dialogButton } from '../dom-stub.js';
import { renderCompletionAutomation, renderAcceptanceNoticeAutomation } from '../../src/ui/web/assets/automation-completion.js';
import { closeDialog } from '../../src/ui/web/assets/dialog.js';
let dom, model, reads, actions, intercept, owned, node;
const json = value => Response.json(value);
const policy = () => ({ version: 1, revision: 'r1', completion_defaults: { enabled: false, level: 'merge' }, acceptance_notice_defaults: { enabled: true },
  display_principles: { completion: 'all', push: 'all', convergence: 'all', acceptance_notice: 'all' } });
beforeEach(() => {
  model = policy(); reads = []; actions = []; intercept = null; owned = true;
  dom = installDom({ fetch: async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    if (body) actions.push(body); else reads.push(String(url));
    if (intercept) return intercept(url, body);
    if (body) { for (const [key, value] of Object.entries(body.params.patch)) model[key] = { ...model[key], ...value }; model.revision = 'r2'; }
    return json({ automation_settings: model });
  } });
});
afterEach(() => { node?.dispose(); closeDialog(); dom.restore(); });
const button = label => node.querySelectorAll('button').find(item => item.textContent === label);
const field = label => node.querySelector(`[aria-label="${label}"]`);
async function start(render = renderCompletionAutomation, catalogue = { automation_settings: model }) { node = render({ catalogue, ownsPage: () => owned }); dom.node('detail').replaceChildren(node); await node.ready; }
async function choose(label, value) { const select = field(label); select.value = value; await select.onchange(); }
async function save(confirm = true) { const pending = button('保存项目设置').onclick(); const control = dialogButton(dom, confirm ? '授权并保存' : '取消'); if (control) await control.onclick(); await pending; }

test('project completion edits only future defaults and display, no Worker directory, records or device writes', async () => {
  await start(); expect(reads).toEqual([]); expect(actions).toEqual([]);
  expect(field('用户新建 Worker 默认开启到').value).toBe('off'); expect(field('默认显示原则').value).toBe('all');
  expect(node.querySelector('.completion-workers')).toBeNull(); expect(node.querySelector('.completion-history-rows')).toBeNull();
  expect(deepText(node)).toContain('功能简介：'); expect(deepText(node)).toContain('原理简介：'); expect(deepText(node)).toContain('child');
  await choose('用户新建 Worker 默认开启到', 'merge'); await choose('默认显示原则', 'user'); expect(actions).toEqual([]);
  expect(button('保存项目设置').classList.contains('agent-call')).toBe(true); expect(button('保存项目设置').getAttribute('data-help')).toContain('token');
  await save(); expect(actions).toEqual([{ method: 'hooks.automation_settings', params: { patch: { completion_defaults: { enabled: true, level: 'merge' }, display_principles: { completion: 'user' } }, expected_revision: 'r1' } }]);
  expect(button('保存项目设置').disabled).toBe(true); expect(deepText(node)).toContain('已有 Worker 授权未修改');
});

test('automatic acceptance confirms resource removal and Agent costs; cancelling retains the complete draft', async () => {
  await start(); await choose('用户新建 Worker 默认开启到', 'accept');
  const pending = button('保存项目设置').onclick(); const confirm = dialogButton(dom, '授权并保存');
  expect(deepText(dom.node('modal'))).toContain('分支子树'); expect(deepText(dom.node('modal'))).toContain('脏改动阻止验收');
  expect(deepText(dom.node('modal'))).toContain('不是质量评审'); expect(confirm.classList.contains('agent-call')).toBe(true); expect(confirm.getAttribute('data-help')).toContain('token');
  await dialogButton(dom, '取消').onclick(); await pending; expect(actions).toEqual([]); expect(field('用户新建 Worker 默认开启到').value).toBe('accept');
  await save(); expect(model.completion_defaults).toEqual({ enabled: true, level: 'accept' });
  await choose('用户新建 Worker 默认开启到', 'off'); await save(); expect(model.completion_defaults).toEqual({ enabled: false, level: 'accept' });
});

test('new order notice defaults save independently of locked child completion and never trigger Agent', async () => {
  await start(renderAcceptanceNoticeAutomation); await choose('用户新建 Worker 默认待验收告知', 'off'); await save();
  expect(actions[0].params.patch).toEqual({ acceptance_notice_defaults: { enabled: false }, display_principles: { acceptance_notice: 'all' } });
  expect(button('保存项目设置').classList.contains('agent-call')).toBe(false); expect(deepText(node)).toContain('派生 child 默认关闭'); expect(deepText(node)).toContain('未知结果');
});

test('stale/conflicting or malformed ACK retains draft and original revision and blocks automatic replay', async () => {
  await start(); await choose('用户新建 Worker 默认开启到', 'merge');
  intercept = () => Response.json({ error: 'revision changed' }, { status: 409 }); await save();
  expect(field('用户新建 Worker 默认开启到').value).toBe('merge'); expect(deepText(node)).toContain('revision changed'); expect(button('保存项目设置').disabled).toBe(true);
  await save(); expect(actions).toHaveLength(1);
  const refresh = button('重新读取项目设置').onclick(); await dialogButton(dom, '取消').onclick(); await refresh; expect(reads).toEqual([]);
  intercept = null; const reset = button('重新读取项目设置').onclick(); await dialogButton(dom, '放弃并读取').onclick(); await reset;
  expect(field('用户新建 Worker 默认开启到').value).toBe('off');
  await choose('用户新建 Worker 默认开启到', 'merge'); intercept = () => json({ automation_settings: model }); await save();
  expect(deepText(node)).toContain('保存响应未确认'); expect(button('保存项目设置').disabled).toBe(true); expect(actions).toHaveLength(2);
});

test('missing/incompatible policy never invents an editable default; initial and reload failures remain explicit', async () => {
  await start(renderCompletionAutomation, { completion_defaults: { enabled: true, level: 'accept' } });
  expect(field('用户新建 Worker 默认开启到').disabled).toBe(true); expect(button('保存项目设置').disabled).toBe(true); expect(deepText(node)).toContain('不使用假默认值');
  intercept = () => { throw Error('offline'); }; await button('重新读取项目设置').onclick(); expect(deepText(node)).toContain('offline'); expect(actions).toEqual([]);
});

test('inactive save and late read never repaint another view; return preserves draft and requires explicit read', async () => {
  await start(); await choose('默认显示原则', 'main'); let release;
  intercept = () => new Promise(resolve => release = resolve); const pending = button('保存项目设置').onclick();
  owned = false; release(json({ automation_settings: { ...model, revision: 'saved', display_principles: { ...model.display_principles, completion: 'main' } } })); await pending;
  owned = true; node.setSubpage(); expect(field('默认显示原则').value).toBe('main'); expect(button('保存项目设置').disabled).toBe(true); expect(actions).toHaveLength(1);
  expect(deepText(node)).toContain('离开期间');
  intercept = null; const reading = button('重新读取项目设置').onclick(); await dialogButton(dom, '放弃并读取').onclick(); await reading; expect(field('默认显示原则').value).toBe('all');
});
