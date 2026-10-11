import { test, expect, afterEach, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
const dom = installDom();
const { serviceRestartControls } = await import('../../src/ui/web/assets/service-restart.js');
const { writePref, readPref } = await import('../../src/ui/web/assets/prefs.js');
const { ui, resetUiState } = await import('../../src/ui/web/assets/state.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const A = 'aaaaaaaaaaaaaaaa', B = 'bbbbbbbbbbbbbbbb', C = 'cccccccccccccccc';
const uuid = id => `00000000-0000-4000-8000-${id === A ? '000000000001' : '000000000002'}`;
const maintenance = (id, patch = {}) => ({ paused: true, phase: 'pausing', ready_to_restart: false,
  batch_id: uuid(id), completion_state: 'pending', completion_notice_id: null, ...patch });
const ready = id => maintenance(id, { phase: 'paused', ready_to_restart: true, completion_state: 'completed', completion_notice_id: id === A ? 9 : 10 });
const row = (id, state = maintenance(id)) => ({ id, running: true, project: `/tmp/${id[0]}`, name: `项目${id[0]}`, summary: { maintenance: state } });
const button = (section, kind) => section.root.querySelector(`[data-service-restart="${kind}"]`);
const text = section => deepText(section.root);
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const fixtures = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.section.dispose(); resetUiState(); });
afterAll(() => dom.restore());
function fixture(options = {}) {
  let time = 0, serial = 0, owns = true, snapshots = [row(A), row(B)], reads = 0;
  const timers = new Map(), calls = [];
  const request = async (url, opts) => {
    calls.push([url, opts]);
    if (url === '/api/host') return options.host?.() ?? { restart_supported: true, pid: 1 };
    if (url === '/api/host/projects') {
      reads++;
      if (reads > 1 && options.probe) return options.probe(url, opts);
      return { projects: snapshots };
    }
    if (opts?.method === 'POST') {
      const id = url.includes(A) ? A : B;
      return options.write ? options.write(id, opts) : maintenance(id);
    }
    throw new Error(`unexpected ${url}`);
  };
  const section = serviceRestartControls({ request, confirm: async () => true, ownsPage: () => owns,
    now: () => time, observationTimeout: 10000,
    schedule: (fn, ms) => { const id = ++serial; timers.set(id, { fn, ms }); return id; },
    unschedule: id => timers.delete(id), ...options });
  section.updateProjects(snapshots);
  const f = { section, calls, timers, rows: value => { snapshots = value; }, leave: () => { owns = false; },
    advance: ms => { time += ms; },
    async tick() { const [id, timer] = timers.entries().next().value || []; if (!timer) throw new Error('no timer'); timers.delete(id); return timer.fn(); },
    writes: () => calls.filter(([, opts]) => opts?.method === 'POST'),
  };
  fixtures.push(f); return f;
}

test('ACK only pins per-project batches: fresh all-source completion and readiness produce a prominent reminder, with no new writes', async () => {
  const f = fixture({ write: id => ready(id) }); await f.section.ready;
  await button(f.section, 'pause').onclick();
  expect(text(f.section)).not.toContain('已全部安全中断'); expect(f.timers.size).toBe(1);
  await f.tick(); expect(text(f.section)).toContain('当前 0/2');
  f.rows([row(A, ready(A)), row(B), row(C, ready(C))]); await f.tick();
  expect(text(f.section)).toContain('当前 1/2'); expect(text(f.section)).not.toContain('已全部安全中断');
  f.rows([row(A, ready(A)), row(B, ready(B)), row(C)]); await f.tick();
  expect(text(f.section)).toContain('2 个项目已全部安全中断');
  expect(text(f.section)).toContain('重启按钮仍会重新检查');
  expect(f.section.root.querySelector('.maintenance-ready')).not.toBeNull();
  expect(f.writes()).toHaveLength(2);
  const unchanged = text(f.section); f.advance(2000); await f.tick(); expect(text(f.section)).toBe(unchanged);
  for (const [url, opts] of f.calls.filter(([, opts]) => opts?.method !== 'POST').slice(1)) {
    expect(url).toBe('/api/host/projects'); expect(opts.signal).toBeInstanceOf(AbortSignal);
  }
  // Completion is durable, readiness is not: a later busy source removes the ready reminder.
  f.rows([row(A, ready(A)), row(B, { ...ready(B), ready_to_restart: false })]); await f.tick();
  expect(f.section.root.querySelector('.maintenance-ready')).toBeNull(); expect(text(f.section)).toContain('当前 1/2');
});

for (const [label, change] of [
  ['unreachable', rows => [{ ...rows[0], running: false }, rows[1]]],
  ['source error', rows => [{ ...rows[0], error: 'offline' }, rows[1]]],
  ['removed', rows => rows.slice(1)],
  ['path changed', rows => [{ ...rows[0], project: '/tmp/replaced' }, rows[1]]],
  ['duplicate source', rows => [...rows, rows[0]]],
  ['old daemon', rows => [{ ...rows[0], summary: { maintenance_paused: true } }, rows[1]]],
  ['different batch', rows => [row(A, { ...ready(A), batch_id: uuid(B) }), rows[1]]],
  ['continued', rows => [row(A, { ...ready(A), paused: false }), rows[1]]],
  ['cancelled', rows => [row(A, { ...ready(A), completion_state: 'cancelled' }), rows[1]]],
  ['unknown', rows => [row(A, { ...ready(A), completion_state: 'unknown' }), rows[1]]],
  ['invalid notice', rows => [row(A, { ...ready(A), completion_notice_id: 0 }), rows[1]]],
  ['missing ready field', rows => { const bad = ready(A); delete bad.ready_to_restart; return [row(A, bad), rows[1]]; }],
]) test(`fixed-scope ${label} stops observation and never reports all ready or retries writes`, async () => {
  const f = fixture(); await f.section.ready; await button(f.section, 'pause').onclick();
  f.rows(change([row(A, ready(A)), row(B, ready(B))])); await f.tick();
  expect(text(f.section)).toContain('观测已停止'); expect(text(f.section)).toContain('已接受 2/2');
  expect(f.timers.size).toBe(0); expect(f.writes()).toHaveLength(2);
  expect(f.section.root.querySelector('.maintenance-ready')).toBeNull();
  // A later unrelated refresh cannot silently resurrect a stopped batch.
  f.section.updateProjects([row(A, ready(A)), row(B, ready(B))]);
  expect(text(f.section)).toContain('观测已停止'); expect(f.timers.size).toBe(0);
});

for (const patch of [{ completion_notice_id: null }, { completion_state: 'pending' }, { ready_to_restart: false }]) {
  test(`completed observation requires every positive notice and live ready field: ${JSON.stringify(patch)}`, async () => {
    const f = fixture(); await f.section.ready; await button(f.section, 'pause').onclick();
    f.rows([row(A, ready(A)), row(B, { ...ready(B), ...patch })]); await f.tick();
    expect(text(f.section)).toContain('当前 1/2'); expect(f.section.root.querySelector('.maintenance-ready')).toBeNull();
  });
}

for (const ack of [undefined, {}, { maintenance: ready(B) }, { result: ready(B) },
  maintenance(B, { batch_id: null }), maintenance(B, { batch_id: 'not-a-uuid' }), maintenance(B, { completion_state: 'unknown' }),
  maintenance(B, { completion_state: 'cancelled' })]) {
  test(`empty/legacy/unknown direct ACK preserves accepted results, stops subsequent mutation: ${JSON.stringify(ack)}`, async () => {
    const f = fixture({ write: id => id === A ? maintenance(A) : ack });
    f.rows([row(A), row(B), row(C)]); await f.section.ready; await button(f.section, 'pause').onclick();
    expect(f.writes()).toHaveLength(2); expect(f.timers.size).toBe(0);
    expect(text(f.section)).toContain('已接受 2 个项目'); expect(text(f.section)).toContain('后续 1 个项目未执行');
    expect(text(f.section)).toContain('不能确认全部安全中断');
  });
}

for (const failure of ['partial write timeout', 'probe timeout']) test(`${failure} never retries writes and preserves accepted source results`, async () => {
  const f = fixture(failure.startsWith('partial') ? { write: id => {
    if (id === B) throw new Error('write timed out'); return maintenance(A);
  } } : { probe: async () => { throw new Error('probe timed out'); } });
  await f.section.ready; await button(f.section, 'pause').onclick();
  if (failure.startsWith('probe')) await f.tick();
  expect(f.writes()).toHaveLength(2); expect(f.timers.size).toBe(0);
  expect(text(f.section)).toContain(failure.startsWith('partial') ? '已接受 1 个项目' : '已接受 2/2');
  expect(f.section.root.querySelector('.maintenance-ready')).toBeNull();
});

test('range identity changes during an accepted write stop all later mutations', async () => {
  const gate = deferred(); const f = fixture({ write: () => gate.promise }); await f.section.ready;
  const work = button(f.section, 'pause').onclick(); await flush();
  f.section.updateProjects([row(A), { ...row(B), project: '/tmp/new' }]); gate.resolve(maintenance(A)); await work;
  expect(f.writes()).toHaveLength(1); expect(f.timers.size).toBe(0); expect(text(f.section)).toContain('后续 1 个项目未执行');
});

test('single-flight polling survives same-page redraw and rejects late responses superseded by a refresh', async () => {
  const gate = deferred(); let probes = 0;
  const f = fixture({ probe: async () => { probes++; return gate.promise; } }); await f.section.ready;
  await button(f.section, 'pause').onclick(); const pending = f.tick(); await flush();
  expect(f.timers.size).toBe(0); expect(probes).toBe(1);
  const opts = f.calls.at(-1)[1];
  f.section.updateProjects([row(A), row(B)]);
  expect(opts.signal.aborted).toBe(true); expect(f.timers.size).toBe(1);
  await f.tick(); expect(probes).toBe(1); expect(f.timers.size).toBe(1);
  gate.resolve({ projects: [row(A, ready(A)), row(B, ready(B))] }); await pending;
  expect(text(f.section)).toContain('当前 0/2'); expect(f.timers.size).toBe(1);
  await f.tick(); expect(probes).toBe(2);
});

for (const stop of ['dispose', 'pagehide', 'navigation', 'boot', 'resume', 'leave', 'deadline']) test(`${stop} cleans observation and ignores old responses`, async () => {
  const gate = deferred(); let probes = 0;
  const f = fixture({ probe: () => ++probes === 1 ? gate.promise : { projects: [row(A), row(B)] } }); await f.section.ready;
  await button(f.section, 'pause').onclick(); const pending = f.tick(); await flush();
  const signal = f.calls.at(-1)[1].signal;
  if (stop === 'dispose') f.section.dispose();
  if (stop === 'pagehide') { await dom.fire('pagehide'); expect(dom.listeners.pagehide).toHaveLength(0); }
  if (stop === 'navigation' || stop === 'boot') {
    activateDetailView({ view: 'project-management' }); ui.disposeServiceRestart = f.section.dispose;
    if (stop === 'navigation') activateDetailView({ view: 'projects' }); else resetUiState();
  }
  if (stop === 'resume') await button(f.section, 'resume').onclick();
  if (stop === 'leave') f.leave();
  if (stop === 'deadline') f.advance(10001);
  gate.resolve({ projects: [row(A, ready(A)), row(B, ready(B))] }); await pending;
  expect(f.timers.size).toBe(0); expect(f.section.root.querySelector('.maintenance-ready')).toBeNull();
  if (!['leave', 'deadline'].includes(stop)) expect(signal.aborted).toBe(true);
  expect(f.writes()).toHaveLength(stop === 'resume' ? 4 : 2);
});

test('a new explicit interruption pins new batches, never accepts an old probe response or overlaps it', async () => {
  const gate = deferred(); let alternate = false, probes = 0, snapshot = [row(A), row(B)];
  const freshId = id => `11111111-0000-4000-8000-${id === A ? '000000000001' : '000000000002'}`;
  const f = fixture({ write: id => maintenance(id, { batch_id: alternate ? freshId(id) : uuid(id) }),
    probe: () => ++probes === 1 ? gate.promise : { projects: snapshot } });
  await f.section.ready; await button(f.section, 'pause').onclick();
  const pending = f.tick(); await flush();
  alternate = true; snapshot = [row(A), row(B)].map(source => ({ ...source,
    summary: { maintenance: maintenance(source.id, { batch_id: freshId(source.id) }) } }));
  await button(f.section, 'pause').onclick();
  gate.resolve({ projects: [row(A, ready(A)), row(B, ready(B))] }); await pending;
  expect(f.section.root.querySelector('.maintenance-ready')).toBeNull(); expect(f.timers.size).toBe(1);
  snapshot = snapshot.map(source => ({ ...source, summary: { maintenance: { ...ready(source.id), batch_id: freshId(source.id) } } }));
  await f.tick(); expect(f.section.root.querySelector('.maintenance-ready')).not.toBeNull();
  expect(f.writes()).toHaveLength(4);
});

test('a late initial Host capability read cannot erase a later explicit resume ACK', async () => {
  const gate = deferred(); const f = fixture({ host: () => gate.promise });
  await button(f.section, 'resume').onclick(); const accepted = text(f.section);
  expect(accepted).toContain('不代表已经运行');
  gate.resolve({ restart_supported: true, pid: 1 }); await f.section.ready;
  expect(text(f.section)).toBe(accepted);
});

test('timer waiting is removed on dispose and observation expires without an extra request', async () => {
  for (const expiry of [false, true]) {
    const f = fixture(); await f.section.ready; await button(f.section, 'pause').onclick();
    const count = f.calls.length;
    if (expiry) { f.advance(10001); await f.tick(); expect(text(f.section)).toContain('超时'); }
    else f.section.dispose();
    expect(f.timers.size).toBe(0); expect(f.calls).toHaveLength(count);
  }
});

test('reminder settings mute live announcement and emphasis, not factual completion or source records', async () => {
  const before = readPref('noticeChannels');
  writePref('noticeChannels', { ...before, idle: { ...before.idle, banner: false } });
  try {
    const f = fixture(); await f.section.ready; await button(f.section, 'pause').onclick();
    f.rows([row(A, ready(A)), row(B, ready(B))]); await f.tick();
    expect(text(f.section)).toContain('已全部安全中断');
    expect(f.section.root.querySelector('.maintenance-ready')).toBeNull();
    expect(f.section.root.querySelector('[role="status"]').getAttribute('aria-live')).toBe('off');
    expect(f.writes()).toHaveLength(2);
  } finally { writePref('noticeChannels', before); }
});
