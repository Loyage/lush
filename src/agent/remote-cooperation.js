import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CLI_COMMANDS, COMMAND_MODULES, LUSHC_PATHS, LUSHC_METHODS, cliHelp } from '../cli/catalog.js';
import { option } from '../cli/args.js';
import * as worker from '../cli/commands/task.js';
import * as progress from '../cli/commands/progress.js';
import * as notice from '../cli/commands/notice.js';
import * as branch from '../cli/commands/branch.js';
import * as skills from '../cli/commands/skills.js';
import { questionnaire } from '../core/questionnaire.js';

const MAX = 256 * 1024;
function requireValue(ok, message) { if (!ok) throw new Error(message); }
function privateDirectory(dir) {
  const st = fs.lstatSync(dir);
  requireValue(st.isDirectory() && !st.isSymbolicLink() && st.uid === process.getuid() && !(st.mode & 0o077)
    && fs.realpathSync(dir) === path.resolve(dir), 'Unsafe control directory');
}
function readBounded(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    requireValue(st.isFile() && st.size <= MAX, 'Control resource exceeds limit or is not a regular file');
    const data = Buffer.alloc(MAX + 1), count = fs.readSync(fd, data, 0, data.length, 0);
    requireValue(count <= MAX, 'Control resource exceeds limit');
    return data.subarray(0, count).toString('utf8');
  } finally { fs.closeSync(fd); }
}
/** Central-only control mapping: resources is {logicalId: absolute reviewed text file};
 * directory is an owner-only invocation directory. Only decision-WORKER.json is writable.
 * Paths come from the host, never the model. Resource registration is a trust boundary.
 */
export class RemoteControlResources {
  constructor({ resources = {}, directory }, workerId) {
    privateDirectory(directory);
    requireValue(resources && typeof resources === 'object' && !Array.isArray(resources)
      && Object.entries(resources).every(([id, file]) => id !== 'questionnaire' && id.length <= 128 && typeof file === 'string' && path.isAbsolute(file)), 'Invalid control resource mapping');
    this.directory = directory; this.resources = new Map(Object.entries(resources));
    this.questionFile = path.join(directory, `decision-${workerId}.json`);
  }
  access({ action, id, content, offset = 0, limit = 16000 }) {
    if (action === 'write') {
      requireValue(id === 'questionnaire' && typeof content === 'string' && Buffer.byteLength(content) <= MAX, 'Only bounded questionnaire writes are allowed');
      const value = JSON.parse(content); questionnaire('', value?.questions);
      privateDirectory(this.directory);
      const temporary = `${this.questionFile}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, JSON.stringify({ questions: value.questions }), { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, this.questionFile);
      } finally { fs.rmSync(temporary, { force: true }); }
      return { id, reference: 'control:questionnaire', written: true };
    }
    requireValue(action === 'read', 'Unknown control action');
    const file = id === 'questionnaire' ? this.questionFile : this.resources.get(id);
    requireValue(typeof file === 'string', 'Control resource is not allowlisted');
    requireValue(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit > 0 && limit <= 50000, 'Invalid control page');
    const text = readBounded(file), next_offset = Math.min(text.length, offset + limit);
    return { id, text: text.slice(offset, next_offset), next_offset, truncated: next_offset < text.length };
  }
  questionsFile(reference) {
    requireValue(reference === 'control:questionnaire', '--questions-file requires control:questionnaire');
    privateDirectory(this.directory);
    readBounded(this.questionFile); // no symlink/device/oversized file can reach CLI's reader
    return this.questionFile;
  }
}
const modules = { worker, progress, notice, branch, skills };
const handlers = new Map(Object.entries(modules).flatMap(([key, value]) => COMMAND_MODULES[key].map(name => [name, value.run])));
/** Real command handlers + shared parser/catalogue; never a generic local CLI subprocess.
 * cooperate({method,params,identity,token}) must invoke the real Dispatcher with this token;
 * it must not reinterpret the request as a user. authorize is rechecked before each RPC.
 */
export async function remoteCooperate(argv, { identity, token, authorize, cooperate, control }) {
  requireValue(Array.isArray(argv) && argv.length <= 128 && argv.every(v => typeof v === 'string' && !v.includes('\0'))
    && Buffer.byteLength(JSON.stringify(argv)) <= MAX, 'Invalid collaboration argv');
  const args = [...argv];
  requireValue(!args.some(v => v === '--project' || v.startsWith('--project=')), 'Project override is not allowed');
  const json = args.indexOf('--json'); if (json !== -1) args.splice(json, 1);
  if (!args.length || ['help', '--help', '-h'].includes(args[0]) || args.includes('--help') || args.includes('-h')) return cliHelp('lushc');
  const entry = CLI_COMMANDS.filter(e => !e.directory && e.path.split(' ').every((part, i) => args[i] === part))
    .sort((a, b) => b.path.length - a.path.length)[0];
  requireValue(entry && LUSHC_PATHS.has(entry.path), 'Command is not available through lushc');
  if (entry.path === 'notice post' && !args.includes('--worker')) args.push('--worker', String(identity.worker_id));
  if (entry.path === 'worker spawn' && !args.includes('--parent')) args.push('--parent', String(identity.worker_id));
  // Validate duplicate file flags before invoking the existing CLI parser/reader.
  if (args.includes('--questions-file')) {
    requireValue(['notice post', 'notice check'].includes(entry.path) && args.filter(a => a === '--questions-file').length === 1, 'Invalid questions file option');
    const reference = option(args, '--questions-file');
    args.push('--questions-file', control.questionsFile(reference));
  }
  const client = { token, request: (method, params = {}) => {
    requireValue(LUSHC_METHODS.has(method) && entry.rpc.includes(method), 'Collaboration RPC is not allowlisted');
    authorize();
    return cooperate({ method, params, identity, token });
  } };
  const command = args.shift();
  if (entry.path === 'status') {
    requireValue(args.length === 0, 'Invalid status arguments');
    return client.request('system.status');
  }
  const handler = handlers.get(command);
  requireValue(handler, 'Command handler is unavailable');
  return handler(command, args, { client, json: true, executable: 'lushc' });
}
