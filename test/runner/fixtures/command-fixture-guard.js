import { createInterface } from 'node:readline';
import fs from 'node:fs';
import { runCommandGuard } from '../../../src/runner/command-guard.js';
import { fixtureController, delayedAttachController } from './command-process-adapter.js';
const lines = createInterface({ input: process.stdin });
lines.once('line', async line => {
  const args = JSON.parse(line);
  const controller = !args.guard_mode || args.guard_mode === 'group' ? fixtureController() : delayedAttachController(args.guard_mode);
  // Test-only scheduling gate before production guard initialization, not a containment bypass.
  if (args.guard_gate) {
    lines.once('close', () => fs.writeFileSync(args.guard_gate + '.eof', 'closed'));
    for (const method of ['prepare', 'launch']) {
      const original = controller[method];
      controller[method] = (...values) => { fs.appendFileSync(args.guard_gate + '.effects', method + '\n'); return original(...values); };
    }
    fs.writeFileSync(args.guard_gate + '.ready', String(process.pid));
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(args.guard_gate)) {
      if (Date.now() >= deadline) process.exit(2);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  const finish = code => { if (args.guard_gate) fs.writeFileSync(args.guard_gate + '.done', String(code)); process.exit(code); };
  void runCommandGuard({ ...args, controller }).then(() => finish(0), () => finish(1));
});
