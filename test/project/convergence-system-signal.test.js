import { test, expect } from 'bun:test';
import path from 'node:path';
import { fixture, repo } from '../helpers.js';
import { Store } from '../../src/persistence/store.js';

test('batch system signals with NULL sender are idempotent across connections and reject altered content', async () => {
  const f = fixture(); f.project.kick = () => {}; let other;
  try {
    await repo(f.root); const parent = await f.project.bootstrapMain();
    other = new Store(path.join(f.config.home, 'project.db'), f.root);
    const first = f.store.signal(parent.id, null, 'merge.completed', 'batch:1', 'fixed batch');
    expect(first.inserted).toBe(true);
    expect(other.signal(parent.id, null, 'merge.completed', 'batch:1', 'fixed batch')).toEqual({ id: first.id, inserted: false });
    expect(() => other.signal(parent.id, null, 'merge.completed', 'batch:1', 'changed')).toThrow('different content');
    expect(f.store.get("SELECT count(*) AS n FROM messages WHERE signal_key='batch:1'").n).toBe(1);
    expect(() => f.store.transaction(() => {
      f.store.signal(parent.id, null, 'merge.completed', 'batch:2', 'rolled back');
      throw new Error('rollback');
    })).toThrow('rollback');
    expect(f.store.get("SELECT count(*) AS n FROM messages WHERE signal_key='batch:2'").n).toBe(0);
  } finally { other?.close(); await f.close(); }
});
