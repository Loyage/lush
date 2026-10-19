import { test, expect } from 'bun:test';
import { installDom } from '../dom-stub.js';
import { renderAgent } from '../../src/ui/web/assets/render-agent.js';
import { renderDiff } from '../../src/ui/web/assets/render-diff.js';
import { executionTarget } from '../../src/ui/web/assets/execution-route.js';
import { workerCliLink, workerCliTarget } from '../../src/ui/web/assets/worker-cli-route.js';
import { ui } from '../../src/ui/web/assets/state.js';

test('CLI interaction entry preserves project and uses strict reloadable Worker route', () => {
  const dom = installDom(); dom.location.pathname = '/p/0123456789abcdef/';
  try {
    const link = workerCliLink({ id: 42, worker_number: 'W333', task_kind: 'order' });
    expect(link.textContent).toBe('打开 CLI 交互'); expect(link.href).toBe('/p/0123456789abcdef/#worker-42-execution-cli');
    expect(link.target).toBe('_blank'); expect(link.rel).toBe('noopener'); expect(link.onclick).toBeFalsy();
    expect(link.classList.contains('nav-link')).toBe(true);
    expect(workerCliTarget('#worker-42-cli')).toEqual({ taskId: 42 });
    for (const hash of ['#worker-0-cli', '#worker-01-cli', '#worker-W333-cli', '#worker-1-cli-other', '#worker-9007199254740992-cli']) expect(workerCliTarget(hash)).toBeNull();
    for (const task of [{ task_kind: 'main' }, { task_kind: 'management' }, { task_kind: 'child', execution_retired: true }]) expect(workerCliLink({ id: 42, ...task })).toBeNull();
  } finally { dom.restore(); }
});

test('execution and code reader entries use project-scoped native new-tab links', () => {
  const dom = installDom(); dom.location.pathname = '/p/0123456789abcdef/';
  const selected = ui.selected, reader = ui.transcriptView, task = { id: 42, workspace: '/tmp/worker' };
  dom.node('detail').scrollTop = 321;
  try {
    const links = [renderAgent(task, null).querySelector('a'), renderDiff(null, 42, task).querySelector('.code-reader-open')];
    for (const [index, link] of links.entries()) {
      expect(link.tagName).toBe('A'); expect(link.target).toBe('_blank');
      expect(link.href).toBe(`/p/0123456789abcdef/#worker-42-execution${index ? '-code' : ''}`);
      expect(link.onclick).toBeFalsy(); expect(link.classList.contains('nav-link')).toBe(true);
    }
    expect(executionTarget('#worker-42-execution')).toEqual({ taskId: 42, mode: 'transcript' });
    expect(executionTarget('#worker-42-execution-code')).toEqual({ taskId: 42, mode: 'code' });
    expect(executionTarget('#worker-42-execution-cli')).toEqual({ taskId: 42, mode: 'cli' });
    expect(executionTarget('#worker-42-execution-performance')).toEqual({ taskId: 42, mode: 'performance' });
    expect(ui.selected).toBe(selected); expect(ui.transcriptView).toBe(reader); expect(dom.node('detail').scrollTop).toBe(321);
  } finally { dom.restore(); }
});
