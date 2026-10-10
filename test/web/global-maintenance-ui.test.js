import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText, dialogButton } from '../dom-stub.js';
const dom = installDom();
const { serviceRestartControls } = await import('../../src/ui/web/assets/service-restart.js');
afterAll(() => dom.restore());
const A = 'aaaaaaaaaaaaaaaa', B = 'bbbbbbbbbbbbbbbb', C = 'cccccccccccccccc';
const row = (id, running = true) => ({ id, running, name: `项目${id[0]}`, project: `/tmp/${id[0]}` });
const rows = [row(A), row(B), row(C, false)];
const button = (section, kind) => section.root.querySelector(`[data-service-restart="${kind}"]`);
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(options = {}) {
  const calls = [];
  const section = serviceRestartControls({ confirm: async () => true, request: async (url, opts) => {
    calls.push([url, opts]);
    return url === '/api/host' ? { restart_supported: true, pid: 1 } : { projects: rows };
  }, ...options });
  section.updateProjects(rows);
  return { section, calls };
}

test('全局维护按钮在重启区域，继续与确认带统一Agent代价，中断不调用Agent', async () => {
  const { section } = fixture({ confirm: undefined }); await section.ready;
  expect(button(section, 'pause').classList.contains('agent-call')).toBe(false);
  expect(button(section, 'resume').classList.contains('agent-call')).toBe(true);
  expect(button(section, 'resume').getAttribute('data-help')).toContain('token');
  const work = button(section, 'resume').onclick(); await flush();
  expect(deepText(dom.node('modal'))).toContain('2 个在线项目');
  expect(deepText(dom.node('modal'))).toContain('/tmp/a');
  expect(deepText(dom.node('modal'))).not.toContain('/tmp/c');
  const confirm = dialogButton(dom, '全部继续');
  expect(confirm.classList.contains('agent-call')).toBe(true);
  expect(confirm.getAttribute('data-help')).toContain('token');
  await dialogButton(dom, '取消').onclick(); await work;
});

for (const [kind, method] of [['pause', 'system.interrupt_all'], ['resume', 'system.resume_all']]) {
  test(`${kind}只读重核并确认固定在线范围，顺序转发无参数项目action，不重启服务`, async () => {
    let changed = 0, confirmations = 0;
    const { section, calls } = fixture({ changed: async () => changed++, confirm: async options => {
      confirmations++;
      expect(options.title).toBe(kind === 'pause' ? '全部中断？' : '全部继续？');
      expect(options.message).toContain('2 个在线项目');
      expect(options.message).toContain('不涉及界面服务');
      expect(options.message).toContain('不自动重试');
      section.updateProjects([row(A), row(B), row(C)]); return true;
    } }); await section.ready; await button(section, kind).onclick();
    expect(calls.map(([url]) => url)).toEqual(['/api/host', '/api/host/projects', `/p/${A}/api/action`, `/p/${B}/api/action`]);
    for (const [, opts] of calls.slice(2)) {
      expect(opts.method).toBe('POST'); expect(JSON.parse(opts.body)).toEqual({ method, params: {} });
      expect(opts.signal).toBeInstanceOf(AbortSignal);
    }
    expect(confirmations).toBe(1); expect(changed).toBe(1);
    expect(deepText(section.root)).toContain('请求已接受');
    expect(deepText(section.root)).toContain(kind === 'pause' ? '仍需安全收尾' : '不代表已经运行');
  });

  test(`${kind}取消和确认期间离页均不发写入`, async () => {
    for (const leave of [false, true]) {
      let owns = true;
      const { section, calls } = fixture({ ownsPage: () => owns, confirm: async () => { owns = !leave; return leave; } });
      await section.ready; await button(section, kind).onclick();
      expect(calls.map(([url]) => url)).toEqual(['/api/host', '/api/host/projects']);
    }
  });

  test(`${kind}初次列表未知或无在线项目禁用，宿主不支持重启仍可维护`, async () => {
    const { section, calls } = fixture({ request: async () => ({ restart_supported: false }) });
    section.updateProjects([]); await section.ready;
    expect(button(section, kind).disabled).toBe(true);
    expect(button(section, kind).parentNode.getAttribute('data-help')).toContain('没有已确认在线');
    expect(button(section, kind).parentNode.tabIndex).toBe(0);
    await button(section, kind).onclick(); expect(calls).toHaveLength(0);
    section.updateProjects(rows); expect(button(section, kind).disabled).toBe(false);
    expect(button(section, 'host').disabled).toBe(true);
    const initial = serviceRestartControls({ request: async () => ({ restart_supported: false }) }); await initial.ready;
    expect(button(initial, kind).disabled).toBe(true);
    expect(button(initial, kind).parentNode.getAttribute('data-help')).toContain('尚未读取');
  });

  test(`${kind}中途失败或写入超时报告部分结果，停止后续，不重试／撤销`, async () => {
    const calls = [];
    const { section } = fixture({ request: async (url, opts) => {
      calls.push([url, opts]);
      if (url === '/api/host') return { restart_supported: true };
      if (url === '/api/host/projects') return { projects: [row(A), row(B), row(C)] };
      if (url.includes(B)) throw new Error('写入超时');
      return {};
    } }); await section.ready; await button(section, kind).onclick();
    expect(calls.filter(([, opts]) => opts?.method === 'POST').map(([url]) => url)).toEqual([`/p/${A}/api/action`, `/p/${B}/api/action`]);
    expect(deepText(section.root)).toContain('已接受 1 个项目');
    expect(deepText(section.root)).toContain('结果未确认；后续 1 个项目未执行');
    expect(deepText(section.root)).toContain('不自动重试或撤销');
    expect(button(section, kind).disabled).toBe(false);
  });

  test(`${kind}写入后离页不提交后续项目、不刷新新页`, async () => {
    let owns = true, changed = 0; const calls = [];
    const { section } = fixture({ ownsPage: () => owns, changed: async () => changed++, request: async (url, opts) => {
      calls.push([url, opts]);
      if (url === '/api/host') return { restart_supported: true };
      if (url === '/api/host/projects') return { projects: rows };
      owns = false; return {};
    } }); await section.ready; await button(section, kind).onclick();
    expect(calls.filter(([, opts]) => opts?.method === 'POST')).toHaveLength(1); expect(changed).toBe(0);
  });
}

test('维护与所有重启共享跨刷新／页面代际单飞锁', async () => {
  const gate = deferred();
  const { section } = fixture({ changed: () => gate.promise }); await section.ready;
  const work = button(section, 'pause').onclick(); await flush();
  section.updateProjects(rows);
  for (const kind of ['pause', 'resume', 'host', 'all']) { expect(button(section, kind).disabled).toBe(true); await button(section, kind).onclick(); }
  const next = fixture(); await next.section.ready;
  for (const kind of ['pause', 'resume', 'host', 'all']) { expect(button(next.section, kind).disabled).toBe(true); await button(next.section, kind).onclick(); }
  const daemon = next.section.projectControl(row(A)).querySelector('button'); expect(daemon.disabled).toBe(true); await daemon.onclick();
  expect(next.calls).toHaveLength(1);
  gate.resolve(); await work;
  expect(button(next.section, 'pause').disabled).toBe(false); expect(daemon.disabled).toBe(false);
});

test('维护成功后的列表刷新失败不冒充维护失败或重复发请求', async () => {
  const { section, calls } = fixture({ changed: async () => { throw new Error('列表离线'); } });
  await section.ready; await button(section, 'pause').onclick();
  expect(deepText(section.root)).toContain('请求已接受'); expect(deepText(section.root)).toContain('列表刷新失败');
  expect(calls.filter(([, opts]) => opts?.method === 'POST')).toHaveLength(2);
});

test('列表错误、旧状态变离线、无效或重复身份都无写入，不伪造空范围成功', async () => {
  for (const projects of [null, [], [row(C, false)], [row('invalid')], [row(A), row(A)]]) {
    let writes = 0, confirmations = 0;
    const { section } = fixture({ confirm: async () => { confirmations++; return true; }, request: async (url, opts) => {
      if (opts?.method) writes++;
      return url === '/api/host' ? { restart_supported: false } : { projects };
    } }); await section.ready; await button(section, 'pause').onclick();
    expect(writes).toBe(0); expect(confirmations).toBe(0);
    expect(deepText(section.root)).not.toContain('请求已接受');
  }
});
