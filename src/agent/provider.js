import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUIDE } from './guide.js';

const BIN = fileURLToPath(new URL('../../bin', import.meta.url));
export class PiProvider {
  constructor(config) { this.config = config; }
  async run({ task, context, messages, cwd, token, signal, onSpawn }) {
    const config = this.config;
    const sessions = path.join(config.home, 'sessions');
    fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
    const prompt = JSON.stringify({ task, project: config.project, ...context, messages });
    // Use a prompt file rather than argv for arbitrarily large project context.
    const promptFile = path.join(sessions, `task-${task.id}-input.md`);
    fs.writeFileSync(promptFile, prompt, { mode: 0o600 });
    const args = ['--print', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes',
      '--session-dir', sessions, '--session-id', `lush-task-${task.id}`, '--append-system-prompt', GUIDE,
      `Read ${promptFile} for your current Lush task and unread messages. Follow the task role and report your result.`];
    if (config.env.LUSH_PI_MODEL) args.unshift('--model', config.env.LUSH_PI_MODEL);
    if (config.env.LUSH_PI_PROVIDER) args.unshift('--provider', config.env.LUSH_PI_PROVIDER);
    const child = cp.spawn(config.env.LUSH_PI_COMMAND || 'pi', args, {
      cwd, detached: true, stdio: ['ignore','pipe','pipe'],
      env: { ...config.env, LUSH_TASK_ID: String(task.id), LUSH_AGENT_TOKEN: token, PATH: `${BIN}${path.delimiter}${config.env.PATH || ''}` },
    });
    onSpawn(child.pid);
    let output = '', stderr = '', overflow = false;
    const kill = () => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (output.length + chunk.length > 256000) { overflow = true; kill(); }
      else output += chunk;
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
    signal.addEventListener('abort', kill, { once: true });
    if (signal.aborted) kill();
    try {
      const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
      if (signal.aborted) throw new Error('agent invocation interrupted or timed out');
      if (overflow) throw new Error('agent output exceeded 256000 characters');
      if (code !== 0) throw new Error(`pi exited ${code}: ${stderr}`);
      return output.trim();
    } finally {
      signal.removeEventListener('abort', kill);
      // A task must not leave background grandchildren editing after its invocation ended.
      kill();
    }
  }
}

/** Deterministic offline backend: exercises delegation but never pretends to edit code. */
export class MockProvider {
  async run({ task, messages, signal, api }) {
    if (signal.aborted) throw new Error('aborted');
    if (task.role === 'planner' && !messages.length) {
      // planner writes a semantic Plan; runtime deterministically compiles it into runnable work.
      api.addSpec(task.id, { goal: `${task.goal}（离线演示调研）`, role: 'research', name: 'mock-research', deps: [] });
      return '已提交结构化 Plan，等待 runtime 编译。';
    }
    return `Mock ${task.role} #${task.id}: ${task.goal}（未调用模型、未修改文件）`;
  }
}
