import { test, expect } from 'bun:test';
import { installDom, dialogButton, dialogText } from '../dom-stub.js';
import { gate } from '../helpers.js';
import { valetLifecycleControls } from '../../src/ui/web/assets/valet-actions.js';
import { closeDialog } from '../../src/ui/web/assets/dialog.js';
import { activateDetailView } from '../../src/ui/web/assets/sidebar-ui.js';
import { ui, resetUiState } from '../../src/ui/web/assets/state.js';

const valet = { id: 801, worker_number: 'V12', role: 'manager', task_kind: 'management', goal: '初始管理事项',
  status: 'completed', calls: 1, children: [], management: { version: 1, revision: 'r1', mode: 'once', enabled: false,
    state: 'succeeded', can_append: true, append_reason: null } };
function activate(dom, task = valet) {
  dom.location.pathname = '/p/1234567890abcdef/';
  activateDetailView({ view: 'task', key: `task-${task.id}`, hash: `#worker-${task.id}` });
  ui.selected = task.id; ui.detailTask = task.id;
}
function mount(dom, task = valet, refresh = async () => {}) {
  const root = valetLifecycleControls(task, { refresh }); dom.node('detail').replaceChildren(root);
  return root.querySelectorAll('button').find(button => button.textContent === '追加输入');
}
const text = dom => dom.node('modal').querySelector('textarea');

test('Valet append uses Agent-marked form, retains edits across refresh and single-flights mutation even if refresh fails', async () => {
  const hold = gate(), requests = [];
  const dom = installDom({ fetch: async (_url, options) => { requests.push(JSON.parse(options.body)); await hold.promise; return Response.json(valet); } });
  resetUiState(); activate(dom);
  let opening;
  try {
    let refreshed = 0;
    const refresh = async () => { refreshed++; throw new Error('read failed'); };
    const control = mount(dom, valet, refresh);
    expect(control.classList.contains('agent-call')).toBe(true);
    expect(control.dataset.help).toContain('token');
    opening = control.onclick();
    const input = text(dom); input.value = '本轮新增事项';
    expect(dialogText(dom)).toContain('追加到 V12');
    const submit = dialogButton(dom, '提交追加');
    expect(submit.classList.contains('agent-call')).toBe(true);
    expect(submit.dataset.help).toContain('token');
    const sending = submit.onclick();
    await submit.onclick();
    const repainted = mount(dom, valet, refresh); await repainted.onclick();
    expect(text(dom)).toBe(input); expect(input.value).toBe('本轮新增事项');
    expect(requests).toEqual([{ method: 'worker.message', params: { id: 801, body: '本轮新增事项' } }]);
    input.value = '在途时新输入，不得清掉';
    hold.resolve(); await sending;
    expect(refreshed).toBe(1);
    expect(text(dom)).toBe(input); expect(input.value).toBe('在途时新输入，不得清掉');
    expect(dialogText(dom)).toContain('请求期间的新编辑已保留');
    expect(submit.disabled).toBe(true);
    await submit.onclick(); expect(requests).toHaveLength(1);
    expect(dom.node('error').textContent).toContain('刷新失败');
  } finally { hold.resolve(); closeDialog(); await opening; resetUiState(); dom.restore(); }
});

test('busy rejection keeps exact text and never resends an unconfirmed mutation or refreshes as success', async () => {
  const requests = [];
  const dom = installDom({ fetch: async (_url, options) => { requests.push(JSON.parse(options.body)); return Response.json({ error: '当前项目已有管家排队、运行或尚未安全收口' }, { status: 400 }); } });
  resetUiState(); activate(dom); let opening;
  try {
    let refreshed = 0;
    opening = mount(dom, valet, async () => { refreshed++; }).onclick();
    const input = text(dom); input.value = '  被拒绝后仍保留\n完整原文  ';
    const submit = dialogButton(dom, '提交追加'); await submit.onclick();
    expect(input.value).toBe('  被拒绝后仍保留\n完整原文  ');
    expect(dialogText(dom)).toContain('已有管家'); expect(dialogText(dom)).toContain('原文已保留');
    expect(submit.disabled).toBe(true);
    await submit.onclick(); expect(requests).toHaveLength(1); expect(refreshed).toBe(0);
  } finally { closeDialog(); await opening; resetUiState(); dom.restore(); }
});

test('missing admission, busy, failed, cancelled and unknown snapshots fail closed with an accessible disabled reason', async () => {
  const dom = installDom({ fetch: async () => { throw new Error('must not send'); } }); resetUiState(); activate(dom);
  try {
    for (const task of [
      { ...valet, management: { version: 1 } },
      { ...valet, management: { ...valet.management, can_append: false, append_reason: '其他管家尚未收口' } },
      { ...valet, status: 'failed' }, { ...valet, status: 'cancelled' },
      { ...valet, management: { ...valet.management, state: 'unknown' } },
    ]) {
      const control = mount(dom, task);
      expect(control.disabled).toBe(true); expect(control.parentNode.classList.contains('help-host')).toBe(true);
      expect(control.parentNode.dataset.help.length).toBeGreaterThan(0);
      expect(control.parentNode.getAttribute('tabindex')).toBe('0');
      await control.onclick(); expect(dom.node('modal').querySelector('textarea')).toBeNull();
    }
  } finally { closeDialog(); resetUiState(); dom.restore(); }
});

test('late mutation response after navigation/project change cannot refresh old detail or close and clear a replacement form', async () => {
  const hold = gate(), requests = [];
  const dom = installDom({ fetch: async (_url, options) => { requests.push(JSON.parse(options.body)); await hold.promise; return Response.json(valet); } });
  resetUiState(); activate(dom); let oldOpening, newOpening;
  try {
    let refreshed = 0;
    oldOpening = mount(dom, valet, async () => { refreshed++; }).onclick();
    text(dom).value = '旧项目追加'; const sending = dialogButton(dom, '提交追加').onclick();
    const other = { ...valet, id: 802, worker_number: 'V13' };
    activate(dom, other); dom.location.pathname = '/p/fedcba0987654321/';
    newOpening = mount(dom, other, async () => { refreshed++; }).onclick();
    const replacement = text(dom); replacement.value = '新项目的新编辑';
    hold.resolve(); await sending; await oldOpening;
    expect(refreshed).toBe(0); expect(text(dom)).toBe(replacement); expect(replacement.value).toBe('新项目的新编辑');
    expect(dialogText(dom)).toContain('追加到 V13'); expect(requests).toHaveLength(1);
  } finally { hold.resolve(); closeDialog(); await oldOpening; await newOpening; resetUiState(); dom.restore(); }
});
