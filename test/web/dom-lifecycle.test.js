import { expect, test } from 'bun:test';
import { installDom } from '../dom-stub.js';
import { startGlobalNoticeObserver, refreshGlobalNotices } from '../../src/ui/web/assets/global-notice-notifications.js';
import { readPref, setPref } from '../../src/ui/web/assets/prefs.js';

const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
const page = { version: 1, items: [], projects: [], has_more: false, cursor: null, complete: true };

test('DOM restore closes singleton reads/listeners/timers and isolates both browser stores from the next fixture', async () => {
  const old = installDom(); let resolve, signal, reads = 0, fired = false;
  const summaries = [], pending = new Promise(yes => { resolve = yes; });
  old.localStorage.setItem('fixture-cache', 'old'); old.sessionStorage.setItem('fixture-draft', 'old');
  setTimeout(() => { fired = true; }, 1);
  setInterval(() => {}, 3000);
  startGlobalNoticeObserver({ read: (_url, options) => { reads++; signal = options.signal; return pending; },
    onSummary: value => summaries.push(value) });
  const done = refreshGlobalNotices();
  try {
    expect(reads).toBe(1); expect(old.listeners.storage).toHaveLength(1);
    old.restore(); await expect(done).rejects.toThrow('已停止'); await flush();
    expect(signal.aborted).toBe(true); expect(old.timeouts.size).toBe(0); expect(old.intervals).toHaveLength(0);
    expect(Object.values(old.listeners).every(value => value.length === 0)).toBe(true);
    expect(Object.values(old.documentListeners).every(value => value.length === 0)).toBe(true);
    let newReads = 0;
    const next = installDom({ fetch: async () => { newReads++; return Response.json(page); } });
    try {
      expect(localStorage.getItem('fixture-cache')).toBeNull(); expect(sessionStorage.getItem('fixture-draft')).toBeNull();
      expect(readPref('taskGraphMinimal')).toBe(true); // No prior privacy-mode memory fallback.
      setPref('noticeNotifications', true); await next.fire('storage', { key: 'lush.noticeNotifications' });
      const before = summaries.length; resolve(page); await flush(); await Bun.sleep(5);
      expect(reads).toBe(1); expect(newReads).toBe(0); expect(summaries).toHaveLength(before); expect(fired).toBe(false);
      expect(await refreshGlobalNotices()).toBeNull();
      old.restore(); expect(globalThis.document).toBe(next.document); // Repeated cleanup cannot overwrite new globals.
    } finally { next.restore(); }
  } finally { resolve(page); old.restore(); }
});

test('mock interval cancellation removes only the owning live timer, including cancellation from a later fixture', () => {
  const old = installDom();
  const removed = setInterval(() => {}, 1000), kept = setInterval(() => {}, 2000);
  try {
    clearInterval(removed); expect(old.intervals.map(value => value.ms)).toEqual([2000]);
    const next = installDom();
    try {
      const current = setInterval(() => {}, 3000);
      clearInterval(kept); expect(old.intervals).toHaveLength(0); expect(next.intervals.map(value => value.ms)).toEqual([3000]);
      clearInterval(current); expect(next.intervals).toHaveLength(0);
    } finally { next.restore(); }
  } finally { old.restore(); }
});
