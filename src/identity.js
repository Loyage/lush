import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export function codeIdentity() {
  const hash = createHash('sha256');
  function walk(dir) {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      const relative = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(relative);
      else hash.update(relative).update(fs.readFileSync(path.join(ROOT, relative)));
    }
  }
  walk('src'); walk('bin');
  hash.update(fs.readFileSync(path.join(ROOT, 'package.json')));
  return { code_dir: ROOT, version: '0.2.0', fingerprint: hash.digest('hex').slice(0, 16) };
}
