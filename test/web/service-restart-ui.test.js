import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText, dialogButton } from '../dom-stub.js';
const dom = installDom();
const { serviceRestartControls, waitForHostRestart } = await import('../../src/ui/web/assets/service-restart.js');
afterAll(() => dom.restore());
const A = 'aaaaaaaaaaaaaaaa', B = 'bbbbbbbbbbbbbbbb', C = 'cccccccccccccccc';
const row = (id, running = true) => ({ id, name: `项目${id[0]}`, project: `/tmp/${id[0]}`, running });
const rows = [row(A), row(B), row(C, false)];
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const control = (section, kind) => section.root.querySelector(`[data-service-restart="${kind}"]`);
const daemon = (section, project = rows[0]) => section.projectControl(project).querySelector('button');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const fixture = (options = {}) => {
  const calls = [], section = serviceRestartControls({ confirm: async () => true, reload: () => {}, recover: async () => true,
    request: async (url, opts) => { calls.push([url, opts]); return url === '/api/host' ? { pid: 1, restart_supported: true }
      : url === '/api/host/projects' ? { projects: rows } : {}; }, ...options });
  return { section, calls };
};

test('全局维护与重启按钮分离；项目重启显式身份、帮助宿主、离线禁用，不调用Agent', async () => {
  const { section } = fixture({ request: async () => ({ pid: 1, restart_supported: false }) });
  expect(control(section, 'host').disabled).toBe(true); expect(control(section, 'all').disabled).toBe(true);
  await section.ready;
  const active = daemon(section), offline = daemon(section, row(C, false));
  expect(active.disabled).toBe(false); expect(offline.disabled).toBe(true);
  expect(active.dataset.projectId).toBe(A); expect(offline.parentNode.getAttribute('data-help')).toContain('未运行');
  expect(section.root.querySelector('[data-service-restart="daemon"]')).toBeNull();
  expect(section.root.querySelectorAll('.help-host')).toHaveLength(4);
  expect(section.root.querySelectorAll('.agent-call')).toHaveLength(1);
  expect(active.classList.contains('agent-call')).toBe(false);
  expect(control(section, 'all').parentNode.getAttribute('data-help')).toContain('不支持');
});

test('真实应用内确认项目名与空闲门，可取消且不发重启请求', async () => {
  const { section, calls } = fixture({ confirm: undefined }); await section.ready;
  const pending = daemon(section).onclick();
  expect(deepText(dom.node('modal'))).toContain('活动 Agent'); expect(deepText(dom.node('modal'))).toContain('/tmp/a');
  await dialogButton(dom, '取消').onclick(); await pending;
  expect(calls.map(call => call[0])).toEqual(['/api/host']);
});

test('只重启固定来源项目；成功仅刷新列表，不刷新页面或丢失草稿', async () => {
  let changed = 0, reloads = 0;
  const { section, calls } = fixture({ changed: async () => changed++, reload: () => reloads++ }); await section.ready;
  await daemon(section, row(B)).onclick();
  expect(calls.map(call => call[0])).toEqual(['/api/host', `/p/${B}/api/service/restart`]);
  expect(calls.at(-1)[1]).toMatchObject({ method: 'POST', body: '{}' });
  expect(changed).toBe(1); expect(reloads).toBe(0); expect(deepText(section.root)).toContain('后台已重启');
});

test('项目忙碌拒绝或写入超时不自动重试，保留可核对的未知结果', async () => {
  let writes = 0;
  const { section } = fixture({ request: async url => {
    if (url === '/api/host') return { restart_supported: true, pid: 1 };
    writes++; throw new Error('后台有活动 Agent');
  } }); await section.ready;
  await daemon(section).onclick();
  expect(writes).toBe(1); expect(deepText(section.root)).toContain('结果未确认'); expect(deepText(section.root)).toContain('活动 Agent');
  expect(deepText(section.root)).toContain('界面服务未重启');
});

test('项目已重启但列表刷新失败，不冒充重启失败或重复执行', async () => {
  const { section, calls } = fixture({ changed: async () => { throw new Error('离线'); } }); await section.ready;
  await daemon(section).onclick(); expect(deepText(section.root)).toContain('后台已重启');
  expect(deepText(section.root)).toContain('列表刷新失败'); expect(calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1);
});

test('全部重启先只读重核列表，一次确认在线范围，顺序项目A/B后界面；离线C不启动', async () => {
  const calls = []; let confirmations = 0, reloads = 0;
  const gate = deferred();
  const { section } = fixture({ confirm: async options => {
    confirmations++; expect(options.title).toBe('全部重启？'); expect(options.message).toContain('2 个在线项目');
    expect(options.detail).toContain('/tmp/a'); expect(options.detail).toContain('/tmp/b'); expect(options.detail).not.toContain('/tmp/c'); return true;
  }, reload: () => reloads++, recover: async pid => { expect(pid).toBe(2); calls.push('recover'); return true; },
  request: async (url, opts) => {
    calls.push(url);
    if (url === '/api/host') return { restart_supported: true, pid: calls.length === 1 ? 1 : 2 };
    if (url === '/api/host/projects') return { projects: rows };
    expect(opts).toMatchObject({ method: 'POST', body: '{}' });
    if (url === `/p/${A}/api/service/restart`) await gate.promise;
    return {};
  } }); await section.ready;
  const first = daemon(section), second = daemon(section, row(B));
  const pending = control(section, 'all').onclick(); await flush();
  for (const button of [first, second, control(section, 'host'), control(section, 'all')]) {
    expect(button.disabled).toBe(true); await button.onclick();
  }
  expect(calls).toEqual(['/api/host', '/api/host/projects', '/api/host', `/p/${A}/api/service/restart`]);
  gate.resolve(); await pending;
  expect(calls).toEqual(['/api/host', '/api/host/projects', '/api/host', `/p/${A}/api/service/restart`, `/p/${B}/api/service/restart`, '/api/host/restart', 'recover']);
  expect(confirmations).toBe(1); expect(reloads).toBe(1);
});

test('全部重启取消只产生读请求，不重启任何服务', async () => {
  const { section, calls } = fixture({ confirm: async () => false }); await section.ready; await control(section, 'all').onclick();
  expect(calls.map(call => call[0])).toEqual(['/api/host', '/api/host/projects']);
});

test('全部重启固定确认时范围，确认后新上线项目不加入', async () => {
  const { section, calls } = fixture({ confirm: async () => { section.updateProjects([row(A), row(B), row(C)]); return true; } });
  await section.ready; await control(section, 'all').onclick();
  expect(calls.map(call => call[0])).not.toContain(`/p/${C}/api/service/restart`);
});

test('首个项目忙碌即停止，不重启后续项目或界面', async () => {
  const calls = [];
  const { section } = fixture({ request: async url => {
    calls.push(url); if (url === '/api/host') return { restart_supported: true, pid: 1 };
    if (url === '/api/host/projects') return { projects: rows };
    throw new Error('后台忙碌');
  } }); await section.ready; await control(section, 'all').onclick();
  expect(calls).toEqual(['/api/host', '/api/host/projects', '/api/host', `/p/${A}/api/service/restart`]);
  expect(deepText(section.root)).toContain('后续 1 个项目未执行，界面服务未重启');
  expect(deepText(section.root)).toContain('没有已确认成功');
});

test('中途失败报告已完成项目、失败项目、未执行数；不重试成功项目', async () => {
  const calls = [];
  const { section } = fixture({ request: async url => {
    calls.push(url); if (url === '/api/host') return { restart_supported: true, pid: 1 };
    if (url === '/api/host/projects') return { projects: [row(A), row(B), row(C)] };
    if (url.includes(B)) throw new Error('项目B忙碌'); return {};
  } }); await section.ready; await control(section, 'all').onclick();
  expect(calls).not.toContain(`/p/${C}/api/service/restart`); expect(calls).not.toContain('/api/host/restart');
  expect(deepText(section.root)).toContain('已成功重启 1 个项目后台：项目a');
  expect(deepText(section.root)).toContain('项目b'); expect(deepText(section.root)).toContain('后续 1 个项目未执行');
});

test('全部重启重核Host能力，不支持时后台一个也不动', async () => {
  let reads = 0; const calls = [];
  const { section } = fixture({ request: async url => {
    calls.push(url); return url === '/api/host' ? { restart_supported: ++reads === 1, pid: 1 } : { projects: rows };
  } }); await section.ready; await control(section, 'all').onclick();
  expect(calls).toEqual(['/api/host', '/api/host/projects', '/api/host']);
  expect(control(section, 'all').disabled).toBe(true); expect(deepText(section.root)).toContain('不支持');
});

test('列表不可达、无效或重复身份时无写入，不将未知状态当空列表', async () => {
  for (const projects of [null, [row('invalid')], [row(A), row(A)]]) {
    let writes = 0;
    const { section } = fixture({ request: async (url, opts) => {
      if (opts?.method) writes++; return url === '/api/host' ? { restart_supported: true, pid: 1 } : { projects };
    } }); await section.ready; await control(section, 'all').onclick(); expect(writes).toBe(0);
  }
  const { section, calls } = fixture({ request: async url => {
    if (url === '/api/host') return { restart_supported: true, pid: 1 }; throw new Error('列表离线');
  } }); await section.ready; await control(section, 'all').onclick(); expect(deepText(section.root)).toContain('列表离线');
});

test('无在线项目时全部重启明确仅界面，不启动离线后台', async () => {
  const calls = [];
  const { section } = fixture({ confirm: async options => { expect(options.message).toContain('0 个在线项目'); return true; }, request: async url => {
    calls.push(url); return url === '/api/host' ? { restart_supported: true, pid: 1 } : { projects: [row(C, false)] };
  } }); await section.ready; await control(section, 'all').onclick();
  expect(calls).toEqual(['/api/host', '/api/host/projects', '/api/host', '/api/host/restart']);
});

test('独立界面重启不读取项目列表、不停后台；恢复401不再刷新', async () => {
  let reloads = 0; const { section, calls } = fixture({ recover: async () => false, reload: () => reloads++ });
  await section.ready; await control(section, 'host').onclick();
  expect(calls.map(call => call[0])).toEqual(['/api/host', '/api/host', '/api/host/restart']); expect(reloads).toBe(0);
});

test('全部后台成功后界面请求／恢复失败报告部分完成，不自动重复后台', async () => {
  for (const failRecovery of [false, true]) {
    const calls = []; let reloads = 0;
    const { section } = fixture({ reload: () => reloads++, recover: async () => { throw new Error('恢复超时'); }, request: async url => {
      calls.push(url); if (url === '/api/host') return { restart_supported: true, pid: 1 };
      if (url === '/api/host/projects') return { projects: rows };
      if (url === '/api/host/restart' && !failRecovery) throw new Error('界面拒绝重启'); return {};
    } }); await section.ready; await control(section, 'all').onclick();
    expect(calls.filter(url => url.endsWith('/api/service/restart'))).toHaveLength(2);
    expect(deepText(section.root)).toContain('已成功重启 2 个项目后台');
    expect(deepText(section.root)).toContain('界面服务重启或恢复失败'); expect(reloads).toBe(0);
  }
});

test('刷新复用项目按钮与在途锁，离线／移除后禁用旧按钮', async () => {
  const gate = deferred(); const { section } = fixture({ changed: () => gate.promise }); await section.ready;
  const button = daemon(section), pending = button.onclick(); await flush();
  section.updateProjects([row(A), row(B)]); expect(daemon(section)).toBe(button); expect(button.disabled).toBe(true);
  gate.resolve(); await pending; section.updateProjects([row(B)]); expect(button.disabled).toBe(true); await button.onclick();
  section.updateProjects([row(A, false)]); expect(button.disabled).toBe(true);
});

test('确认期间离页不写入；在途写入后离页不继续后续项目／Host或刷新新页', async () => {
  for (const duringConfirm of [true, false]) {
    let owns = true, reloads = 0; const calls = [];
    const { section } = fixture({ ownsPage: () => owns, reload: () => reloads++, confirm: async () => { if (duringConfirm) owns = false; return true; },
      request: async url => {
        calls.push(url); if (url === '/api/host') return { restart_supported: true, pid: 1 };
        if (url === '/api/host/projects') return { projects: rows };
        owns = false; return {};
      } }); await section.ready; await control(section, 'all').onclick();
    expect(calls.filter(url => url.endsWith('/api/service/restart'))).toHaveLength(duringConfirm ? 0 : 1);
    expect(calls).not.toContain('/api/host/restart'); expect(reloads).toBe(0);
    const before = calls.length; await control(section, 'host').onclick(); expect(calls).toHaveLength(before);
  }
});

test('跨总览代际的在途请求也阻止新按钮重复重启，结束后解锁', async () => {
  const gate = deferred(); const { section } = fixture({ changed: () => gate.promise }); await section.ready;
  const pending = daemon(section).onclick(); await flush();
  const next = fixture(); await next.section.ready;
  expect(control(next.section, 'host').disabled).toBe(true); await control(next.section, 'host').onclick(); expect(next.calls).toHaveLength(1);
  gate.resolve(); await pending; expect(control(next.section, 'host').disabled).toBe(false);
});

test('Host恢复：旧pid/暂时断连不算完成，新pid才完成', async () => {
  let time = 0, attempt = 0;
  const ok = await waitForHostRestart(1, { now: () => time, sleep: async ms => { time += ms; }, fetchHost: async () => {
    attempt++; if (attempt === 1) throw new Error('offline'); return Response.json({ pid: attempt === 2 ? 1 : 2 });
  } }); expect(ok).toBe(true); expect(attempt).toBe(3);
});

test('Host恢复：401去登录，不刷新；超时保留可操作提示', async () => {
  let time = 0, logins = 0; const options = { now: () => time, sleep: async ms => { time += ms; }, timeout: 1000 };
  expect(await waitForHostRestart(1, { ...options, loginRequired: () => logins++, fetchHost: async () => new Response('', { status: 401 }) })).toBe(false);
  expect(logins).toBe(1); time = 0;
  await expect(waitForHostRestart(1, { ...options, fetchHost: async () => Response.json({ pid: 1 }) })).rejects.toThrow('界面服务尚未恢复');
});
