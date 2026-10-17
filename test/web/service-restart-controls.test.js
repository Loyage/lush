import { test, expect } from 'bun:test';
import { installDom } from '../dom-stub.js';
import { serviceRestartControls } from '../../src/ui/web/assets/service-restart.js';

const id = 'a'.repeat(16), batch_id = '00000000-0000-4000-8000-000000000001';
const row = maintenance => ({ id, name: '来源项目', project: '/fixture/a', running: true, summary: { maintenance } });
const running = { paused: false, phase: 'running', ready_to_restart: true, batch_id: null, completion_state: null, completion_notice_id: null };
const batch = (notify_completion = false) => ({ paused: true, phase: 'paused', ready_to_restart: true, batch_id,
  completion_state: 'completed', completion_notice_id: notify_completion ? 7 : null, notify_completion });
const flush = async () => { for (let n = 0; n < 100; n++) await Promise.resolve(); };

test('restart modes expose only their operations, guard edits and share confirmation single-flight', async () => {
  const dom = installDom(); let release, confirmations = 0, writable = false;
  const request = async path => path === '/api/host' ? { restart_supported: true, pid: 1 } : { projects: [row(running)] };
  const quick = serviceRestartControls({ mode: 'quick_actions', canAct: () => writable, request,
    confirm: () => { confirmations++; return new Promise(resolve => { release = resolve; }); } });
  const manager = serviceRestartControls({ mode: 'management', request });
  try {
    await Promise.all([quick.ready, manager.ready]); manager.updateProjects([row(running)]);
    expect(quick.root.querySelectorAll('button').map(b => b.dataset.serviceRestart)).toEqual(['safe']);
    expect(quick.projectControl).toBeUndefined();
    expect(manager.root.querySelectorAll('button').map(b => b.dataset.serviceRestart)).toEqual(['host', 'pause', 'all', 'resume']);
    const safe = quick.root.querySelector('button'), host = manager.root.querySelector('[data-service-restart="host"]');
    expect(safe.disabled).toBe(true); await safe.onclick(); expect(confirmations).toBe(0);
    writable = true; quick.sync(); const operation = safe.onclick(); await flush();
    expect(confirmations).toBe(1); expect(host.disabled).toBe(true);
    await safe.onclick(); expect(confirmations).toBe(1);
    quick.dispose(); release(false); await operation;
    expect(host.disabled).toBe(false);
  } finally { quick.dispose(); manager.dispose(); dom.restore(); }
});

test('manual observation accepts explicit silent completion but never infers missing completion evidence', async () => {
  for (const maintenance of [batch(false), batch(true), { ...batch(false), notify_completion: undefined }, { ...batch(false), notify_completion: null },
    { ...batch(true), notify_completion: null }, { ...batch(false), phase: 'pausing', completion_state: 'pending', notify_completion: null }]) {
    const dom = installDom(), scheduled = [], writes = [];
    const section = serviceRestartControls({ request: async (path, options) => {
      if (path === '/api/host') return { restart_supported: true, pid: 1 };
      if (path === '/api/host/projects') return { projects: [row(maintenance)] };
      writes.push(JSON.parse(options.body)); return maintenance;
    }, confirm: async () => true, schedule: fn => { scheduled.push(fn); return fn; }, unschedule: () => {} });
    try {
      await section.ready; section.updateProjects([row(maintenance)]);
      await section.root.querySelector('[data-service-restart="pause"]').onclick();
      if (scheduled.length) await scheduled.shift()();
      expect(writes).toEqual([{ method: 'system.interrupt_all', params: {} }]);
      expect(section.status.textContent.includes('已全部安全中断')).toBe(typeof maintenance.notify_completion === 'boolean');
      if (typeof maintenance.notify_completion !== 'boolean') expect(section.status.textContent).toContain('不能确认全部安全中断');
    } finally { section.dispose(); dom.restore(); }
  }
});

test('disposing a quick action with an accepted in-flight request cannot authorize later writes', async () => {
  const dom = installDom(), calls = []; let paused = false, release;
  const section = serviceRestartControls({ mode: 'quick_actions', confirm: async () => true,
    request: async (path, options) => {
      if (options?.method === 'POST') {
        calls.push(path); paused = true;
        expect(JSON.parse(options.body)).toEqual({ method: 'system.interrupt_all', params: { notify_completion: false } });
        return new Promise(resolve => { release = () => resolve(batch(false)); });
      }
      return path === '/api/host' ? { restart_supported: true, pid: 1 } : { projects: [row(paused ? batch(false) : running)] };
    } });
  try {
    await section.ready; const operation = section.root.querySelector('button').onclick();
    await flush(); expect(calls).toEqual([`/p/${id}/api/action`]);
    section.dispose(); release(); await operation; await flush();
    expect(calls).toEqual([`/p/${id}/api/action`]);
  } finally { section.dispose(); dom.restore(); }
});

test('selected maintenance controls retain one flow/lock and removed selection cannot confirm an old action', async () => {
  const dom = installDom(), writes = []; let release;
  const section = serviceRestartControls({ mode: 'quick_actions', request: async (path, options) => {
    if (options?.method === 'POST') writes.push(path);
    return path === '/api/host' ? { restart_supported: true, pid: 1 } : { projects: [row(running)] };
  }, confirm: () => new Promise(resolve => { release = resolve; }) });
  try {
    await section.ready; section.updateProjects([row(running)]);
    const safe = section.root.querySelector('button'), operation = safe.onclick(); await flush();
    section.setButtons(['safe_restart','auto_select','interrupt_all','resume_all','restart_all']);
    expect(section.root.querySelector('[data-service-restart="safe"]')).toBe(safe);
    expect(section.root.querySelectorAll('button').map(b => b.dataset.serviceRestart)).toEqual(['safe','pause','resume','all']);
    expect(section.root.querySelectorAll('button').every(b => b.disabled)).toBe(true);
    section.setButtons(['interrupt_all']); release(true); await operation;
    expect(writes).toEqual([]); expect(section.root.querySelectorAll('button').map(b => b.dataset.serviceRestart)).toEqual(['pause']);
    section.setButtons([]); expect(section.root.querySelectorAll('button')).toHaveLength(0);
  } finally { section.dispose(); dom.restore(); }
});
