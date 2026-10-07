import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { check } from '../core/types.js';
import { AGENT_BACKENDS, MODEL_PRESETS } from './settings.js';
import { agentNetworkEnvironment, redactNetworkText } from './network.js';
import { discoverPiModelMetadata } from './status.js';
import { piConfigDirectory } from './pi-config.js';
import { normalizeConfigurationScope, scopedConfiguration, configurationScope } from '../core/device-config.js';

const MAX_OUTPUT = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

function commandOutput(command, args, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(command, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
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
    child.on('close', code => finish(code === 0 ? null : new Error(`${path.basename(command)} exited ${code}; check outbound network and CLI configuration`), stdout));
  });
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
    warning: `无法读取 ${agent === 'pi' ? 'Lush Pi 本地' : `${agent} CLI`}模型目录，暂时显示内置预设：${String(error?.message || error).slice(0, 500)}` };
}

function hasLocalModelFile(config) {
  const file = path.join(piConfigDirectory(config), 'models.json');
  try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/** Pi uses an auth-free, offline SDK probe; Codex keeps its local CLI catalog. Raw diagnostics never leave this module. */
export async function discoverAgentModels(config, agent, scope = 'project') {
  check(AGENT_BACKENDS.includes(agent), 'agent must be pi or codex');
  normalizeConfigurationScope(scope);
  const selected = scope === 'device' ? scopedConfiguration(config, scope) : config;
  let env, view;
  try {
    env = agentNetworkEnvironment(selected);
    if (agent === 'pi') {
      // A local custom catalog keeps precedence; an absent one can reuse the shared baseline.
      const metadataConfig = scope === 'project' && config.deviceHome && !hasLocalModelFile(config)
        ? scopedConfiguration(config, 'device') : selected;
      view = await discoverPiModelMetadata(metadataConfig);
    } else {
      const command = selected.env.LUSH_CODEX_COMMAND || 'codex';
      const models = codexModels(await commandOutput(command, ['debug', 'models'], env, scope === 'device' ? selected.home : selected.project || selected.home));
      check(models.length > 0, 'codex returned an empty model catalog');
      view = { agent, source: 'cli', models, warning: null };
    }
  } catch (error) { view = fallback(agent, new Error(redactNetworkText(env || {}, String(error?.message || error)))); }
  return { ...view, ...(config.deviceHome ? { configuration_scope: configurationScope(config, scope, scope === 'device' ? 'device' : 'mixed') } : {}) };
}
