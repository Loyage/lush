import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText, findByText } from '../dom-stub.js';
const dom = installDom();
const { serviceRestartControls, waitForHostRestart } = await import('../../src/ui/web/assets/service-restart.js');
afterAll(() => dom.restore());
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const control = (section, kind) => section.querySelector(`[data-service-restart="${kind}"]`);

test('独立按钮、帮助宿主、不调用Agent；未知或不支持的Host禁用', async () => {
  const section = serviceRestartControls({ request: async () => ({ pid: 1, restart_supported: false }) });
  expect(control(section, 'host').disabled).toBe(true);
  await flush();
  expect(control(section, 'daemon').disabled).toBe(false);
  expect(control(section, 'host').disabled).toBe(true);
  expect(section.querySelectorAll('.help-host').length).toBe(2);
  expect(section.querySelectorAll('.agent-call').length).toBe(0);
  expect(deepText(section)).toContain('当前界面宿主不支持');
});

test('真实应用内确认可取消，不发重启请求', async () => {
  const calls = [];
  const section = serviceRestartControls({ request: async url => { calls.push(url); return { restart_supported: true, pid: 1 }; } });
  await flush();
  const pending = control(section, 'daemon').onclick();
  expect(deepText(dom.node('modal'))).toContain('存在活动 Agent');
  await findByText(dom.node('modal'), '取消').onclick();
  await pending;
  expect(calls).toEqual(['/api/host']);
  expect(control(section, 'daemon').disabled).toBe(false);
});

test('后台拒绝忙碌时就地显示错误，不刷新；重试成功后刷新', async () => {
  const calls = []; let busy = true, reloads = 0;
  const section = serviceRestartControls({ confirm: async () => true, reload: () => reloads++, request: async (url, opts) => {
    calls.push([url, opts]);
    if (url === '/api/host') return { restart_supported: true, pid: 1 };
    if (busy) throw new Error('请先结束正在执行的 Agent');
    return { restarted: true };
  } });
  await flush(); await control(section, 'daemon').onclick();
  expect(reloads).toBe(0); expect(deepText(section)).toContain('请先结束正在执行的 Agent');
  expect(calls.at(-1)[0]).toBe('/api/service/restart');
  expect(calls.at(-1)[1]).toMatchObject({ method: 'POST', body: '{}' });
  busy = false; await control(section, 'daemon').onclick(); expect(reloads).toBe(1);
});

test('Host读取当前pid后重启，等待新进程再刷新；重启中重复点击被挡住', async () => {
  const calls = []; let release, reloads = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const section = serviceRestartControls({ confirm: async () => true, reload: () => reloads++, recover: async pid => {
    expect(pid).toBe(2); await gate; return true;
  }, request: async url => {
    calls.push(url);
    return url === '/api/host' ? { pid: calls.length === 1 ? 1 : 2, restart_supported: true } : { restarting: true };
  } });
  await flush(); const pending = control(section, 'host').onclick(); await flush(); await flush();
  await control(section, 'daemon').onclick(); await control(section, 'host').onclick();
  expect(control(section, 'daemon').disabled).toBe(true);
  expect(calls).toEqual(['/api/host', '/api/host', '/api/host/restart']);
  expect(reloads).toBe(0); release(); await pending; expect(reloads).toBe(1);
});

test('Host恢复：旧pid/暂时断连不算完成，新pid才完成', async () => {
  let time = 0, attempt = 0;
  const ok = await waitForHostRestart(1, { now: () => time, sleep: async ms => { time += ms; }, fetchHost: async () => {
    attempt++;
    if (attempt === 1) throw new Error('offline');
    return Response.json({ pid: attempt === 2 ? 1 : 2 });
  } });
  expect(ok).toBe(true); expect(attempt).toBe(3);
});

test('Host恢复：401去登录，不刷新；超时保留可操作提示', async () => {
  let time = 0, logins = 0;
  const options = { now: () => time, sleep: async ms => { time += ms; }, timeout: 1000 };
  expect(await waitForHostRestart(1, { ...options, loginRequired: () => logins++, fetchHost: async () => new Response('', { status: 401 }) })).toBe(false);
  expect(logins).toBe(1); time = 0;
  await expect(waitForHostRestart(1, { ...options, fetchHost: async () => Response.json({ pid: 1 }) })).rejects.toThrow('界面服务尚未恢复');
});
