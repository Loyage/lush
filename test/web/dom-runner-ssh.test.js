import { test, expect } from 'bun:test';
import { installDom, deepText, dialogText } from '../dom-stub.js';
import { renderRunnerSettings } from '../../src/ui/web/assets/runner-settings.js';
const button = (root, text) => root.querySelectorAll('button').find(node => node.textContent === text);
const field = (root, key) => root.querySelector(`[data-runner-field="${key}"]`);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture() {
  const calls = [], nodes = { version: 1, revision: 'a'.repeat(64), nodes: [] }; let intercept = () => null;
  const response = (value, status = 200) => ({ ok: status === 200, status, json: async () => value });
  const dom = installDom({ fetch: async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null; calls.push({ url: String(url), body });
    const custom = intercept(String(url), body); if (custom) return custom;
    if (String(url).includes('/ssh/aliases')) return response({ aliases: ['fixture'], status: 'ok', limited: false });
    if (String(url).includes('/runner/nodes')) return response(nodes);
    if (String(url).includes('/runner/credentials')) return response({ version: 1, revision: 'absent', nodes: [] });
    if (body?.method === 'runner.ssh.test') return response({ ok: true, reason: 'connected' });
    if (body?.method === 'runner.nodes.set') return response({ ...nodes, nodes: body.params.nodes });
    throw new Error('unexpected request');
  } });
  dom.window.addEventListener = globalThis.addEventListener; dom.window.removeEventListener = globalThis.removeEventListener;
  const editor = renderRunnerSettings(); dom.node('detail').append(editor.root);
  return { dom, editor, calls, response, intercept(fn) { intercept = fn; }, close() { editor.dispose(); dom.restore(); } };
}

test('new-node dialog discovers via Host transport, offers manual alias, explicit SSH test independent of save/credentials, with help and retained failed input', async () => {
  const f = fixture();
  try {
    await f.editor.ready; expect(f.calls).toHaveLength(2);
    const editing = button(f.editor.root, '新增执行节点').onclick(); await flush();
    const modal = f.dom.node('modal'), select = field(modal, 'ssh_discovered'), alias = field(modal, 'ssh_alias');
    expect(select.querySelectorAll('option').map(row => row.value)).toEqual(['', 'fixture']);
    expect(dialogText(f.dom)).toContain('SSH 成功 ≠ Runner 可用');
    expect(dialogText(f.dom)).toContain('当前系统用户'); expect(dialogText(f.dom)).toContain('Include'); expect(dialogText(f.dom)).toContain('不支持跳板');
    const limits = modal.querySelectorAll('details').find(node => deepText(node).includes('SSH 配置范围与安全限制'));
    expect(Boolean(limits.open)).toBe(false); expect(deepText(limits)).toContain('32 文件');
    expect(dialogText(f.dom)).toContain('试连仅支持安全子集');
    const trial = button(modal, '测试 SSH'); expect(trial.disabled).toBe(true); expect(trial.parentNode.className).toBe('help-host');
    select.value = 'fixture'; select.onchange(); expect(alias.value).toBe('fixture'); expect(trial.disabled).toBe(false);
    expect(trial.classList.contains('agent-call')).toBe(false); expect(trial.dataset.help).toContain('不调用模型');
    await trial.onclick(); expect(dialogText(f.dom)).toContain('SSH 成功 ≠ Runner 可用');
    expect(f.calls.filter(row => row.body).map(row => row.body)).toEqual([{ method: 'runner.ssh.test', params: { ssh_alias: 'fixture' } }]);
    field(modal, 'name').value = '保留名称'; alias.value = 'manual'; alias.listeners.input.forEach(fn => fn()); expect(select.value).toBe('');
    f.intercept((_url, body) => body?.method === 'runner.ssh.test' ? f.response({ error: 'private-output' }, 400) : null);
    await trial.onclick(); expect(dialogText(f.dom)).toContain('填写已保留'); expect(dialogText(f.dom)).not.toContain('private-output');
    expect(alias.value).toBe('manual'); expect(field(modal, 'name').value).toBe('保留名称');
    expect(button(modal, '保存节点').disabled).toBe(false);
    await button(modal, '保存节点').onclick(); await editing;
    expect(f.calls.filter(row => row.body?.method === 'runner.nodes.set')).toHaveLength(1);
    expect(f.calls.filter(row => row.body).every(row => row.url === '/api/host/settings/action')).toBe(true);
  } finally { f.close(); }
});

test('trial is single-flight; changed alias invalidates result, does not force save or clear draft', async () => {
  const f = fixture();
  try {
    await f.editor.ready; const editing = button(f.editor.root, '新增执行节点').onclick(); await flush();
    const modal = f.dom.node('modal'), alias = field(modal, 'ssh_alias'), select = field(modal, 'ssh_discovered');
    select.value = 'fixture'; select.onchange();
    const wait = deferred(); f.intercept((_url, body) => body?.method === 'runner.ssh.test' ? wait.promise : null);
    const trial = button(modal, '测试 SSH'), pending = trial.onclick();
    expect(trial.disabled).toBe(true); expect(trial.parentNode.dataset.help).toContain('进行中'); expect(select.disabled).toBe(true);
    await trial.onclick(); expect(f.calls.filter(row => row.body)).toHaveLength(1);
    alias.value = 'changed'; alias.listeners.input.forEach(fn => fn());
    wait.resolve(f.response({ ok: true })); await pending;
    expect(dialogText(f.dom)).not.toContain('SSH 登录成功'); expect(alias.value).toBe('changed'); expect(trial.disabled).toBe(false);
    await button(modal, '取消').onclick(); await editing;
    expect(f.calls.filter(row => row.body?.method === 'runner.nodes.set')).toHaveLength(0);
  } finally { f.close(); }
});

test('late discovery/trial after close, replacement or dispose cannot overwrite new dialog/page', async () => {
  const f = fixture(); let replacement;
  try {
    await f.editor.ready;
    const read = deferred(); f.intercept(url => url.includes('/ssh/aliases') ? read.promise : null);
    const old = button(f.editor.root, '新增执行节点').onclick();
    await button(f.dom.node('modal'), '取消').onclick(); await old;
    f.intercept(() => null);
    const next = button(f.editor.root, '新增执行节点').onclick(); await flush();
    const nextAlias = field(f.dom.node('modal'), 'ssh_alias'); nextAlias.value = 'new';
    read.resolve(f.response({ aliases: ['stale'], status: 'ok' })); await flush();
    expect(field(f.dom.node('modal'), 'ssh_discovered').querySelectorAll('option').map(row => row.value)).not.toContain('stale'); expect(nextAlias.value).toBe('new');
    nextAlias.listeners.input.forEach(fn => fn());
    const wait = deferred(); f.intercept((_url, body) => body?.method === 'runner.ssh.test' ? wait.promise : null);
    const trial = button(f.dom.node('modal'), '测试 SSH').onclick();
    f.editor.dispose(); await next;
    replacement = renderRunnerSettings(); f.dom.node('detail').replaceChildren(replacement.root); await replacement.ready;
    f.intercept(() => null); const another = button(replacement.root, '新增执行节点').onclick(); await flush();
    wait.resolve(f.response({ ok: true })); await trial;
    expect(dialogText(f.dom)).not.toContain('SSH 登录成功'); expect(deepText(replacement.root)).not.toContain('SSH 登录成功');
    await button(f.dom.node('modal'), '取消').onclick(); await another;
  } finally { replacement?.dispose(); f.close(); }
});

test('pagehide dismisses trial dialog and late result cannot repaint', async () => {
  const f = fixture();
  try {
    await f.editor.ready;
    const editing = button(f.editor.root, '新增执行节点').onclick(); await flush();
    const select = field(f.dom.node('modal'), 'ssh_discovered'); select.value = 'fixture'; select.onchange();
    const wait = deferred(); f.intercept((_url, body) => body?.method === 'runner.ssh.test' ? wait.promise : null);
    const pending = button(f.dom.node('modal'), '测试 SSH').onclick();
    await f.dom.fire('pagehide'); await editing;
    expect(f.dom.node('modal').hidden).toBe(true);
    wait.resolve(f.response({ ok: true })); await pending;
    expect(f.dom.node('modal').hidden).toBe(true); expect(deepText(f.editor.root)).not.toContain('SSH 登录成功');
  } finally { f.close(); }
});

test('limited discovery and unsupported trial explicitly refuse connection, keep form and do not display login success', async () => {
  const f = fixture();
  try {
    await f.editor.ready;
    f.intercept((url, body) => url.includes('/ssh/aliases') ? f.response({ aliases: ['fixture'], status: 'ok', limited: true })
      : body?.method === 'runner.ssh.test' ? f.response({ ok: false, reason: 'config_unsupported' }) : null);
    const editing = button(f.editor.root, '新增执行节点').onclick(); await flush();
    const modal = f.dom.node('modal'); expect(dialogText(f.dom)).toContain('试连将拒绝');
    const select = field(modal, 'ssh_discovered'); select.value = 'fixture'; select.onchange();
    field(modal, 'name').value = '保留'; await button(modal, '测试 SSH').onclick();
    expect(dialogText(f.dom)).toContain('未发起 SSH 连接'); expect(dialogText(f.dom)).toContain('不能验证原配置');
    expect(dialogText(f.dom)).not.toContain('SSH 登录成功'); expect(field(modal, 'name').value).toBe('保留');
    expect(field(modal, 'ssh_alias').value).toBe('fixture');
    await button(modal, '取消').onclick(); await editing;
  } finally { f.close(); }
});

test('discovery failure retains manual path and never requires SSH test before save', async () => {
  const f = fixture();
  try {
    await f.editor.ready;
    f.intercept(url => url.includes('/ssh/aliases') ? f.response({ error: 'secret-path' }, 500) : null);
    const editing = button(f.editor.root, '新增执行节点').onclick(); await flush();
    const modal = f.dom.node('modal'); expect(dialogText(f.dom)).toContain('可继续手填'); expect(dialogText(f.dom)).not.toContain('secret-path');
    field(modal, 'name').value = '手动节点'; field(modal, 'ssh_alias').value = 'manual';
    await button(modal, '保存节点').onclick(); await editing;
    expect(f.calls.filter(row => row.body).map(row => row.body.method)).toEqual(['runner.nodes.set']);
  } finally { f.close(); }
});
