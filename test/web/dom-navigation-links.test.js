import { test, expect } from 'bun:test';
import { installDom } from '../dom-stub.js';
import { renderAgent } from '../../src/ui/web/assets/render-agent.js';
import { renderDiff } from '../../src/ui/web/assets/render-diff.js';
import { executionTarget } from '../../src/ui/web/assets/execution-route.js';
import { detailActions } from '../../src/ui/web/assets/detail-actions.js';
import { workerCliTarget } from '../../src/ui/web/assets/worker-cli-route.js';
import { ui } from '../../src/ui/web/assets/state.js';

test('unified workbench preserves project and legacy CLI bookmarks remain strict', () => {
  const dom = installDom(); dom.location.pathname = '/p/0123456789abcdef/';
  try {
    const link = detailActions({ id: 42, worker_number: 'W333', task_kind: 'order' }).root.children[0];
    expect(link.textContent).toBe('打开工作台'); expect(link.href).toBe('/p/0123456789abcdef/#worker-42-execution');
    expect(link.target).toBe('_blank'); expect(link.rel).toBe('noopener'); expect(link.onclick).toBeFalsy();
    expect(link.classList.contains('nav-link')).toBe(true);
    expect(workerCliTarget('#worker-42-cli')).toEqual({ taskId: 42 });
    for (const hash of ['#worker-0-cli', '#worker-01-cli', '#worker-W333-cli', '#worker-1-cli-other', '#worker-9007199254740992-cli']) expect(workerCliTarget(hash)).toBeNull();
    expect(link.getAttribute('data-help')).toContain('不会执行命令或调用 Agent');
  } finally { dom.restore(); }
});

test('one reading entry replaces module links without eager reads or changing source state', () => {
  const dom = installDom(); dom.location.pathname = '/p/0123456789abcdef/';
  const selected = ui.selected, reader = ui.transcriptView, task = { id: 42, workspace: '/tmp/worker' };
  dom.node('detail').scrollTop = 321;
  try {
    expect(renderAgent(task, null).querySelector('a')).toBeNull();
    expect(renderDiff(null, 42, task).querySelector('a')).toBeNull();
    const link = detailActions(task).root.querySelector('a');
    expect(link.tagName).toBe('A'); expect(link.target).toBe('_blank');
    expect(link.href).toBe('/p/0123456789abcdef/#worker-42-execution');
    expect(link.onclick).toBeFalsy(); expect(link.classList.contains('nav-link')).toBe(true);
    expect(executionTarget('#worker-42-execution')).toEqual({ taskId: 42, mode: 'transcript' });
    expect(executionTarget('#worker-42-execution-code')).toEqual({ taskId: 42, mode: 'code' });
    expect(executionTarget('#worker-42-execution-cli')).toEqual({ taskId: 42, mode: 'cli' });
    expect(executionTarget('#worker-42-execution-performance')).toEqual({ taskId: 42, mode: 'performance' });
    expect(ui.selected).toBe(selected); expect(ui.transcriptView).toBe(reader); expect(dom.node('detail').scrollTop).toBe(321);
  } finally { dom.restore(); }
});
