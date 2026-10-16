import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunnerStore } from '../../src/runner/store.js';
import { RunnerError } from '../../src/runner/protocol.js';
import { commandGroupName } from '../../src/runner/cgroup.js';
import { finishExecution } from '../../src/runner/command-state.js';
import { beginCommandResources, beginContainmentCreation, recordCommandContainment, createCommandHome,
  resourceRow, commandResourceCleanup } from '../../src/runner/command-resources.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-command-resources-'));
  const store = new RunnerStore(root);
  const stat = directory => { const s = fs.lstatSync(directory, { bigint: true }); return { dev: String(s.dev), ino: String(s.ino) }; };
  const counts = new Map();
  // Ordinary fixture directories model ownership only. They are not cgroup v2 evidence.
  const controller = {
    verify(receipt) {
      const s = fs.lstatSync(receipt.directory);
      if (!s.isDirectory() || s.isSymbolicLink() || JSON.stringify(stat(receipt.directory)) !== JSON.stringify(receipt.identity))
        throw new RunnerError('STALE', 'fixture containment changed');
      return receipt.directory;
    },
    remove(receipt) { this.verify(receipt); counts.set(receipt.directory, (counts.get(receipt.directory) ?? 0) + 1); fs.rmdirSync(receipt.directory); },
    absent(receipt) { return !fs.existsSync(receipt.directory); },
  };
  function execution(id, allocate = true) {
    const spec = { resources_version: 1, bootstrap_state: 'exited' };
    const row = { execution_id: id, workspace_key: 'workspace' };
    store.db.query(`INSERT INTO executions(execution_id,workspace_key,request_id,identity_json,session_id,state,spec_json,cgroup_name,created_at,expires_at,queue_deadline,stop_confirmed)
      VALUES (?,?,'request','{}','session',?,?,?,0,9999999999999,9999999999999,?)`)
      .run(id, row.workspace_key, allocate ? 'exited' : 'queued', JSON.stringify(spec), commandGroupName(row), allocate ? 1 : 0);
    if (allocate) {
      beginCommandResources(store, row); beginContainmentCreation(store, row);
      const directory = path.join(root, `fixture-containment-${id}`); fs.mkdirSync(directory);
      const receipt = { kind: 'fixture-directory', directory, identity: stat(directory) };
      recordCommandContainment(store, row, receipt);
      const home = createCommandHome(store, row); fs.writeFileSync(path.join(home, 'cache'), 'owned');
      store.db.query('UPDATE executions SET spec_json=? WHERE execution_id=?').run(JSON.stringify({ ...spec, containment: receipt }), id);
    }
    return store.db.query('SELECT * FROM executions WHERE execution_id=?').get(id);
  }
  return { root, store, controller, counts, execution,
    close() { store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('per-resource removal receipts preserve partial progress and do not remove completed resources twice', () => {
  const f = fixture();
  try {
    const first = f.execution('first'), second = f.execution('second'), rows = [first, second];
    const firstResource = resourceRow(f.store, first.execution_id), secondResource = resourceRow(f.store, second.execution_id);
    const remove = f.controller.remove.bind(f.controller);
    f.controller.remove = receipt => { if (receipt.directory === secondResource.containment.directory) throw new RunnerError('STALE', 'fixture removal unavailable'); remove(receipt); };
    expect(() => commandResourceCleanup(f.store, rows, {}, { controller: f.controller })()).toThrow('unavailable');
    expect(resourceRow(f.store, first.execution_id).phase).toBe('removed');
    expect(resourceRow(f.store, second.execution_id).cgroup_state).toBe('removing');
    expect(fs.existsSync(secondResource.home.directory)).toBe(true);
    f.controller.remove = remove;
    commandResourceCleanup(f.store, rows, {}, { controller: f.controller })();
    commandResourceCleanup(f.store, rows, {}, { controller: f.controller })();
    expect(f.counts.get(firstResource.containment.directory)).toBe(1);
    expect(f.counts.get(secondResource.containment.directory)).toBe(1);
    expect(resourceRow(f.store, second.execution_id).phase).toBe('removed');
  } finally { f.close(); }
});

test('missing directory after an interrupted removal is unknown, not inferred success', () => {
  const f = fixture();
  try {
    const row = f.execution('interrupted'), resource = resourceRow(f.store, row.execution_id);
    f.controller.remove = receipt => { fs.rmdirSync(receipt.directory); throw new Error('lost persistence after rmdir'); };
    expect(() => commandResourceCleanup(f.store, [row], {}, { controller: f.controller })()).toThrow('lost persistence');
    expect(resourceRow(f.store, row.execution_id).cgroup_state).toBe('removing');
    expect(() => commandResourceCleanup(f.store, [row], {}, { controller: f.controller })).toThrow();
    expect(fs.existsSync(resource.home.directory)).toBe(true);
  } finally { f.close(); }
});

test('owned home contents include nested tmp and links, but cleanup never follows the links', () => {
  const f = fixture();
  try {
    const row = f.execution('links'), resource = resourceRow(f.store, row.execution_id);
    const foreign = path.join(f.root, 'foreign'); fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, 'keep'), 'foreign');
    fs.mkdirSync(path.join(resource.home.directory, 'tmp')); fs.symlinkSync(foreign, path.join(resource.home.directory, 'tmp/link'));
    commandResourceCleanup(f.store, [row], {}, { controller: f.controller })();
    expect(fs.existsSync(resource.home.directory)).toBe(false);
    expect(fs.readFileSync(path.join(foreign, 'keep'), 'utf8')).toBe('foreign');
  } finally { f.close(); }
});

test('unallocated cancelled queue has an explicit empty resource receipt rather than a guessed historical absence', () => {
  const f = fixture();
  try {
    const row = f.execution('queued', false);
    finishExecution(f.store, row, { reason: 'cancelled', stop_confirmed: true });
    expect(resourceRow(f.store, row.execution_id)).toMatchObject({ phase: 'unallocated', home_state: 'absent', cgroup_state: 'absent' });
    commandResourceCleanup(f.store, [row], {}, { controller: f.controller })();
    expect(resourceRow(f.store, row.execution_id).phase).toBe('removed');
  } finally { f.close(); }
});

test('resource preparation refuses path-like execution IDs before recording or creating a home', () => {
  const f = fixture();
  try {
    const row = { execution_id: '../foreign', workspace_key: 'workspace' };
    expect(() => beginCommandResources(f.store, row)).toThrow('execution_id');
    expect(() => createCommandHome(f.store, row)).toThrow('execution_id');
    expect(f.store.db.query('SELECT COUNT(*) AS n FROM command_resources').get().n).toBe(0);
  } finally { f.close(); }
});

test('last ownership check runs after the cleanup guard and preserves a late home replacement', () => {
  const f = fixture();
  try {
    const row = f.execution('late-change'), resource = resourceRow(f.store, row.execution_id);
    let replaced = false;
    const guard = () => {
      if (!replaced && resourceRow(f.store, row.execution_id).home_state === 'removing') {
        replaced = true; fs.renameSync(resource.home.directory, resource.home.directory + '-original');
        fs.mkdirSync(resource.home.directory); fs.writeFileSync(path.join(resource.home.directory, 'keep'), 'replacement');
      }
    };
    expect(() => commandResourceCleanup(f.store, [row], {}, { controller: f.controller, guard })()).toThrow('ownership changed');
    expect(fs.readFileSync(path.join(resource.home.directory, 'keep'), 'utf8')).toBe('replacement');
    expect(fs.readFileSync(path.join(resource.home.directory + '-original', 'cache'), 'utf8')).toBe('owned');
    expect(resourceRow(f.store, row.execution_id).cgroup_state).toBe('removed');
  } finally { f.close(); }
});

test('interrupted container creation survives Store restart without adopting a directory lacking an inode receipt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-resource-restart-'));
  let store = new RunnerStore(root);
  try {
    const metadata = JSON.parse(store.db.query("SELECT value FROM node_metadata WHERE key='command_homes_v1'").get().value);
    delete metadata.dev; delete metadata.ino; metadata.state = 'creating';
    store.db.query("UPDATE node_metadata SET value=? WHERE key='command_homes_v1'").run(JSON.stringify(metadata));
    store.close(); store = new RunnerStore(root);
    const row = { execution_id: 'cannot-adopt', workspace_key: 'workspace' };
    beginCommandResources(store, row);
    expect(() => createCommandHome(store, row)).toThrow('not confirmed');
    expect(JSON.parse(store.db.query("SELECT value FROM node_metadata WHERE key='command_homes_v1'").get().value).state).toBe('creating');
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
