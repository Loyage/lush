import cp from 'node:child_process';
import path from 'node:path';
import { check } from '../core/types.js';
import { AGENT_BACKENDS, MODEL_PRESETS } from './settings.js';

const MAX_OUTPUT = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

function commandOutput(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish(new Error(`${path.basename(command)} model discovery timed out`));
    }, TIMEOUT_MS);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT) {
        try { child.kill('SIGKILL'); } catch {}
        finish(new Error(`${path.basename(command)} model catalog is too large`));
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', error => finish(error));
    child.on('close', code => finish(code === 0 ? null : new Error(`${path.basename(command)} exited ${code}: ${stderr.trim()}`), stdout));
  });
}

function piModels(output) {
  const rows = [];
  for (const line of output.split(/\r?\n/).slice(1)) {
    const columns = line.trim().split(/\s{2,}/);
    if (columns.length < 2 || !columns[0] || !columns[1]) continue;
    const [provider, model, context = '', max_output = '', thinking = '', images = ''] = columns;
    rows.push({ id: `${provider}/${model}`, label: model, provider, context, max_output,
      thinking: thinking.toLowerCase() === 'yes', images: images.toLowerCase() === 'yes' });
  }
  return rows.slice(0, 500);
}

function codexModels(output) {
  const value = JSON.parse(output);
  check(Array.isArray(value?.models), 'codex returned an invalid model catalog');
  return value.models
    .filter(model => model && typeof model.slug === 'string' && model.visibility !== 'hide')
    .slice(0, 500)
    .map(model => ({
      id: model.slug,
      label: typeof model.display_name === 'string' ? model.display_name : model.slug,
      description: typeof model.description === 'string' ? model.description.slice(0, 500) : '',
      default_thinking: typeof model.default_reasoning_level === 'string' ? model.default_reasoning_level : '',
      thinking: Array.isArray(model.supported_reasoning_levels)
        ? model.supported_reasoning_levels.map(level => level?.effort).filter(value => typeof value === 'string') : [],
    }));
}

function fallback(agent, error) {
  return { agent, source: 'presets', models: (MODEL_PRESETS[agent] || []).map(id => ({ id, label: id })),
    warning: `无法读取 ${agent} CLI 模型目录，暂时显示内置预设：${String(error?.message || error).slice(0, 500)}` };
}

/** Read the model catalog exposed by the selected local CLI. Raw CLI output is never returned. */
export async function discoverAgentModels(config, agent) {
  check(AGENT_BACKENDS.includes(agent), 'agent must be pi or codex');
  try {
    if (agent === 'pi') {
      const command = config.env.LUSH_PI_COMMAND || 'pi';
      const models = piModels(await commandOutput(command, ['--list-models'], config.env));
      check(models.length > 0, 'pi returned an empty model catalog');
      return { agent, source: 'cli', models, warning: null };
    }
    const command = config.env.LUSH_CODEX_COMMAND || 'codex';
    const models = codexModels(await commandOutput(command, ['debug', 'models'], config.env));
    check(models.length > 0, 'codex returned an empty model catalog');
    return { agent, source: 'cli', models, warning: null };
  } catch (error) { return fallback(agent, error); }
}
