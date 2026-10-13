import { test, expect, afterEach, afterAll } from 'bun:test';
import { installDom, deepText, dialogButton } from '../dom-stub.js';
const dom = installDom();
const { serviceRestartControls } = await import('../../src/ui/web/assets/service-restart.js');
const A = 'aaaaaaaaaaaaaaaa', B = 'bbbbbbbbbbbbbbbb', C = 'cccccccccccccccc';
const batchId = id => `${id.slice(0, 8)}-1111-2222-3333-444444444444`;
const initial = () => ({ paused: false, phase: 'running', ready_to_restart: true, batch_id: null, completion_state: null, completion_notice_id: null });
const pending = id => ({ paused: true, phase: 'pausing', ready_to_restart: false, batch_id: batchId(id), completion_state: 'pending', completion_notice_id: null });
const completed = id => ({ ...pending(id), phase: 'paused', ready_to_restart: true, completion_state: 'completed', completion_notice_id: id === A ? 11 : 12 });
const row = (id, value = initial(), running = true) => ({ id, name: `项目${id[0]}`, project: `/tmp/${id[0]}`, running, summary: { maintenance: value, maintenance_paused: value.paused } });
const clone = value => structuredClone(value);
const flush = async () => { for (let i = 0; i < 180; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const sections = [];
afterEach(() => { for (const section of sections.splice(0)) section.dispose(); });
afterAll(() => dom.restore());
function clock() {
  let time = 0, id = 0; const timers = new Map();
  return { timers, now: () => time, schedule: (fn, ms) => { const key = ++id; timers.set(key, { fn, at: time + ms }); return key; },
    unschedule: key => timers.delete(key), tick: async ms => { time += ms; for (const [key, timer] of [...timers]) if (timer.at <= time) { timers.delete(key); timer.fn(); } await flush(); } };
}
function fixture({ states = [row(A), row(B), row(C, initial(), false)], automaticCompletion = true,
  intercept = async () => null, confirm = async () => true, ...options } = {}) {
  const calls = [], f = { states: clone(states), calls, hostReads: 0, projectReads: 0, reloads: 0, confirmations: [] };
  const section = serviceRestartControls({ confirm: confirm === null ? undefined : async value => { f.confirmations.push(value); return confirm(value); },
    recover: async () => true, reload: () => f.reloads++, ...options,
    request: async (route, opts) => {
      calls.push([route, opts]);
      if (route === '/api/host') f.hostReads++;
      if (route === '/api/host/projects') f.projectReads++;
      const result = await intercept(route, opts, f); if (result !== null) return result;
      if (route === '/api/host') return { restart_supported: true, pid: 100 };
      if (route === '/api/host/projects') {
        if (automaticCompletion) for (const source of f.states) if (source.summary.maintenance.paused && source.summary.maintenance.completion_state === 'pending') source.summary.maintenance = completed(source.id);
        return { projects: clone(f.states) };
      }
      if (route === '/api/host/restart') return { restarting: true };
      const source = f.states.find(r => route.includes(r.id));
      if (route.endsWith('/api/service/restart')) return { restarted: true, project: source.project, pid: 200 };
      const method = JSON.parse(opts.body).method;
      source.summary.maintenance = method === 'system.interrupt_all' ? pending(source.id)
        : { ...source.summary.maintenance, paused: false, phase: 'running', ready_to_restart: true, completion_state: 'cancelled', completion_notice_id: null };
      source.summary.maintenance_paused = source.summary.maintenance.paused;
      return clone(source.summary.maintenance);
    } });
  sections.push(section); f.section = section;
  f.button = kind => section.root.querySelector(`[data-service-restart="${kind}"]`);
  f.writes = () => calls.filter(([, opts]) => opts?.method === 'POST').map(([route, opts]) => [route, route.endsWith('/api/action') ? JSON.parse(opts.body).method : 'restart']);
  f.run = async () => { await section.ready; return f.button('safe').onclick(); };
  f.text = () => deepText(section.root);
  return f;
}
const action = (id, method) => [`/p/${id}/api/action`, `system.${method}_all`];
const restart = id => [`/p/${id}/api/service/restart`, 'restart'];

test('一键按钮及确认均为紫色Agent动作，手动维护默认折叠，独立界面重启保留', async () => {
  const f = fixture(); await f.run();
  expect(f.button('safe').classList.contains('agent-call')).toBe(true);
  expect(f.button('safe').getAttribute('data-help')).toContain('token');
  expect(f.confirmations[0]).toMatchObject({ agent: true, confirmLabel: '一键安全重启' });
  expect(f.confirmations[0].confirmHelp).toContain('token');
  expect(f.section.root.querySelector('details').open).not.toBe(true);
  expect(f.section.root.querySelector('details').querySelector('[data-service-restart="pause"]')).toBe(f.button('pause'));
  expect(f.button('host')).not.toBeNull();
});

test('真实应用内一键确认展示范围与费用，取消无写入', async () => {
  const f = fixture({ confirm: null }); const operation = f.run(); await flush();
  const button = dialogButton(dom, '一键安全重启');
  expect(button.classList.contains('agent-call')).toBe(true); expect(button.getAttribute('data-help')).toContain('token');
  expect(deepText(dom.node('modal'))).toContain('/tmp/a'); expect(deepText(dom.node('modal'))).toContain('/tmp/b');
  await dialogButton(dom, '取消').onclick(); await operation; expect(f.writes()).toHaveLength(0);
});

test('一次确认完整顺序：两项目中断→新鲜就绪→全部后台→全部继续→界面；离线不启动', async () => {
  const f = fixture(); await f.run();
  expect(f.writes()).toEqual([action(A, 'interrupt'), action(B, 'interrupt'), restart(A), restart(B), action(A, 'resume'), action(B, 'resume'), ['/api/host/restart', 'restart']]);
  expect(f.confirmations).toHaveLength(1); expect(f.reloads).toBe(1); expect(f.text()).toContain('一键安全重启已完成');
  expect(f.projectReads).toBeGreaterThan(8);
});

test('原项目维护暂停只重启不继续；固定名称路径与暂停说明列在确认中', async () => {
  const f = fixture({ states: [row(A), row(B, completed(B))] }); await f.run();
  expect(f.writes()).toEqual([action(A, 'interrupt'), restart(A), restart(B), action(A, 'resume'), ['/api/host/restart', 'restart']]);
  expect(f.states[1].summary.maintenance.paused).toBe(true);
  expect(f.confirmations[0].detail).toContain('原维护暂停，重启后保持暂停');
  expect(f.confirmations[0].detail).toContain('/tmp/b');
});

test('无在线项目仍确认仅重启界面，无维护或后台写入', async () => {
  const f = fixture({ states: [row(C, initial(), false)] }); await f.run();
  expect(f.writes()).toEqual([['/api/host/restart', 'restart']]); expect(f.confirmations[0].message).toContain('0 个在线项目');
});

test('取消及确认期间离页均无写入', async () => {
  for (const mode of ['cancel', 'owns', 'dispose', 'pagehide']) {
    let owns = true;
    const f = fixture({ ownsPage: () => owns, confirm: async () => {
      if (mode === 'owns') owns = false;
      if (mode === 'dispose') f.section.dispose();
      if (mode === 'pagehide') await dom.fire('pagehide');
      return mode !== 'cancel';
    } });
    await f.run(); expect(f.writes()).toHaveLength(0);
  }
});

test('原暂停缺字段、未知批次、completed缺Notice、相矛盾字段或无路径都不写入', async () => {
  for (const change of [r => delete r.summary.maintenance.paused, r => delete r.summary.maintenance.batch_id,
    r => { r.summary.maintenance = { ...completed(A), completion_state: 'unknown' }; },
    r => { r.summary.maintenance = { ...completed(A), completion_notice_id: null }; },
    r => { r.summary.maintenance_paused = true; }, r => delete r.project]) {
    const source = row(A); change(source); const f = fixture({ states: [source] }); await f.run();
    expect(f.writes()).toHaveLength(0); expect(f.text()).toContain('失败／结果未确认');
  }
});

test('中断ACK缺批次或未知只记录接受，不将ACK当就绪，不提交下个项目', async () => {
  for (const ack of [{ paused: true }, { ...pending(A), completion_state: 'unknown' }]) {
    const f = fixture({ intercept: async (route, opts) => route.includes(A) && opts?.method === 'POST' ? ack : null }); await f.run();
    expect(f.writes()).toEqual([action(A, 'interrupt')]); expect(f.text()).toContain('中断已接受：项目a');
    expect(f.text()).toContain('未执行中断：项目b'); expect(f.text()).toContain('界面：未执行重启');
  }
});

test('ACK说完成仍等待新鲜动态ready；等待无并发探测，超时不能当就绪', async () => {
  const time = clock(); let reads = 0, peak = 0;
  const f = fixture({ ...time, observationTimeout: 5000, automaticCompletion: false,
    intercept: async (route, opts, f) => {
      if (route === '/api/host/projects') { reads++; peak = Math.max(peak, reads); await Promise.resolve(); reads--; }
      if (route.includes('/api/action')) { const source = f.states.find(r => route.includes(r.id)); source.summary.maintenance = pending(source.id); source.summary.maintenance_paused = true; return completed(source.id); }
      return null;
    } });
  const operation = f.run(); await flush();
  expect(f.writes()).toEqual([action(A, 'interrupt'), action(B, 'interrupt')]);
  await time.tick(2000); await time.tick(2000); await time.tick(1000); await operation;
  expect(f.writes()).toHaveLength(2); expect(peak).toBe(1); expect(f.text()).toContain('超时'); expect(time.timers.size).toBe(0);
});

test('只读探测有界，迟到就绪响应不触发写入或覆盖失败结果', async () => {
  const time = clock(), gate = deferred();
  const f = fixture({ ...time, intercept: async (route, opts, f) => route === '/api/host/projects' && f.projectReads === 1 ? gate.promise : null });
  const operation = f.run(); await flush(); await time.tick(10000); await operation;
  expect(f.writes()).toHaveLength(0); const text = f.text(); gate.resolve({ projects: [row(A)] }); await flush();
  expect(f.writes()).toHaveLength(0); expect(f.text()).toBe(text);
});

test('写入超时结果未知，迟到成功回执不继续、不重发', async () => {
  const time = clock(), gate = deferred();
  const f = fixture({ ...time, intercept: async route => route === `/p/${A}/api/service/restart` ? gate.promise : null });
  const operation = f.run(); await flush(); expect(f.writes()).toHaveLength(3);
  await time.tick(30000); await operation; const text = f.text();
  expect(text).toContain('后台重启失败／结果未确认'); expect(text).toContain('等待超时');
  gate.resolve({ restarted: true, project: '/tmp/a', pid: 200 }); await flush();
  expect(f.writes()).toHaveLength(3); expect(f.text()).toBe(text); expect(f.reloads).toBe(0);
});

test('旧手动只读探测未settle时新一键不并发探测；settle后可执行固定流程', async () => {
  const time = clock(), gate = deferred();
  const f = fixture({ ...time, intercept: async (route, opts, f) => route === '/api/host/projects' && f.projectReads === 2 ? gate.promise : null });
  await f.section.ready; f.section.updateProjects(clone(f.states)); await f.button('pause').onclick();
  await time.tick(0); const reads = f.projectReads; expect(reads).toBe(2);
  const operation = f.run(); await flush(); expect(f.projectReads).toBe(reads);
  expect(f.writes()).toHaveLength(2);
  gate.resolve({ projects: clone(f.states) }); await operation;
  expect(f.writes()).toEqual([action(A, 'interrupt'), action(B, 'interrupt'), restart(A), restart(B), ['/api/host/restart', 'restart']]);
});

test('等待时dispose/pagehide/离页及迟到响应不继续写；释放共享单飞', async () => {
  for (const mode of ['dispose', 'pagehide', 'owns']) {
    const gate = deferred(); let owns = true;
    const f = fixture({ ownsPage: () => owns, intercept: async (route, opts, f) => route === '/api/host/projects' && f.projectReads === 4 ? gate.promise : null });
    const operation = f.run(); await flush();
    if (mode === 'owns') owns = false;
    else if (mode === 'dispose') f.section.dispose(); else await dom.fire('pagehide');
    gate.resolve({ projects: clone(f.states) }); await operation;
    const before = f.writes().length; await f.button('safe').onclick(); expect(f.writes()).toHaveLength(before);
    expect(f.writes().some(([route]) => route.endsWith('/api/service/restart'))).toBe(false);
  }
});

test('确认与等待共享单飞阻止手动及跨代际操作；正常完成后解锁', async () => {
  const gate = deferred(); const f = fixture({ confirm: async () => gate.promise });
  const operation = f.run(); await flush();
  for (const kind of ['safe', 'host', 'all', 'pause', 'resume']) { expect(f.button(kind).disabled).toBe(true); await f.button(kind).onclick(); }
  const next = fixture(); await next.section.ready; expect(next.button('safe').disabled).toBe(true); await next.button('safe').onclick();
  expect(next.writes()).toHaveLength(0); gate.resolve(true); await operation;
  expect(next.button('safe').disabled).toBe(false);
});

test('确认后新上线不加入；确认固定来源移除、路径变化、离线、批次变化立即停', async () => {
  const added = fixture({ confirm: async () => { added.states.push(row(C)); return true; } }); await added.run();
  expect(added.writes().some(([route]) => route.includes(C))).toBe(false);
  for (const change of [f => f.states.splice(0, 1), f => { f.states[0].project = '/changed'; }, f => { f.states[0].running = false; },
    f => { f.states[0].summary.maintenance = completed(B); f.states[0].summary.maintenance_paused = true; }]) {
    const f = fixture({ confirm: async () => { change(f); return true; } }); await f.run(); expect(f.writes()).toHaveLength(0);
  }
});

test('动态仍忙碌时也固定新鲜完成Notice，变化不当作新就绪；来源读取失败不重试', async () => {
  for (const offline of [false, true]) {
    const f = fixture({ automaticCompletion: false, intercept: async (route, opts, f) => {
      if (route !== '/api/host/projects') return null;
      if (f.projectReads === 4) f.states[0].summary.maintenance = { ...completed(A), ready_to_restart: false };
      if (f.projectReads === 5) {
        if (offline) throw new Error('来源不可达');
        f.states[0].summary.maintenance = { ...completed(A), completion_notice_id: 99 };
      }
      return null;
    } }); await f.run();
    expect(f.writes()).toEqual([action(A, 'interrupt'), action(B, 'interrupt')]);
    expect(f.projectReads).toBe(5); expect(f.text()).toContain(offline ? '来源不可达' : '完成告知身份已变化');
  }
});

test('非维护暂停的旧已撤销批次不能作为本次新中断ACK复用', async () => {
  const old = { ...completed(A), paused: false, phase: 'running', completion_state: 'cancelled', completion_notice_id: null };
  const f = fixture({ states: [row(A, old), row(B)] }); await f.run();
  expect(f.writes()).toEqual([action(A, 'interrupt')]); expect(f.text()).toContain('没有确认新的维护暂停批次');
});

test('后台重启前动态再次忙碌/Notice变化/批次变化停止，所有后台成功前绝不继续', async () => {
  for (const change of [m => { m.ready_to_restart = false; }, m => { m.completion_notice_id = 99; }, m => { m.batch_id = batchId(C); }]) {
    const f = fixture({ intercept: async (route, opts, f) => {
      if (route === `/p/${A}/api/service/restart`) change(f.states[1].summary.maintenance);
      return null;
    } }); await f.run();
    expect(f.writes()).toEqual([action(A, 'interrupt'), action(B, 'interrupt'), restart(A)]);
    expect(f.text()).toContain('后台已重启：项目a'); expect(f.text()).toContain('未执行后台重启：项目b'); expect(f.text()).toContain('未执行继续：项目a');
  }
});

test('各阶段写入失败/未知回执停下且不重发、不回滚、明确部分结果', async () => {
  const sequence = [action(A, 'interrupt'), action(B, 'interrupt'), restart(A), restart(B), action(A, 'resume'), action(B, 'resume'), ['/api/host/restart', 'restart']];
  for (let failure = 0; failure < sequence.length; failure++) {
    let writes = 0;
    const f = fixture({ intercept: async (_route, opts) => {
      if (opts?.method === 'POST' && writes++ === failure) throw new Error('写入结果未知'); return null;
    } }); await f.run();
    expect(f.writes()).toEqual(sequence.slice(0, failure + 1)); expect(f.text()).toContain('写入结果未知'); expect(f.reloads).toBe(0);
    expect(f.text()).toContain('未执行继续'); expect(f.text()).toContain('不自动重试');
  }
});

test('后台与继续无效成功回执也不得推进后续；Host不支持/身份变化/失败无写入', async () => {
  for (const route of [`/p/${A}/api/service/restart`, `/p/${A}/api/action`, '/api/host/restart']) {
    const f = fixture({ intercept: async (url, opts) => url === route && (url.endsWith('restart') || JSON.parse(opts?.body || '{}').method === 'system.resume_all') ? {} : null });
    await f.run(); expect(f.reloads).toBe(0); expect(f.text()).toContain('失败／结果未确认');
  }
  for (const mode of ['unsupported', 'changed', 'error']) {
    const f = fixture({ intercept: async (route, opts, f) => {
      if (route !== '/api/host' || f.hostReads === 1) return null;
      if (mode === 'error') throw new Error('Host不可达');
      return { restart_supported: mode !== 'unsupported', pid: f.hostReads === 2 ? 100 : 101 };
    } }); await f.run(); expect(f.writes()).toHaveLength(0); expect(f.reloads).toBe(0);
  }
});

test('Host最终恢复401不刷新或重复继续；恢复失败报告已完成范围', async () => {
  for (const fail of [false, true]) {
    const f = fixture({ recover: async () => { if (fail) throw new Error('恢复超时'); return false; } }); await f.run();
    expect(f.writes()).toHaveLength(7); expect(f.reloads).toBe(0);
    if (fail) { expect(f.text()).toContain('已继续：项目a'); expect(f.text()).toContain('恢复超时'); }
  }
});
