import { test, expect, setDefaultTimeout } from 'bun:test';
import { repo, until } from '../helpers.js';
import { setup, fetch } from './harness.js';

setDefaultTimeout(20000);
const question = (multiSelect = false) => ({ header: '方案', question: '采用哪个方案？', multiSelect,
  options: [{ label: '第一项', description: '没有推荐标记。' }, { label: '第二项（推荐）', description: '仍不选这一项。' }] });
async function get(f, suffix) {
  const response = await fetch(f.url + suffix); expect(response.status).toBe(200); return response.json();
}
async function post(f, method, params) {
  const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }) });
  return { status: response.status, value: await response.json() };
}

test('real HTTP/RPC/SQLite auto-select handles old and new questions and exposes durable Lush versus user provenance', async () => {
  const f = await setup(); f.project.kick = () => {};
  try {
    await repo(f.root);
    const worker = (await f.project.order('auto-select HTTP job', 'main', [], null, false)).task;
    const old = f.project.notice(worker.id, 'mixed old questionnaire', '', 'question', [question(), question(true)]);
    const oldText = f.project.notice(worker.id, 'old text question', '让 Agent 判断');
    const plan = f.project.notice(worker.id, 'plan not authorized', '', 'plan');
    const before = await get(f, '/api/hooks');
    expect(before.daemon_hooks.mounts[0].enabled).toBe(false);
    const initialOverview = await get(f, '/api/overview');
    expect(initialOverview.status.auto_select).toMatchObject({ enabled: false, revision: before.daemon_hooks.revision, editable: true });
    expect(await get(f, `/api/overview?revision=${initialOverview.revision}`)).toMatchObject({ unchanged: true });
    const enabled = await post(f, 'hooks.auto_select', { enabled: true, expected_revision: before.daemon_hooks.revision });
    expect(enabled.status).toBe(200); expect(enabled.value.daemon_hooks.mounts[0].enabled).toBe(true);
    const enabledOverview = await get(f, `/api/overview?revision=${initialOverview.revision}`);
    expect(enabledOverview.unchanged).toBeUndefined();
    expect(enabledOverview.status.auto_select).toMatchObject({ enabled: true, revision: enabled.value.daemon_hooks.revision });
    await until(() => f.store.get('SELECT status FROM notices WHERE id=?', oldText.id).status === 'answered');
    const records = (await get(f, '/api/notices?status=all')).notices;
    const selected = records.find(n => n.id === old.id);
    expect(selected.answer_source).toBe('lush');
    expect(JSON.parse(selected.answer).answers).toMatchObject([
      { selected: [0], labels: ['第一项'], custom: '' },
      { selected: [], custom: '请由 Agent 自行判断并继续。' },
    ]);
    expect(records.find(n => n.id === oldText.id)).toMatchObject({ answer_source: 'lush', answer: '请由 Agent 自行判断并继续。' });
    expect(records.find(n => n.id === plan.id)).toBeUndefined(); // Web never exposes old plan approvals.
    expect(f.store.get('SELECT status,answer_source FROM notices WHERE id=?', plan.id)).toEqual({ status: 'open', answer_source: null });
    const fresh = f.project.notice(worker.id, 'new single', '', 'question', [question()]);
    expect(fresh).toMatchObject({ status: 'answered', answer_source: 'lush' });
    const renamed = await post(f, 'worker.rename', { id: worker.id, title: '用户自定义 Worker 标题' });
    expect(renamed.status).toBe(200);
    expect(renamed.value).toEqual({ id: worker.id, display_title: '用户自定义 Worker 标题' });
    expect((await get(f, '/api/hooks')).daemon_hooks.revision).toBe(enabled.value.daemon_hooks.revision);
    const inspected = await get(f, `/api/worker/${worker.id}`);
    expect(inspected.notices.find(n => n.id === fresh.id).answer_source).toBe('lush');
    const message = JSON.parse(f.store.unread(worker.id).find(m => JSON.parse(m.body).notice_id === fresh.id).body);
    expect(message).toMatchObject({ automatic: true, answer_source: 'lush' });
    const stale = await post(f, 'hooks.auto_select', { enabled: false, expected_revision: before.daemon_hooks.revision });
    expect(stale.status).toBe(400);
    const current = await get(f, '/api/hooks');
    const disabled = await post(f, 'hooks.auto_select', { enabled: false, expected_revision: current.daemon_hooks.revision });
    expect(disabled.status).toBe(200);
    const manual = f.project.notice(worker.id, 'manual text');
    expect(manual.status).toBe('open');
    const spoof = await post(f, 'notice.answer', { id: manual.id, answer: 'user answer', answer_source: 'lush' });
    expect(spoof.status).toBe(400);
    const answered = await post(f, 'notice.answer', { id: manual.id, answer: 'user answer' });
    expect(answered.status).toBe(200); expect(answered.value.answer_source).toBe('user');
    expect((await get(f, '/api/notices?status=answered')).notices.find(n => n.id === manual.id).answer_source).toBe('user');
    const automatic = []; let cursor = '';
    do {
      const page = await get(f, `/api/notices?status=automatic&limit=1${cursor}`);
      automatic.push(...page.notices);
      if (!page.has_more) break;
      cursor = `&before=${page.cursor}`;
    } while (automatic.length < 10);
    expect(automatic.map(n => n.id)).toEqual([fresh.id, oldText.id, old.id]);
    expect(automatic.every(n => n.answer_source === 'lush')).toBe(true);
    expect(automatic.map(n => n.title)).toEqual(['new single', 'old text question', 'mixed old questionnaire']);
    expect(automatic.find(n => n.id === old.id).answer).toBe(selected.answer);
    expect((await get(f, '/api/snapshot')).status.auto_select.enabled).toBe(false);
  } finally { await f.close(); }
});
