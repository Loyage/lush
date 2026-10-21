import { test, expect } from 'bun:test';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { repo, until } from '../helpers.js';
import { setup, fetch as httpFetch } from './harness.js';
import { managementLegacyRPCProvider as managementToolCLI } from '../agent/management-legacy-rpc-fixture.js';
import { AgentProvider } from '../../src/agent/provider.js';
import { renderManagementCalls } from '../../src/ui/web/assets/render-management-calls.js';

import { resetUiState } from '../../src/ui/web/assets/state.js';
function clipboard() {
  const old = Object.getOwnPropertyDescriptor(globalThis, 'navigator'), copies = [];
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { async writeText(value) { copies.push(value); } } }, configurable: true });
  return { copies, restore() { if (old) Object.defineProperty(globalThis, 'navigator', old); else delete globalThis.navigator; } };
}

test('real controlled Provider/bridge failure -> isolated safe HTTP receipt -> visible per-call summary and exact whitelist copy with stable source links', async () => {
  const f = await setup(); f.project.kick = () => {}; await repo(f.root);
  const c = clipboard(); let dom, section;
  try {
    f.project.scheduleInputEmissions = () => {};
    const dispatch = f.project.managementDispatch.bind(f.project);
    f.project.managementDispatch = async (method, ...args) => {
      const result = await dispatch(method, ...args);
      if (method === 'input.emit') throw new Error('PRIVATE-AFTER-MOUNT token=PRIVATE');
      return result;
    };
    const cli = managementToolCLI(f.root, 'node'); f.config.env.LUSH_PI_COMMAND = cli.command;
    f.project.provider = new AgentProvider(f.config, f.project.agentSettings);
    cli.plan([{ name: 'manager_call', params: { method: 'input.emit', params: { content: 'PRIVATE-INPUT', client_request_id: 'PRIVATE-KEY' } } }]);
    const manager = f.project.submitManagementInstruction({ instruction: '隔离诊断UI测试', profile: { agent: 'pi', config_mode: 'pi' } }).task;
    f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise));
    const receipt = JSON.parse(f.store.task(manager.id).result).replies[0].response.details.receipt_id;
    await f.project.rpcDispatcher.dispatch('management.emergency_stop', { revision: f.project.managementEmergencyPreview().revision, confirm: true });
    const endpoint = `/api/management/receipt?receipt_id=${receipt}&limit=1`;
    const eventCount = f.store.get('SELECT count(*) AS n FROM events').n;
    const response = await httpFetch(f.url + endpoint), first = await response.json();
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(first).toMatchObject({ diagnostic: { original_failure: { code: 'execution_failed' }, effect: 'unknown', disposition: { emergency: 'isolated' } }, input_emit: { mount: 'confirmed', dispatch: 'not_started' } });
    expect((await httpFetch(f.url + endpoint, { anonymous: true })).status).toBe(401);
    expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(eventCount);
    const inspected = await (await httpFetch(f.url + '/api/worker/' + manager.id)).json();
    dom = installDom({ fetch: url => httpFetch(f.url + new URL(url, 'http://fixture').pathname + new URL(url, 'http://fixture').search) }); resetUiState();
    dom.document.body.append(dom.node('detail'));
    section = renderManagementCalls(inspected); dom.node('detail').append(section);
    await until(() => section.querySelector('.management-call-failure'));
    const headingActions = section.querySelector('.section-title').querySelector('.module-actions');
    expect(headingActions.querySelectorAll('.view-control')).toHaveLength(2);
    expect(headingActions.querySelector('.view-sort-icon')).toBeTruthy();
    expect(section.querySelector('.management-calls-controls').querySelectorAll('.view-control')).toHaveLength(0);
    const row = section.querySelectorAll('.management-call').find(node => deepText(node).includes('input.emit'));
    const summary = row.querySelector('.management-call-failure'), disclosure = row.querySelector('.management-call-fold');
    expect(disclosure.open).toBe(false); expect(row.querySelector('.management-call-alert').hidden).toBe(false);
    expect(summary.parentNode.parentNode).toBe(disclosure);
    disclosure.open = true; disclosure.ontoggle();
    expect(row.querySelector('.management-call-head').getAttribute('aria-expanded')).toBe('true');
    expect(summary.hidden).toBe(false); expect(section.classList.contains('management-calls-has-failures')).toBe(true);
    expect(deepText(summary)).toContain('最初失败：执行回调'); expect(deepText(summary)).toContain('底层原因未安全分类');
    expect(deepText(summary)).toContain('已急救隔离'); expect(deepText(row)).not.toContain('PRIVATE');
    expect(row.querySelectorAll('a').some(a => a.getAttribute('href') === '#input-draft-' + first.input_emit.draft_id)).toBe(true);
    expect(row.querySelectorAll('a').some(a => a.getAttribute('href')?.startsWith('#input-input-'))).toBe(false);
    await findByText(row, '复制脱敏诊断').onclick();
    const before = c.copies.at(-1);
    for (const p of summary.children.filter(p => !p.hidden)) expect(before).toContain(p.textContent);
    expect(before).not.toContain('PRIVATE'); expect(before).toContain('尚未读取');
    await findByText(row, '读取关联时间线').onclick();
    expect(deepText(row)).toContain('management.emergency_isolated');
    await findByText(row, '复制脱敏诊断').onclick();
    expect(c.copies.at(-1)).toContain('management.emergency_isolated'); expect(c.copies.at(-1)).toContain('已到本次关联范围末尾');
    const failures = section.querySelectorAll('.management-call-failure').filter(n => !n.hidden);
    expect(failures.length).toBeGreaterThan(0);
    expect(f.store.all("SELECT id FROM events WHERE type='input.emitted'")).toHaveLength(1);
    expect(f.store.all('SELECT id FROM inputs')).toHaveLength(0);
  } finally { section?.disposeCalls(); if (dom) { resetUiState(); dom.restore(); } c.restore(); await f.close(); }
});
