import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_OUTPUT = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024;
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
      finish(new Error(`${path.basename(command)} resource discovery timed out`));
    }, TIMEOUT_MS);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT) {
        try { child.kill('SIGKILL'); } catch {}
        finish(new Error(`${path.basename(command)} resource catalog is too large`));
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', error => finish(error));
    child.on('close', code => finish(code === 0 ? null : new Error(`${path.basename(command)} exited ${code}: ${stderr.trim()}`), stdout));
  });
}

function realFile(value) {
  try {
    const resolved = fs.realpathSync(value);
    const stat = fs.statSync(resolved);
    return stat.isFile() ? resolved : null;
  } catch { return null; }
}

function addExtension(rows, value, source, label = '') {
  const file = realFile(value);
  if (!file || !['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'].includes(path.extname(file))) return;
  rows.set(file, { id: file, label: label || path.basename(file), source });
}

function extensionEntries(rows, root, source, labelPrefix = '') {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).slice(0, 500)) {
    const full = path.join(root, entry.name);
    if (entry.isFile()) addExtension(rows, full, source, labelPrefix ? `${labelPrefix} · ${entry.name}` : entry.name);
    else if (entry.isDirectory()) {
      for (const name of ['index.ts', 'index.js', 'index.mts', 'index.mjs', 'index.cts', 'index.cjs']) {
        if (fs.existsSync(path.join(full, name))) { addExtension(rows, path.join(full, name), source, labelPrefix ? `${labelPrefix} · ${entry.name}` : entry.name); break; }
      }
    }
  }
}

function skillInfo(file) {
  let body = '';
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    body = fs.readFileSync(file, 'utf8');
  } catch { return null; }
  const header = /^---\s*\n([\s\S]*?)\n---/.exec(body)?.[1] || '';
  const name = /^name:\s*["']?([^\n"']+)/m.exec(header)?.[1]?.trim();
  const description = /^description:\s*["']?([^\n"']+)/m.exec(header)?.[1]?.trim() || '';
  if (!name || !description) return null;
  return { name: name.slice(0, 128), description: description.slice(0, 500) };
}

function skillEntries(rows, root, source, depth = 0) {
  if (depth > 8 || !fs.existsSync(root) || rows.size >= 500) return;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  const skillFile = entries.find(entry => entry.isFile() && entry.name === 'SKILL.md');
  if (skillFile) {
    const file = realFile(path.join(root, skillFile.name));
    const info = file && skillInfo(file);
    if (file && info) rows.set(file, { id: file, label: info.name, description: info.description, source });
    return;
  }
  for (const entry of entries.slice(0, 500)) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) skillEntries(rows, full, source, depth + 1);
    else if (depth === 0 && entry.isFile() && path.extname(entry.name) === '.md') {
      const file = realFile(full), info = file && skillInfo(file);
      if (file && info) rows.set(file, { id: file, label: info.name, description: info.description, source });
    }
  }
}

function manifestPaths(root, values) {
  if (!Array.isArray(values)) return [];
  const included = new Set(), excluded = [];
  for (const raw of values) {
    if (typeof raw !== 'string' || !raw) continue;
    if (raw.startsWith('!')) { try { excluded.push(new Bun.Glob(raw.slice(1))); } catch {} continue; }
    if (raw.startsWith('-')) { excluded.push(path.resolve(root, raw.slice(1))); continue; }
    const value = raw.startsWith('+') ? raw.slice(1) : raw;
    const exact = path.resolve(root, value);
    if (raw.startsWith('+') || fs.existsSync(exact)) { included.add(exact); continue; }
    try {
      for (const match of new Bun.Glob(value).scanSync({ cwd: root, absolute: true, onlyFiles: false, dot: true })) {
        included.add(path.resolve(match));
        if (included.size >= 500) break;
      }
    } catch {}
  }
  return [...included].filter(value => !excluded.some(rule => typeof rule === 'string'
    ? value === rule : rule.match(path.relative(root, value).split(path.sep).join('/'))));
}

function packageEntries(extensions, skills, root, source) {
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch {}
  const pi = manifest?.pi;
  const extensionPaths = manifestPaths(root, pi?.extensions);
  const skillPaths = manifestPaths(root, pi?.skills);
  if (extensionPaths.length) for (const entry of extensionPaths) {
    const stat = (() => { try { return fs.statSync(entry); } catch { return null; } })();
    if (stat?.isDirectory()) extensionEntries(extensions, entry, source, source); else addExtension(extensions, entry, source, `${source} · ${path.basename(entry)}`);
  }
  else extensionEntries(extensions, path.join(root, 'extensions'), source, source);
  if (skillPaths.length) for (const entry of skillPaths) skillEntries(skills, entry, source);
  else skillEntries(skills, path.join(root, 'skills'), source);
}

function installedPackages(output) {
  const rows = [];
  let source = '';
  for (const line of output.split(/\r?\n/)) {
    const sourceMatch = /^  (\S.*)$/.exec(line);
    if (sourceMatch) { source = sourceMatch[1].trim(); continue; }
    const pathMatch = /^    (\S.*)$/.exec(line);
    if (source && pathMatch) rows.push({ source, root: pathMatch[1].trim() });
  }
  return rows.slice(0, 200);
}

/** Discover installed Pi extensions and skills without loading or executing them. */
export async function discoverAgentResources(config) {
  const extensions = new Map(), skills = new Map();
  const configDir = config.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
  extensionEntries(extensions, path.join(configDir, 'extensions'), '用户扩展');
  skillEntries(skills, path.join(configDir, 'skills'), '用户 Skills');
  skillEntries(skills, path.join(os.homedir(), '.agents', 'skills'), '用户 Skills');
  extensionEntries(extensions, path.join(config.project, '.pi', 'extensions'), '项目扩展');
  skillEntries(skills, path.join(config.project, '.pi', 'skills'), '项目 Skills');
  skillEntries(skills, path.join(config.project, '.agents', 'skills'), '项目 Skills');

  let warning = null;
  try {
    const command = config.env.LUSH_PI_COMMAND || 'pi';
    const output = await commandOutput(command, ['list'], config.env, config.project);
    for (const item of installedPackages(output)) packageEntries(extensions, skills, item.root, item.source);
  } catch (error) {
    warning = `无法读取 Pi 已安装包，仅显示本地目录资源：${String(error?.message || error).slice(0, 500)}`;
  }
  const sorted = values => [...values.values()].sort((a, b) => a.source.localeCompare(b.source) || a.label.localeCompare(b.label));
  return { agent: 'pi', extensions: sorted(extensions), skills: sorted(skills), warning };
}
