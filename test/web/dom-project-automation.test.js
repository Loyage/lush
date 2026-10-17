import { test, expect } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { openProjectAutomation } from '../../src/ui/web/assets/render-project-automation.js';
import { ui } from '../../src/ui/web/assets/state.js';
import { activateDetailView } from '../../src/ui/web/assets/sidebar-ui.js';

test('automation directory searches its three lazy feature entries without fetching feature data', async () => {
  const reads = [], dom = installDom({ fetch: async url => { reads.push(url); throw Error(`unexpected ${url}`); } });
  activateDetailView({ view: 'overview' }); ui.automationPage = null; dom.location.pathname = '/p/1111111111111111/';
  try {
    await openProjectAutomation(); const root = dom.node('detail'), entries = root.querySelectorAll('.automation-feature');
    expect(entries.map(item => item.dataset.feature)).toEqual(['completion', 'push', 'acceptance_notice']);
    expect(deepText(root)).toContain('成果自动合并与验收');
    const search = root.querySelector('[aria-label="查找自动化功能"]'); search.value = 'push'; search.listeners.input[0]();
    expect(entries.every(item => !item.hidden)).toBe(true);
    search.listeners.keydown[0]({ key: 'Enter', preventDefault() {} });
    expect(entries.filter(item => !item.hidden).map(item => item.dataset.feature)).toEqual(['push']); expect(reads).toEqual([]);
  } finally { ui.disposeProjectAutomation?.(); dom.restore(); }
});
