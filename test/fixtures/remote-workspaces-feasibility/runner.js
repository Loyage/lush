import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { TOOL_REGISTRY, TOOL_NAMES, authorize } from './registry.js';

const [entry, rootArgument] = process.argv.slice(2);
const pi = await import(pathToFileURL(entry).href);
const root = fs.realpathSync(rootArgument);
const emptyAgentDir = process.env.HOME;
const running = new Map();
const seen = new Set();
let binding, closing = false;
const send = frame => process.stdout.write(JSON.stringify(frame) + '\n');
const inside = value => value === root || value.startsWith(root + path.sep);
function codePath(input) {
  if (typeof input !== 'string' || input.includes('\0')) throw new Error('Denied: invalid path');
  const target = path.resolve(root, input);
  if (!inside(target)) throw new Error('Denied: path outside workspace');
  // Refuse symlink components, including dangling symlinks. Trusted shell is NOT an OS sandbox.
  let current = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Denied: symlink'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}
function context(cwd) {
  return pi.loadProjectContextFiles({ cwd, agentDir: emptyAgentDir }).filter(file => inside(file.path));
}
function killGroup(pid) {
  try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
function shellOperations(requestId) {
  return { exec: (command, cwd, { signal, onData, timeout }) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const child = spawn('/bin/bash', ['--noprofile', '--norc', '-c', command], {
      cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', HOME: emptyAgentDir, TMPDIR: emptyAgentDir },
    });
    let timedOut = false;
    const stop = () => { if (child.pid) killGroup(child.pid); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, Math.min(timeout ?? 5, 5) * 1000);
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.once('spawn', () => send({ event: 'command_started', id: requestId, pid: child.pid }));
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', stop);
      stop(); // Reap same-process-group background work even on a successful root exit.
      send({ event: 'command_stopped', id: requestId, pid: child.pid, code });
      if (signal?.aborted) reject(new Error('aborted; Runner stop observed'));
      else if (timedOut) reject(new Error('timeout; Runner stop observed'));
      else resolve({ exitCode: code ?? 1 });
    });
  }) };
}
async function shutdown() {
  closing = true;
  for (const execution of running.values()) execution.controller.abort();
  await Promise.allSettled([...running.values()].map(execution => execution.promise));
}
async function dispatch(frame) {
  authorize(frame, binding);
  if (frame.method === 'cancel') { running.get(frame.target)?.controller.abort(); return; }
  if (frame.method === 'shutdown') { await shutdown(); return { active: running.size }; }
  if (closing) throw new Error('Runner closing');
  if (seen.has(frame.id)) throw new Error('Duplicate request refused; no replay');
  seen.add(frame.id);
  if (frame.method === 'hello') return { pid: process.pid, root, tools: TOOL_NAMES, version: pi.VERSION };
  if (frame.method === 'context') return context(codePath(frame.cwd ?? '.'));
  if (frame.method !== 'tool') throw new Error('Denied: method not registered');
  // Serial workspace admission for this slice; production requires a persistent queue/lease.
  if (running.size) throw new Error('Workspace busy');
  const definition = TOOL_REGISTRY.find(tool => tool.name === frame.name);
  const args = { ...frame.args };
  let files = [];
  if (frame.name !== 'bash') {
    args.path = codePath(args.path);
    files = context(path.dirname(args.path));
  }
  const tool = pi[definition.factory](root, frame.name === 'bash'
    ? { operations: shellOperations(frame.id), exposeSessionEnvironment: false }
    : undefined);
  const controller = new AbortController();
  const promise = tool.execute(frame.id, args, controller.signal,
    update => send({ id: frame.id, update })).then(result => {
    if (files.length) result.content.push({ type: 'text', text: files.map(file =>
      `<project-context path=${JSON.stringify(file.path)}>\n${file.content}\n</project-context>`).join('\n') });
    return result;
  });
  running.set(frame.id, { controller, promise });
  send({ event: 'admitted', id: frame.id, tool: frame.name });
  try { return await promise; } finally { running.delete(frame.id); }
}
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  let frame;
  try { frame = JSON.parse(line); } catch { return; }
  if (!binding) {
    if (frame.method === 'bind' && frame.binding?.token) binding = frame.binding;
    else send({ id: frame.id, error: 'Missing binding' });
    return;
  }
  dispatch(frame).then(result => {
    if (frame.id) send({ id: frame.id, result });
  }, error => send({ id: frame.id, error: error.message }));
});
// Local pipe loss exercises a node-side watchdog path, not a claim about network leases.
input.on('close', async () => { await shutdown(); process.exit(0); });
