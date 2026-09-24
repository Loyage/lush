import { test, expect } from 'bun:test';
import { fixture, repo, until } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/protocol.js';
import { createSignal } from '../../src/signal.js';

test('drafts buffer, drop and commit one input per draft', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    expect(() => f.project.draft('   ')).toThrow('draft must be non-empty');
    const first = f.project.draft('第一条 想法');
    const second = f.project.draft('第二条');
    const third = f.project.draft('第三条');
    expect(f.project.drafts().map(draft => draft.content)).toEqual(['第一条 想法', '第二条', '第三条']);
    expect(f.project.dropDraft(second.id)).toEqual({ id: second.id });
    expect(f.project.drafts()).toHaveLength(2);

    const committed = await f.project.commitDrafts();
    expect(committed.drafts).toEqual([first.id, third.id]);
    expect(committed.inputs).toHaveLength(2);
    // 每条草稿各成一条输入，正文逐字，不再有批次引导语。
    expect(committed.inputs.map(row => row.content)).toEqual(['第一条 想法', '第三条']);
    expect(committed.inputs.map(row => row.task.role)).toEqual(['planner', 'planner']);
    expect(committed.inputs.map(row => row.task.goal)).toEqual(['第一条 想法', '第三条']);
    expect(committed.inputs.map(row => row.draft)).toEqual([first.id, third.id]);
    for (const row of committed.inputs) expect(row.content).not.toContain('用户在一次提交中给了');
    // 每条草稿各自回写 input_id 作为审计链；被移除的草稿不留行
    expect(f.store.all('SELECT content,input_id FROM drafts ORDER BY id').map(row => [row.content, row.input_id]))
      .toEqual([['第一条 想法', committed.inputs[0].id], ['第三条', committed.inputs[1].id]]);
    expect(f.store.draftCount()).toBe(0);
    expect(f.project.inputs().map(row => row.draft_count)).toEqual([1, 1]);
    // direct 字段已从读模型移除。
    expect(f.project.inputs()[0].direct).toBeUndefined();
    expect(() => f.project.dropDraft(first.id)).toThrow('already submitted');
    await expect(f.project.commitDrafts()).rejects.toThrow('no buffered drafts');
  } finally { await f.close(); }
});

test('a single buffered draft reaches its own planner verbatim', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const draft = f.project.draft('  原话\n保留  ');
    const committed = await f.project.commitDrafts();
    expect(committed.inputs).toHaveLength(1);
    expect(committed.inputs[0].content).toBe('  原话\n保留  ');
    expect(committed.inputs[0].task.goal).toBe('  原话\n保留  ');
  } finally { await f.close(); }
});

test('drafts can be edited in place and submitted as a chosen subset', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
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

    // 只提交选中的子集，且按草稿 id 升序逐条提交；未选中的继续留在缓存
    const committed = await f.project.commitDrafts([second.id, first.id]);
    expect(committed.drafts).toEqual([first.id, second.id]);
    expect(committed.inputs.map(row => row.content)).toEqual(['第一条', '第二条（改过）']);
    expect(f.store.draft(first.id).input_id).toBe(committed.inputs[0].id);
    expect(f.store.draft(second.id).input_id).toBe(committed.inputs[1].id);
    expect(f.store.draft(third.id).input_id).toBeNull();
    expect(f.project.drafts().map(draft => draft.id)).toEqual([third.id]);

    // 已提交的草稿既不能改也不能再提交；未知 / 重复 / 空数组都在提交前拒绝
    expect(() => f.project.editDraft(first.id, 'x')).toThrow(`draft ${first.id} was already submitted as input ${committed.inputs[0].id}`);
    await expect(f.project.commitDrafts([first.id])).rejects.toThrow('already submitted');
    await expect(f.project.commitDrafts([999])).rejects.toThrow('draft 999 not found');
    await expect(f.project.commitDrafts([third.id, third.id])).rejects.toThrow(`draft ${third.id} listed twice`);
    await expect(f.project.commitDrafts([])).rejects.toThrow('select at least one draft');
    await expect(f.project.commitDrafts('nope')).rejects.toThrow('must be an array');

    // 省略 ids 时行为不变：提交全部 open drafts
    const rest = await f.project.commitDrafts();
    expect(rest.drafts).toEqual([third.id]);
    expect(rest.inputs.map(row => row.content)).toEqual(['第三条']);
    expect(f.store.draftCount()).toBe(0);
  } finally { await f.close(); }
});

test('a failure midway keeps earlier inputs and leaves the failed draft and later ones buffered', async () => {
  const f = fixture(); await repo(f.root); f.project.stopping = true;
  const original = f.project.materializeSpec.bind(f.project);
  let seen = 0;
  f.project.materializeSpec = (...args) => { seen += 1; if (seen === 2) throw new Error('controlled compile failure'); return original(...args); };
  try {
    const first = f.project.draft('开发 第一条');
    const second = f.project.draft('开发 第二条');
    const third = f.project.draft('开发 第三条');
    await expect(f.project.commitDrafts()).rejects.toThrow('controlled compile failure');
    // 第一条已落库；第二条失败、第三条未提交，都还在缓存里。
    expect(f.project.inputs().map(row => row.content)).toEqual(['开发 第一条']);
    expect(f.store.draft(first.id).input_id).not.toBeNull();
    expect(f.store.draft(second.id).input_id).toBeNull();
    expect(f.store.draft(third.id).input_id).toBeNull();
    expect(f.project.drafts().map(row => row.id)).toEqual([second.id, third.id]);
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
  await repo(f.root);
  try {
    const root = (await f.project.submit('root')).task;
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
