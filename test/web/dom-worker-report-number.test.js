import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { ui, resetUiState } from '../../src/ui/web/assets/state.js';
import { workerLabel } from '../../src/ui/web/assets/worker-label.js';
import { explanationLocation } from '../../src/ui/web/assets/quick-explanation.js';
import { renderStatistics } from '../../src/ui/web/assets/render-statistics.js';
import { renderVerifications } from '../../src/ui/web/assets/render-verify.js';
import { renderResolutions } from '../../src/ui/web/assets/render-resolutions.js';
import { specItem } from '../../src/ui/web/assets/render-specs.js';
import { sleepChoiceCard } from '../../src/ui/web/assets/sleep-ui.js';
import { registerNavigation } from '../../src/ui/web/assets/navigate.js';

const requests = [];
const dom = installDom({ fetch: async url => { requests.push(url); throw new Error('labels must not fetch'); } });
dom.document.createElementNS = (_ns, tag) => dom.document.createElement(tag);
beforeEach(() => { resetUiState(); dom.location.pathname = '/p/aaaaaaaaaaaaaaaa/'; requests.length = 0; });
afterAll(() => dom.restore());
const totals = () => ({ tokens: 0, cost: 0, requests: 0, input: 0, output: 0, cache_read: 0, cache_write: 0,
  unknown_cost: 0, unknown_tokens: 0 });

test('statistics Worker and invocation attribution use explicit deep labels and cache without changing run identities', () => {
  workerLabel(301, 'W8-1');
  const data = { totals: totals(), range: { start: null, end: '2026-10-01' }, generated_at: '2026-10-01',
    coverage: {}, buckets: [], models: [], interval: 'day',
    tasks: [{ ...totals(), task_id: 205, task_worker_number: 'W5-3-2', role: 'agent' },
      { ...totals(), task_id: 47, task_worker_number: null, role: 'worker' }],
    invocations: [{ ...totals(), task_id: 301, run_id: 19, role: 'agent' }] };
  const snapshot = structuredClone(data);
  const text = deepText(renderStatistics(data));
  expect(text).toContain('W5-3-2 · agent'); expect(text).not.toContain('#205');
  expect(text).toContain('#47 · worker'); expect(text).toContain('W8-1 · agent · run 19');
  expect(data).toEqual(snapshot); expect(requests).toHaveLength(0);
});

test('quick explanation source labels use metadata/cache only, remain project scoped and leave locations untouched', () => {
  const location = { view: 'task', section: 'result', task_id: 205, task_worker_number: 'W5-3-2', path: 'src/code.js' };
  const snapshot = structuredClone(location);
  expect(explanationLocation(location)).toContain('Worker W5-3-2');
  expect(explanationLocation({ task_id: 205 })).toBe('Worker W5-3-2');
  expect(location).toEqual(snapshot);
  dom.location.pathname = '/p/bbbbbbbbbbbbbbbb/';
  expect(explanationLocation({ task_id: 205 })).toBe('Worker #205');
  expect(explanationLocation({ task_id: 47, task_worker_number: null })).toBe('Worker #47');
  expect(requests).toHaveLength(0);
});

test('verification and resolution labels prefer metadata while reference targets and navigation stay integer', async () => {
  const verifier = { id: 205, worker_number: 'W5-3-2', role: 'verifier', verifies_task_id: 301,
    verifies_task_worker_number: 'W8-1', result: null };
  const snapshot = structuredClone(verifier);
  const own = renderVerifications(verifier);
  expect(deepText(own)).toContain('本 Worker 检验 W8-1');
  expect(own.dataset.ref).toContain('verification-205'); expect(own.dataset.ref).not.toContain('W5');
  expect(verifier).toEqual(snapshot);
  const task = { id: 301, verifications: [{ id: 205, worker_number: 'W5-3-2', status: 'completed' },
    { id: 47, worker_number: null, status: 'failed', error: '历史报告 #47 不回写' }] };
  const section = renderVerifications(task);
  expect(deepText(section)).toContain('W5-3-2'); expect(deepText(section)).toContain('#47');
  expect(deepText(section)).toContain('历史报告 #47 不回写');
  expect(section.querySelector('.verify').dataset.ref).toContain('verification-205');
  let opened;
  const restore = registerNavigation({ detail: id => { opened = id; } });
  try {
    await section.querySelector('button').onclick(); expect(opened).toBe(205);
    const resolution = renderResolutions({ resolutions: [{ id: 205, worker_number: 'W5-3-2', status: 'completed', integration: 'merged' },
      { id: 47, worker_number: null, status: 'failed', integration: 'conflict' }] });
    expect(deepText(resolution)).toContain('W5-3-2'); expect(deepText(resolution)).toContain('#47');
    await resolution.querySelector('button').onclick(); expect(opened).toBe(205);
  } finally { restore(); }
  expect(requests).toHaveLength(0);
});

test('spec items still reachable in historical Worker detail only relabel their associated Worker, not spec identity', async () => {
  const spec = { id: 19, status: 'planned', task_id: 205, task_worker_number: 'W5-3-2', goal: '历史规划', deps: [12] };
  const snapshot = structuredClone(spec), item = specItem(spec);
  expect(deepText(item)).toContain('Worker W5-3-2'); expect(deepText(item)).toContain('#19');
  expect(deepText(item)).toContain('依赖 spec #12'); expect(item.dataset.ref).toContain('spec-19');
  let opened;
  const restore = registerNavigation({ detail: id => { opened = id; } });
  try { await item.querySelector('button').onclick(); expect(opened).toBe(205); } finally { restore(); }
  expect(spec).toEqual(snapshot); expect(requests).toHaveLength(0);
});

test('historical butler cards label Workers independently from Notice and choice numbers without rewriting snapshots', () => {
  const choice = { id: 12, mode: 'recommended', created_at: '2026-10-01',
    notice: { id: 19, task_id: 205, task_worker_number: 'W5-3-2', title: '历史事项', kind: 'question', body: '历史正文 #205' },
    result: { status: 'applied' } };
  const snapshot = structuredClone(choice);
  const text = deepText(sleepChoiceCard(choice));
  expect(text).toContain('管家选择 #12'); expect(text).toContain('Notice #19');
  expect(text).toContain('Worker W5-3-2'); expect(text).toContain('历史正文 #205');
  expect(choice).toEqual(snapshot); expect(requests).toHaveLength(0);
  choice.notice.task_worker_number = null;
  expect(deepText(sleepChoiceCard(choice))).toContain('Worker #205');
});
