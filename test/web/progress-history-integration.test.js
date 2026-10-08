import { test, expect } from 'bun:test';
import { setup, fetch } from './harness.js';
import { installDom, deepText } from '../dom-stub.js';
import { loadDetail } from '../../src/ui/web/assets/detail.js';
import { refreshProgressDurations } from '../../src/ui/web/assets/render-progress.js';
import { ui, resetUiState } from '../../src/ui/web/assets/state.js';

// Exercise the real Project → RPC → HTTP → detail renderer contract, not a synthetic history fixture.
test('appended work resets current progress while real archived HTTP pages remain folded and readable', async () => {
  const f = await setup();
  f.project.kick = () => {}; // No Agent/model or user daemon is needed for this read-path integration.
  const task = f.store.create({ role: 'agent', task_kind: 'order', goal: 'history integration' });
  const steps = revision => [{ key: 'inspect', label: `检查 ${revision}` }, { key: 'test', label: `测试 ${revision}` }];
  let dom;
  try {
    for (let revision = 0; revision < 13; revision++) f.project.reportProgressPlan(task.id, steps(revision));
    f.project.completeProgressStep(task.id, 'inspect');
    f.project.message(task.id, '追加开发');
    f.project.reportProgressPlan(task.id, steps(12));
    const requests = [];
    dom = installDom({ fetch: (url, options) => { requests.push(String(url)); return fetch(f.url + url, options); } });
    resetUiState();
    await loadDetail(task.id);
    const panel = dom.node('detail'), history = panel.querySelector('.progress-history-panel');
    const current = panel.querySelector('.task-progress-panel');
    expect(current.querySelector('.task-progress-meter').value).toBe(0);
    expect(current.querySelector('.task-progress-meter').max).toBe(2);
    const folds = () => history.querySelectorAll('.progress-history-version');
    expect(folds()).toHaveLength(10);
    expect(folds().every(node => !node.open)).toBe(true);
    expect(folds()[0].querySelector('summary').textContent).toContain('收到追加输入');
    expect(folds()[0].querySelector('.task-progress-meter').value).toBe(1);
    folds()[0].open = true;
    const summary = folds()[0].querySelector('summary');
    summary.focus();
    const text = deepText(folds()[0]);
    refreshProgressDurations(history);
    expect(deepText(folds()[0])).toBe(text);
    expect(history.querySelector('.is-running-duration')).toBeNull();
    await history.querySelector('.progress-history-controls').querySelector('button').click();
    expect(folds()).toHaveLength(13);
    expect(history.querySelector('.progress-history-controls').querySelector('button').hidden).toBe(true);
    expect(requests.filter(url => url.includes('/progress-history?'))).toHaveLength(1);
    await loadDetail(task.id);
    expect(panel.querySelector('.progress-history-panel')).toBe(history);
    expect(folds()).toHaveLength(13);
    expect(folds()[0].open).toBe(true);
    expect(document.activeElement).toBe(summary);
    const snapshot = await (await fetch(f.url + '/api/snapshot')).json();
    const row = snapshot.tasks.find(row => row.id === task.id);
    expect(row.progress.items.filter(item => item.kind !== 'wait' && item.status === 'completed')).toHaveLength(0);
    expect(row.progress_history).toBeUndefined();
    expect(ui.detailTask).toBe(task.id);
  } finally {
    resetUiState(); dom?.restore(); await f.close();
  }
});
