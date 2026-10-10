import { test, expect } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { block, el } from '../../src/ui/web/assets/dom.js';
import { limitDetailModules, revealDetailPreview } from '../../src/ui/web/assets/detail-preview.js';
import { renderDetail } from '../../src/ui/web/assets/render-detail.js';
import { locateReference, referenceable, clearLocateFlash } from '../../src/ui/web/assets/context-references.js';
import { registerNavigation } from '../../src/ui/web/assets/navigate.js';

function fixture(run) {
  const dom = installDom(), previous = globalThis.ResizeObserver, observers = [];
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
    observe(node) { this.targets.add(node); }
    unobserve(node) { this.targets.delete(node); }
    disconnect() { this.targets.clear(); this.disconnected = true; }
  };
  const resize = (section, height = 1000, limit = 400) => {
    section.querySelector('.detail-preview-content').getBoundingClientRect = () => ({ height });
    section.querySelector('.detail-preview-limit').getBoundingClientRect = () => ({ height: limit });
    observers.at(-1).callback();
  };
  return Promise.resolve().then(() => run({ dom, observers, resize })).finally(() => {
    clearLocateFlash(); dom.restore();
    if (previous === undefined) delete globalThis.ResizeObserver; else globalThis.ResizeObserver = previous;
  });
}

const toggle = section => section.querySelector('.detail-preview-toggle');
const expanded = section => section.classList.contains('detail-preview-expanded');

test('whole module gets one bounded preview, keeps original nodes/references and exposes one accessible header control only when long', () => fixture(async ({ dom, resize }) => {
  const panel = dom.node('detail'), section = block('消息', '20');
  const messages = Array.from({ length: 20 }, (_, i) => el('p', `消息 ${i}`));
  referenceable(messages[19], { kind: 'message', target: { task_id: 7, message_id: 20 } });
  section.append(...messages); panel.append(section);
  limitDetailModules(panel, { taskId: 7 }); resize(section, 120);
  expect(toggle(section).hidden).toBe(true);
  resize(section);
  expect(toggle(section).hidden).toBe(false); expect(expanded(section)).toBe(false);
  expect(section.querySelectorAll('.detail-preview-body')).toHaveLength(1);
  expect(section.querySelectorAll('.detail-preview-toggle')).toHaveLength(1);
  expect(section.querySelector('.section-title').querySelector('.detail-preview-toggle')).toBe(toggle(section));
  expect(section.querySelector('.detail-preview-footer').querySelector('.detail-preview-toggle')).toBeNull();
  expect(section.querySelector('.detail-preview-content').children).toEqual(messages);
  expect(deepText(section)).toContain('消息 19'); expect(messages[19].dataset.ref).toBe('message-20');
  const control = toggle(section);
  let scrolledControl = false;
  control.scrollIntoView = () => { scrolledControl = true; };
  expect(control.getAttribute('aria-controls')).toBe(section.querySelector('.detail-preview-body').id);
  expect(control.getAttribute('aria-label')).toContain('消息'); expect(control.getAttribute('data-help')).toContain('不调用 Agent');
  await control.click(); expect(expanded(section)).toBe(true); expect(control.getAttribute('aria-expanded')).toBe('true');
  expect(control.textContent).toBe('收起'); expect(scrolledControl).toBe(false);
  await control.click(); expect(expanded(section)).toBe(false); expect(control.getAttribute('aria-expanded')).toBe('false');
  expect(control.textContent).toBe('展开完整内容'); expect(scrolledControl).toBe(true);
  expect(section.querySelector('.detail-preview-content').children[19]).toBe(messages[19]);
}));

test('same Worker refresh preserves expansion even when module rebuilt; other Workers reset and observers are released', () => fixture(async ({ dom, observers, resize }) => {
  const panel = dom.node('detail'), first = block('结果'); first.append(el('p', '原结果')); panel.append(first);
  limitDetailModules(panel, { taskId: 7 }); resize(first); await toggle(first).click();
  const second = block('结果'); second.append(el('p', '新结果')); panel.replaceChildren(second);
  limitDetailModules(panel, { taskId: 7 }); resize(second);
  expect(observers[0].disconnected).toBe(true); expect(expanded(second)).toBe(true);
  expect(deepText(second)).toContain('新结果');
  await toggle(second).click(); limitDetailModules(panel, { taskId: 7 }); resize(second);
  expect(expanded(second)).toBe(false); expect(second.querySelectorAll('.detail-preview-body')).toHaveLength(1);
  await toggle(second).click();
  const third = block('结果'); panel.replaceChildren(third); limitDetailModules(panel, { taskId: 8 }); resize(third);
  expect(expanded(third)).toBe(false);
  panel.replaceChildren(); observers.at(-1).callback(); expect(observers.at(-1).targets.size).toBe(0);
}));

test('natural content observation handles lazy growth, narrow viewports and shrinking without resetting manual state', () => fixture(async ({ dom, observers, resize }) => {
  const panel = dom.node('detail'), section = block('事件时间线'); panel.append(section);
  limitDetailModules(panel, { taskId: 7 });
  expect([...observers[0].targets]).toEqual([section.querySelector('.detail-preview-content'), section.querySelector('.detail-preview-limit'), section, section.children[0]]);
  resize(section, 400, 400); expect(toggle(section).hidden).toBe(true);
  resize(section, 400, 160); expect(toggle(section).hidden).toBe(false);
  await toggle(section).click();
  resize(section, 100, 160); expect(toggle(section).hidden).toBe(true); expect(expanded(section)).toBe(true);
  resize(section, 800, 160); expect(toggle(section).hidden).toBe(false); expect(expanded(section)).toBe(true);
}));

test('only overflow beyond the 120px margin clips; exact boundary and shrinking stay fully visible', () => fixture(async ({ dom, resize }) => {
  const panel = dom.node('detail'), section = block('结果'); panel.append(section);
  limitDetailModules(panel, { taskId: 7 });
  const footer = section.querySelector('.detail-preview-footer');
  for (const limit of [400, 275.5]) {
    for (const height of [limit - 1, limit, limit + 1, limit + 119, limit + 120]) {
      resize(section, height, limit);
      expect(section.classList.contains('detail-preview-long')).toBe(false);
      expect(toggle(section).hidden).toBe(true); expect(footer.hidden).toBe(true);
    }
    resize(section, limit + 120.5, limit);
    expect(section.classList.contains('detail-preview-long')).toBe(true);
    expect(toggle(section).hidden).toBe(false); expect(footer.hidden).toBe(false);
    expect(expanded(section)).toBe(false);
    await toggle(section).click();
    resize(section, limit + 120, limit);
    expect(section.classList.contains('detail-preview-long')).toBe(false);
    expect(toggle(section).hidden).toBe(true); expect(expanded(section)).toBe(true);
    resize(section, limit + 121, limit);
    expect(toggle(section).hidden).toBe(false); expect(expanded(section)).toBe(true);
    await toggle(section).click();
    limitDetailModules(panel, { taskId: 7 }); resize(section, limit + 120, limit);
    expect(section.classList.contains('detail-preview-long')).toBe(false);
    expect(toggle(section).hidden).toBe(true);
  }
}));

test('keyboard focus and reference navigation reveal clipped destinations before scrolling', () => fixture(async ({ dom, resize }) => {
  const panel = dom.node('detail'), section = block('消息'), fold = el('details'), message = el('p', '完整来源');
  referenceable(message, { kind: 'message', target: { task_id: 7, message_id: 20 } });
  fold.append(el('summary', '原文'), message); section.append(fold); panel.append(section);
  limitDetailModules(panel, { taskId: 7 }); resize(section);
  for (const listener of section.querySelector('.detail-preview-body').listeners.focusin) listener();
  expect(expanded(section)).toBe(true); await toggle(section).click();
  let revealedWhenScrolled = false;
  message.scrollIntoView = () => { revealedWhenScrolled = expanded(section) && fold.open; };
  const restore = registerNavigation({ detail: async () => {} });
  try {
    expect(await locateReference({ kind: 'message', target: { task_id: 7, message_id: 20 } })).toBe(true);
    expect(revealedWhenScrolled).toBe(true); expect(expanded(section)).toBe(true);
    expect(revealDetailPreview(el('p', '无所属模块'))).toBe(false);
  } finally { restore(); }
}));

const at = '2026-10-08T10:00:00Z';
const task = { id: 7, worker_number: 'W7', role: 'agent', task_kind: 'order', status: 'waiting', calls: 0,
  goal: '目标\n'.repeat(200), result: '结果\n'.repeat(200), created_at: at, updated_at: at,
  messages: Array.from({ length: 20 }, (_, i) => ({ id: i + 1, task_id: 7, sender_id: null, body: `消息 ${i}`, created_at: at })) };

test('detail limits reading blocks only and preserves reused conversation/message nodes and state on refresh', () => fixture(async ({ dom, resize }) => {
  renderDetail(task, { events: [] }, null, null);
  const panel = dom.node('detail'), result = panel.querySelector('.conversation-panel');
  const message = panel.querySelector('.task-message');
  expect(result.classList.contains('detail-preview')).toBe(true);
  const messages = [...panel.children].find(node => node.children[0]?.querySelector('h2')?.textContent === '消息');
  resize(messages); await toggle(messages).click();
  resize(result); await toggle(result).click();
  expect(panel.querySelector('.task-actions').querySelector('.detail-preview-body')).toBeNull();
  renderDetail({ ...task, display_title: '用户自定义标题', messages: [...task.messages, { id: 21, body: '新消息', sender_id: null }] }, { events: [] }, null, null);
  expect(panel.querySelector('h1').textContent).toBe('用户自定义标题');
  expect(panel.querySelector('.task-actions').querySelector('.worker-rename')).toBeTruthy();
  expect(panel.querySelector('.task-actions').querySelector('.detail-preview-body')).toBeNull();
  expect(panel.querySelector('.conversation-panel')).toBe(result);
  expect(panel.querySelector('.task-message')).toBe(message); expect(expanded(result)).toBe(true);
  const updatedMessages = [...panel.children].find(node => node.children[0]?.querySelector('h2')?.textContent === '消息');
  expect(expanded(updatedMessages)).toBe(true); expect(deepText(updatedMessages)).toContain('新消息');
  const ids = panel.querySelectorAll('.detail-preview-body').map(node => node.id);
  expect(new Set(ids).size).toBe(ids.length);
}));

test('merged parent semantics stay intact: child flow Hooks remain unclipped/read-only and historical decisions have no snapshot entry', () => fixture(async ({ dom, resize }) => {
  const requests = [];
  globalThis.fetch = async (url, options) => { requests.push([url, options]); throw new Error('no request expected'); };
  // Even an old editable projection must not offer child flow configuration.
  const completion = { level: 'merge', min_level: 'merge', locked: false, editable: true, phase: 'merge', state: 'waiting' };
  const notice = { id: 71, task_id: 7, kind: 'questionnaire', status: 'answered', title: '历史选择',
    body: JSON.stringify({ version: 1, body: '保留历史', questions: [{ header: '范围', question: '选哪一种？',
      options: [{ label: '方案一', description: '旧选择' }, { label: '方案二', description: '旧候选' }] }] }),
    answer: JSON.stringify({ answers: [{ selected: [0], labels: ['方案一'], custom: '' }] }) };
  const child = { ...task, task_kind: 'child', notices: [notice], completion,
    auto_merge: { enabled: true, locked: false, editable: true },
    hooks: { version: 1, worker_id: 7, revision: 'mount-v1', completion, mounts: [] } };
  renderDetail(child, { events: [] }, null, null);
  const panel = dom.node('detail'), hooks = panel.querySelector('.worker-hooks');
  expect(hooks.classList.contains('detail-preview')).toBe(false);
  expect(hooks.querySelector('.detail-preview-body')).toBeNull();
  const levels = hooks.querySelectorAll('.hook-completion-level'); expect(levels).toHaveLength(3);
  for (const control of levels) { expect(control.disabled).toBe(true); await control.onclick(); }
  const decisions = [...panel.children].find(node => node.children[0]?.querySelector('h2')?.textContent === '决策记录');
  const fold = decisions.querySelector('.decision-record'); fold.open = true;
  resize(decisions); await toggle(decisions).click();
  expect(decisions.classList.contains('detail-preview')).toBe(true); expect(deepText(decisions)).toContain('已选：方案一');
  expect(decisions.querySelector('.choice-snapshot')).toBeNull(); expect(decisions.querySelector('textarea')).toBeNull();
  for (const text of ['查看快照与重选', '重新选择', '确认新选择并创建 Worker']) expect(deepText(decisions)).not.toContain(text);
  renderDetail(child, { events: [] }, null, null);
  const refreshed = [...panel.children].find(node => node.children[0]?.querySelector('h2')?.textContent === '决策记录');
  expect(expanded(refreshed)).toBe(true); expect(refreshed.querySelector('.decision-record')).toBe(fold);
  expect(fold.open).toBe(true); expect(requests).toHaveLength(0);
}));
