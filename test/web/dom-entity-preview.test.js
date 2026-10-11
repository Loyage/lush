import { test, expect, afterAll } from 'bun:test';
import { installDom } from '../dom-stub.js';
import { gate, until } from '../helpers.js';
import { el, button } from '../../src/ui/web/assets/dom.js';
import { initHelp, hideHelp, setHelpTimers, agentHelp } from '../../src/ui/web/assets/help.js';
import { entityPreviewTarget, inputPreviewText, workerPreviewText, loadEntityPreview } from '../../src/ui/web/assets/entity-preview.js';
import { linkWorkerNumbers } from '../../src/ui/web/assets/worker-links.js';
import { renderTree } from '../../src/ui/web/assets/render-tree.js';
import { renderTaskGraph } from '../../src/ui/web/assets/render-task-graph.js';
import { openInputs } from '../../src/ui/web/assets/render-inputs.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';

const calls = [];
let respond = async () => ({});
const dom = installDom({ fetch: async (url, options) => {
  calls.push({ url, options });
  const value = await respond(url);
  return { ok: !value.error, status: value.error ? 404 : 200, json: async () => value };
} });
dom.location.origin = 'http://localhost';
let clock = 0, seq = 0;
const timers = new Map();
setHelpTimers({ setTimeout: (fn, ms) => { timers.set(++seq, { fn, at: clock + ms }); return seq; }, clearTimeout: id => timers.delete(id) });
const advance = ms => { clock += ms; for (const [id, item] of [...timers]) if (item.at <= clock) { timers.delete(id); item.fn(); } };
initHelp();
const tip = () => dom.node('help-tip');
function reset() { hideHelp(); calls.length = 0; dom.location.pathname = '/p/1111111111111111/'; resetUiState(); }
function link(href) { const node = el('a', '查看'); node.setAttribute('href', href); dom.document.body.append(node); return node; }
async function hover(node) { await dom.fire('pointerover', { target: node, pointerType: 'mouse' }); advance(1200); }
afterAll(() => { hideHelp(); setHelpTimers(null); dom.restore(); });

test('seeded navigation buttons show Worker facts after delay; click and fly-by never fetch', async () => {
  reset(); let clicked = 0;
  const node = button('详情', () => clicked++, 'ghost', { worker: { id: 301, worker_number: 'W203-1', display_title: '连接资源', goal: '读取连接余额并保留未知状态', status: 'running' }, help: '打开详情' });
  dom.document.body.append(node);
  await dom.fire('pointerover', { target: node }); advance(1199); expect(tip().hidden).toBe(true);
  await dom.fire('pointerout', { target: node }); advance(1); expect(tip().hidden).toBe(true);
  await dom.fire('pointerover', { target: node });
  await dom.fire('click', { target: node }); await node.onclick(); advance(1200);
  expect(clicked).toBe(1); expect(calls).toHaveLength(0); expect(tip().hidden).toBe(true);
  await hover(node);
  expect(tip().textContent).toContain('Worker W203-1 · 连接资源');
  expect(tip().textContent).toContain('读取连接余额并保留未知状态');
  expect(tip().textContent).not.toContain('打开详情');
  expect(node.getAttribute('aria-describedby')).toBe('help-tip'); expect(calls).toHaveLength(0);
});

test('native Worker links override ancestor/action help, load only on dwell and reuse summaries', async () => {
  reset(); respond = async () => ({ id: 302, worker_number: 'W203-2', goal: '保留原生新标签导航', status: 'waiting' });
  const parent = el('span'); parent.setAttribute('data-help', '打开已有详情');
  const node = link('#worker-302'); node.setAttribute('title', '打开详情'); parent.append(node); dom.document.body.append(parent);
  await dom.fire('pointerover', { target: node }); advance(1199); expect(calls).toHaveLength(0);
  advance(1); expect(tip().textContent).toContain('正在读取简介'); expect(node.getAttribute('title')).toBeNull();
  await until(() => tip().textContent.includes('保留原生新标签导航'));
  expect(calls.map(row => row.url)).toEqual(['/p/1111111111111111/api/worker/302']);
  expect(calls[0].options?.method).toBeUndefined(); expect(node.getAttribute('href')).toBe('#worker-302');
  hideHelp(); await hover(node); await until(() => tip().textContent.includes('保留原生新标签导航'));
  expect(calls).toHaveLength(1);
});

test('number mentions resolve explicit identity; Order reads original content, not Worker goal', async () => {
  reset(); respond = async url => url.includes('worker-lookup') ? { id: 303, worker_number: 'W203-3' }
    : url.includes('/worker/') ? { id: 303, worker_number: 'W203-3', goal: 'Worker 后续任务' }
    : { id: 204, kind: 'input', content: '<img onerror=alert(1)> 原始用户指令' };
  const root = linkWorkerNumbers(el('p', '请比较 W203-3 与 O204，N2 不受影响')); dom.document.body.append(root);
  const nodes = root.querySelectorAll('a'); expect(calls).toHaveLength(0);
  await hover(nodes[0]); await until(() => tip().textContent.includes('Worker 后续任务'));
  expect(calls[0].url).toBe('/p/1111111111111111/api/worker-lookup?number=W203-3');
  expect(calls[1].url).toBe('/p/1111111111111111/api/worker/303');
  hideHelp(); await hover(nodes[1]); await until(() => tip().textContent.includes('原始用户指令'));
  expect(calls[2].url).toBe('/p/1111111111111111/api/input/input/204');
  expect(tip().textContent).toContain('原始指令 O204'); expect(tip().textContent).not.toContain('Worker 后续任务');
  expect(tip().querySelectorAll('img')).toHaveLength(0); expect(entityPreviewTarget(nodes[2])).toBeNull();
});

test('cross-project links keep source project, including identical internal IDs', async () => {
  reset(); respond = async url => ({ id: 304, goal: url.includes('2222222222222222') ? '来源项目二' : '来源项目一' });
  const one = link('#worker-304'), two = link('/p/2222222222222222/#worker-304');
  await hover(one); await until(() => tip().textContent.includes('来源项目一'));
  hideHelp(); await hover(two); await until(() => tip().textContent.includes('来源项目二'));
  expect(calls.map(row => row.url)).toEqual(['/p/1111111111111111/api/worker/304', '/p/2222222222222222/api/worker/304']);
  for (const href of ['https://example.com/p/1111111111111111/#worker-304', '/p/not-a-project/#worker-304', '#worker-0', '#worker-number-W1-0', '#input-draft-204', '/other/#worker-304'])
    expect(entityPreviewTarget(link(href))).toBeNull();
  dom.location.pathname = '/';
  expect(entityPreviewTarget(two)?.base).toBe('/p/2222222222222222');
});

test('late responses cannot reopen hidden tips, overwrite another target or follow a rebound link', async () => {
  reset(); const slow = gate(); respond = async url => url.endsWith('/305') ? slow.promise : { id: 306, goal: '新目标简介' };
  const old = link('#worker-305'), next = link('#worker-306'); await hover(old);
  const oldRead = loadEntityPreview(entityPreviewTarget(old));
  await dom.fire('pointerout', { target: old }); await hover(next);
  await until(() => tip().textContent.includes('新目标简介'));
  slow.resolve({ id: 305, goal: '迟到的旧简介' }); await oldRead;
  expect(tip().textContent).toContain('新目标简介');
  const removed = gate(); respond = async () => removed.promise;
  hideHelp(); const node = link('#worker-307'); await hover(node);
  const removedRead = loadEntityPreview(entityPreviewTarget(node)); node.remove(); hideHelp();
  removed.resolve({ id: 307, goal: '已卸载简介' }); await removedRead;
  expect(tip().hidden).toBe(true);
  const rebound = gate(); respond = async () => rebound.promise;
  const changing = link('#worker-308'); await hover(changing);
  const reboundRead = loadEntityPreview(entityPreviewTarget(changing)); changing.setAttribute('href', '#worker-309');
  rebound.resolve({ id: 308, goal: '错误目标内容' }); await reboundRead;
  expect(tip().textContent).not.toContain('错误目标内容');
});

test('single-flight per source; errors are explicit, not cached, and retry on next dwell', async () => {
  reset(); const pending = gate(); respond = async () => pending.promise;
  const a = link('#worker-310'), b = link('#worker-310');
  await hover(a); hideHelp(); await hover(b); expect(calls).toHaveLength(1);
  pending.resolve({ error: 'private raw error' }); await until(() => tip().textContent.includes('简介暂不可用'));
  expect(tip().textContent).not.toContain('private raw error');
  respond = async () => ({ id: 310, worker_number: 'W203-10', goal: '重试成功' });
  hideHelp(); await hover(b); await until(() => tip().textContent.includes('重试成功')); expect(calls).toHaveLength(2);
});

test('keyboard focus and long press share summaries; Agent action help is not replaced', async () => {
  reset(); const node = button('查看', () => {}, '', { worker: { id: 311, goal: '键盘与触屏简介' } }); dom.document.body.append(node);
  await dom.fire('keydown', { key: 'Tab' }); await dom.fire('focusin', { target: node }); advance(1200);
  expect(tip().textContent).toContain('键盘与触屏简介'); hideHelp();
  await dom.fire('touchstart', { target: node }); advance(650); expect(tip().textContent).toContain('键盘与触屏简介');
  let prevented = false; await dom.fire('click', { target: node, preventDefault: () => prevented = true }); expect(prevented).toBe(true);
  hideHelp(); const action = button('发射并开始', () => {}, '', { agent: true, help: agentHelp('创建并执行这条指令。') }); dom.document.body.append(action);
  await hover(action); expect(tip().textContent).toContain('消耗 token'); expect(action.classList.contains('agent-call')).toBe(true); expect(calls).toHaveLength(0);
});

test('summaries are bounded plain text with explicit truncation, missing historical numbers fall back to #id', () => {
  expect(workerPreviewText({ id: 312, goal: '甲'.repeat(1000) })).toContain('#312');
  expect(workerPreviewText({ id: 312, goal: '甲'.repeat(1000) }).length).toBeLessThan(550);
  expect(inputPreviewText({ id: 205, content: '甲'.repeat(400) })).toEndWith('…');
  expect(inputPreviewText({ id: 205, content: '一部分', content_truncated: true })).toEndWith('…');
});

test('list and both graph modes bind facts without rendering prefetch or native title duplication', async () => {
  reset(); const task = { id: 313, worker_number: 'W203-13', role: 'agent', task_kind: 'order', goal: '列表与树的目标', status: 'running', updated_at: new Date().toISOString(), integration: 'none' };
  renderTree({ tasks: [task], status: { concurrency: 1 }, notices: [] });
  const row = dom.node('tasks').children[0]; expect(row.title).toBe(''); expect(row.getAttribute('data-preview-text')).toContain('列表与树的目标');
  ui.view = { id: 'task-graph' };
  for (const minimal of [true, false]) {
    ui.taskGraphMinimal = minimal;
    renderTaskGraph({ nodes: [{ ...task, parent_id: null, title: '自定义树标题', goal_preview: task.goal }], generated_at: new Date().toISOString() });
    expect(dom.node('detail').querySelector('.task-graph-title').getAttribute('data-preview-text')).toContain('列表与树的目标');
    if (minimal) expect(dom.node('detail').querySelector('.task-graph-more-trigger').getAttribute('data-preview-text')).toContain('自定义树标题');
  }
  expect(calls).toHaveLength(0);
});

test('generated/manual titles stay consistent in previews, list patches and both graph modes without timestamp changes', async () => {
  reset();
  const task = { id: 314, worker_number: 'W203-14', role: 'agent', task_kind: 'order', goal: '原始首行\n真正需要实现的详细目标',
    status: 'running', updated_at: '2026-10-01T00:00:00Z', integration: 'none', auto_title: null };
  const paint = value => renderTree({ tasks: [value], status: { concurrency: 1 }, notices: [] });
  paint(task); const row = dom.node('tasks').children[0];
  const generated = { ...task, auto_title: '理解后的主题 <img onerror=alert(1)>' };
  paint(generated); expect(dom.node('tasks').children[0]).toBe(row);
  expect(row.querySelector('.goal').textContent).toBe(generated.auto_title);
  await hover(row);
  expect(tip().textContent).toContain(`Worker W203-14 · ${generated.auto_title}`);
  expect(tip().textContent).toContain('原始首行 真正需要实现的详细目标');
  expect(tip().querySelector('img')).toBeNull();
  const manual = { ...generated, display_title: '用户手动标题' }; paint(manual); hideHelp(); await hover(row);
  expect(tip().textContent).toStartWith('Worker W203-14 · 用户手动标题\n');
  paint({ ...manual, display_title: null }); hideHelp(); await hover(row);
  expect(tip().textContent).toStartWith(`Worker W203-14 · ${generated.auto_title}\n`);
  ui.view = { id: 'task-graph' };
  for (const minimal of [true, false]) for (const record of [generated, manual]) {
    ui.taskGraphMinimal = minimal; hideHelp();
    renderTaskGraph({ nodes: [{ ...record, parent_id: null, title: record.display_title || record.auto_title }], generated_at: task.updated_at });
    const title = dom.node('detail').querySelector('.task-graph-title');
    expect(title.getAttribute('data-preview-text')).toStartWith(`Worker W203-14 · ${record.display_title || record.auto_title}\n`);
    expect(title.getAttribute('data-preview-text')).toContain('真正需要实现的详细目标');
  }
  // Explicit auto_title also wins over a legacy graph title projection.
  expect(workerPreviewText({ ...generated, title: '旧首行标题' })).toStartWith(`Worker W203-14 · ${generated.auto_title}\n`);
  expect(calls).toHaveLength(0);
});

test('lazy inspect previews honor generated title precedence without making any title mutation', async () => {
  reset(); respond = async () => ({ id: 315, worker_number: 'W203-15', goal: '完整原始目标', auto_title: '已生成的主题' });
  const node = link('#worker-315'); await hover(node);
  await until(() => tip().textContent.includes('已生成的主题'));
  expect(tip().textContent).toStartWith('Worker W203-15 · 已生成的主题\n');
  expect(tip().textContent).toContain('完整原始目标');
  expect(calls.map(row => row.url)).toEqual(['/p/1111111111111111/api/worker/315']);
  expect(calls[0].options?.method).toBeUndefined();
});

test('preview cache expires and stays bounded instead of retaining all visited records', async () => {
  reset(); respond = async url => ({ id: Number(url.split('/').at(-1)), goal: '缓存简介' });
  const target = { kind: 'worker', id: 600, base: '/p/1111111111111111' };
  await loadEntityPreview(target); await loadEntityPreview(target); expect(calls).toHaveLength(1);
  const originalNow = Date.now, now = originalNow();
  try {
    Date.now = () => now + 30001;
    await loadEntityPreview(target); expect(calls).toHaveLength(2);
  } finally { Date.now = originalNow; }
  for (let id = 601; id <= 856; id++) await loadEntityPreview({ ...target, id });
  const before = calls.length; await loadEntityPreview(target); expect(calls).toHaveLength(before + 1);
});

test('history Order rows reuse loaded original summary without extra preview reads', async () => {
  reset(); respond = async () => ({ items: [{ kind: 'input', id: 206, content: '历史原始指令摘要', content_truncated: true, status: 'completed', merge_status: 'merged' }], has_more: false, cursor: null });
  await openInputs(); await until(() => dom.node('detail').querySelector('.input-row'));
  const row = dom.node('detail').querySelector('.input-row');
  expect(row.getAttribute('data-preview-text')).toContain('原始指令 O206');
  expect(row.getAttribute('data-preview-text')).toContain('历史原始指令摘要…');
  const before = calls.length; await hover(row); expect(tip().textContent).toContain('历史原始指令摘要…'); expect(calls).toHaveLength(before);
});
