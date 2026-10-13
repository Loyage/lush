import { test, expect, afterAll, beforeEach } from 'bun:test';
import fs from 'node:fs';
import { installDom, deepText } from '../dom-stub.js';

const dom = installDom();
const { resourceSummary } = await import('../../src/ui/web/assets/task-graph-usage.js');
const { initHelp, hideHelp, setHelpTimers } = await import('../../src/ui/web/assets/help.js');
const complete = { input: 1200, output: 300, cost: 0.24, run_ms: 61000,
  incomplete: false, unknown_tokens: 0, unknown_cost: 0, known_tokens: 1, known_cost: 1, pending_files: 0 };
const summary = (changes = {}, node = {}, folded = false) => resourceSummary({ resources: { own: { ...complete, ...changes } }, ...node }, folded);
const field = (box, name) => box.querySelector(`.task-graph-usage-${name}`)?.textContent;
let clock = 0, nextId = 1;
const timers = new Map();
setHelpTimers({
  setTimeout(fn, delay) { const id = nextId++; timers.set(id, { fn, at: clock + delay }); return id; },
  clearTimeout(id) { timers.delete(id); },
});
const advance = ms => {
  clock += ms;
  for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.fn(); }
};
initHelp();
beforeEach(() => hideHelp());
afterAll(() => { hideHelp(); setHelpTimers(null); dom.restore(); });

test('完整摘要不增加已知标签，兼容无 known_* 字段的旧服务和无请求的零', () => {
  for (const changes of [{}, { known_tokens: undefined, known_cost: undefined },
    { input: 0, output: 0, cost: 0, known_tokens: 0, known_cost: 0 }]) {
    const box = summary(changes);
    expect(field(box, 'incomplete')).toBeUndefined();
    expect(deepText(box)).not.toContain('已知');
    expect(field(box, 'input')).toBe(changes.input === 0 ? '↑0' : '↑1.2k');
    expect(field(box, 'cost')).toBe(changes.cost === 0 ? '$0.00' : '$0.24');
  }
});

test('token 与费用独立判断完整性；未知项只展示有请求计数证据的已知小计', () => {
  for (const [changes, input, output, cost] of [
    [{ unknown_tokens: 1 }, '已知 ↑1.2k', '已知 ↓300', '$0.24'],
    [{ unknown_cost: 1 }, '↑1.2k', '↓300', '已知 $0.24'],
    [{ incomplete: true }, '已知 ↑1.2k', '已知 ↓300', '已知 $0.24'],
    [{ unknown_cost: 1, known_cost: 0 }, '↑1.2k', '↓300', '—'],
    [{ unknown_tokens: 1, known_tokens: 0 }, '↑—', '↓—', '$0.24'],
    [{ incomplete: true, known_cost: 0 }, '已知 ↑1.2k', '已知 ↓300', '—'],
    [{ incomplete: true, known_tokens: 0 }, '↑—', '↓—', '已知 $0.24'],
    [{ incomplete: true, known_tokens: 0, known_cost: 0 }, '↑—', '↓—', '—'],
  ]) {
    const box = summary(changes);
    expect(field(box, 'input')).toBe(input);
    expect(field(box, 'output')).toBe(output);
    expect(field(box, 'cost')).toBe(cost);
    expect(field(box, 'incomplete')).toBe('统计不完整');
    expect(box.getAttribute('aria-label')).toContain('统计不完整');
    expect(box.getAttribute('aria-label').includes('输入 已知小计')).toBe(input.includes('已知'));
    expect(box.getAttribute('aria-label').includes('费用 已知小计')).toBe(cost.includes('已知'));
  }
});

test('有证据的已知零仍展示，缺失记录不补零，不按正数字猜测已知覆盖', () => {
  const zero = summary({ incomplete: true, input: 0, output: 0, cost: 0 });
  expect(field(zero, 'input')).toBe('已知 ↑0');
  expect(field(zero, 'output')).toBe('已知 ↓0');
  expect(field(zero, 'cost')).toBe('已知 $0.00');
  for (const count of [undefined, null, 0, -1, 0.5, NaN, Infinity, '2', true]) {
    const box = summary({ incomplete: true, known_tokens: count, known_cost: count });
    expect(field(box, 'input')).toBe('↑—');
    expect(field(box, 'output')).toBe('↓—');
    expect(field(box, 'cost')).toBe('—');
  }
});

test('旧服务不完整摘要保守降级；缺字段不影响另一项完整值', () => {
  const old = { ...complete, known_tokens: undefined, known_cost: undefined };
  const both = summary({ ...old, incomplete: true });
  expect(field(both, 'input')).toBe('↑—');
  expect(field(both, 'cost')).toBe('—');
  const tokensOnly = summary({ ...old, unknown_cost: 1 });
  expect(field(tokensOnly, 'input')).toBe('↑1.2k');
  expect(field(tokensOnly, 'cost')).toBe('—');
  const costOnly = summary({ ...old, unknown_tokens: 1 });
  expect(field(costOnly, 'input')).toBe('↑—');
  expect(field(costOnly, 'cost')).toBe('$0.24');
});

test('无 resources、缺失选中的 own/subtree、加载中均不冒充零或另一个范围的合计', () => {
  for (const [node, folded] of [
    [{}, false], [{ details_pending: true }, false],
    [{ resources: { own: complete }, children_total: 2 }, true],
    [{ resources: { subtree: complete } }, false],
    [{ resources: { own: complete }, details_pending: true }, false],
  ]) {
    const box = resourceSummary(node, folded);
    expect(field(box, 'runtime')).toBe('—');
    expect(field(box, 'input')).toBe('↑—');
    expect(field(box, 'output')).toBe('↓—');
    expect(field(box, 'cost')).toBe('—');
    expect(field(box, 'incomplete')).toBeUndefined();
    if (node.details_pending) {
      expect(box.getAttribute('data-help')).toContain('正在加载');
      expect(box.getAttribute('aria-label')).toContain('正在加载');
    }
  }
});

test('折叠只读后端 lifetime 子树摘要，包含图外后代；展开不受后代 running 影响', () => {
  const own = complete, subtree = { ...complete, input: 2400, output: 600, cost: 0.48, unknown_cost: 1, running: true };
  for (const children of [{ children_total: 50 }, { children: [{ resources: { own: { input: 999999 } } }] }]) {
    const node = { ...children, resources: { own, subtree } };
    const expanded = resourceSummary(node, false), folded = resourceSummary(node, true);
    expect(field(expanded, 'input')).toBe('↑1.2k');
    expect(expanded.classList.contains('is-aggregate')).toBe(false);
    expect(expanded.classList.contains('is-live')).toBe(false);
    expect(field(folded, 'input')).toBe('↑2.4k');
    expect(field(folded, 'cost')).toBe('已知 $0.48');
    expect(folded.classList.contains('is-aggregate')).toBe(true);
    expect(folded.classList.contains('is-live')).toBe(true);
    expect(folded.getAttribute('data-help')).toContain('隐藏、归档及图外节点');
    expect(folded.getAttribute('aria-label')).toContain('子树合计，统计不完整');
  }
  expect(resourceSummary({ resources: { own, subtree } }, true).classList.contains('is-aggregate')).toBe(false);
});

test('帮助区分后台补齐与记录缺失，说明小计证据、估算账单与不含等待', () => {
  for (const pending_files of [0, undefined, 2]) {
    const help = summary({ incomplete: true, pending_files }).getAttribute('data-help');
    expect(help).toContain('后台补齐');
    expect(help.includes('后台补齐中')).toBe(pending_files > 0);
    expect(help).toContain(pending_files > 0 ? '文件未补齐或签名失效' : '记录缺失');
    expect(help).toContain('token 与费用分别判断');
    expect(help).toContain('有证据的小计，不是完整总额');
    expect(help).toContain('估算，不代表实际账单');
    expect(help).toContain('不含等待');
    expect(help).toContain('不代表零');
  }
});

test('资源摘要保持可键盘聚焦，键盘与触摸长按均可读取补齐帮助', async () => {
  const box = summary({ incomplete: true, pending_files: 1 });
  dom.document.body.append(box);
  expect(box.getAttribute('tabindex')).toBe('0');
  expect(box.getAttribute('title')).toBeNull();
  await dom.fire('keydown', { key: 'Tab' });
  await dom.fire('focusin', { target: box });
  advance(1200);
  expect(dom.node('help-tip').hidden).toBe(false);
  expect(dom.node('help-tip').textContent).toContain('后台补齐中');
  expect(box.getAttribute('aria-describedby')).toBe('help-tip');
  await dom.fire('focusout', { target: box });
  expect(box.getAttribute('aria-describedby')).toBeNull();
  await dom.fire('touchstart', { target: box });
  advance(650);
  expect(dom.node('help-tip').hidden).toBe(false);
  expect(dom.node('help-tip').textContent).toContain('不是完整总额');
});

test('不完整提示与已知数字同在摘要内，沿用窄屏换行和横向阅读，不引入截断', () => {
  const box = summary({ incomplete: true });
  expect(box.querySelectorAll('span')).toHaveLength(5);
  expect(box.children[0].className).toBe('task-graph-usage-runtime');
  expect(box.children[1].className).toBe('task-graph-usage-incomplete');
  const css = fs.readFileSync(new URL('../../src/ui/web/assets/styles.css', import.meta.url), 'utf8');
  expect(css).toContain('.task-graph-minimal-meta>.task-graph-usage{flex:0 1 auto;min-width:0;flex-wrap:wrap;gap:0 7px;white-space:normal}');
  expect(css).toContain('.task-graph-minimal-meta>.task-graph-usage>span{white-space:nowrap}');
  for (const rule of css.matchAll(/[^{}]*task-graph-usage[^{}]*\{([^{}]*)\}/g)) {
    expect(rule[1]).not.toMatch(/overflow\s*:\s*hidden|text-overflow\s*:\s*ellipsis/);
  }
});
