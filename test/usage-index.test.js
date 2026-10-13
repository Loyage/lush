import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { fixture, gate, env } from './helpers.js';
import { UsageIndex } from '../src/core/usage-index.js';
import { readCompactUsageFile, readWorkerResources } from '../src/core/usage-statistics.js';

const row = (id, input = 10, cost = .1) => JSON.stringify({ type: 'message', lush: { task_id: id },
  message: { role: 'assistant', content: [{ type: 'text', text: 'PRIVATE BODY NOT IN INDEX' }],
    usage: { input, output: 2, cost: cost === null ? undefined : { total: cost } } } }) + '\n';
function save(config, id, body = row(id), prefix = 'now') {
  const dir = path.join(config.home, 'sessions'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${prefix}_lush-task-${id}.jsonl`); fs.writeFileSync(file, body); return file;
}
const tasks = [{ id: 1, parent_id: null, status: 'waiting' }, { id: 2, parent_id: 1, status: 'completed' }];
const resources = (f, index = f.project.usageIndex) => readWorkerResources(f.config, tasks, [], { index, read_ids: new Set([1]) });

test('durable compact summaries invalidate on append/replacement/delete, isolate bad/symlink sources and track known request evidence', async () => {
  const f = fixture(), original = fs.createReadStream; let reads = [];
  fs.createReadStream = function(file, ...args) { reads.push(file); return original.call(this, file, ...args); };
  try {
    const file = save(f.config, 2, row(1, 1000) + row(2) + row(2, 5, null) + 'illegal\n{"type":');
    let value = (await resources(f)).get(1).subtree;
    expect(value).toMatchObject({ input: 0, known_tokens: 0, known_cost: 0, pending_files: 1, incomplete: true });
    expect(reads).toEqual([]);
    await f.project.usageIndex.refresh();
    value = (await resources(f)).get(1).subtree;
    expect(value).toMatchObject({ input: 15, output: 4, cost: .1, known_tokens: 2, known_cost: 1,
      unknown_tokens: 0, unknown_cost: 1, pending_files: 0, incomplete: true });
    const stored = f.project.usageIndex.db.query('SELECT summary FROM summaries').get().summary;
    expect(stored).not.toContain('PRIVATE'); expect(stored).not.toContain('message'); expect(stored).not.toContain('rows');
    reads = []; await f.project.usageIndex.refresh(); expect(reads).toEqual([]);
    fs.appendFileSync(file, '}\n' + row(2, 3, 0));
    value = (await resources(f)).get(1).subtree;
    expect(value).toMatchObject({ input: 0, pending_files: 1, known_tokens: 0, incomplete: true });
    await f.project.usageIndex.refresh();
    expect(reads).toEqual([file]);
    expect((await resources(f)).get(1).subtree).toMatchObject({ input: 18, known_tokens: 3, known_cost: 2, pending_files: 0 });
    fs.unlinkSync(file); fs.writeFileSync(file, row(2, 7));
    await f.project.usageIndex.refresh(); expect((await resources(f)).get(1).subtree.input).toBe(7);
    fs.unlinkSync(file); await f.project.usageIndex.refresh();
    expect((await resources(f)).get(1).subtree).toMatchObject({ input: 0, pending_files: 0, known_cost: 0, incomplete: false });
    expect(f.project.usageIndex.db.query('SELECT count(*) AS n FROM summaries').get().n).toBe(0);
    const external = path.join(f.root, 'external.jsonl'); fs.writeFileSync(external, row(2, 9000)); fs.symlinkSync(external, file);
    reads = []; await f.project.usageIndex.refresh(); expect(reads).toEqual([]);
    const isolated = await resources(f);
    expect(isolated.get(2).own).toMatchObject({ input: 0, pending_files: 1, incomplete: true });
    expect(isolated.get(1).own.incomplete).toBe(false);
    fs.unlinkSync(file); save(f.config, 2, row(2), 'manager_lush-manager-ignored');
    // Both configuration-mode session naming variants are recognized by the same index.
    fs.writeFileSync(path.join(f.config.home, 'sessions', 'a_lush-manager-2-pi.jsonl'), row(2, 4));
    await f.project.usageIndex.refresh();
    expect((await resources(f)).get(1).subtree.input).toBe(14);
    fs.writeFileSync(path.join(f.config.home, 'sessions', 'codex-task-1.json'), '{"threadId":"metadata only"}');
    expect((await resources(f)).get(1).own).toMatchObject({ known_cost: 0, known_tokens: 0, pending_files: 0, incomplete: true });
  } finally { fs.createReadStream = original; await f.close(); }
});

test('restart in a fresh process uses persisted summaries without opening old session bodies; version, scope and corruption rebuild', async () => {
  const f = fixture(), other = fixture();
  try {
    save(f.config, 2);
    for (let id = 3; id <= 142; id++) save(f.config, id);
    await f.project.usageIndex.refresh(); await f.project.usageIndex.stop();
    const module = new URL('../src/core/usage-index.js', import.meta.url).href;
    const statistics = new URL('../src/core/usage-statistics.js', import.meta.url).href;
    const script = `import fs from 'node:fs'; import {UsageIndex} from ${JSON.stringify(module)};
      import {readWorkerResources} from ${JSON.stringify(statistics)};
      const config=${JSON.stringify({ home: f.config.home, project: f.config.project })};
      fs.createReadStream=()=>{throw new Error('must not reparse historical sessions')};
      const index=new UsageIndex(config); await index.refresh();
      const result=await readWorkerResources(config, ${JSON.stringify(tasks)}, [], {index,read_ids:new Set([1])});
      console.log(JSON.stringify(result.get(1).subtree)); await index.stop();`;
    const proc = Bun.spawn(['bun', '-e', script], { env: env(), stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(stderr).toBe(''); expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ input: 10, known_tokens: 1, known_cost: 1, pending_files: 0, incomplete: false });
    // A copied index cannot attach another project's observations, even when names match.
    fs.copyFileSync(f.project.usageIndex.file, other.project.usageIndex.file);
    save(other.config, 2, row(2, 99));
    expect((await resources(other)).get(1).subtree).toMatchObject({ input: 0, pending_files: 1 });
    await other.project.usageIndex.refresh(); expect((await resources(other)).get(1).subtree.input).toBe(99);
    const db = new Database(f.project.usageIndex.file);
    db.query("UPDATE metadata SET value='1' WHERE key='version'").run(); db.close();
    let index = new UsageIndex(f.config);
    expect((await resources(f, index)).get(1).subtree).toMatchObject({ input: 0, pending_files: 1, incomplete: true });
    await index.refresh(); expect((await resources(f, index)).get(1).subtree.input).toBe(10);
    index.db.query("UPDATE summaries SET summary='invalid json'").run();
    expect((await resources(f, index)).get(1).subtree.pending_files).toBe(1);
    await index.refresh(); expect((await resources(f, index)).get(1).subtree.pending_files).toBe(0);
    index.db.query('UPDATE summaries SET summary=?').run(JSON.stringify({ signature: 'broken', resources: { input: 1000 } }));
    expect((await resources(f, index)).get(1).subtree.pending_files).toBe(1);
    await index.stop(); fs.writeFileSync(index.file, 'not a SQLite database');
    index = new UsageIndex(f.config);
    expect((await resources(f, index)).get(1).subtree.pending_files).toBe(1);
    await index.refresh(); expect((await resources(f, index)).get(1).subtree.input).toBe(10);
    index.db.exec('DROP TABLE summaries; CREATE TABLE summaries (wrong TEXT)');
    await index.stop(); index = new UsageIndex(f.config);
    expect((await resources(f, index)).get(1).subtree.pending_files).toBe(1);
    await index.refresh(); expect((await resources(f, index)).get(1).subtree.input).toBe(10);
    await index.stop();
    fs.unlinkSync(index.file); fs.symlinkSync(other.project.usageIndex.file, index.file);
    index = new UsageIndex(f.config);
    expect(index.open()).toBeNull();
    expect(other.project.usageIndex.db.query('SELECT count(*) AS n FROM summaries').get().n).toBe(1);
    await index.stop();
  } finally { await f.close(); await other.close(); }
});

test('background single flight, bounded batches and stop drain in-flight work without admitting remaining files', async () => {
  const f = fixture(), entered = gate(), release = gate(); let calls = 0, turns = 0;
  const index = new UsageIndex(f.config, { batchSize: 2, intervalMs: 100000, parse: async (...args) => {
    calls++; if (calls === 1) { entered.resolve(); await release.promise; } return readCompactUsageFile(...args);
  } });
  try {
    for (let id = 1; id <= 6; id++) save(f.config, id);
    index.start(); index.start(); await entered.promise;
    const first = index.refresh(); expect(index.refresh()).toBe(first);
    const file = path.join(f.config.home, 'sessions', 'now_lush-task-1.jsonl'), stat = fs.statSync(file);
    const visible = index.read(file, stat);
    const stopping = index.stop(); let stopped = false; stopping.then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve)); expect(stopped).toBe(false); expect(calls).toBe(1);
    release.resolve(); await Promise.all([first, visible, stopping]);
    expect(stopped).toBe(true); expect(calls).toBe(1); expect(index.timer).toBeNull(); expect(index.db).toBeNull();
    // Fresh service completes the remaining pass and yields between batches.
    const completing = new UsageIndex(f.config, { batchSize: 2 });
    const tick = () => { turns++; if (!completing.closed) setImmediate(tick); };
    setImmediate(tick); await completing.refresh(); await completing.stop();
    expect(turns).toBeGreaterThanOrEqual(3);
    index.start(); expect(index.timer).toBeNull();
  } finally { release.resolve(); await index.stop(); await f.close(); }
});

test('one parser failure and a concurrent source append remain pending without poisoning valid neighbors', async () => {
  const f = fixture(), entered = gate(), release = gate(); let fail = true;
  const file = save(f.config, 1), other = save(f.config, 2);
  const index = new UsageIndex(f.config, { parse: async (name, stat) => {
    if (name === other && fail) throw new Error('source unavailable');
    if (name === file && fail) { entered.resolve(); await release.promise; }
    return readCompactUsageFile(name, stat);
  } });
  try {
    const flight = index.refresh(); await entered.promise; fs.appendFileSync(file, row(1, 3)); release.resolve(); await flight;
    expect(index.get(file, fs.statSync(file))).toBeNull(); expect(index.get(other, fs.statSync(other))).toBeNull();
    fail = false; await index.refresh();
    expect(index.get(file, fs.statSync(file)).resources.input).toBe(13);
    expect(index.get(other, fs.statSync(other)).resources.input).toBe(10);
  } finally { release.resolve(); await index.stop(); await f.close(); }
});


test('automatic background reconciliation discovers later files and changes without parsing unchanged history', async () => {
  const f = fixture(), first = gate(), second = gate(), third = gate(); let calls = 0;
  const file = save(f.config, 1);
  const index = new UsageIndex(f.config, { intervalMs: 1, parse: async (...args) => {
    calls++; const summary = await readCompactUsageFile(...args);
    if (calls === 1) first.resolve(); else if (calls === 2) second.resolve(); else if (calls === 3) third.resolve();
    return summary;
  } });
  try {
    index.start(); await first.promise; await index.refresh();
    expect(calls).toBe(1);
    save(f.config, 2); await second.promise; await index.refresh();
    expect(calls).toBe(2);
    fs.appendFileSync(file, row(1, 7)); await third.promise; await index.refresh();
    expect(calls).toBe(3);
    expect(index.get(file, fs.statSync(file)).resources.input).toBe(17);
  } finally { await index.stop(); await f.close(); }
});
