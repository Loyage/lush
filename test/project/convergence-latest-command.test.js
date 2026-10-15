import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git } from '../helpers.js';
import { convergenceJSON } from '../../src/core/convergence-contract.js';
import { historicalConvergencePolicy, pinHistoricalConvergence } from '../convergence-fixtures.js';

async function setup() {
  const f = fixture(); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {}; f.project.scheduleConvergence = () => {};
  await repo(f.root); f.main = await f.project.bootstrapMain();
  f.marker = path.join(f.config.home, 'validation-ran');
  f.command = f.project.saveShortcutCommand({ name: 'old', command: `printf old > '${f.marker}'` }, f.project.shortcutCommands().revision).commands.items.at(-1);
  historicalConvergencePolicy(f, f.main, { validation: { command_id: f.command.id } });
  const source = (await f.project.order('fixed source', 'main', [], null, false)).task;
  fs.writeFileSync(path.join(source.workspace, 'source.txt'), 'source'); await git(source.workspace, 'add', '.'); await git(source.workspace, 'commit', '-m', 'source');
  f.store.update(source.id, { status: 'waiting' }); await f.project.requestTaskMerge(source.id);
  f.reference = { command_id: f.command.id, command_version: 1 };
  await pinHistoricalConvergence(f, source.id, f.reference);
  f.run = await f.project.formConvergenceBatch(f.main.id); f.baseline = await git(f.root, 'rev-parse', 'main');
  return f;
}
const edit = (f, value) => f.project.saveShortcutCommand({ id: f.command.id, name: 'latest', ...value }, f.project.shortcutCommands().revision);

test('legacy command batch claims the latest definition at validation, ignores old revoked boolean, and retains historical reference', async () => {
  const f = await setup();
  try {
    expect(convergenceJSON(f.store.task(f.store.deliveryMembers(f.run.id)[0].task_id).reservation).validation).toEqual(f.reference);
    edit(f, { command: `printf new > '${f.marker}'` });
    const commands = JSON.parse(f.store.get("SELECT value FROM meta WHERE key='shortcut_commands'").value);
    commands.items.at(-1).authorized = false;
    f.store.run("UPDATE meta SET value=? WHERE key='shortcut_commands'", JSON.stringify(commands));
    f.store.event(null, 'shortcut.command_authorized', { command_id: f.command.id, version: 2, authorized: false });
    await f.project.prepareConvergenceRun(f.run.id, 1, new AbortController().signal);
    const run = f.store.deliveryRun(f.run.id);
    expect(run.state).toBe('integrated'); expect(fs.readFileSync(f.marker, 'utf8')).toBe('new');
    expect(convergenceJSON(run.validation)).toEqual({ command_id: f.command.id });
    expect(convergenceJSON(run.data).validation_execution).toMatchObject({ command_id: f.command.id, command_version: 2 });
    expect(convergenceJSON(run.validation_result)).toMatchObject({ state: 'passed', command_id: f.command.id, command_version: 2, command_name: 'latest' });
    expect(f.project.convergenceRunView(run).validation).toMatchObject({ command_id: f.command.id, command_version: 2, state: 'passed' });
  } finally { await f.close(); }
});

for (const mutation of ['edit', 'delete', 'type_switch']) test(`validation ${mutation} during async admission fails without running mixed body or replaying`, async () => {
  const f = await setup();
  try {
    const runner = f.project.workspaces.runConvergenceValidation.bind(f.project.workspaces);
    let runs = 0;
    f.project.workspaces.runConvergenceValidation = async (...args) => {
      runs++;
      await Promise.resolve();
      if (mutation === 'delete') f.project.removeShortcutCommand(f.command.id, f.project.shortcutCommands().revision);
      else if (mutation === 'type_switch') edit(f, { kind: 'prompt', prompt: 'not Shell' });
      else edit(f, { command: `printf new > '${f.marker}'` });
      return runner(...args);
    };
    expect(f.project.startConvergenceJob(f.run.id)).toBe(true); await f.project.convergenceJobs.get(f.run.id).promise;
    const failed = f.store.deliveryRun(f.run.id);
    expect(failed).toMatchObject({ state: 'failed', landing_receipt: null });
    expect(convergenceJSON(failed.validation_result)).toMatchObject({ state: 'unknown', command_id: f.command.id, command_version: 1 });
    expect(fs.existsSync(f.marker)).toBe(false); expect(await git(f.root, 'rev-parse', 'main')).toBe(f.baseline);
    expect(convergenceJSON(failed.validation)).toEqual({ command_id: f.command.id });
    expect(f.project.startConvergenceJob(f.run.id)).toBe(false); expect(runs).toBe(1);
  } finally { await f.close(); }
});
