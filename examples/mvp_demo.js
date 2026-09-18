/**
 * Reproducible CLI/daemon demo, isolated from the user's normal Lush data.
 * Run with: bun run demo
 *
 * It walks the shape of Lush: passive **processes** (identity, variables,
 * state) and **tasks** (the work, run by agents, delegated downstream) — and
 * the task tree that shows one piece of work being solved across processes.
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

    // Processes are passive nodes: creating one starts nothing at all.
    await run(['process', 'spawn', '0', 'project-manager', '--name', 'project-manager']);
    await run(['process', 'spawn', '1', 'generic-task', '--name', 'implement-login', '--goal', '实现登录功能']);
    await run(['process', 'tree']);
    if ((await json('task', 'list')).length !== 0) throw new Error('spawning a process must not create work');
    console.log('✓ Processes are passive: no agent, no task, just identity and state');

    // `call` is the entry point: a root task on the process, worked by an agent.
    const first = await run(['call', '2', '请介绍一下你当前的身份和任务'], { quiet: true });
    if (!first.includes('PID = 2') || !first.includes('parent = project-manager[1]')) {
      throw new Error('mock identity output changed');
    }
    await run(['task', 'list']);
    await run(['task', 'tree', '1']);
    await run(['task', 'history', '1']);
    console.log('✓ A call creates a task on a process; the task owns the agent and the conversation');

    // Delegation: the agent on PID 1 opens a task on its own child process.
    await run(['call', '1', '把这活派给下游']);
    await run(['process', 'tree']);
    const tasks = await json('task', 'list');
    const root = tasks.find((task) => task.pid === 1);
    const delegated = tasks.filter((task) => task.parent_task_id === root.id);
    if (delegated.length === 0) throw new Error('the task was not delegated downstream');
    await run(['task', 'tree', String(root.id)]);
    console.log('✓ A task delegates by creating child tasks on its child processes');

    // The autonomous-spawn path stays available: the agent may grow the tree.
    await run(['call', '1', '创建一个子任务，研究 OAuth 登录实现方式']);
    const tree = await run(['process', 'tree'], { quiet: true });
    if (!tree.includes('research-oauth[3]')) throw new Error('autonomous spawn failed');
    await run(['process', 'tree']);

    // Restart: nodes, variables, tasks and their conversations all survive.
    const before = await json('process', 'inspect', '2');
    const beforeTasks = (await json('task', 'list')).length;
    await run(['daemon', 'stop']);
    await run(['daemon', 'start']);
    if ((await run(['process', 'tree'], { quiet: true })) !== tree) throw new Error('tree was not restored');
    if ((await json('task', 'list')).length !== beforeTasks) throw new Error('tasks were not restored');
    if (JSON.stringify(before.context) !== JSON.stringify((await json('process', 'inspect', '2')).context)) {
      throw new Error('context was not restored');
    }
    console.log('✓ Restart restored the tree, its tasks, state and conversation');

    // Stopping a node hands its active children to PID 0, and cancels its work.
    await run(['process', 'spawn', '2', 'generic-service', '--name', 'login-helper']);
    const helper = (await json('process', 'list')).find((row) => row.name === 'login-helper');
    const longTask = await json('task', 'spawn', '2', '--goal', 'hold this work');
    await json('task', 'wait', String(longTask.id));
    await run(['process', 'stop', '2']);
    const orphan = await json('process', 'inspect', String(helper.pid));
    if (orphan.parent_pid !== 0 || orphan.original_parent_pid !== 2) throw new Error('orphan adoption failed');
    await run(['process', 'orphans']);
    console.log('✓ Stopping a node hands its active children to PID 0');

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

    // Tasks are removable history; the call rows stay as the node's record.
    const doomed = (await json('task', 'list')).find((task) => task.status === 'completed');
    await run(['task', 'delete', String(doomed.id)]);
    if ((await json('task', 'list')).some((task) => task.id === doomed.id)) throw new Error('task was not deleted');
    console.log('✓ Tasks can be archived without losing the process history');
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
