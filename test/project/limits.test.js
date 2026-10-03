import { test, expect } from 'bun:test';
import { fixture, repo, until, gate } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/protocol.js';
import { assertAllowed } from '../../src/rpc/registry.js';
import { createSignal } from '../../src/signal.js';

function controlled() {
  const calls = [];
  return { calls, run(ctx) {
    const done = gate(); calls.push({ ...ctx, done });
    ctx.signal.addEventListener('abort', () => done.resolve('aborted'), { once:true });
    return done.promise;
  } };
}

test('depth and invocation limits bound runaway agents', async () => {
  const f = fixture({ async run({task, api}) { api.message(task.id, 'again'); return 'loop'; } }, {LUSH_TASK_CALLS:'2', LUSH_MAX_DEPTH:'3'}); await repo(f.root);
  try {
    f.project.stopping = true;
    const root = (await f.project.say('root')).task;
    const child = await f.project.spawn(root.id,'child', undefined, [], 'child');
    // depth: main → say root → child is already at the limit.
    expect(() => f.project.spawn(child.id,'too deep', undefined, [], 'deep')).toThrow('nesting');
    f.project.stopping = false;
    f.project.kick();
    await until(() => f.store.task(root.id).status === 'failed');
    expect(f.store.task(root.id).error).toContain('invocation limit');
  } finally { await f.close(); }
});

test('timeout aborts invocation and frees the agent slot', async () => {
  const provider = controlled(), f = fixture(provider, {LUSH_CALL_TIMEOUT:'1'}); await repo(f.root);
  try {
    const task = (await f.project.say('timeout')).task;
    await until(() => f.store.task(task.id).status === 'failed');
    expect(provider.calls[0].signal.aborted).toBe(true);
    expect(f.store.task(task.id).error).toBe('agent invocation timed out after 1 second');
    expect(f.store.runsForTask(task.id).at(-1)).toMatchObject({
      status: 'failed', error: 'agent invocation timed out after 1 second',
    });
    expect(f.project.running.size).toBe(0);
  } finally { await f.close(); }
});

/** R-07：inspect 首屏只读最新窗口，更早的调用与产物用游标继续读取。 */
function seededTask(f, { runs = 0, artifacts = 0, bigArtifacts = 0 } = {}) {
  const task = f.store.create({ input_id: null, role: 'agent', goal: 'bounded inspect', task_kind: 'say' });
  // Fixture setup may be large; batch it so the test measures the read path, not per-row commit cost.
  return f.store.transaction(() => {
    for (let index = 0; index < runs; index++) f.store.finishRun(f.store.startRun(task).id, 'completed', { result: `run ${index}` });
    const ids = [];
    for (let index = 0; index < artifacts; index++) ids.push(f.store.addArtifact({ task_id: task.id, kind: 'note', payload: { index } }).id);
    for (let index = 0; index < bigArtifacts; index++) {
      ids.push(f.store.addArtifact({ task_id: task.id, kind: 'note', payload: { index, blob: 'x'.repeat(30000) } }).id);
    }
    return { task, artifactIds: ids };
  });
}

test('Run and Artifact cursors page the newest window without skips or repeats', async () => {
  const f = fixture(); await repo(f.root);
  try {
    const { task, artifactIds } = seededTask(f, { runs: 120, artifacts: 120 });
    const pages = [];
    let page = f.store.runsPage(task.id, { limit: 50 });
    expect(page.items).toHaveLength(50); expect(page.has_more).toBe(true);
    expect(page.cursor).toBe(page.items[0].id); expect(page.limit).toBe(50);
    pages.push(page);
    while (page.has_more) { page = f.store.runsPage(task.id, { before: page.cursor, limit: 50 }); pages.push(page); }
    // 每一页内部升序，页间从新到旧；把页序反过来就是完整且无重复跳过的时间序。
    const runs = pages.reverse().flatMap(part => part.items);
    expect(runs.map(run => run.id)).toEqual([...new Set(runs.map(run => run.id))]);
    expect(runs).toHaveLength(120);
    expect(runs.map(run => run.id)).toEqual([...runs.map(run => run.id)].sort((a, b) => a - b));
    expect(runs.at(-1).result).toBe('run 119');
    expect(runs.at(0).result).toBe('run 0');

    const artifacts = [];
    let artifactPage = f.store.artifactsPage(task.id, { limit: 50 });
    expect(artifactPage.items.at(-1).id).toBe(artifactIds.at(-1));
    artifacts.push(...artifactPage.items);
    while (artifactPage.has_more) { artifactPage = f.store.artifactsPage(task.id, { before: artifactPage.cursor, limit: 50 }); artifacts.push(...artifactPage.items); }
    expect(artifacts.map(row => row.id).sort((a, b) => a - b)).toEqual([...artifactIds].sort((a, b) => a - b));
    expect(new Set(artifacts.map(row => row.id)).size).toBe(artifacts.length);
    expect(() => f.store.runsPage(task.id, { limit: 0 })).toThrow('run limit');
    expect(() => f.store.artifactsPage(task.id, { limit: 201 })).toThrow('artifact limit');
    expect(() => f.store.runsPage(task.id, { before: -1 })).toThrow('invalid run cursor');
    expect(f.store.runsPage(task.id, { before: 1, limit: 50 }).items).toEqual([]);
  } finally { await f.close(); }
});

test('inspect reads a bounded, newest-first history window and never scans older calls', async () => {
  const f = fixture(); await repo(f.root);
  try {
    const { task } = seededTask(f, { runs: 10000, artifacts: 400 });
    const all = f.store.all.bind(f.store);
    let runRows = 0, artifactRows = 0;
    f.store.all = (sql, ...params) => { const rows = all(sql, ...params);
      if (sql.includes('agent_runs')) runRows += rows.length;
      else if (sql.includes('artifacts')) artifactRows += rows.length;
      return rows; };
    const inspected = f.project.inspect(task.id);
    expect(runRows).toBeLessThanOrEqual(51);
    expect(artifactRows).toBeLessThanOrEqual(51);
    expect(inspected.runs).toHaveLength(50);
    expect(inspected.artifacts).toHaveLength(50);
    expect(inspected.runs.at(-1).result).toBe('run 9999');
    expect(inspected.agent).toMatchObject({ task_id: task.id, role: 'agent' });
    expect(Buffer.byteLength(JSON.stringify(inspected.runs))).toBeLessThan(200000);
    expect(inspected.runs_page).toEqual({ has_more: true, cursor: inspected.runs[0].id, limit: 50, truncated: false });
    expect(inspected.artifacts_page).toEqual({ has_more: true, cursor: inspected.artifacts[0].id, limit: 50, truncated: false });
    // 继续读取从首屏最旧一条往更早走，不重复也不跳过。
    const older = f.store.runsPage(task.id, { before: inspected.runs_page.cursor, limit: 50 });
    expect(older.items.at(-1).id).toBeLessThan(inspected.runs[0].id);
    expect(inspected.runs.map(run => run.id)).not.toContain(older.items.at(-1).id);
  } finally { await f.close(); }
});

test('a small Run window still rebuilds progress instead of losing earlier work time', async () => {
  const f = fixture(); await repo(f.root);
  try {
    const root = f.store.create({ input_id: null, role: 'agent', goal: 'progress window', task_kind: 'say' });
    // 第一步的调用区间在首屏 50 条窗口之外；进度重建仍必须看到它，否则用时会被静默算成 0。
    const first = f.store.startRun(root);
    f.store.update(root.id, { status: 'running' });
    f.project.reportProgressPlan(root.id, [{ key: 'a', label: '第一步' }, { key: 'b', label: '第二步' }]);
    f.project.completeProgressStep(root.id, 'a');
    f.store.finishRun(first.id, 'completed', { result: 'first' });
    for (let index = 0; index < 60; index++) f.store.finishRun(f.store.startRun(root).id, 'completed', { result: `later ${index}` });
    const inspected = f.project.inspect(root.id);
    expect(inspected.runs).toHaveLength(50);
    expect(inspected.runs.at(0).id).toBeGreaterThan(first.id);
    expect(inspected.runs_page.has_more).toBe(true);
    const step = inspected.progress.items.find(item => item.key === 'a');
    expect(step.work_ms).toBeGreaterThan(0);
    expect(step).toMatchObject({ status: 'completed', wait_ms: 0 });
  } finally { await f.close(); }
});

test('Artifact windows mark truncated payloads and keep the complete record readable', async () => {
  const f = fixture(); await repo(f.root);
  try {
    const { task } = seededTask(f, { artifacts: 1, bigArtifacts: 2 });
    const inspected = f.project.inspect(task.id);
    const [small, ...big] = inspected.artifacts;
    expect(small.payload).toEqual({ index: 0 });
    expect(small.payload_truncated).toBe(false);
    expect(inspected.artifacts_page).toEqual({ has_more: false, cursor: small.id, limit: 50, truncated: false });
    for (const row of big) {
      expect(row.payload_truncated).toBe(true);
      expect(row.payload_bytes).toBeGreaterThan(30000);
      expect(row.payload.summary.length).toBeLessThanOrEqual(8192);
      expect(typeof row.payload.summary).toBe('string');
    }
    const full = f.store.artifact(big.at(-1).id);
    expect(full.payload).toEqual({ index: 1, blob: 'x'.repeat(30000) });
    expect(full.payload_truncated).toBeUndefined();
  } finally { await f.close(); }
});

test('paged reads stay user-only and validate their parameters', async () => {
  const f = fixture(); await repo(f.root);
  try {
    const { task } = seededTask(f, { runs: 3, artifacts: 1 });
    const dispatcher = new Dispatcher(f.project, createSignal(), {});
    expect(assertAllowed('worker.runs_page', { id: task.id }, null)).toBeNull();
    expect(() => assertAllowed('worker.artifact', { id: 1 }, 42)).toThrow('requires user approval');
    const page = await dispatcher.dispatch('worker.runs_page', { id: task.id, limit: 2 });
    expect(page.items).toHaveLength(2); expect(page.has_more).toBe(true);
    expect((await dispatcher.dispatch('worker.runs_page', { id: task.id, before: page.cursor, limit: 2 })).items).toHaveLength(1);
    expect((await dispatcher.dispatch('worker.artifacts_page', { id: task.id })).items).toHaveLength(1);
    const artifact = await dispatcher.dispatch('worker.artifact', { id: (await dispatcher.dispatch('worker.artifacts_page', { id: task.id })).items[0].id });
    expect(artifact.payload).toEqual({ index: 0 });
    await expect(dispatcher.dispatch('worker.runs_page', { id: task.id, limit: 0 })).rejects.toThrow('run limit');
    await expect(dispatcher.dispatch('worker.runs_page', { id: task.id, status: 'running' })).rejects.toThrow('unknown parameter');
    await expect(dispatcher.dispatch('worker.artifact', { id: 999 })).rejects.toThrow('not found');
    await expect(dispatcher.dispatch('worker.runs_page', { id: 999 })).rejects.toThrow('not found');
  } finally { await f.close(); }
});
