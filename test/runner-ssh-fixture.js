import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** Internal adapter only: production always launches ssh; this child records the actual argv/config. */
export function sshFixture(root) {
  const home = path.join(root, 'os-user'), directory = path.join(home, '.ssh'), log = path.join(root, 'ssh-trial.jsonl');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const program = path.join(root, 'controlled-ssh.js');
  fs.writeFileSync(program, `import fs from 'node:fs';
const [log, ...args] = process.argv.slice(2), alias = args[args.indexOf('--') + 1];
const config = args[args.indexOf('-F') + 1];
fs.appendFileSync(log, JSON.stringify({ args, config: fs.readFileSync(config, 'utf8'), mode: fs.statSync(config).mode & 511, env: Object.keys(process.env) }) + '\\n');
if (alias === 'hang') { setInterval(() => {}, 1000); }
else if (alias === 'flood') { process.stdout.write('private-diagnostic'.repeat(2000)); setInterval(() => {}, 1000); }
else { process.stderr.write('raw-private-diagnostic'); process.exit(alias === 'fail' ? 255 : 0); }
`);
  let calls = 0;
  return { home, directory, log, options: { home, spawn_process(command, args, options) {
    if (command !== 'ssh') throw new Error('unexpected executable');
    calls++;
    return spawn(process.execPath, [program, log, ...args], options);
  } }, calls: () => calls,
    records: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [],
    config(text) { fs.writeFileSync(path.join(directory, 'config'), text, { mode: 0o600 }); },
  };
}
