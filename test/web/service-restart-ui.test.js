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
  expect(control(section, 'all').disabled).toBe(true);
  await flush();
  expect(control(section, 'daemon').disabled).toBe(false);
  expect(control(section, 'host').disabled).toBe(true);
  expect(control(section, 'all').disabled).toBe(true);
  expect(control(section, 'all').parentNode.getAttribute('data-help')).toContain('不支持');
  expect(section.querySelectorAll('.help-host').length).toBe(3);
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

test('全部重启一次确认，后台完成后才重启界面，恢复后刷新；各入口互斥', async () => {
  const calls = []; let release, reloads = 0, confirmations = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const section = serviceRestartControls({ confirm: async options => {
    confirmations++;
    expect(options.title).toBe('全部重启？');
    expect(options.message).toContain('其他项目后台不受影响');
    expect(options.message).toContain('存在活动 Agent');
    return true;
  }, reload: () => reloads++, recover: async pid => {
    expect(pid).toBe(2); calls.push('recover'); return true;
  }, request: async (url, options) => {
    calls.push(url);
    if (url === '/api/host') return { restart_supported: true, pid: calls.length === 1 ? 1 : 2 };
    expect(options).toMatchObject({ method: 'POST', body: '{}' });
    if (url === '/api/service/restart') await gate;
    return {};
  } });
  await flush();
  expect(control(section, 'all').disabled).toBe(false);
  const pending = control(section, 'all').onclick(); await flush(); await flush();
  for (const kind of ['daemon', 'host', 'all']) {
    expect(control(section, kind).disabled).toBe(true);
    await control(section, kind).onclick();
  }
  expect(calls).toEqual(['/api/host', '/api/host', '/api/service/restart']);
  expect(reloads).toBe(0);
  release(); await pending;
  expect(calls).toEqual(['/api/host', '/api/host', '/api/service/restart', '/api/host/restart', 'recover']);
  expect(confirmations).toBe(1); expect(reloads).toBe(1);
});

test('全部重启确认可取消，忙碌拒绝时不重启界面也不刷新', async () => {
  const calls = []; let accepted = false, reloads = 0;
  const section = serviceRestartControls({ confirm: async () => accepted, reload: () => reloads++,
    recover: async () => { throw new Error('must not recover'); }, request: async url => {
      calls.push(url);
      if (url === '/api/host') return { restart_supported: true, pid: 1 };
      throw new Error('后台有活动 Agent，拒绝重启');
    } });
  await flush(); await control(section, 'all').onclick();
  expect(calls).toEqual(['/api/host']);
  accepted = true; await control(section, 'all').onclick();
  expect(calls).toEqual(['/api/host', '/api/host', '/api/service/restart']);
  expect(deepText(section)).toContain('后台有活动 Agent');
  expect(reloads).toBe(0); expect(control(section, 'all').disabled).toBe(false);
});

test('全部重启重新检查Host能力，失去支持时不改动后台', async () => {
  const calls = [];
  const section = serviceRestartControls({ confirm: async () => true, request: async url => {
    calls.push(url); return { restart_supported: calls.length === 1, pid: 1 };
  } });
  await flush(); await control(section, 'all').onclick();
  expect(calls).toEqual(['/api/host', '/api/host']);
  expect(control(section, 'all').disabled).toBe(true);
  expect(deepText(section)).toContain('不支持');
});

test('全部重启界面请求或恢复失败时明确后台已成功，不自动重试', async () => {
  for (const failRecovery of [false, true]) {
    const calls = []; let reloads = 0;
    const section = serviceRestartControls({ confirm: async () => true, reload: () => reloads++,
      recover: async () => { throw new Error('恢复超时'); }, request: async url => {
        calls.push(url);
        if (url === '/api/host') return { restart_supported: true, pid: 1 };
        if (url === '/api/host/restart' && !failRecovery) throw new Error('界面拒绝重启');
        return {};
      } });
    await flush(); await control(section, 'all').onclick();
    expect(calls).toEqual(['/api/host', '/api/host', '/api/service/restart', '/api/host/restart']);
    expect(deepText(section)).toContain('当前项目后台已重启，但界面服务重启或恢复失败');
    expect(deepText(section)).toContain(failRecovery ? '恢复超时' : '界面拒绝重启');
    expect(reloads).toBe(0); expect(control(section, 'all').disabled).toBe(false);
  }
});

test('全部重启恢复需登录时不刷新', async () => {
  let reloads = 0;
  const section = serviceRestartControls({ confirm: async () => true, reload: () => reloads++,
    recover: async () => false, request: async () => ({ restart_supported: true, pid: 1 }) });
  await flush(); await control(section, 'all').onclick();
  expect(reloads).toBe(0);
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
