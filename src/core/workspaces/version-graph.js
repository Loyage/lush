import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { check } from '../types.js';
import { runGit } from './code-io.js';

export const graphOID = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const secrets = new WeakMap();
const activeReaders = new WeakMap();
function mac(owner, text) {
  if (!secrets.has(owner)) secrets.set(owner, randomBytes(32));
  return createHmac('sha256', secrets.get(owner)).update(text).digest();
}
function encode(owner, value) {
  const text = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${text}.${mac(owner, text).toString('hex')}`;
}
function decode(owner, cursor, delivery) {
  check(typeof cursor === 'string' && cursor.length <= 2000 && /^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(cursor),
    'invalid version graph cursor; refresh the graph');
  const [text, signature] = cursor.split('.');
  check(timingSafeEqual(Buffer.from(signature, 'hex'), mac(owner, text)), 'expired or invalid version graph cursor; refresh the graph');
  let value; try { value = JSON.parse(Buffer.from(text, 'base64url').toString()); } catch {}
  check(value?.version === 1 && value.delivery === delivery && graphOID(value.tip)
    && Number.isSafeInteger(value.offset) && value.offset > 0 && Number.isSafeInteger(value.event_max) && value.event_max >= 0,
  'version graph cursor belongs to a different or invalid scope; refresh the graph');
  return value;
}

// Only identity/ref sampling uses the project's Git directory. History runs with a
// sterile config, no replace refs/grafts/shallow file, no filters, notes or lazy fetch.
async function reader(workspaces) {
  const { config } = workspaces, deadline = Date.now() + 15000;
  const identity = args => runGit(config, config.project, args, { deadline }).then(out => out.toString('utf8').trim());
  const common = fs.realpathSync(await identity(['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const format = await identity(['rev-parse', '--show-object-format']);
  check(['sha1', 'sha256'].includes(format), 'unsupported version graph object format');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-version-graph-'));
  try {
    fs.chmodSync(root, 0o700);
    const dir = path.join(root, 'git'); fs.mkdirSync(dir); fs.mkdirSync(path.join(dir, 'objects')); fs.mkdirSync(path.join(dir, 'refs'));
    fs.writeFileSync(path.join(dir, 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(dir, 'config'), `[core]\nrepositoryformatversion = ${format === 'sha256' ? 1 : 0}\nbare = true\n${format === 'sha256' ? '[extensions]\nobjectformat = sha256\n' : ''}`);
    const git = (args, options = {}) => runGit(config, root, args, { deadline,
      env: { GIT_DIR: dir, GIT_OBJECT_DIRECTORY: path.join(common, 'objects') }, ...options });
    return { git, identity, close() { fs.rmSync(root, { recursive: true, force: true }); } };
  } catch (error) { fs.rmSync(root, { recursive: true, force: true }); throw error; }
}
function parse(raw) {
  const fields = raw.toString('utf8').split('\0'), rows = [];
  for (let i = 0; i + 5 < fields.length; i += 5) {
    const commit = fields[i].replace(/^\n/, ''), parents = fields[i + 1] ? fields[i + 1].split(' ') : [];
    check(graphOID(commit) && parents.every(graphOID), 'invalid Git graph record');
    rows.push({ commit, short_commit: commit.slice(0, 12), parents, subject: fields[i + 2],
      author: { name: fields[i + 3] }, committed_at: fields[i + 4] });
  }
  return rows;
}

export const methods = {
  /** Internal fixed-object range only; public RPC never accepts these SHA fields. */
  async versionGraphPage({ delivery = null, tip, base = null, landed, parent_base = null, convergence = null, cursor, limit = 50, event_max = 0 } = {}) {
    check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, 'version graph limit must be 1..100');
    const snapshot = cursor === undefined ? null : decode(this, cursor, delivery);
    const active = activeReaders.get(this) ?? 0;
    check(active < 4, 'version graph reading is busy; retry later');
    activeReaders.set(this, active + 1);
    let read;
    try {
      read = await reader(this);
      if (delivery === null) {
        if (snapshot) tip = snapshot.tip;
        else {
          const refs = await read.identity(['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/heads/main']);
          tip = refs.split('\n').find(line => line.startsWith('refs/heads/main\0'))?.split('\0')[1] ?? null;
        }
        if (tip === null) return { tip: null, base: null, commits: [], cursor: null, has_more: false, event_max };
      }
      check(graphOID(tip), 'invalid fixed version graph tip');
      await read.git(['cat-file', '-e', `${tip}^{commit}`]);
      let exclude = [];
      if (delivery !== null) {
        check(graphOID(base) && graphOID(landed) && (parent_base === null || graphOID(parent_base)), 'delivery is not traceable: missing fixed range evidence');
        await read.git(['cat-file', '-e', `${base}^{commit}`]);
        const common = (await read.git(['merge-base', '--all', base, tip])).toString().trim().split('\n');
        check(common.length === 1 && common[0] === base, 'delivery is not traceable: development baseline is not an ancestor');
        const landing = parse(await read.git(['log', '--no-show-signature', '--no-notes', '--encoding=UTF-8', '--max-count=1',
          '--format=%H%x00%P%x00%s%x00%an%x00%cI%x00', landed, '--']))[0];
        check(landing?.commit === landed, 'delivery landing object is unavailable');
        if (parent_base === null) {
          check(landed !== tip && landing.parents.length === 1, 'delivery is not traceable: missing fixed parent baseline');
          parent_base = landing.parents[0];
        } else {
          check(parent_base === landed || landing.parents.length === 1 && landing.parents[0] === parent_base,
            'delivery is not traceable: parent baseline and landing disagree');
        }
        await read.git(['cat-file', '-e', `${parent_base}^{commit}`]);
        const sourceTree = (await read.git(['rev-parse', `${tip}^{tree}`])).toString().trim();
        const landedTree = (await read.git(['rev-parse', `${landed}^{tree}`])).toString().trim();
        if (convergence === null) {
          check(sourceTree === landedTree, 'delivery is not traceable: source and landing trees disagree');
        } else {
          // Project has bound the immutable shared receipt to this exact member. Verify objects
          // with the same sterile reader as legacy graphs: never trust replace refs or live tips.
          check(convergence.commit === landed && convergence.baseline === parent_base && graphOID(convergence.tree)
            && convergence.tree === landedTree && graphOID(convergence.evidence?.commit)
            && Array.isArray(convergence.members) && convergence.members.length > 0 && convergence.members.length <= 8
            && convergence.members.some(member => member.source === tip), 'delivery is not traceable: invalid convergence mapping');
          const evidence = convergence.evidence.commit;
          check((await read.git(['rev-parse', `${evidence}^{tree}`])).toString().trim() === landedTree,
            'delivery is not traceable: convergence evidence tree disagrees');
          for (const input of [parent_base, ...convergence.members.map(member => member.source)]) {
            check(graphOID(input), 'delivery is not traceable: invalid convergence input');
            await read.git(['merge-base', '--is-ancestor', input, evidence]);
          }
        }
        exclude = [...new Set([base, parent_base])];
      }
      check(!snapshot || snapshot.tip === tip && snapshot.base === base && JSON.stringify(snapshot.exclude) === JSON.stringify(exclude),
        'version graph cursor range changed; refresh the graph');
      const offset = snapshot?.offset ?? 0;
      event_max = snapshot?.event_max ?? event_max;
      const rows = parse(await read.git(['log', '--topo-order', '--no-show-signature', '--no-notes', '--no-decorate', '--encoding=UTF-8',
        `--skip=${offset}`, `--max-count=${limit + 1}`, '--format=%H%x00%P%x00%s%x00%an%x00%cI%x00', tip,
        ...exclude.map(sha => `^${sha}`), '--']));
      const has_more = rows.length > limit;
      return { tip, base, commits: rows.slice(0, limit), event_max,
        cursor: has_more ? encode(this, { version: 1, delivery, tip, base, exclude, event_max, offset: offset + limit }) : null, has_more };
    } finally {
      try { read?.close(); } finally { activeReaders.set(this, activeReaders.get(this) - 1); }
    }
  },
};
