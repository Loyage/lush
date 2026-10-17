import { test, expect } from 'bun:test';
import { installDom } from '../dom-stub.js';
import { renderAgent } from '../../src/ui/web/assets/render-agent.js';
import { renderDiff } from '../../src/ui/web/assets/render-diff.js';
import { executionTarget } from '../../src/ui/web/assets/execution-route.js';
import { ui } from '../../src/ui/web/assets/state.js';

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
    expect(ui.selected).toBe(selected); expect(ui.transcriptView).toBe(reader); expect(dom.node('detail').scrollTop).toBe(321);
  } finally { dom.restore(); }
});
