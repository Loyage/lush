import fs from 'node:fs';
import path from 'node:path';
const directory = process.argv[2];
// Simulates a real bootstrap parked BEFORE attachment. No untrusted action until released.
const release = path.join(directory, 'release-bootstrap');
const watcher = fs.watch(directory, () => {
  if (!fs.existsSync(release)) return;
  watcher.close();
  fs.writeFileSync(path.join(directory, 'late-execution'), 'must never execute after a stop receipt');
  process.exit(0);
});
fs.writeFileSync(path.join(directory, 'bootstrap-ready'), String(process.pid));
