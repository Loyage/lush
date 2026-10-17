import { test, expect } from 'bun:test';
import { installDom, answerDialog, dialogText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';
import { renderDetail } from '../../src/ui/web/assets/render-detail.js';
import { registerNavigation } from '../../src/ui/web/assets/navigate.js';
import { activateDetailView } from '../../src/ui/web/assets/sidebar-ui.js';
import { ui, resetUiState } from '../../src/ui/web/assets/state.js';
import { closeDialog } from '../../src/ui/web/assets/dialog.js';

const valet = { id: 801, worker_number: 'V12', role: 'manager', task_kind: 'management', goal: '查询状态', status: 'waiting', calls: 0, children: [],
  management: { version: 1, revision: 'binding-r1', enabled: true, state: 'waiting_actions', mode: 'once' } };

test('Valet detail confirms disabling authorization and refreshes the same Valet', async () => {
  const requests = [], navigated = [], world = makeWorld();
  const dom = installDom({ fetch: (url, options) => {
    if (String(url).endsWith('/api/action')) { requests.push(JSON.parse(options.body)); return Response.json(valet); }
    return world.fetchImpl(url, options);
  } });
  resetUiState(); dom.location.pathname = '/p/1234567890abcdef/';
  const restore = registerNavigation({ detail: async id => { navigated.push(id); } });
  try {
    activateDetailView({ view: 'task', key: 'task-801', hash: '#worker-801' }); ui.selected = 801; ui.detailTask = 801;
    const patches = renderDetail(valet, { events: [] }, null, null, null, { current: () => true });
    try {
      const control = dom.node('detail').querySelectorAll('button').find(node => node.textContent === '停用授权');
      expect(control.classList.contains('agent-call')).toBe(false);
      const pending = control.onclick(); for (let i = 0; i < 40; i++) await Promise.resolve();
      expect(dialogText(dom)).toContain('不会强杀');
      await answerDialog(dom, '停用授权'); await pending;
      expect(requests).toEqual([{ method: 'management.binding_update', params: { id: 801, enabled: false, expected_revision: 'binding-r1' } }]);
      expect(navigated).toEqual([801]);
    } finally { patches.dispose(); }
  } finally { closeDialog(); restore(); resetUiState(); dom.restore(); }
});
