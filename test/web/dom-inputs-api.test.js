import { test, expect, afterAll } from 'bun:test';
import { repo, gate, until } from '../helpers.js';
import { managementToolCLI } from '../agent/management-tool-cli-fixture.js';
import { AgentProvider } from '../../src/agent/provider.js';
import { fetch as httpFetch, setup } from './harness.js';
import { installDom } from '../dom-stub.js';

let fixture;
const requests = [];
let lostManagementResponse = null;
const dom = installDom({ fetch: async (url, options) => {
  const request = options?.body ? JSON.parse(options.body) : null; if (request) requests.push(request);
  const response = await httpFetch(fixture.url + url, options);
  if (request?.method === 'management.submit' && lostManagementResponse) {
    const loss = lostManagementResponse; lostManagementResponse = null; loss.received.resolve(); await loss.release.promise;
    throw Error('controlled lost management response');
  }
  return response;
} });
const { resetUiState, ui } = await import('../../src/ui/web/assets/state.js');
const { initComposer } = await import('../../src/ui/web/assets/composer.js');
const { openInputs } = await import('../../src/ui/web/assets/render-inputs.js');
const { selectComposerMode, currentEdit, collapseComposer } = await import('../../src/ui/web/assets/composer-workspace.js');
const { action } = await import('../../src/ui/web/assets/api.js');
const { loadDetail } = await import('../../src/ui/web/assets/detail.js');
const { registerNavigation } = await import('../../src/ui/web/assets/navigate.js');
afterAll(() => dom.restore());
function editorDom() {
  const form = dom.node('input-form'), input = dom.node('input'); input.tagName = 'TEXTAREA';
  form.insertBefore(input, null); dom.node('composer-shell').insertBefore(form, null);
}

test('real detail DOM submits an explicit append through HTTP/RPC and returns composer to create mode', async () => {
  fixture = await setup(); fixture.project.stopping = true; await repo(fixture.root);
  const restore = registerNavigation({ refresh: async () => {}, detail: async () => {} });
  try {
    dom.localStorage.clear(); resetUiState(); dom.node('input').value = ''; dom.node('input-parent').value = ''; editorDom(); await initComposer();
    const { task } = await fixture.project.order('初始要求', 'main', [], null, false);
    await loadDetail(task.id);
    expect(dom.node('input-form').dataset.mode).toBe('create');
    const append = dom.node('detail').querySelectorAll('button').find(node => node.textContent === '追加输入');
    await append.onclick();
    expect(dom.node('composer-mode-target').textContent).toContain(task.worker_number);
    const input = dom.node('input'); input.value = '后续要求'; input.oninput();
    await input.onkeydown({ key: 'Enter', preventDefault() { throw Error('Enter must only insert a newline'); } });
    await input.onkeydown({ key: 's', ctrlKey: true, repeat: true, preventDefault() {} });
    expect(fixture.store.all('SELECT * FROM drafts')).toHaveLength(0);
    await input.onkeydown({ key: 's', metaKey: true, preventDefault() {} });
    expect(input.value).toBe('后续要求');
    expect(fixture.store.all('SELECT * FROM drafts')).toHaveLength(1);
    expect(fixture.store.all('SELECT * FROM inputs')).toHaveLength(1); // Saving does not authorize the append.
    await input.onkeydown({ key: 'Enter', ctrlKey: true, preventDefault() {} });
    expect(fixture.store.all('SELECT * FROM drafts')).toHaveLength(1);
    expect(input.value).toBe(''); expect(dom.node('input-form').dataset.mode).toBe('create');
    expect(fixture.store.all('SELECT * FROM agent_runs')).toHaveLength(0);
  } finally { restore(); await fixture.close(); }
});

test('real composer resumes, updates and emits an order draft through HTTP/RPC and SQLite', async () => {
  fixture = await setup(); fixture.project.stopping = true; await repo(fixture.root);
  const restore = registerNavigation({ refresh: async () => {} });
  try {
    dom.localStorage.clear(); fixture.project.kick = () => {}; fixture.project.scheduleInputEmissions = () => {};
    const repair = (await fixture.project.order('source repair', 'main', [], null, false)).task;
    fixture.store.update(repair.id, { reservation: JSON.stringify({ version: 2, kind: 'merge', queue_protocol: 1,
      status: 'resolving', parent_id: repair.parent_id, baseline: repair.base_commit }) });
    const refs = [{ version: 1, kind: 'text', target: {}, label: '快照', quote: '引用原文', location: {}, captured_at: '2026-01-01T00:00:00.000Z' }];
    const draft = await action('draft.add', { content: '原始暂存', references: refs, branch: 'main' }, { refresh: false });
    resetUiState(); dom.node('input').value = ''; dom.node('input-parent').value = ''; editorDom(); await initComposer();
    await selectComposerMode('order'); requests.length = 0;
    expect(ui.composerParents.find(row => row.branch === 'main').freeze.creation_commit).toBe(repair.base_commit);
    expect(dom.node('input-parent').querySelectorAll('option').some(row => row.textContent.includes('可从固定提交新建'))).toBe(true);
    const input = dom.node('input');
    await input.onkeydown({ key: 'ArrowUp', preventDefault() {} });
    expect(currentEdit().saved).toMatchObject({ id: draft.id, revision: 1, references: refs });
    input.value = '原位续写后的正文'; input.oninput();
    await collapseComposer(); expect(requests.filter(request => request.method === 'draft.update')).toHaveLength(1);
    resetUiState(); input.value = ''; dom.node('input-parent').value = ''; editorDom(); await initComposer();
    dom.node('composer-launcher').click();
    await dom.node('composer-menu-order').click();
    const choose = dom.node('composer-choose-draft'), list = dom.node('composer-draft-list');
    const label = () => choose.querySelector('.view-control-label').textContent;
    expect(list.hidden).toBe(true); expect(label()).toBe('展开草稿');
    expect(choose.getAttribute('aria-expanded')).toBe('false');
    const opening = choose.click(); // Collapse while the lookup is still pending.
    expect(label()).toBe('收起草稿'); expect(choose.getAttribute('aria-expanded')).toBe('true');
    await choose.click(); await opening;
    expect(list.hidden).toBe(true); expect(label()).toBe('展开草稿');
    await choose.click();
    expect(list.hidden).toBe(false); expect(label()).toBe('收起草稿');
    const writes = requests.length, content = input.value, entry = currentEdit();
    await choose.click();
    expect(list.hidden).toBe(true); expect(choose.getAttribute('aria-expanded')).toBe('false');
    expect(currentEdit()).toBe(entry); expect(input.value).toBe(content); expect(requests).toHaveLength(writes);
    await choose.click();
    await list.querySelectorAll('button').find(row => row.dataset.editKey === `draft:${draft.id}`).click();
    expect(list.hidden).toBe(true); expect(label()).toBe('展开草稿');
    expect(choose.getAttribute('aria-expanded')).toBe('false');
    expect(input.value).toBe('原位续写后的正文');
    await input.onkeydown({ key: 's', ctrlKey: true, preventDefault() {} }); expect(input.value).toBe('原位续写后的正文');
    expect(fixture.store.draft(draft.id).content).toBe('原位续写后的正文');
    await openInputs({ item: { kind: 'draft', id: draft.id } });
    const panel = dom.node('detail').querySelector('.input-detail'), body = panel.querySelector('textarea');
    expect(body).toBe(input); // same actual component, not a synchronized second body
    expect(currentEdit().saved.id).toBe(draft.id);
    ui.restoreInputContext = async () => { ui.view = { id: 'overview' }; };
    await ui.inputEditor.continuePortable();
    expect(ui.inputEditor.inDetail).toBe(false);
    await openInputs({ item: { kind: 'draft', id: draft.id } });
    const key = options => ui.composerKeydown({ preventDefault() {}, ...options });
    body.value += '！'; body.oninput();
    await key({ key: 'Enter' });
    await key({ key: 'Enter', ctrlKey: true, isComposing: true });
    await key({ key: 'Enter', metaKey: true, repeat: true });
    expect(requests.some(request => request.method === 'input.emit')).toBe(false);
    await key({ key: 's', metaKey: true });
    expect(fixture.store.draft(draft.id).revision).toBe(3);
    expect(body.value).toBe('原位续写后的正文！');
    body.value += '最终'; body.oninput();
    await key({ key: 'Enter', ctrlKey: true });
    expect(requests.find(request => request.method === 'input.emit').params).toMatchObject({ draft_id: draft.id, expected_revision: 4 });
    fixture.project.stopping = false; await fixture.project.drainInputEmissions(); fixture.project.stopping = true;
    const receipt = fixture.project.inputGet('draft', draft.id); expect(receipt.dispatch.state).toBe('succeeded');
    expect(fixture.store.all('SELECT * FROM inputs WHERE content=?', '原位续写后的正文！最终')).toHaveLength(1);
    expect(fixture.project.inputGet('input', receipt.input_id).references[0].quote).toBe('引用原文');
    expect(fixture.store.all('SELECT * FROM agent_runs')).toHaveLength(0);
    expect(fixture.store.task(receipt.dispatch.worker_id).base_commit).toBe(repair.base_commit);
    fixture.store.update(repair.id, { reservation: null });

    // Extend this main flow rather than add a mock-only UI case: new entrance ->
    // real HTTP submit -> restricted Provider/CLI bridge -> same draft + receipt.
    fixture.store.update(receipt.dispatch.worker_id, { status: 'paused' });
    const dependency = (await fixture.project.order('等待完成的工作', 'main', [], null, false)).task;
    const cli = managementToolCLI(fixture.root, 'node'); fixture.config.env.LUSH_PI_COMMAND = cli.command;
    fixture.config.provider = 'pi'; fixture.project.agentSettings.save({ default: { agent: 'pi', config_mode: 'pi' } });
    fixture.project.provider = new AgentProvider(fixture.config, fixture.project.agentSettings);
    await selectComposerMode('order'); input.value = '按条件执行的草稿'; input.oninput(); await ui.inputEditor.detail();
    const conditionUi = dom.node('input-form').querySelector('.draft-condition-valet');
    const conditionText = conditionUi.querySelector('textarea'), handoff = conditionUi.querySelector('button');
    expect(dom.node('input-form').querySelector('.unified-editor-conditions').open).toBe(false);
    expect(handoff.classList.contains('agent-call')).toBe(true); expect(handoff.getAttribute('data-help')).toContain('token');
    conditionText.value = `等 ${dependency.worker_number} 安全收尾后提交`; conditionText.oninput();
    input.value += '（保存确切版本）'; input.oninput();
    const loss = lostManagementResponse = { received: gate(), release: gate() };
    const creating = handoff.click(); await loss.received.promise;
    const exact = { ...currentEdit().saved }; expect(exact.revision).toBe(2);
    expect(fixture.project.inputGet('draft', exact.id).content).toBe(input.value);
    await handoff.click(); // duplicate click and the original submitter share one flight
    const emitsBefore = requests.filter(row => row.method === 'input.emit').length;
    const ordinarySubmit = ui.inputEditor.submit();
    input.value += '（在途新编辑保留）'; input.oninput();
    conditionText.value += '（条件新编辑保留）'; conditionText.oninput();
    loss.release.resolve(); await creating; await ordinarySubmit;
    expect(requests.filter(row => row.method === 'input.emit')).toHaveLength(emitsBefore);
    expect(input.value).toContain('在途新编辑保留'); expect(conditionText.value).toContain('条件新编辑保留');
    expect(fixture.store.all("SELECT * FROM tasks WHERE task_kind='management'")).toHaveLength(1);
    await handoff.click(); // same exact key + instruction resolves the lost ACK
    const managementRequests = requests.filter(row => row.method === 'management.submit');
    expect(managementRequests).toHaveLength(2); expect(managementRequests[1].params).toEqual(managementRequests[0].params);
    expect(managementRequests[0].params).not.toHaveProperty('profile');
    expect(managementRequests[0].params.instruction).toContain(`\"draft_id\":${exact.id},\"revision\":2`);
    expect(managementRequests[0].params.instruction).not.toContain('在途新编辑保留');
    expect(managementRequests[0].params.instruction).not.toContain('条件新编辑保留');
    expect(fixture.project.inputGet('draft', exact.id)).toMatchObject({ revision: 2, content: exact.content, dispatch: null });
    const manager = fixture.store.all("SELECT * FROM tasks WHERE task_kind='management'")[0];
    expect(conditionUi.querySelectorAll('a').map(a => a.getAttribute('href'))).toEqual([`#worker-${manager.id}`, `#input-draft-${exact.id}`]);
    expect(handoff.disabled).toBe(true); await handoff.click();
    expect(fixture.store.all("SELECT * FROM tasks WHERE task_kind='management'")).toHaveLength(1);
    cli.plan([
      { name: 'lush_cli', params: { argv: ['input','draft','show',String(exact.id)] } },
      { name: 'lush_cli', params: { argv: ['input','draft','update',String(exact.id),exact.content,'--revision','2','--after-settled',dependency.worker_number] } },
      { name: 'lush_cli', params: { argv: ['input','draft','submit',String(exact.id),'--revision','3'] } },
    ]);
    fixture.project.stopping = false; fixture.project.pump();
    await until(() => fixture.store.task(manager.id).result && !fixture.project.running.has(manager.id));
    fixture.project.stopping = true;
    const providerResult = JSON.parse(fixture.store.task(manager.id).result);
    for (const key of ['registered','cliActive','sessionActive','modelActive']) expect(providerResult[key]).toEqual(['lush_cli']);
    expect(providerResult.blocked.every(Boolean)).toBe(true);
    expect(providerResult.replies.every(reply => !reply.error)).toBe(true);
    const mounted = fixture.project.inputGet('draft', exact.id);
    expect(mounted).toMatchObject({ content: exact.content, mode: 'order', branch: 'main', conditions: [{ kind: 'worker_settled', worker_id: dependency.id }], dispatch: { state: 'waiting_conditions' } });
    const calls = await (await httpFetch(fixture.url + `/api/worker/${manager.id}/management-calls?after=0`)).json();
    expect(calls.items.filter(row => row.phase === 'finished').map(row => row.method)).toEqual(['input.get','worker.lookup','draft.update','input.emit']);
    expect(input.value).toContain('在途新编辑保留'); expect(conditionText.value).toContain('条件新编辑保留');
  } finally { restore(); await fixture.close(); }
});
