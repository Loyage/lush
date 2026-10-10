import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom, deepText, answerDialog, dialogText } from '../dom-stub.js';
import { gate } from '../helpers.js';

const PROJECT = 'a'.repeat(16), OTHER = 'b'.repeat(16);
const running = { version: 1, paused: false, phase: 'running', ready_to_restart: false, active_calls: 2,
  pending_operations: 0, affected_count: 0, blockers: ['等待当前调用安全退出'] };
const pausing = { ...running, paused: true, phase: 'pausing', affected_count: 2 };
const paused = { ...pausing, phase: 'paused', ready_to_restart: true, active_calls: 0, blockers: [] };
let requests = [], readCount = 0, requestGate = null, readGate = null, reject = false, rejectRead = false, nextRead = null;
const dom = installDom({ fetch: async (url, options) => {
  requests.push({ url: String(url), ...JSON.parse(options.body) });
  if (requestGate) await requestGate.promise;
  if (reject) return Response.json({ error: '当前项目正在停止' }, { status: 409 });
  return Response.json(requests.at(-1).method === 'system.interrupt_all' ? pausing : running);
} });
const { renderProjectMaintenance: paint, projectMaintenanceRegion, resetProjectMaintenance, validMaintenance } = await import('../../src/ui/web/assets/project-maintenance.js');
const { registerNavigation } = await import('../../src/ui/web/assets/navigate.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
const { renderOverview } = await import('../../src/ui/web/assets/render-overview.js');
const { AGENT_NOTE } = await import('../../src/ui/web/assets/help.js');
const { clear, setTimers } = await import('../../src/ui/web/assets/messages.js');
const { closeDialog } = await import('../../src/ui/web/assets/dialog.js');
const restoreNavigation = registerNavigation({ refresh: async () => {
  readCount++; if (readGate) await readGate.promise;
  if (nextRead) paint(nextRead);
  if (rejectRead) throw new Error('项目状态读取失败');
}, detail: async () => {}, overview: async () => {} });
const host = () => dom.node('project-maintenance');
const control = label => host().querySelectorAll('button').find(node => node.textContent === label);
const pause = () => control('全部中断');
const resume = () => control('全部继续');
const copy = () => deepText(host());
async function interrupt() { const work = pause().onclick(); await answerDialog(dom, '全部中断'); return work; }
setTimers({ setTimeout: () => 1, clearTimeout: () => {}, now: () => 0 });
beforeEach(() => {
  dom.location.pathname = `/p/${PROJECT}/`; ui.view = { id: 'overview' }; ui.overviewKey = null; ui.offline = false;
  requests = []; readCount = 0;
  requestGate = readGate = nextRead = null; reject = rejectRead = false;
  closeDialog(); clear(); resetProjectMaintenance(); document.activeElement = null;
});
afterAll(() => { closeDialog(); clear(); setTimers(); restoreNavigation(); dom.restore(); });

test('unknown, malformed and legacy responses disable both controls rather than guessing running/restart readiness', () => {
  for (const model of [null, undefined, {}, { ...paused, version: 2 }, { ...paused, active_calls: -1 }, { ...paused, blockers: ['x', 4] }]) {
    paint(model);
    expect(validMaintenance(model)).toBe(false); expect(pause().disabled).toBe(true); expect(resume().disabled).toBe(true);
    expect(copy()).toContain('暂不可用'); expect(copy()).not.toContain('当前可重启');
    expect(pause().parentNode.classList.contains('help-host')).toBe(true);
    expect(pause().parentNode.tabIndex).toBe(0);
    expect(resume().parentNode.getAttribute('data-help')).toContain(AGENT_NOTE);
  }
});

test('global/invalid project routes never expose or send current-project maintenance actions', async () => {
  for (const path of ['/', '/p/invalid/']) {
    dom.location.pathname = path; paint(paused);
    expect(host().hidden).toBe(true);
    await resume().onclick(); await pause().onclick();
    expect(requests).toEqual([]);
  }
});

test('truthful pausing/paused/readiness projection comes only from the daemon fields, not worker status', () => {
  paint(running); expect(copy()).toContain('当前项目运行开放'); expect(resume().disabled).toBe(true);
  paint(pausing); expect(copy()).toContain('等待安全退出'); expect(copy()).toContain('活动调用 2'); expect(copy()).toContain('尚不可重启');
  expect(pause().disabled).toBe(true); expect(resume().disabled).toBe(false);
  paint({ ...pausing, pending_operations: 3, blockers: ['等待后台操作退出'] });
  expect(copy()).toContain('后台操作 3'); expect(copy()).toContain('等待后台操作退出');
  paint(paused); expect(copy()).toContain('当前项目维护暂停'); expect(copy()).toContain('当前可重启'); expect(copy()).toContain('后台仍会重新检查');
  expect(copy()).toContain('重启后仍保持暂停');
});

test('continue has the canonical Agent cost and both disabled controls have focusable help hosts', () => {
  paint(pausing);
  expect(resume().classList.contains('agent-call')).toBe(true);
  expect(resume().getAttribute('data-help')).toContain(AGENT_NOTE);
  expect(resume().getAttribute('data-help')).toContain('等待子 Worker');
  expect(pause().classList.contains('agent-call')).toBe(false);
  expect(pause().parentNode.getAttribute('data-help')).toContain('安全收尾');
});

test('interruption confirms exactly once, explains descendants and durable pause, and cancellation sends nothing', async () => {
  paint(running); const work = pause().onclick();
  expect(dialogText(dom)).toContain('全部中断当前项目？');
  for (const text of ['包括子 Worker', '安全点', '不强杀', '其他后端', '后台重启后仍保持', '不会自动重启', '不影响其他项目']) expect(dialogText(dom)).toContain(text);
  await pause().onclick(); expect(requests).toEqual([]);
  await answerDialog(dom, '取消'); await work;
  expect(readCount).toBe(0); expect(requests).toEqual([]); expect(pause().disabled).toBe(false);
});

test('pause ACK sends only project-scoped no-parameter action and does not promise that calls already stopped', async () => {
  paint(running); await interrupt();
  expect(requests).toEqual([{ url: `/p/${PROJECT}/api/action`, method: 'system.interrupt_all', params: {} }]);
  expect(readCount).toBe(1); expect(copy()).toContain('全部中断请求中');
  expect(dom.node('error').textContent).toContain('请求已接受'); expect(dom.node('error').textContent).not.toContain('已中断');
  expect(pause().disabled).toBe(true); expect(resume().disabled).toBe(false);
});

test('continue restores only the maintenance wave with no auto-restart request or claim of already running', async () => {
  paint(pausing); await resume().onclick();
  expect(requests).toEqual([{ url: `/p/${PROJECT}/api/action`, method: 'system.resume_all', params: {} }]);
  expect(dom.node('error').textContent).toContain('全部继续请求已接受');
  expect(dom.node('error').textContent).toContain('只恢复本次影响'); expect(dom.node('error').textContent).toContain('不代表已经运行');
  expect(pause().disabled).toBe(false); expect(resume().disabled).toBe(true);
});

test('polling reuses overview nodes, keeps focus and cannot replace composer/edited detail', () => {
  paint(running); const button = pause(), title = host().querySelector('strong'); button.focus();
  const editor = document.createElement('textarea'); editor.value = '未提交的界面编辑'; dom.node('detail').append(editor);
  dom.node('input').value = '下一条用户输入';
  paint(pausing); paint(paused);
  expect(pause()).toBe(button); expect(host().querySelector('strong')).toBe(title); expect(document.activeElement).toBe(button);
  expect(dom.node('detail').querySelector('textarea')).toBe(editor); expect(editor.value).toBe('未提交的界面编辑');
  expect(dom.node('input').value).toBe('下一条用户输入');
});

test('in-flight request blocks duplicate clicks despite polling; force read updates confirmed truth without a second mutation', async () => {
  paint(paused); requestGate = gate(); readGate = gate(); nextRead = running;
  const work = resume().onclick(); paint(paused);
  await resume().onclick(); await pause().onclick();
  expect(requests).toHaveLength(1); expect(pause().disabled).toBe(true); expect(resume().disabled).toBe(true);
  requestGate.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  paint(paused); // Older in-flight snapshot must not repaint the ACK while follow-up read is pending.
  expect(host().getAttribute('aria-busy')).toBe('true');
  readGate.resolve(); await work;
  expect(copy()).toContain('当前项目运行开放'); expect(resume().disabled).toBe(true); expect(requests).toHaveLength(1);
});

test('failed mutation is reported as unconfirmed, permits deliberate retry after re-read and never retries automatically', async () => {
  paint(paused); reject = true; nextRead = paused;
  await resume().onclick(); expect(requests).toHaveLength(1); expect(readCount).toBe(1);
  expect(dom.node('error').textContent).toContain('维护请求未确认'); expect(dom.node('error').textContent).toContain('当前项目正在停止');
  expect(resume().disabled).toBe(false);
  reject = false; nextRead = running; await resume().onclick(); expect(requests).toHaveLength(2);
});

test('ACK and refresh failure stay separate; confirmed action is never resent and old readiness is not advertised offline', async () => {
  paint(paused); rejectRead = true; nextRead = paused;
  await resume().onclick(); expect(requests).toHaveLength(1);
  expect(dom.node('error').textContent).toContain('请求已接受，但状态刷新失败'); expect(dom.node('error').textContent).toContain('不会自动重发');
  expect(copy()).toContain('离线'); expect(copy()).not.toContain('当前可重启');
  expect(resume().disabled).toBe(true); expect(pause().disabled).toBe(true);
});

test('offline status discards cached readiness until authoritative reconnect and missing fields never retain old availability', () => {
  paint(paused); paint(paused, { offline: true });
  expect(copy()).not.toContain('当前可重启'); expect(copy()).toContain('维护状态未确认'); expect(resume().disabled).toBe(true);
  paint(paused); expect(resume().disabled).toBe(false);
  paint(undefined); expect(resume().disabled).toBe(true); expect(copy()).not.toContain('当前可重启');
});

test('route change or fresh boot invalidates late action responses and does not update another project', async () => {
  for (const replace of [() => { dom.location.pathname = `/p/${OTHER}/`; paint(paused); }, () => resetProjectMaintenance()]) {
    dom.location.pathname = `/p/${PROJECT}/`; resetProjectMaintenance(); paint(paused); requestGate = gate();
    const work = resume().onclick(); replace(); clear(); requestGate.resolve(); await work;
    expect(readCount).toBe(0); expect(dom.node('error').textContent).toBe('');
  }
});

test('leaving the overview during confirmation sends no late pause request', async () => {
  paint(running); const work = pause().onclick();
  ui.view = { id: 'task', key: '1' };
  await answerDialog(dom, '全部中断'); await work;
  expect(requests).toEqual([]); expect(readCount).toBe(0);
  ui.view = { id: 'overview' }; expect(pause().disabled).toBe(false);
});

test('overview navigation/repaint preserves in-flight single flight and completes an ACK while detached', async () => {
  const panel = dom.node('detail'), getElementById = document.getElementById;
  // Unlike the generic stub, resolve dynamic IDs only while attached to the overview.
  document.getElementById = id => id === 'project-maintenance' ? panel.querySelector('.project-maintenance') : getElementById(id);
  try {
    resetProjectMaintenance(); panel.replaceChildren();
    paint(paused); expect(panel.querySelector('.project-maintenance')).toBeNull();
    const data = { revision: 'initial', tasks: [], notices: [], status: { maintenance: paused } };
    renderOverview(data);
    const region = panel.querySelector('.project-maintenance'), button = region.querySelector('.agent-call');
    requestGate = gate(); nextRead = running;
    const work = button.onclick();
    ui.view = { id: 'task' }; panel.replaceChildren(); paint(paused);
    expect(panel.querySelector('.project-maintenance')).toBeNull();
    ui.view = { id: 'overview' }; ui.overviewKey = null;
    renderOverview(data);
    expect(panel.querySelector('.project-maintenance')).toBe(region);
    expect(region.getAttribute('aria-busy')).toBe('true'); await button.onclick();
    expect(requests).toHaveLength(1);
    // The response finishes off-page, but releases the retained region and refreshes exactly once.
    ui.view = { id: 'task' }; panel.replaceChildren(); requestGate.resolve(); await work;
    expect(readCount).toBe(1); expect(region.getAttribute('aria-busy')).toBe('false');
    ui.view = { id: 'overview' }; ui.overviewKey = null; ui.offline = true;
    renderOverview(data);
    expect(panel.querySelector('.project-maintenance')).toBe(region);
    expect(deepText(region)).toContain('离线'); expect(button.disabled).toBe(true);
    ui.offline = false; paint(paused); button.parentNode.focus();
    renderOverview({ ...data, revision: 'changed' });
    expect(document.activeElement).toBe(button.parentNode);
  } finally { document.getElementById = getElementById; resetProjectMaintenance(); }
});

test('leaving the project or losing capability during the confirmation does not send a late pause request', async () => {
  for (const invalidate of [() => { dom.location.pathname = '/'; paint(null); }, () => paint(null, { offline: true }), () => paint(null)]) {
    dom.location.pathname = `/p/${PROJECT}/`; resetProjectMaintenance(); paint(running);
    const work = pause().onclick(); invalidate(); await answerDialog(dom, '全部中断'); await work;
    expect(requests).toEqual([]);
  }
});

test('maintenance belongs to the overview, not the shared HTML shell, with bounded narrow-screen targets', async () => {
  const html = await Bun.file(new URL('../../src/ui/web/assets/index.html', import.meta.url)).text();
  const css = await Bun.file(new URL('../../src/ui/web/assets/styles-workspace-shell.css', import.meta.url)).text();
  expect(html).not.toContain('id="project-maintenance"');
  const region = projectMaintenanceRegion(paused);
  expect(region.id).toBe('project-maintenance'); expect(region.getAttribute('aria-label')).toBe('当前项目维护控制');
  renderOverview({ revision: 'overview-placement', tasks: [], notices: [], status: { maintenance: paused } });
  expect(region.parentNode).toBe(dom.node('detail'));
  expect(dom.node('detail').children[0].classList.contains('overview-hero')).toBe(true);
  expect(dom.node('detail').children[1]).toBe(region);
  // The project-specific control must coexist with the parent branch's stripped global shell.
  expect(html).not.toContain('id="global-inbox-summary"');
  expect(html).toContain('<a id="home" href="/#projects"');
  expect(html).toContain('data-global-navigation="true"');
  expect(css).toContain('.project-maintenance-copy { min-width: 0; overflow-wrap: anywhere;');
  expect(css).toContain('.project-maintenance-actions { display: flex; flex: none; flex-wrap: wrap;');
  expect(css).toContain('@media (max-width: 680px)'); expect(css).toContain('.project-maintenance-actions button { min-height: 44px; }');
});
