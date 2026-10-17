import { test, expect } from 'bun:test';
import { installDom } from '../dom-stub.js';
import { applyDeviceAutomation, deviceAutomationStatus, refreshDeviceAutomation, saveDeviceAutomation } from '../../src/ui/web/assets/workspace-automation.js';
import { changeAutoSelect, createAutoSelectAction } from '../../src/ui/web/assets/auto-select-action.js';
const model = (enabled = false, revision = 'r1') => ({ version: 1, revision, auto_select: { enabled }, completion_defaults: { enabled: false, level: 'merge' } });
const response = (value, ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => value });
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };

test('all auto-select entries share confirmation lease; edit, navigation and changed revision reject stale authorization', async () => {
  for (const reason of ['edit', 'leave', 'revision', 'cancel']) {
    const calls = [], confirm = gate(); let active = true, writable = true;
    const dom = installDom({ fetch: async (url, options) => { calls.push(options); return response(model(true, 'r2')); } });
    try {
      applyDeviceAutomation(model());
      const work = changeAutoSelect(true, { confirm: () => confirm.promise, ownsPage: () => active, canAct: () => writable });
      await flush(); expect(deviceAutomationStatus().confirming).toBe(true);
      expect(await changeAutoSelect(true, { confirm: () => { throw Error('duplicate confirmation'); } })).toBe(false);
      await expect(saveDeviceAutomation({ auto_select: { enabled: true } }, 'r1')).rejects.toThrow('确认或保存');
      if (reason === 'edit') writable = false;
      if (reason === 'leave') active = false;
      if (reason === 'revision') applyDeviceAutomation(model(false, 'newer'));
      confirm.resolve(reason !== 'cancel'); expect(await work).toBe(false);
      expect(calls).toHaveLength(0); expect(deviceAutomationStatus().confirming).toBe(false);
    } finally { dom.restore(); }
  }
});

test('unknown/error write locks every entry until explicit reread; enabling costs Agent, disabling does not confirm', async () => {
  for (const failure of ['transport', 'bad_ack']) {
    let writes = 0, read = model(), confirmation;
    const dom = installDom({ fetch: async (url, options = {}) => {
      if (options.method === 'POST') { writes++; if (writes > 1) return response(model(false, 'r4')); return failure === 'transport' ? response({ error: 'controlled failure' }, false) : response(model(false, 'r2')); }
      return response(read);
    } });
    try {
      applyDeviceAutomation(model());
      await expect(changeAutoSelect(true, { confirm: async value => { confirmation = value; return true; } })).rejects.toThrow();
      expect(confirmation.agent).toBe(true); expect(confirmation.confirmHelp).toContain('token');
      expect(deviceAutomationStatus().uncertain).toBe(true);
      expect(await changeAutoSelect(true)).toBe(false); expect(writes).toBe(1);
      await refreshDeviceAutomation({ reconcile: false }); expect(deviceAutomationStatus().uncertain).toBe(true);
      read = model(true, 'r3'); await refreshDeviceAutomation(); expect(deviceAutomationStatus().uncertain).toBe(false);
      // A disabling action has no authorization dialog; its ACK is still validated globally.
      await expect(changeAutoSelect(false, { confirm: () => { throw Error('disable must not confirm'); } })).resolves.toBe(true);
      expect(writes).toBe(2); expect(deviceAutomationStatus().model.auto_select.enabled).toBe(false);
    } finally { dom.restore(); }
  }
});

test('late read cannot roll back a saved policy; UI subscriptions reflect shared state and unknown reads', async () => {
  const stale = gate(); let reads = 0;
  const dom = installDom({ fetch: async (url, options = {}) => {
    if (options.method === 'POST') return response(model(true, 'r2'));
    reads++; return reads === 1 ? stale.promise : response({ error: 'offline' }, false);
  } });
  let control;
  try {
    applyDeviceAutomation(model());
    const oldRead = refreshDeviceAutomation();
    control = createAutoSelectAction({ ownsPage: () => true });
    await changeAutoSelect(true, { confirm: async () => true });
    stale.resolve(response(model(false, 'r1'))); await oldRead; await control.ready;
    expect(deviceAutomationStatus().model.revision).toBe('r2'); expect(control.status.textContent).toContain('已确认开启');
    expect(control.control.classList.contains('agent-call')).toBe(false);
    await expect(refreshDeviceAutomation()).rejects.toThrow();
    expect(control.status.textContent).toContain('状态未知'); expect(control.control.disabled).toBe(true);
    expect(control.control.parentNode.dataset.help).toContain('重新读取');
  } finally { control?.dispose(); dom.restore(); }
});

test('leaving after a sent policy write does not undo it or permit a duplicate through another entry', async () => {
  const accepted = gate(); let writes = 0, active = true;
  const dom = installDom({ fetch: async (url, options = {}) => {
    if (options.method === 'POST') { writes++; return accepted.promise; }
    return response(model());
  } });
  const control = createAutoSelectAction({ ownsPage: () => active, confirm: async () => true });
  try {
    await control.ready; const operation = control.control.onclick(); await flush();
    expect(writes).toBe(1); active = false; control.dispose();
    expect(await changeAutoSelect(true)).toBe(false);
    accepted.resolve(response(model(true, 'accepted-r2'))); await operation;
    expect(deviceAutomationStatus().model.auto_select.enabled).toBe(true);
    expect(writes).toBe(1); expect(deviceAutomationStatus().saving).toBe(false);
    // The removed control is not repainted or resurrected by the shared successful ACK.
    expect(control.status.textContent).not.toContain('已确认开启');
  } finally { active = false; control.dispose(); dom.restore(); }
});

test('pagehide invalidates an unsubmitted enable authorization even if the document is retained', async () => {
  const answer = gate(); let writes = 0;
  const dom = installDom({ fetch: async (url, options = {}) => { if (options.method === 'POST') writes++; return response(model()); } });
  const control = createAutoSelectAction({ confirm: () => answer.promise });
  try {
    await control.ready; const operation = control.control.onclick(); await flush();
    await dom.fire('pagehide'); answer.resolve(true); await operation;
    expect(writes).toBe(0); expect(deviceAutomationStatus().confirming).toBe(false);
  } finally { control.dispose(); dom.restore(); }
});
