import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo } from '../helpers.js';
import { PiProvider } from '../../src/agent/provider.js';
import { choiceForkPath, choiceDigest, writeChoiceFile } from '../../src/agent/choice-context.js';
import { managedPiRun } from './managed-runtime-fixture.js';

test('Pi choice fork uses independent frozen file, never falls back to commit context or repeats fork on resume', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    await repo(f.root);
    const { task } = await f.project.order('choice provider test');
    const command = path.join(f.root, 'fake-pi'), argsFile = path.join(f.root, 'args.json');
    fs.writeFileSync(command, '#!/usr/bin/env bun\nimport fs from "node:fs"; fs.writeFileSync(process.env.ARGS_FILE, JSON.stringify(process.argv.slice(2))); console.log("ok");\n', { mode: 0o700 });
    const bytes = Buffer.from(JSON.stringify({ type: 'session', version: 3, id: 'frozen' }) + '\n');
    const file = choiceForkPath(f.config.home, task.id), digest = choiceDigest(bytes);
    writeChoiceFile(f.config.home, file, bytes);
    const provider = new PiProvider({ ...f.config, env: { ...f.config.env, LUSH_PI_COMMAND: command, ARGS_FILE: argsFile } });
    const invoke = (override = {}) => provider.run(managedPiRun({ task, context: { invocation: { run_id: 42 }, choice_reselection: { answer_source: 'user' } },
      cwd: task.workspace, token: 'test', messages: [], signal: new AbortController().signal, onSpawn() {},
      agent: { agent: 'pi', extensions: [], skills: [], soft_budget: {} },
      forkPointer: { session: '/must-not-be-read', entry: 'old' }, choiceFork: { file, digest }, ...override }));
    expect(await invoke()).toBe('ok');
    let args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    expect(args.slice(args.indexOf('--fork'), args.indexOf('--fork') + 2)).toEqual(['--fork', file]);
    expect(args).toContain('--system-prompt');
    fs.writeFileSync(path.join(f.config.home, 'sessions', `time_lush-task-${task.id}.jsonl`), bytes);
    expect(await invoke()).toBe('ok');
    args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    expect(args).not.toContain('--fork');
    expect(args).toContain('--append-system-prompt');
    await expect(invoke({ choiceFork: { file: '/tmp/forged.jsonl', digest } })).rejects.toThrow('ownership');
    await expect(invoke({ agent: { agent: 'pi', config_mode: 'pi' } })).rejects.toThrow('mode');
    // Management sessions must never inherit a development choice checkpoint.
    await expect(invoke({ task: { ...task, role: 'manager', task_kind: 'management' } })).rejects.toThrow('mode');
    fs.appendFileSync(file, '{}\n');
    await expect(invoke()).rejects.toThrow('checkpoint');
  } finally { await f.close(); }
});
