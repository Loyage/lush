import { RunnerStore } from '../../../src/runner/store.js';
await Bun.stdin.text(); // Test barrier: all independent processes are released together.
const store = new RunnerStore(process.argv[2]);
try { console.log(JSON.stringify({ runner_id: store.runner_id, tables: store.db.query("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get().n })); }
finally { store.close(); }
