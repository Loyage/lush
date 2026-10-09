import { test, expect } from 'bun:test';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { until } from '../helpers.js';
import { ui, resetUiState } from '../../src/ui/web/assets/state.js';
import { registerNavigation } from '../../src/ui/web/assets/navigate.js';
import { activateDetailView, openResource } from '../../src/ui/web/assets/sidebar-ui.js';
import { initNoticeRecords, openNotice, renderNotices } from '../../src/ui/web/assets/render-notices.js';
import { automaticNotice, noticeMatches } from '../../src/ui/web/assets/notice-kind.js';
import { renderAutoSelectBanner, applyAutoSelectCatalogue } from '../../src/ui/web/assets/auto-select-banner.js';

const model = (enabled = true, revision = 'auto-v1', editable = true) => ({ enabled, revision, editable });
const catalogue = (enabled = false, revision = 'auto-v2') => ({ daemon_hooks: { version: 1, revision, mounts: [{ id: 'auto-select', enabled, editable: true }] } });
const json = value => ({ ok: true, json: async () => structuredClone(value) });
const base = { task_id: 10, task_worker_number: 'W158', kind: 'question', status: 'answered', body: '原始问题正文', answer: '请由 Agent 自行判断并继续。', created_at: '2026-01-01T00:00:00Z' };
const body = JSON.stringify({ version: 1, context: '原问卷说明', questions: [{ header: '方案', question: '采用哪个方案？', options: [{ label: '第一项', description: '说明 A' }, { label: '第二项', description: '说明 B' }] }] });
const answer = JSON.stringify({ version: 1, answers: [{ question: '采用哪个方案？', header: '方案', selected: [0], labels: ['第一项'], custom: '' }] });

test('automatic filter uses explicit source, settled question type and status rather than answer text', () => {
  for (const kind of ['question', 'questionnaire']) {
    expect(automaticNotice({ ...base, kind, answer_source: 'lush' })).toBe(true);
    expect(noticeMatches({ ...base, kind, answer_source: 'lush' }, 'automatic')).toBe(true);
    for (const source of ['user', null, undefined]) expect(automaticNotice({ ...base, kind, answer_source: source })).toBe(false);
  }
  for (const status of ['open', 'dismissed', 'sent']) expect(automaticNotice({ ...base, status, answer_source: 'lush' })).toBe(false);
  for (const kind of ['info', 'plan']) expect(automaticNotice({ ...base, kind, answer_source: 'lush' })).toBe(false);
});

test('dedicated tab paginates automatic answers and replays text/questionnaires read-only, including Worker numbers', async () => {
  const rows = [
    { ...base, id: 9, title: '人工答复', answer_source: 'user' },
    { ...base, id: 8, title: '自动问卷', answer_source: 'lush', kind: 'questionnaire', body, answer },
    { ...base, id: 7, title: '历史未知来源', answer_source: null },
    { ...base, id: 6, title: '自动文字问题', answer_source: 'lush' },
  ];
  const reads = [], writes = [];
  const dom = installDom({ fetch: async (url, options = {}) => {
    if (options.body) { writes.push(options.body); throw new Error('history must be read-only'); }
    if (url === '/api/worker/10') return json({ id: 10, worker_number: 'W158' });
    const params = new URL(url, 'http://localhost').searchParams;
    reads.push(params.get('status'));
    const filtered = rows.filter(row => row.id < Number(params.get('before') || Infinity) && noticeMatches(row, params.get('status') || 'all'));
    const notices = filtered.slice(0, Number(params.get('limit') || 1));
    return json({ notices, cursor: notices.at(-1)?.id, has_more: filtered.length > notices.length });
  } });
  resetUiState(); initNoticeRecords(); openResource('notices');
  try {
    await findByText(dom.node('side-notices-body'), '自动选择').onclick();
    expect(ui.noticeRecords.status).toBe('automatic');
    expect(deepText(dom.node('notices'))).toContain('自动问卷');
    expect(deepText(dom.node('notices'))).not.toContain('人工答复');
    await findByText(dom.node('notice-pagination'), '加载更早记录').onclick();
    expect(ui.noticeRecords.rows.map(row => row.id)).toEqual([8, 6]);
    expect(reads.filter(value => value === 'automatic')).toHaveLength(2);
    await openNotice(8);
    const focus = dom.node('notice-record-detail');
    expect(deepText(focus)).toContain('W158'); expect(deepText(focus)).toContain('Lush 自动选择');
    expect(deepText(focus)).toContain('采用哪个方案？'); expect(deepText(focus)).toContain('第二项');
    expect(focus.querySelector('textarea')).toBeNull();
    expect(focus.querySelectorAll('button').every(node => !node.classList.contains('agent-call'))).toBe(true);
    await focus.querySelector('.decision-option').onclick(); expect(writes).toHaveLength(0);
    await openNotice(6);
    expect(deepText(focus)).toContain('原始问题正文'); expect(deepText(focus)).toContain(base.answer);
    expect(focus.querySelector('textarea')).toBeNull(); expect(writes).toHaveLength(0);
    renderNotices({ revision: 'new', notices: [rows[0], rows[1]] });
    expect(deepText(dom.node('notices'))).not.toContain('人工答复');
    expect(ui.noticeRecords.rows).toHaveLength(2);
  } finally { dom.restore(); resetUiState(); }
});

test('persistent banner survives navigation, reuses focused controls and opens automatic history without calling Agent', async () => {
  const writes = [];
  const dom = installDom({ fetch: async (_url, options = {}) => {
    if (options.body) writes.push(options.body);
    return json({ notices: [], cursor: null, has_more: false });
  } });
  resetUiState(); initNoticeRecords();
  const restore = registerNavigation({ resource: openResource, refresh: async () => {} });
  try {
    const host = dom.node('auto-select-banner');
    renderAutoSelectBanner(model(false)); expect(host.hidden).toBe(true);
    applyAutoSelectCatalogue(catalogue(true, 'auto-v2'));
    expect(host.hidden).toBe(false); expect(deepText(host)).toContain('自动选择已开启');
    expect(deepText(host)).toContain('离开页面后'); expect(deepText(host)).toContain('调用费用');
    const close = findByText(host, '关闭自动选择'); close.focus();
    for (const view of ['task-graph', 'settings', 'docs', 'task']) {
      activateDetailView({ view }); renderAutoSelectBanner(model(true, 'auto-v2'));
      expect(host.hidden).toBe(false); expect(document.activeElement).toBe(close);
      expect(findByText(host, '关闭自动选择')).toBe(close);
    }
    expect(close.classList.contains('agent-call')).toBe(false); expect(close.dataset.help).toContain('不撤回已有答案');
    await findByText(host, '查看自动问答').onclick();
    await until(() => !ui.noticeRecords.pending);
    expect(ui.indexOpen).toBe('notices'); expect(ui.noticeRecords.status).toBe('automatic');
    expect(writes).toHaveLength(0);
    expect(dom.node('side-notices-body').querySelectorAll('button').find(node => node.dataset.noticeFilter === 'automatic').getAttribute('aria-pressed')).toBe('true');
  } finally { restore(); dom.restore(); resetUiState(); }
});

test('closing uses the independent revision once, applies ACK before refresh and ignores stale pre-ACK polls', async () => {
  let release, refreshes = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const calls = [];
  const dom = installDom({ fetch: async (_url, options) => { calls.push(JSON.parse(options.body)); return pending; } });
  resetUiState();
  const restore = registerNavigation({ refresh: async () => { refreshes++; throw new Error('refresh offline'); } });
  try {
    const host = dom.node('auto-select-banner');
    renderAutoSelectBanner(model()); ui.lastSnapshot = { status: { auto_select: model() } };
    const close = findByText(host, '关闭自动选择');
    const closing = close.onclick(); await close.onclick();
    expect(calls).toEqual([{ method: 'hooks.auto_select', params: { enabled: false, expected_revision: 'auto-v1' } }]);
    expect(close.disabled).toBe(true); expect(close.parentNode.dataset.help).toContain('正在保存');
    activateDetailView({ view: 'docs' });
    release(json(catalogue())); await closing;
    expect(host.hidden).toBe(true); expect(ui.lastSnapshot.status.auto_select.enabled).toBe(false);
    renderAutoSelectBanner(model()); expect(host.hidden).toBe(true);
    await until(() => refreshes === 1);
    expect(ui.view.id).toBe('docs');
    renderAutoSelectBanner(model(true, 'auto-v3')); expect(host.hidden).toBe(false);
  } finally { restore(); dom.restore(); resetUiState(); }
});

test('an older close ACK does not permanently suppress a newer authorization from another tab', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const dom = installDom({ fetch: async () => pending }); resetUiState();
  const restore = registerNavigation({ refresh: async () => {} });
  try {
    const host = dom.node('auto-select-banner'); renderAutoSelectBanner(model());
    const closing = findByText(host, '关闭自动选择').onclick();
    renderAutoSelectBanner(model(true, 'auto-v3'));
    release(json(catalogue(false, 'auto-v2'))); await closing;
    renderAutoSelectBanner(model(true, 'auto-v3'));
    expect(host.hidden).toBe(false);
    expect(findByText(host, '关闭自动选择').disabled).toBe(false);
  } finally { restore(); dom.restore(); resetUiState(); }
});

test('failure retains enabled warning; offline/read-only states cannot falsely stop automatic answering', async () => {
  let calls = 0;
  const dom = installDom({ fetch: async () => { calls++; return { ok: false, status: 400, json: async () => ({ error: 'revision changed' }) }; } });
  resetUiState();
  const restore = registerNavigation({ refresh: async () => {} });
  try {
    const host = dom.node('auto-select-banner'); renderAutoSelectBanner(model());
    const close = findByText(host, '关闭自动选择'); await close.onclick();
    expect(host.hidden).toBe(false); expect(close.disabled).toBe(false);
    expect(dom.node('error').textContent).toContain('关闭未确认');
    renderAutoSelectBanner(model(), { offline: true });
    expect(deepText(host)).toContain('当前离线'); expect(close.disabled).toBe(true);
    await close.onclick(); expect(calls).toBe(1);
    renderAutoSelectBanner(model(true, 'auto-v1', false));
    expect(close.disabled).toBe(true); expect(close.parentNode.dataset.help).toContain('暂不允许');
    renderAutoSelectBanner(model(false, 'auto-v2')); expect(host.hidden).toBe(true);
  } finally { restore(); dom.restore(); resetUiState(); }
});

test('late close ACK cannot leak authorization or alerts into another project/boot', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const dom = installDom({ fetch: async () => pending }); resetUiState();
  const restore = registerNavigation({ refresh: async () => { throw new Error('wrong project refresh'); } });
  try {
    const host = dom.node('auto-select-banner'); renderAutoSelectBanner(model());
    const closing = findByText(host, '关闭自动选择').onclick();
    dom.location.pathname = '/p/another/'; resetUiState(); renderAutoSelectBanner(model(true, 'other-v1'));
    release(json(catalogue())); await closing;
    expect(host.hidden).toBe(false); expect(deepText(host)).toContain('已开启');
    expect(dom.node('error').textContent).toBe('');
  } finally { restore(); dom.restore(); resetUiState(); }
});
