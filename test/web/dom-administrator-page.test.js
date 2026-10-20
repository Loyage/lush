import { test, expect } from 'bun:test';
import { installDom, deepText, dialogButton, dialogText } from '../dom-stub.js';
import { until } from '../helpers.js';
import { createAdministratorPage } from '../../src/ui/web/assets/administrator-page.js';
import { closeDialog } from '../../src/ui/web/assets/dialog.js';
import { ADMINISTRATOR_API, ADMINISTRATOR_MODE, ADMINISTRATOR_SCOPE } from '../../src/administrator/protocol.js';

const button = (root, title) => root.querySelectorAll('button').find(node => node.textContent === title);

// This page has no existing main-flow coverage. One DOM flow verifies the UI contract with
// an injected API; it does not stand in for the parent's authenticated service/Provider integration.
test('administrator page: separate creation and first-input confirmations, retained unknown evidence, direct emergency stop', async () => {
  const dom = installDom(), requests = [];
  let worker = null, instructions = [], online = false, receiptFound = false;
  const request = async (url, options = {}) => {
    expect(url.startsWith(ADMINISTRATOR_API + '/')).toBe(true);
    const route = new URL(url, 'http://test.invalid').pathname.slice(ADMINISTRATOR_API.length + 1);
    const body = options.body ? JSON.parse(options.body) : null; requests.push({ route, body, method: options.method || 'GET' });
    if (route === 'status') return { version: 1, online };
    if (route === 'workers') return { version: 1, items: worker ? [worker] : [], next_cursor: null, has_more: false };
    if (route === 'worker') return { version: 1, worker, instructions, events: [{ id: 9, type: 'administrator.tool_failed', created_at: 'now',
      data: { status: 'unknown', effect: 'unknown', credential: 'PRIVATE_PAYLOAD_CANARY' } }], next_cursor: null, has_more: false, coverage: 'bounded safe events' };
    if (route === 'receipt') {
      if (!receiptFound) return { version: 1, found: false };
      const original = requests.filter(item => item.route === 'commit').at(-1).body.definition;
      worker = { ...worker, status: 'unknown', can_input: false, error: '原始安全失败证据', original_failure: {
        stage: 'execution', detail: { source: 'executor_receipt', error: { name: 'Error', message: '最初写后异常采样', credential: 'PRIVATE_PAYLOAD_CANARY' } },
      } };
      const instruction = { id: 'unknown-original', instruction: original.instruction, status: 'unknown', effect: 'unknown', error: '原始安全失败证据' };
      return { version: 1, found: true, definition: structuredClone(original), worker, instruction };
    }
    if (route === 'preview') { online = true; return { version: 1, confirmation_id: 'confirmation-' + requests.length,
      expires_at: new Date(Date.now() + 60000).toISOString(), definition: structuredClone(body.definition) }; }
    if (route === 'commit') {
      expect(body.confirm).toBe(true);
      if (body.definition.kind === 'create') {
        expect(body.definition.instruction).toBeUndefined();
        worker = { id: 'admin-one', worker_number: 'ADM1', name: body.definition.name, mode: ADMINISTRATOR_MODE,
          scope: ADMINISTRATOR_SCOPE, can_input: true, status: 'idle', result: null, error: null };
        return { version: 1, worker };
      }
      if (body.definition.instruction === 'unknown invocation') throw new Error('response lost');
      worker = { ...worker, status: 'running', can_input: false };
      const instruction = { id: 'instruction-one', instruction: body.definition.instruction, status: 'running', effect: 'unknown', error: null };
      instructions = [instruction]; return { version: 1, worker, instruction };
    }
    if (route === 'stop') { worker = { ...worker, status: 'stopping', can_input: false }; return { version: 1, worker }; }
    throw new Error('unexpected route');
  };
  let page;
  try {
    page = createAdministratorPage({ container: dom.node('detail'), request }); await page.ready;
    expect(deepText(page.root)).toContain('不能据此判断没有历史');
    expect(requests.every(item => item.method === 'GET')).toBe(true);
    expect(requests.some(item => item.route === 'workers')).toBe(false);
    const name = page.root.querySelector('.administrator-name'); name.value = '初稿'; name.oninput();
    const create = button(page.root, '核对权限范围并创建'); expect(create.classList.contains('agent-call')).toBe(false);
    const stale = create.onclick(); await until(() => dialogButton(dom, '确认高权限范围并创建'));
    name.value = '跨项目救援'; name.oninput(); await stale;
    expect(dom.node('modal').hidden).toBe(true);
    expect(requests.filter(item => item.route === 'commit')).toHaveLength(0);

    const creating = create.onclick(); await until(() => dialogButton(dom, '确认高权限范围并创建'));
    expect(dialogText(dom)).toContain('跨项目救援'); expect(dialogText(dom)).toContain('仅建立管理员身份');
    expect(dialogButton(dom, '确认高权限范围并创建').classList.contains('agent-call')).toBe(false);
    await dialogButton(dom, '确认高权限范围并创建').onclick(); await creating;
    expect(worker.status).toBe('idle'); expect(instructions).toHaveLength(0);
    expect(deepText(page.root)).toContain('尚未调用 Agent');
    expect(deepText(page.root)).not.toContain('PRIVATE_PAYLOAD_CANARY');
    const input = page.root.querySelector('.administrator-instruction');
    input.value = '核对项目 A 与 B\n 保留精确空白 '; input.oninput();
    const submit = button(page.root, '核对本条指令并确认执行');
    expect(submit.classList.contains('agent-call')).toBe(true); expect(submit.getAttribute('data-help')).toContain('token');
    const submitting = submit.onclick(); await until(() => dialogButton(dom, '确认本条指令并执行'));
    expect(dialogText(dom)).toContain('核对项目 A 与 B\n 保留精确空白 ');
    expect(dialogText(dom)).toContain('administrator'); expect(dialogText(dom)).toContain('device_user');
    expect(dialogButton(dom, '确认本条指令并执行').classList.contains('agent-call')).toBe(true);
    expect(requests.filter(item => item.route === 'commit')).toHaveLength(1);
    await dialogButton(dom, '确认本条指令并执行').onclick(); await submitting;
    expect(requests.filter(item => item.route === 'commit')[1].body.definition).toMatchObject({ kind: 'input', id: 'admin-one',
      instruction: '核对项目 A 与 B\n 保留精确空白 ', mode: ADMINISTRATOR_MODE, scope: ADMINISTRATOR_SCOPE });
    expect(deepText(page.root)).toContain('副作用未知');

    worker = { ...worker, status: 'idle', can_input: true }; await page.refresh();
    const later = page.root.querySelector('.administrator-instruction'); later.value = 'unknown invocation'; later.oninput();
    const unknown = button(page.root, '核对本条指令并确认执行').onclick(); await until(() => dialogButton(dom, '确认本条指令并执行'));
    await dialogButton(dom, '确认本条指令并执行').onclick();
    const writes = requests.filter(item => item.route === 'commit'); expect(writes).toHaveLength(3);
    expect(dialogButton(dom, '确认本条指令并执行').disabled).toBe(true);
    const originalKey = writes[2].body.definition.client_request_id;
    expect(deepText(page.root)).toContain(originalKey); expect(deepText(page.root)).toContain('提交结果未确认');
    closeDialog(); await unknown; await page.refresh();
    expect(button(page.root, '核对本条指令并确认执行').disabled).toBe(true);
    expect(JSON.parse(dom.sessionStorage.getItem('lush.administrator.unconfirmed.v1'))[0].definition.client_request_id).toBe(originalKey);
    expect(requests.filter(item => item.route === 'commit')).toHaveLength(3);
    expect(requests.some(item => item.route === 'receipt')).toBe(false); // no automatic recovery polling
    await button(page.root, '只读核对本次提交').onclick();
    expect(button(page.root, '核对本条指令并确认执行').disabled).toBe(true);
    expect(deepText(page.root)).toContain('原请求可能仍在并发提交');
    expect(JSON.parse(dom.sessionStorage.getItem('lush.administrator.unconfirmed.v1'))).toHaveLength(1);
    receiptFound = true; await button(page.root, '只读核对本次提交').onclick();
    expect(JSON.parse(dom.sessionStorage.getItem('lush.administrator.unconfirmed.v1'))).toHaveLength(0);
    expect(deepText(page.root)).toContain('原提交已确认存在 · 不等于执行成功');
    expect(deepText(page.root)).toContain('原始安全失败证据');
    expect(deepText(page.root)).toContain('最初写后异常采样');
    expect(deepText(page.root)).not.toContain('PRIVATE_PAYLOAD_CANARY');
    expect(deepText(page.root)).toContain(originalKey);
    expect(button(page.root, '核对本条指令并确认执行').disabled).toBe(true); // actual unknown effects still block execution
    expect(requests.filter(item => item.route === 'receipt').every(item => item.method === 'GET')).toBe(true);
    expect(requests.filter(item => item.route === 'commit')).toHaveLength(3);
    const stop = button(page.root, '紧急停止并撤销未执行授权'); expect(stop.classList.contains('agent-call')).toBe(false);
    await stop.onclick();
    expect(requests.filter(item => item.route === 'stop')).toHaveLength(1);
    expect(dom.node('modal').hidden).toBe(true);
    expect(deepText(page.root)).toContain('停止中，尚未确认退出');
    expect(button(page.root, '紧急停止并撤销未执行授权').disabled).toBe(true);
    expect(requests.every(item => !item.route.includes('notice'))).toBe(true);
  } finally { page?.dispose(); closeDialog(); dom.restore(); }
});
