import { test, expect } from 'bun:test';
import { fixture, until } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/protocol.js';
import { createSignal } from '../../src/signal.js';

test('drafts buffer, drop and commit as one numbered batch to a single planner', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    expect(() => f.project.draft('   ')).toThrow('draft must be non-empty');
    const first = f.project.draft('第一条 想法');
    const second = f.project.draft('第二条');
    const third = f.project.draft('第三条');
    expect(f.project.drafts().map(draft => draft.content)).toEqual(['第一条 想法', '第二条', '第三条']);
    expect(f.project.dropDraft(second.id)).toEqual({ id: second.id });
    expect(f.project.drafts()).toHaveLength(2);

    const batch = f.project.commitDrafts();
    expect(batch.drafts).toEqual([first.id, third.id]);
    expect(batch.task.role).toBe('planner');
    expect(batch.task.goal).toBe(batch.content);
    expect(f.project.inspect(batch.task.id).goal).toContain('用户在一次提交中给了 2 条');
    expect(batch.content).toContain('1) 第一条 想法');
    expect(batch.content).toContain('2) 第三条');
    // 每条原话逐字留在 drafts 行上，提交过的回写 input_id 作为审计链；被移除的草稿不留行
    expect(f.store.all('SELECT content,input_id FROM drafts ORDER BY id').map(row => [row.content, row.input_id]))
      .toEqual([['第一条 想法', batch.id], ['第三条', batch.id]]);
    expect(f.store.draftCount()).toBe(0);
    expect(f.project.inputs()[0].draft_count).toBe(2);
    expect(() => f.project.dropDraft(first.id)).toThrow('already submitted');
    expect(() => f.project.commitDrafts()).toThrow('no buffered drafts');
  } finally { await f.close(); }
});

test('a single buffered draft reaches the planner verbatim', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    f.project.draft('  原话\n保留  ');
    const batch = f.project.commitDrafts();
    expect(batch.content).toBe('  原话\n保留  ');
    expect(batch.task.goal).toBe('  原话\n保留  ');
  } finally { await f.close(); }
});

test('drafts can be edited in place and submitted as a chosen subset', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    const first = f.project.draft('第一条');
    const second = f.project.draft('第二条');
    const third = f.project.draft('第三条');

    // 编辑就地生效，草稿 id 不变，输入顺序因此稳定
    const edited = f.project.editDraft(second.id, '第二条（改过）');
    expect(edited).toMatchObject({ id: second.id, content: '第二条（改过）', input_id: null });
    expect(f.project.drafts().map(draft => draft.content)).toEqual(['第一条', '第二条（改过）', '第三条']);
    expect(() => f.project.editDraft(second.id, '   ')).toThrow('draft must be non-empty');
    expect(() => f.project.editDraft(999, 'x')).toThrow('draft 999 not found');

    // 只提交选中的子集，且按草稿 id 升序拼接；未选中的继续留在缓存
    const batch = f.project.commitDrafts([second.id, first.id]);
    expect(batch.drafts).toEqual([first.id, second.id]);
    expect(batch.content).toContain('1) 第一条');
    expect(batch.content).toContain('2) 第二条（改过）');
    expect(batch.content).not.toContain('第三条');
    expect(f.store.draft(first.id).input_id).toBe(batch.id);
    expect(f.store.draft(second.id).input_id).toBe(batch.id);
    expect(f.store.draft(third.id).input_id).toBeNull();
    expect(f.project.drafts().map(draft => draft.id)).toEqual([third.id]);

    // 已提交的草稿既不能改也不能再提交；未知 / 重复 / 空数组都在提交前拒绝
    expect(() => f.project.editDraft(first.id, 'x')).toThrow(`draft ${first.id} was already submitted as input ${batch.id}`);
    expect(() => f.project.commitDrafts([first.id])).toThrow('already submitted');
    expect(() => f.project.commitDrafts([999])).toThrow('draft 999 not found');
    expect(() => f.project.commitDrafts([third.id, third.id])).toThrow(`draft ${third.id} listed twice`);
    expect(() => f.project.commitDrafts([])).toThrow('select at least one draft');
    expect(() => f.project.commitDrafts('nope')).toThrow('must be an array');

    // 省略 ids 时行为不变：提交全部 open drafts
    const rest = f.project.commitDrafts();
    expect(rest.drafts).toEqual([third.id]);
    expect(rest.content).toBe('第三条');
    expect(f.store.draftCount()).toBe(0);
  } finally { await f.close(); }
});

test('the draft cache is bounded', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    for (let index = 0; index < 500; index += 1) f.store.addDraft(`draft ${index}`);
    expect(() => f.project.draft('one too many')).toThrow('too many buffered drafts');
  } finally { await f.close(); }
});

test('agent tokens cannot touch the user input buffer', async () => {
  const f = fixture({ run({ signal }) { return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); } });
  try {
    const root = f.project.submit('root').task;
    await until(() => f.project.running.has(root.id));
    const token = f.project.running.get(root.id).token;
    const rpc = new Dispatcher(f.project, createSignal(), {});
    expect(await rpc.dispatch('draft.list', { _token: token })).toEqual([]);
    for (const [method, params] of [['draft.add', { content: 'sneak' }], ['draft.update', { id: 1, content: 'sneak' }], ['draft.remove', { id: 1 }], ['draft.commit', {}]]) {
      await expect(rpc.dispatch(method, { ...params, _token: token })).rejects.toThrow('user approval');
    }
    expect(f.store.draftCount()).toBe(0);
  } finally { await f.close(); }
});
