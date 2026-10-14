import { test, expect } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { block, el } from '../../src/ui/web/assets/dom.js';
import { enhanceModule, observeModules, disposeModules, revealModule } from '../../src/ui/web/assets/shared-module.js';
import { captureModuleReading, restoreModuleReading } from '../../src/ui/web/assets/module-reading.js';
import { automationModule } from '../../src/ui/web/assets/automation-module.js';
import { revealDetailPreview } from '../../src/ui/web/assets/detail-preview.js';

function fixture(run) {
  const dom = installDom(), originalResize = globalThis.ResizeObserver, originalMutation = globalThis.MutationObserver;
  const resizes = [], mutations = [];
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.targets = new Set(); resizes.push(this); }
    observe(node) { this.targets.add(node); }
    unobserve(node) { this.targets.delete(node); }
    disconnect() { this.targets.clear(); this.disconnected = true; }
  };
  globalThis.MutationObserver = class {
    constructor(callback) { this.callback = callback; mutations.push(this); }
    observe(node, options) { this.node = node; this.options = options; }
    disconnect() { this.disconnected = true; }
  };
  return Promise.resolve().then(() => run({ dom, panel: dom.node('detail'), resizes, mutations })).finally(() => {
    disposeModules(dom.node('detail')); dom.restore();
    if (originalResize === undefined) delete globalThis.ResizeObserver; else globalThis.ResizeObserver = originalResize;
    if (originalMutation === undefined) delete globalThis.MutationObserver; else globalThis.MutationObserver = originalMutation;
  });
}

const measure = (view, height, limit = 400) => {
  view.content.getBoundingClientRect = () => ({ height });
  if (view.gauge) view.gauge.getBoundingClientRect = () => ({ height: limit });
  view.measure();
};

test('shared preview is opt-in, moves bare text/editor nodes, stays idempotent and leaves diagnostics outside clipping', () => fixture(async ({ panel }) => {
  const section = block('常规模块'), untouched = block('不裁切'), editor = el('textarea'); editor.value = '未保存草稿';
  section.append('裸文本', editor); panel.append(section, untouched);
  const states = new Map(), view = enhanceModule(section, { key: 'list', states, summary: '读取失败：请重试' });
  expect(section.querySelectorAll('.module-body')).toHaveLength(1);
  expect(view.content.childNodes[0].textContent).toBe('裸文本'); expect(view.content.children[0]).toBe(editor);
  expect(view.summary.parentNode).toBe(section); expect(view.summary.getAttribute('role')).toBe('status');
  expect(view.body.querySelector('.module-summary')).toBeNull(); expect(untouched.querySelector('.module-body')).toBeNull();
  for (const height of [100, 400, 519, 520]) {
    measure(view, height); expect(view.toggle.hidden).toBe(true); expect(section.classList.contains('module-long')).toBe(false);
  }
  measure(view, 521); expect(view.toggle.hidden).toBe(false); expect(view.expanded).toBe(false);
  expect(view.toggle.getAttribute('aria-controls')).toBe(view.body.id);
  expect(view.toggle.getAttribute('data-help')).toContain('不调用 Agent');
  await view.toggle.click(); expect(states.get('list')).toBe(true);
  expect(enhanceModule(section, { key: 'list', summary: '新的失败摘要' })).toBe(view);
  expect(view.expanded).toBe(true); expect(view.summary.textContent).toBe('新的失败摘要');
  const diagnostic = el('span', '异步读取状态'); view.summary.append(diagnostic);
  enhanceModule(section, { key: 'list', states });
  expect(diagnostic.parentNode).toBe(view.summary); expect(view.summary.hidden).toBe(false);
  enhanceModule(section, { summary: '' }); expect(view.summary.hidden).toBe(true);
  expect(view.summary.textContent).toBe('');
  expect(editor.value).toBe('未保存草稿'); expect(section.querySelectorAll('.module-toggle')).toHaveLength(1);
  measure(view, 150, 200); expect(view.toggle.hidden).toBe(true); expect(view.expanded).toBe(true);
  measure(view, 700, 200); expect(view.toggle.hidden).toBe(false); expect(view.expanded).toBe(true);
  expect(() => enhanceModule(section, { mode: 'fold' })).toThrow('two presentation modes');
  expect(() => enhanceModule(block('错误模式'), { mode: 'auto' })).toThrow('Unknown module mode');
  expect(() => enhanceModule(el('div'))).toThrow('section-title');
}));

test('fold is explicit even for huge form/questionnaire content, summary stays visible and collapse returns focus', () => fixture(async ({ dom, panel }) => {
  const section = block('待答问卷'), input = el('textarea'); input.value = '未提交回答'; section.append(input); panel.append(section);
  const states = new Map(), view = enhanceModule(section, { key: 'questionnaire', mode: 'fold', states, summary: '等待回答 · 失败诊断' });
  measure(view, 100000);
  expect(view.expanded).toBe(true); expect(view.body.hidden).toBe(false); expect(view.gauge).toBeNull();
  expect(section.classList.contains('module-long')).toBe(false); expect(view.toggle.hidden).toBe(false);
  input.focus(); await view.toggle.click();
  expect(view.body.hidden).toBe(true); expect(view.summary.hidden).toBe(false);
  expect(dom.document.activeElement).toBe(view.toggle); expect(states.get('questionnaire')).toBe(false);
  await view.toggle.click(); expect(view.body.hidden).toBe(false); expect(input.value).toBe('未提交回答');
  expect(view.content.children[0]).toBe(input);
}));

test('page-owned maps restore rebuilt modules, isolate scopes and do not share by matching title', () => fixture(async ({ panel }) => {
  const states = new Map(), first = block('历史'), second = block('历史'); panel.append(first, second);
  const one = enhanceModule(first, { key: 'one', states }), two = enhanceModule(second, { key: 'two', states });
  one.setExpanded(true); expect(two.expanded).toBe(false);
  const replacement = block('历史'); expect(enhanceModule(replacement, { key: 'one', states }).expanded).toBe(true);
  expect(enhanceModule(block('历史'), { key: 'one', states: new Map() }).expanded).toBe(false);
  expect(enhanceModule(first, { key: 'one', states: new Map() }).expanded).toBe(false);
}));

test('focus and detail-compatible reference reveal open every enclosing shared module and details', () => fixture(async ({ panel }) => {
  const outer = block('外层'), inner = block('内层'), details = el('details'), destination = el('p', '引用位置');
  details.append(el('summary', '原文'), destination); inner.append(details); outer.append(inner); panel.append(outer);
  const form = enhanceModule(outer, { key: 'outer', mode: 'fold', states: new Map([['outer', false]]) });
  const reading = enhanceModule(inner, { key: 'inner' }); measure(reading, 1000);
  let revealedMessage = false; destination.revealReadingContent = () => { revealedMessage = true; };
  expect(revealDetailPreview(destination)).toBe(true);
  expect(details.open).toBe(true); expect(form.expanded).toBe(true); expect(reading.expanded).toBe(true); expect(revealedMessage).toBe(true);
  reading.setExpanded(false); let scrolled = false;
  destination.scrollIntoView = options => { scrolled = true; expect(reading.expanded).toBe(true); expect(options.block).toBe('center'); };
  for (const listener of reading.body.listeners.focusin) listener({ target: destination });
  expect(scrolled).toBe(true); expect(reading.expanded).toBe(true); expect(revealModule(el('p'))).toBe(false);
  reading.setExpanded(false); reading.dispose(); scrolled = false;
  for (const listener of reading.body.listeners.focusin) listener({ target: destination });
  expect(scrolled).toBe(false); expect(reading.expanded).toBe(false);
}));

test('observers compensate layout once, release old subscriptions, skip stale pages and disconnect on view disposal', () => fixture(async ({ panel, resizes, mutations }) => {
  const section = block('模块'); panel.append(section); panel.dataset.view = 'settings';
  const view = enhanceModule(section, { key: 'settings' });
  let captures = 0, restores = 0, scroll = 0;
  const options = { capture: () => { captures++; return { scroll }; }, restore: (_panel, state) => { restores++; expect(state.scroll).toBe(scroll); } };
  const dispose = observeModules(panel, [view], options), first = resizes[0];
  expect([...first.targets]).toEqual([view.content, view.gauge, section, view.head]);
  measure(view, 1000); first.callback(); expect(restores).toBe(1);
  scroll = 20; first.callback(); expect(restores).toBe(2);
  observeModules(panel, [view], options); expect(first.disconnected).toBe(true); expect(mutations[0].disconnected).toBe(true);
  const before = captures; view.setExpanded(true); await Promise.resolve(); expect(captures).toBe(before + 1);
  dispose(); // An old disposer must not kill a new page observer.
  expect(resizes[1].disconnected).not.toBe(true);
  panel.dataset.view = 'tasks'; mutations[1].callback(); expect(resizes[1].disconnected).toBe(true);
  const count = restores; resizes[1].callback(); expect(restores).toBe(count);
  panel.dataset.view = 'settings'; observeModules(panel, [view], options); view.dispose();
  expect(resizes[2].disconnected).toBe(true); expect(mutations[2].disconnected).toBe(true);
  view.setExpanded(false); for (const listener of view.body.listeners.focusin) listener(); expect(view.expanded).toBe(false);
  enhanceModule(section, { key: 'settings' }); observeModules(panel, [view], options);
  panel.replaceChildren(); mutations[3].callback(); expect(resizes[3].disconnected).toBe(true);
}));

test('removing one module unobserves its geometry without disabling remaining modules', () => fixture(({ panel, resizes }) => {
  const a = block('甲'), b = block('乙'); panel.append(a, b);
  const one = enhanceModule(a), two = enhanceModule(b); observeModules(panel, [one, two]);
  a.remove(); resizes[0].callback();
  expect(resizes[0].targets.has(one.content)).toBe(false); expect(resizes[0].targets.has(two.content)).toBe(true);
  expect(resizes[0].disconnected).not.toBe(true);
}));

test('automation compatibility keeps moduleBody hidden/id, moduleOpen map and visible error summary without extra controls', () => fixture(async ({ panel }) => {
  const section = block('自动化'), editor = el('textarea'); editor.value = '草稿'; section.append('裸文本', editor); panel.append(section);
  const states = new Map([['signals', false]]);
  expect(automationModule(section, 'signals', states, '未知副作用')).toBe(section);
  expect(section.moduleOpen).toBe(false); expect(section.moduleBody.hidden).toBe(true);
  const toggle = section.querySelector('.automation-module-toggle');
  expect(toggle.getAttribute('aria-controls')).toBe(section.moduleBody.id);
  expect(section.moduleSummary.textContent).toBe('未知副作用'); expect(section.moduleSummary.hidden).toBe(false);
  section.moduleOpen = true; expect(states.get('signals')).toBe(true); expect(section.moduleBody.hidden).toBe(false);
  section.moduleOpen = false; automationModule(section, 'signals', states, '读取失败');
  expect(section.moduleOpen).toBe(false); expect(section.querySelectorAll('.module-body')).toHaveLength(1);
  expect(section.querySelectorAll('.module-toggle')).toHaveLength(1); expect(deepText(section.moduleBody)).toContain('裸文本');
  expect(editor.value).toBe('草稿'); await toggle.click(); expect(section.moduleOpen).toBe(true);
  const implicit = automationModule(block('默认状态'), 'implicit'); implicit.moduleOpen = false;
  automationModule(implicit, 'implicit'); expect(implicit.moduleOpen).toBe(false);
  const explicit = new Map(); automationModule(block('默认展开'), 'default', explicit); expect(explicit.get('default')).toBe(true);
}));

for (const page of [false, true]) test(`ordinary wrapped page preserves a visible reading anchor (${page ? 'mobile' : 'desktop'})`, () => fixture(({ dom, panel }) => {
  dom.window.innerWidth = page ? 390 : 1440; dom.window.innerHeight = 900;
  dom.window.matchMedia = () => ({ matches: page }); dom.window.scrollY = page ? 500 : 0;
  dom.window.scrollTo = ({ top }) => { dom.window.scrollY = top; }; panel.scrollTop = page ? 0 : 500;
  panel.getBoundingClientRect = () => ({ top: 0, bottom: 900 });
  const wrapper = el('div'), section = block('设置'), text = el('p', '阅读位置');
  section.append(text); wrapper.append(section); panel.append(wrapper);
  enhanceModule(section, { key: 'settings', mode: 'fold' }); section.dataset.module = 'settings';
  let shift = 0;
  const scroll = () => page ? dom.window.scrollY : panel.scrollTop;
  section.getBoundingClientRect = () => ({ top: 400 + shift - scroll(), bottom: 1500 + shift - scroll() });
  text.getBoundingClientRect = () => ({ top: 650 + shift - scroll(), bottom: 690 + shift - scroll() });
  const saved = captureModuleReading(panel); expect(saved.key).toBe('settings'); expect(saved.anchor).toBe(text);
  shift = 180; restoreModuleReading(panel, saved); expect(scroll()).toBe(680); expect(text.getBoundingClientRect().top).toBe(150);
}));
