/**
 * Reproducible CLI/daemon demo, isolated from the user's normal Lush data.
 * Run with: bun run demo
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { forceStopDaemon } from '../src/daemon/locking.js';

const ROOT = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const CLI = path.join(ROOT, 'src', 'cli', 'main.js');

function makeRunner(home) {
  const env = {
    ...process.env,
    LUSH_HOME: home,
    LUSH_PROVIDER: 'mock',
    LUSH_CALL_TIMEOUT: '30',
    LUSH_RPC_TIMEOUT: '40',
  };
  return async function run(args, { input = null, quiet = false } = {}) {
    if (!quiet) process.stdout.write(`$ lush ${args.join(' ')}\n`);
    const proc = Bun.spawn([process.execPath, CLI, ...args], {
      cwd: ROOT,
      env,
      stdin: input === null ? 'ignore' : Buffer.from(input),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new Error(stderr || `lush ${args.join(' ')} exited with ${code}`);
    if (!quiet && stdout) process.stdout.write(stdout);
    return stdout;
  };
}

async function demo(home) {
  const run = makeRunner(home);
  const json = async (...args) => JSON.parse(await run(['--json', ...args], { quiet: true }));
  try {
    await run(['daemon', 'start']);
    if ((await run(['process', 'tree'], { quiet: true })).trim() !== 'lush[0]') throw new Error('unexpected initial tree');
    await run(['process', 'spawn', '0', 'project-manager', '--name', 'project-manager']);
    await run(['process', 'spawn', '1', 'generic-task', '--name', 'implement-login', '--goal', '实现登录功能']);
    await run(['process', 'tree']);

    const identity = await run(['process', 'call', '2', '请介绍一下你当前的身份和任务'], { quiet: true });
    if (!identity.includes('PID = 2') || !identity.includes('project-manager[1]')) {
      throw new Error('mock identity output changed');
    }
    await run(['process', 'attach', '2'], { input: '当前任务是什么？\n查看你的子任务\n/exit\n' });
    await run(['process', 'call', '1', '创建一个子任务，研究 OAuth 登录实现方式']);
    const tree = await run(['process', 'tree'], { quiet: true });
    if (!tree.includes('research-oauth[3]')) throw new Error('autonomous spawn failed');

    await run(['process', 'call', '2', '/tool process.update_state {"patch":{"progress":"designing"}}']);
    const before = await json('process', 'inspect', '2');

    await run(['daemon', 'stop']);
    await run(['daemon', 'start']);
    if ((await run(['process', 'tree'], { quiet: true })) !== tree) throw new Error('tree was not restored');
    const after = await json('process', 'inspect', '2');
    if (JSON.stringify(before.context) !== JSON.stringify(after.context)) {
      throw new Error('context was not restored');
    }
    console.log('✓ Restart restored tree, state, conversation and invocation history');

    await run(['process', 'spawn', '2', 'generic-service', '--name', 'login-helper']);
    await run(['process', 'call', '2', '/tool process.complete {"result":"MVP lifecycle demonstration complete"}']);
    const orphan = await json('process', 'inspect', '4');
    if (orphan.parent_pid !== 0 || orphan.original_parent_pid !== 2) throw new Error('orphan adoption failed');
    await run(['process', 'tree']);
    console.log('✓ Task completion adopted its live Service into PID 0');

    const reclaimed = await json('process', 'reclaim', '2');
    if (reclaimed.status !== 'reclaimed') throw new Error('reclaim failed');
    if ((await json('process', 'history', '2')).messages.length === 0) throw new Error('history was dropped');
    console.log('✓ Reclaim preserved history');

    // Variables: creation values are checked against the template and split into
    // immutable / mutable; only mutable ones can change afterwards.
    const project = await json('process', 'spawn', '1', 'project', '--name', 'lush-demo',
      '--vars', JSON.stringify({ path: ROOT }));
    const variables = (await json('process', 'inspect', String(project.pid))).variables;
    if (variables.immutable.path !== ROOT || variables.mutable.branch !== 'main') {
      throw new Error('template variables were not applied at creation');
    }
    let refused = null;
    try {
      await run(['process', 'update-vars', String(project.pid), '--vars', '{"path":"/tmp"}'], { quiet: true });
    } catch (err) {
      refused = err;
    }
    if (refused === null || !String(refused.message).includes('immutable')) {
      throw new Error('immutable variable was not protected');
    }
    await run(['process', 'update-vars', String(project.pid), '--vars', '{"branch":"demo"}']);
    if ((await json('process', 'inspect', String(project.pid))).variables.mutable.branch !== 'demo') {
      throw new Error('mutable variable was not updated');
    }
    const variableTree = await run(['process', 'tree'], { quiet: true });
    if (!variableTree.includes(`lush-demo[${project.pid}] path=`) || !variableTree.includes('~branch=demo')) {
      throw new Error('tree does not show variables');
    }
    console.log('✓ Variables: required path at creation, mutable branch updated, immutable path refused');
    console.log('\nMVP demo passed.');
  } finally {
    await run(['daemon', 'stop'], { quiet: true }).catch(() => {});
  }
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-demo-'));
try {
  await demo(home);
} finally {
  // The graceful stop above can fail (a wedged daemon, a lost socket); a
  // detached daemon would then outlive the demo with its home deleted.
  const forced = await forceStopDaemon(home);
  if (forced.killed) console.log(`(cleaned up leftover daemon pid ${forced.pid})`);
  fs.rmSync(home, { recursive: true, force: true });
}
