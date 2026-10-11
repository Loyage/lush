import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { setup, git } from './convergence-harness.js';
import { convergenceValidationEnvironment, executeConvergenceValidation } from '../../src/core/workspaces/delivery-validation.js';
import { COMMAND_LIMITS } from '../../src/core/workspaces/command.js';
import { gate } from '../helpers.js';

async function resource() {
  const f = await setup();
  try {
    await f.member('a', { 'a.txt': 'a\n' }); const root = await f.combine(), receipt = await f.prepare(root.tree);
    const checkout = await f.workspaces.exclusive(() => f.workspaces.createConvergenceValidationUnsafe({ id: 1, generation: 1, commit: receipt.commit }));
    return { ...f, checkout, receipt,
      run(command, guard = () => true, options = {}) { return f.workspaces.runConvergenceValidation(checkout, command, guard, options); },
      remove() { return f.workspaces.exclusive(() => f.workspaces.removeConvergenceValidationUnsafe(checkout)); } };
  } catch (error) { f.close(); throw error; }
}

test('registered isolated exact candidate passes without provider capabilities or public output and is cleanly reclaimed', async () => {
  const f = await resource();
  try {
    Object.assign(f.config.env, { LUSH_AGENT_TOKEN: 'secret', PI_API_KEY: 'secret', CODEX_HOME: 'private',
      OPENAI_API_KEY: 'secret', ANTHROPIC_API_KEY: 'secret', GIT_WORK_TREE: '/wrong', GIT_INDEX_FILE: '/wrong' });
    // Git identity uses the config env; remove override test values before Git, and test all override keys via the pure env helper below.
    delete f.config.env.GIT_WORK_TREE; delete f.config.env.GIT_INDEX_FILE;
    const result = await f.run('test -z "$LUSH_AGENT_TOKEN$PI_API_KEY$CODEX_HOME$OPENAI_API_KEY$ANTHROPIC_API_KEY" && '
      + `test "$(git rev-parse HEAD)" = '${f.receipt.commit}' && test -f a.txt && printf output-secret`);
    expect(result.status).toBe('succeeded'); expect(result.output_bytes).toBe('output-secret'.length);
    expect(JSON.stringify(result)).not.toContain('output-secret'); expect(result.commit).toBe(f.receipt.commit);
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(f.baseline);
    expect(await git(f.members[0].workspace, 'rev-parse', 'HEAD')).toBe(f.members[0].source_commit);
    await f.remove(); expect(fs.existsSync(f.checkout.path)).toBe(false);
    await expect(git(f.root, 'show-ref', '--verify', f.checkout.ref)).rejects.toThrow();
    expect(JSON.parse(f.store.get("SELECT value FROM meta WHERE key='convergence_validation:1:1'").value).state).toBe('removed');
    expect(COMMAND_LIMITS.timeout_ms).toBe(60000); expect(COMMAND_LIMITS.output_bytes).toBe(65536);
  } finally { f.close(); }
});

test('ambient invocation/provider/Git overrides are stripped but ordinary project env remains', () => {
  const env = convergenceValidationEnvironment({ PATH: '/bin', NORMAL: 'yes', LUSH_PROJECT: 'private',
    LUSH_AGENT_TOKEN: 'private', PI_SECRET: 'private', CODEX_TOKEN: 'private', OPENAI_BASE_URL: 'private',
    ANTHROPIC_API_KEY: 'private', GIT_DIR: 'wrong', GIT_WORK_TREE: 'wrong', GIT_INDEX_FILE: 'wrong',
    GIT_OBJECT_DIRECTORY: 'wrong', GIT_ALTERNATE_OBJECT_DIRECTORIES: 'wrong' });
  expect(env.NORMAL).toBe('yes'); expect(env.CI).toBe('1'); expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  for (const key of ['LUSH_PROJECT','LUSH_AGENT_TOKEN','PI_SECRET','CODEX_TOKEN','OPENAI_BASE_URL','ANTHROPIC_API_KEY',
    'GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES']) expect(key in env).toBe(false);
});

test('authorization checked after async identity and immediately after started callback prevents execution', async () => {
  for (const late of ['identity', 'started', 'async', 'throw']) {
    const f = await resource();
    try {
      const marker = path.join(f.config.home, 'not-run'); let authorized = true;
      if (late === 'identity') {
        const original = f.workspaces.assertCleanBranches;
        f.workspaces.assertCleanBranches = async function(...args) { await original.apply(this, args); authorized = false; };
      }
      const guard = late === 'async' ? async () => true : late === 'throw' ? () => { throw new Error('private-secret'); } : () => authorized;
      const result = await f.run(`printf ran > '${marker}'`, guard, { started: late === 'started' ? () => { authorized = false; } : undefined });
      expect(result.status).toBe('failed'); expect(result.reason).toBe('authorization'); expect(fs.existsSync(marker)).toBe(false);
      expect(JSON.stringify(result)).not.toContain('private-secret');
    } finally { f.close(); }
  }
});

test('successful Shell result loses publication validity when authorization is revoked during execution', async () => {
  const f = await resource();
  try {
    let authorized = true;
    const result = await f.run('exit 0', () => authorized, { started: () => { queueMicrotask(() => { authorized = false; }); } });
    expect(result.status).toBe('failed'); expect(result.reason).toBe('authorization'); expect(result.exit_code).toBe(0);
  } finally { f.close(); }
});

test('validation does not hold project Git serial gate and a concurrent second run cannot claim same resource', async () => {
  const f = await resource();
  try {
    const started = gate(); let done = false;
    const run = f.run('sleep 0.08', () => true, { started: () => started.resolve() }).then(result => { done = true; return result; });
    await started.promise;
    await f.workspaces.exclusive(async () => { expect(done).toBe(false); await git(f.root, 'rev-parse', 'HEAD'); });
    await expect(f.run('exit 0')).rejects.toThrow('already');
    expect((await run).status).toBe('succeeded');
  } finally { f.close(); }
});

test('pre-aborted, timeout, output overflow and explicit abort stop process groups; output never becomes a log', async () => {
  for (const mode of ['pre', 'timeout', 'output', 'abort']) {
    const f = await resource();
    try {
      const controller = new AbortController();
      const marker = path.join(f.config.home, 'descendant-must-not-survive');
      let timer;
      if (mode === 'pre') controller.abort();
      const command = mode === 'output' ? "while :; do printf 'private-output'; done"
        : `(sleep .25; printf leak > '${marker}') & sleep 10`;
      const result = await f.run(command, () => true, { signal: controller.signal,
        timeout_ms: mode === 'timeout' ? 40 : 1000, output_bytes: mode === 'output' ? 32 : 65536,
        started: mode === 'abort' ? () => { timer = setTimeout(() => controller.abort(), 30); } : undefined });
      clearTimeout(timer);
      expect(result.status).toBe('failed'); expect(result.reason).toBe(mode === 'timeout' ? 'timeout' : mode === 'output' ? 'output_limit' : 'cancelled');
      expect(result.output_truncated).toBe(mode === 'output'); expect(JSON.stringify(result)).not.toContain('private-output');
      if (mode !== 'output') { await Bun.sleep(275); expect(fs.existsSync(marker)).toBe(false); }
    } finally { f.close(); }
  }
});

test('late stdout is fully drained and failed exit is safe; budget options cannot expand upper bounds', async () => {
  const f = await resource();
  try {
    const result = await f.run('printf private-stdout; printf private-stderr >&2; exit 7', () => true, { timeout_ms: 50 });
    expect(result.status).toBe('failed'); expect(result.reason).toBe('exit'); expect(result.exit_code).toBe(7);
    expect(result.output_bytes).toBe('private-stdoutprivate-stderr'.length); expect(JSON.stringify(result)).not.toContain('private-stdout');
    const output = await executeConvergenceValidation('printf 12345', f.root, convergenceValidationEnvironment(f.config.env), { output_bytes: 4 });
    expect(output.status).toBe('failed'); expect(output.output_truncated).toBe(true);
  } finally { f.close(); }
});

test('wrong descriptor, foreign/detached ref, dirty candidate or post-command commit mutation cannot pass or delete evidence', async () => {
  for (const mode of ['descriptor', 'detach', 'dirty', 'commit', 'switch']) {
    const f = await resource();
    try {
      if (mode === 'descriptor') {
        await expect(f.workspaces.runConvergenceValidation({ ...f.checkout, path: f.root }, 'exit 0', () => true)).rejects.toThrow('identity');
        await expect(f.workspaces.removeConvergenceValidationUnsafe({ ...f.checkout, ref: 'refs/heads/main' })).rejects.toThrow('identity');
        continue;
      }
      if (mode === 'detach') await git(f.checkout.path, 'checkout', '--detach');
      if (mode === 'dirty') fs.writeFileSync(path.join(f.checkout.path, 'file.txt'), 'uncommitted');
      const command = mode === 'commit' ? 'git -c user.name=Test -c user.email=test@invalid commit --allow-empty -m moved'
        : mode === 'switch' ? 'git checkout --detach' : 'exit 0';
      const result = await f.run(command); expect(result.status).toBe('failed'); expect(result.reason).toBe('identity');
      await expect(f.remove()).rejects.toThrow(); expect(fs.existsSync(f.checkout.path)).toBe(true);
      expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(f.baseline);
    } finally { f.close(); }
  }
});

test('registration exists before worktree creation; partial creation/cleanup and orphan execution are not adopted or replayed', async () => {
  const f = await resource();
  try {
    const original = f.workspaces.git;
    let persisted = false;
    f.workspaces.git = async function(cwd, ...args) {
      if (args.includes('worktree') && args.includes('add')) {
        persisted = JSON.parse(f.store.get("SELECT value FROM meta WHERE key='convergence_validation:2:1'").value).state === 'creating';
        throw new Error('creation fault');
      }
      return original.call(this, cwd, ...args);
    };
    await expect(f.workspaces.exclusive(() => f.workspaces.createConvergenceValidationUnsafe({ id: 2, generation: 1, commit: f.receipt.commit }))).rejects.toThrow('fault');
    expect(persisted).toBe(true);
    f.workspaces.git = original;
    await expect(f.workspaces.exclusive(() => f.workspaces.createConvergenceValidationUnsafe({ id: 2, generation: 1, commit: f.receipt.commit }))).rejects.toThrow('path');
    const ledger = JSON.parse(f.store.get("SELECT value FROM meta WHERE key='convergence_validation:1:1'").value);
    f.store.run('UPDATE meta SET value=? WHERE key=?', JSON.stringify({ ...ledger, state: 'running' }), 'convergence_validation:1:1');
    await expect(f.run('exit 0')).rejects.toThrow('already'); await expect(f.remove()).rejects.toThrow('active');
    expect(fs.existsSync(f.checkout.path)).toBe(true);
  } finally { f.close(); }
});

test('unknown path/ref are not overwritten; cleanup failure preserves a removing receipt and cannot blindly replay', async () => {
  const f = await resource();
  try {
    const occupied = path.join(f.config.home, 'convergence-validation', '3-1'); fs.mkdirSync(occupied); fs.writeFileSync(path.join(occupied, 'keep'), 'keep');
    await expect(f.workspaces.createConvergenceValidationUnsafe({ id: 3, generation: 1, commit: f.receipt.commit })).rejects.toThrow('exists');
    const original = f.workspaces.git;
    f.workspaces.git = async function(cwd, ...args) {
      if (args.includes('update-ref') && args.includes('-d')) throw new Error('delete fault');
      return original.call(this, cwd, ...args);
    };
    await expect(f.remove()).rejects.toThrow('fault');
    expect(fs.existsSync(f.checkout.path)).toBe(false);
    expect(await git(f.root, 'rev-parse', f.checkout.ref)).toBe(f.checkout.commit);
    await expect(f.remove()).rejects.toThrow('inspection');
    expect(JSON.parse(f.store.get("SELECT value FROM meta WHERE key='convergence_validation:1:1'").value).state).toBe('removing');
    expect(fs.readFileSync(path.join(occupied, 'keep'), 'utf8')).toBe('keep');
  } finally { f.close(); }
});
