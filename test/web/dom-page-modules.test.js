import { test, expect } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { block, el } from '../../src/ui/web/assets/dom.js';
import { ui, resetUiState } from '../../src/ui/web/assets/state.js';
import { pageBlocks, pageModules, disposePageModules } from '../../src/ui/web/assets/page-modules.js';
import { activateDetailView } from '../../src/ui/web/assets/sidebar-ui.js';
import { enhanceModule } from '../../src/ui/web/assets/shared-module.js';
import { initNoticeRecords, noticePanel } from '../../src/ui/web/assets/render-notices.js';
import { renderOverview } from '../../src/ui/web/assets/render-overview.js';

async function fixture(run) {
  const dom = installDom(), before = globalThis.ResizeObserver, observers = [];
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
    observe(node) { this.targets.add(node); } unobserve(node) { this.targets.delete(node); }
    disconnect() { this.targets.clear(); this.disconnected = true; }
  };
  resetUiState(); activateDetailView({ view: 'settings', push: false });
  try { await run({ dom, panel: dom.node('detail'), observers }); }
  finally { disposePageModules(); resetUiState(); dom.restore(); if (before === undefined) delete globalThis.ResizeObserver; else globalThis.ResizeObserver = before; }
}

test('independent page groups share one observer, retain explicit fold state and release on navigation/boot', () => fixture(async ({ panel, observers }) => {
  const a = el('div'), b = el('div'), editor = block('配置'), diagnostics = block('诊断');
  const input = el('textarea'); input.value = '未保存正文'; editor.append(input); a.append(editor); b.append(diagnostics); panel.replaceChildren(a, b);
  const [form] = pageBlocks(a, 'settings', 'fold'); pageBlocks(b, 'diagnostics'); await Promise.resolve();
  expect(observers.at(-1).targets.has(form.content)).toBe(true);
  expect(observers.at(-1).targets.has(diagnostics.querySelector('.module-content'))).toBe(true);
  form.setExpanded(false); expect(input.value).toBe('未保存正文'); expect(form.body.hidden).toBe(true);
  const next = block('配置'); a.replaceChildren(next); const [rebuilt] = pageBlocks(a, 'settings', 'fold'); await Promise.resolve();
  expect(rebuilt.expanded).toBe(false); expect(form.active).toBe(false);
  expect(observers.at(-1).targets.has(diagnostics.querySelector('.module-content'))).toBe(true);
  activateDetailView({ view: 'docs', push: false }); expect(observers.at(-1).disconnected).toBe(true);
  activateDetailView({ view: 'settings', push: false }); panel.replaceChildren(a); expect(pageBlocks(a, 'settings', 'fold')[0].expanded).toBe(true);
  await Promise.resolve(); resetUiState(); expect(observers.at(-1).disconnected).toBe(true);
}));

test('page selection does not scan nested forms or specialized workspaces', () => fixture(({ panel }) => {
  const root = el('div'), known = block('常规模块'), nested = block('嵌套编辑器'), reader = el('section', undefined, 'transcript-dialog');
  known.append(nested); root.append(known, reader); panel.replaceChildren(root);
  pageBlocks(root, 'known', 'fold');
  expect(known.classList.contains('module-fold')).toBe(true);
  expect(nested.classList.contains('ui-module')).toBe(false); expect(reader.classList.contains('ui-module')).toBe(false);
}));

test('repainting a retained section rebuilds its control without stale wrappers or lost fold state', () => fixture(({ panel }) => {
  const section = block('出站网络'); panel.replaceChildren(section);
  const states = new Map(), first = enhanceModule(section, { key: 'network', mode: 'fold', states }); first.setExpanded(false);
  const heading = el('div', undefined, 'section-title'); heading.append(el('h2', '出站网络')); const input = el('input'); input.value = '新草稿';
  section.replaceChildren(heading, input);
  const next = enhanceModule(section, { key: 'network', mode: 'fold', states });
  expect(next).not.toBe(first); expect(first.active).toBe(false); expect(next.expanded).toBe(false);
  expect(next.content.children).toEqual([input]); expect(section.querySelectorAll('.module-toggle')).toHaveLength(1);
}));

test('a queued old page setup cannot attach observation after navigating away', () => fixture(async ({ panel, observers }) => {
  const root = el('div'), section = block('阅读'); root.append(section); panel.replaceChildren(root);
  pageModules(root, { scope: 'late', entries: [{ section, key: 'reading' }] });
  activateDetailView({ view: 'versions', push: false }); await Promise.resolve();
  expect(observers).toHaveLength(0);
}));

test('current questions are explicit folds only; status remains visible and collapse is not an answer', () => fixture(async ({ panel }) => {
  const notice = { id: 777, task_id: 22, kind: 'question', status: 'open', title: '待答问题', body: '长正文'.repeat(200), created_at: '2026-01-01' };
  const section = noticePanel(notice); panel.replaceChildren(section);
  expect(section.classList.contains('module-fold')).toBe(true); expect(section.classList.contains('module-preview')).toBe(false);
  expect(section.querySelector('.module-body').hidden).toBe(false);
  await section.querySelector('.module-toggle').onclick();
  expect(section.querySelector('.module-body').hidden).toBe(true);
  expect(section.querySelector('.module-summary').hidden).toBe(false); expect(notice.status).toBe('open');
  const rebuilt = noticePanel(notice); expect(rebuilt.querySelector('.module-body').hidden).toBe(true);
}));

test('answered decision headings separate metadata from title and preserve fold controls', () => fixture(async ({ panel }) => {
  const notice = { id: 778, task_id: 22, task_worker_number: 'W231', kind: 'questionnaire', status: 'answered',
    answer_source: 'user', title: '已回答的长决策标题'.repeat(12), created_at: '2026-01-01',
    body: JSON.stringify({ version: 1, body: '决定背景', questions: [{ header: '范围', question: '选择范围？',
      options: [{ label: '方案一', description: '当前方案' }, { label: '方案二', description: '候选方案' }] }] }),
    answer: JSON.stringify({ answers: [{ selected: [0], labels: ['方案一'], custom: '' }] }) };
  const section = noticePanel(notice); panel.replaceChildren(section);
  const head = section.querySelector('.notice-head'), title = head.querySelector('h3'), meta = head.querySelector('.notice-meta');
  expect(title.textContent).toBe(notice.title);
  expect([...head.children]).toEqual([meta, title, head.querySelector('.module-toggle')]);
  expect(deepText(meta)).toContain('D778'); expect(deepText(meta)).toContain('W231');
  expect(deepText(meta)).toContain('已回答'); expect(deepText(meta)).toContain('用户答复');
  const body = section.querySelector('.module-body');
  expect(deepText(body)).toContain('方案一');
  await head.querySelector('.module-toggle').onclick(); expect(body.hidden).toBe(true);
  expect(head.querySelector('h3')).toBe(title); expect(deepText(meta)).toContain('已回答');
  await head.querySelector('.module-toggle').onclick(); expect(body.hidden).toBe(false);
}));

test('Notice list heading height follows wrapping and its observer releases on navigation and reset', () => fixture(({ dom, observers }) => {
  const root = dom.node('side-notices'), card = el('div', undefined, 'resource-card'), head = el('div', undefined, 'section-title');
  let height = 41; head.getBoundingClientRect = () => ({ height });
  card.append(head, dom.node('side-notices-body')); root.append(card);
  initNoticeRecords();
  const first = observers.at(-1);
  expect(first.targets.has(head)).toBe(true); expect(card.style.getPropertyValue('--notice-list-heading-height')).toBe('41px');
  height = 82; first.callback(); expect(card.style.getPropertyValue('--notice-list-heading-height')).toBe('82px');
  height = 0; first.callback(); expect(card.style.getPropertyValue('--notice-list-heading-height')).toBe('82px');
  activateDetailView({ view: 'docs', push: false }); expect(first.disconnected).toBe(true);
  height = 60; first.callback(); expect(card.style.getPropertyValue('--notice-list-heading-height')).toBe('82px');
  activateDetailView({ view: 'notices', push: false });
  const resumed = observers.at(-1); expect(resumed).not.toBe(first);
  expect(resumed.targets.has(head)).toBe(true); expect(card.style.getPropertyValue('--notice-list-heading-height')).toBe('60px');
  initNoticeRecords(); expect(resumed.disconnected).toBe(true);
  const rebuilt = observers.at(-1); resetUiState(); expect(rebuilt.disconnected).toBe(true);
}));

test('folded forms keep live failures outside the hidden body and release summary observers', () => fixture(async ({ panel }) => {
  const before = globalThis.MutationObserver, mutations = [];
  globalThis.MutationObserver = class { constructor(callback) { this.callback = callback; mutations.push(this); } observe() {} disconnect() { this.disconnected = true; } };
  try {
    const section = block('设置'), failure = el('p', '', 'settings-error'); failure.hidden = true; section.append(failure); panel.replaceChildren(section);
    const [view] = pageBlocks(panel, 'live-failure', 'fold'); await Promise.resolve(); view.setExpanded(false);
    failure.textContent = '保存失败：编辑仍保留'; failure.hidden = false; mutations[0].callback();
    expect(view.body.hidden).toBe(true); expect(view.summary.hidden).toBe(false); expect(view.summary.textContent).toBe('保存失败：编辑仍保留');
    failure.hidden = true; mutations[0].callback(); expect(view.summary.hidden).toBe(true);
    disposePageModules(); expect(mutations.every(observer => observer.disconnected)).toBe(true);
  } finally { if (before === undefined) delete globalThis.MutationObserver; else globalThis.MutationObserver = before; }
}));

test('overview reading modules reuse preview while maintenance actions remain outside', () => fixture(async ({ panel }) => {
  activateDetailView({ view: 'overview', push: false });
  renderOverview({ revision: 'shared-page-test', status: { agents: [], project: '/temporary', provider: 'mock' }, tasks: [], notices: [] });
  await Promise.resolve();
  const modules = [...panel.children].filter(node => node.classList.contains('block'));
  expect(modules.length).toBeGreaterThan(0);
  expect(modules.every(node => node.classList.contains('module-preview'))).toBe(true);
  expect(panel.querySelector('.project-maintenance')?.classList.contains('module-preview') || false).toBe(false);
}));
