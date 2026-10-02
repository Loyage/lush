import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { check } from '../types.js';
import { runGit } from './code-io.js';

const secrets = new WeakMap();
const oid = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
function secret(owner) { if (!secrets.has(owner)) secrets.set(owner, randomBytes(32)); return secrets.get(owner); }
function signature(owner, text) { return createHmac('sha256', secret(owner)).update(text).digest('hex'); }
function encode(owner, tip, next) {
  const text = Buffer.from(JSON.stringify({ version: 1, tip, next })).toString('base64url');
  return `${text}.${signature(owner, text)}`;
}
function decode(owner, cursor) {
  check(typeof cursor === 'string' && cursor.length <= 500 && /^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(cursor), 'invalid version history cursor; refresh the list');
  const [text, mac] = cursor.split('.');
  check(timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(signature(owner, text), 'hex')), 'expired or invalid version history cursor; refresh the list');
  let value; try { value = JSON.parse(Buffer.from(text, 'base64url').toString()); } catch {}
  check(value?.version === 1 && oid(value.tip) && oid(value.next), 'invalid version history cursor');
  return value;
}

/** Signed cursors only encode objects sampled from main's first-parent chain.
 * They retain that snapshot when main advances, and expire on daemon restart. */
export const methods = {
  async mainHistory({ cursor, limit = 50 } = {}) {
    check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, 'version history limit must be 1..100');
    const deadline = Date.now() + 15000;
    const git = (args, options = {}) => runGit(this.config, this.config.project, args, { deadline, ...options });
    const snapshot = cursor === undefined ? null : decode(this, cursor);
    let tip = snapshot?.tip;
    if (!tip) {
      // for-each-ref distinguishes absent refs from a broken/unreadable repository.
      const refs = (await git(['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/heads/main'])).toString().trim();
      const ref = refs.split('\n').find(line => line.startsWith('refs/heads/main\0'))?.split('\0')[1];
      if (!ref) return { branch: 'main', tip: null, commits: [], cursor: null, has_more: false };
      check(oid(ref) && !ref.includes('\n'), 'invalid main ref'); tip = ref;
    }
    const start = snapshot?.next ?? tip;
    const raw = (await git(['log', '--first-parent', '--no-show-signature', '--no-notes', '--encoding=UTF-8', `--max-count=${limit + 1}`,
      '--format=%H%x00%P%x00%s%x00%an%x00%cI%x00', start, '--'])).toString('utf8');
    const fields = raw.split('\0'), rows = [];
    // Git inserts a newline between formatted records; user text is never split on newlines.
    for (let i = 0; i + 5 < fields.length; i += 5) {
      const commit = fields[i].replace(/^\n/, ''), parents = fields[i + 1] ? fields[i + 1].split(' ') : [];
      check(oid(commit) && parents.every(oid), 'invalid Git history record');
      rows.push({ commit, short_commit: commit.slice(0, 12), parents, subject: fields[i + 2],
        author: { name: fields[i + 3] }, committed_at: fields[i + 4] });
    }
    const has_more = rows.length > limit, commits = rows.slice(0, limit);
    return { branch: 'main', tip, commits, cursor: has_more ? encode(this, tip, rows[limit].commit) : null, has_more };
  },
};
