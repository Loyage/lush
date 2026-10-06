import { check, id, text, TERMINAL } from '../types.js';
import { assertTaskAncestorsOpen } from './iteration.js';

const STATUSES = new Set(['draft','created','queued','running','waiting','awaiting','paused','awaiting_acceptance','completed','failed','cancelled','unknown']);
const MERGES = new Set(['merging','blocked','merged','none']);
const MAX_PARENTS = 2000;

export function expectedRevision(value) {
  check(value === null || (Number.isSafeInteger(value) && value > 0), 'expected_revision must be an explicit positive integer or null for a legacy draft');
  return value;
}
export function checkDraftRevision(draft, expected) {
  expectedRevision(expected);
  check(draft.input_id === null, `draft ${draft.id} was already submitted as input ${draft.input_id}`);
  check(draft.revision === expected, `draft ${draft.id} changed; reload its latest revision`);
}

export default {
  inputHistory({ cursor, limit = 50, q = '', status, integration } = {}) {
    check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, 'limit must be an integer from 1 to 100');
    check(typeof q === 'string' && q.length <= 1000, 'q must be text of at most 1000 characters');
    check(status === undefined || STATUSES.has(status), 'invalid input status');
    check(integration === undefined || MERGES.has(integration), 'invalid input integration filter');
    const filters = { q, status: status ?? null, integration: integration ?? null };
    let after = null;
    if (cursor !== undefined) {
      check(typeof cursor === 'string' && cursor.length > 0 && cursor.length <= 16384 && /^[A-Za-z0-9_-]+$/.test(cursor), 'invalid input history cursor');
      try { after = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { check(false, 'invalid input history cursor'); }
      check(after?.version === 1 && ['input','draft'].includes(after.kind)
        && typeof after.created_at === 'string' && after.created_at.length <= 64
        && Number.isSafeInteger(after.id) && after.id > 0
        && JSON.stringify(after.filters) === JSON.stringify(filters), 'invalid input history cursor or changed filters');
    }
    const rows = this.store.inputHistoryRows({ q, status, integration, cursor: after, limit });
    const more = rows.length > limit, items = rows.slice(0, limit), last = items.at(-1);
    const mounts = items.some(item => item.kind === 'draft') ? this.draftHookMountMap() : new Map();
    return { items: items.map(item => item.kind === 'draft' ? { ...item, hook_mount: mounts.get(item.id) ?? null } : item), next_cursor: more ? Buffer.from(JSON.stringify({ version: 1, created_at: last.created_at,
      kind: last.kind, id: last.id, filters })).toString('base64url') : null };
  },

  inputGet(kind, itemId) {
    check(['input','draft'].includes(kind), 'kind must be input or draft');
    const item = this.store.inputHistoryItem(kind, id(itemId));
    check(item, `${kind} ${itemId} not found or already submitted`);
    return { ...item, ...(kind === 'draft' ? { hook_mount: this.draftHookMount(item.id) } : {}),
      references: kind === 'draft' ? this.store.draftReferences(item.id) : this.store.inputReferences(item.id) };
  },

  /** Resolve identity when buffering, not the code baseline. No checkout is created here. */
  async inputParent(branch) {
    if (branch !== undefined) check(typeof branch === 'string' && branch.trim().length > 0 && branch.length <= 512, 'branch must be non-empty text (max 512 characters)');
    const target = branch ?? await this.workspaces.git(this.config.project, 'symbolic-ref', '--short', 'HEAD')
      .catch(() => { throw new Error('select a local parent branch before buffering from detached HEAD'); });
    if (target === 'main') await this.ensureMainTask();
    const parent = this.store.get("SELECT * FROM tasks WHERE branch=? AND task_kind IN ('main','owner','order','say')", target);
    check(parent, `branch ${target} needs an explicitly bound Worker`);
    this.assertInputParent(parent.id, target);
    await this.workspaces.git(this.config.project, 'show-ref', '--verify', `refs/heads/${target}`)
      .catch(() => { throw new Error(`local parent branch ${target} does not exist`); });
    return this.assertInputParent(parent.id, target);
  },

  assertInputParent(parentId, branch = undefined) {
    const parent = this.store.task(id(parentId));
    check(['main','owner','order'].includes(parent.task_kind) && parent.branch && (branch === undefined || parent.branch === branch)
      && !TERMINAL.has(parent.status), `parent worker #${parent.id} is no longer available; select an active parent Worker`);
    const record = this.store.branch(parent.branch);
    check(!record || !['deleted','archived'].includes(record.status), 'parent branch was deleted or archived; select another parent Worker');
    assertTaskAncestorsOpen(this, parent);
    return parent;
  },

  async inputParents() {
    const rows = this.store.all(`SELECT id,worker_number,branch,substr(goal,1,1000) AS goal FROM tasks
      WHERE task_kind IN ('main','owner','order','say') AND branch IS NOT NULL
        AND status NOT IN ('completed','failed','cancelled') ORDER BY id DESC LIMIT ?`, MAX_PARENTS + 1);
    check(rows.length <= MAX_PARENTS, `too many parent Worker candidates (limit ${MAX_PARENTS}); narrow the active parent set before selecting a parent`);
    const refs = new Set((await this.workspaces.git(this.config.project, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/')).split('\n'));
    const items = rows.filter(row => {
      if (!refs.has(row.branch)) return false;
      try { this.assertInputParent(row.id, row.branch); return true; } catch { return false; }
    });
    return { items: items.map(item => ({ ...item, freeze: this.branchFreeze(item.branch) })) };
  },

  addBufferedDraft(content, references = [], branch = undefined) {
    return this.write('buffer a draft', async () => {
      text(content, 'draft');
      const normalized = this.normalizeReferences(references);
      const parent = await this.inputParent(branch);
      this.assertWritable('buffer a draft');
      return this.store.transaction(() => {
        this.assertInputParent(parent.id, parent.branch);
        check(this.store.draftCount() < 500, 'too many buffered drafts; submit or remove some first');
        const draft = this.store.addDraft(content);
        this.store.run('UPDATE drafts SET parent_id=?,revision=1 WHERE id=?', parent.id, draft.id);
        this.store.setDraftReferences(draft.id, normalized);
        return this.inputGet('draft', draft.id);
      });
    });
  },

  updateBufferedDraft(draftId, content, references, branch, revision) {
    expectedRevision(revision);
    return this.write('edit a draft', async () => {
      text(content, 'draft');
      const draft = this.store.draft(id(draftId));
      check(!this.draftHookMount(draft.id), 'draft is mounted on a Hook; remove the mount before editing');
      checkDraftRevision(draft, revision);
      const normalized = references === undefined ? null : this.normalizeReferences(references);
      const parent = branch === undefined ? null : await this.inputParent(branch);
      this.assertWritable('edit a draft');
      return this.store.transaction(() => {
        checkDraftRevision(this.store.draft(draft.id), revision);
        if (parent) this.assertInputParent(parent.id, parent.branch);
        this.store.updateDraft(draft.id, content);
        if (parent) this.store.run('UPDATE drafts SET parent_id=? WHERE id=?', parent.id, draft.id);
        if (normalized !== null) this.store.setDraftReferences(draft.id, normalized);
        return this.inputGet('draft', draft.id);
      });
    });
  },

  removeBufferedDraft(draftId, revision) {
    this.assertWritable('remove a draft');
    return this.store.transaction(() => {
      const draft = this.store.draft(id(draftId));
      check(!this.draftHookMount(draft.id), 'draft is mounted on a Hook; remove the mount before deleting');
      checkDraftRevision(draft, revision);
      this.store.run('DELETE FROM drafts WHERE id=?', draft.id);
      return { id: draft.id };
    });
  },

  submitBufferedDraft(draftId, revision, start = true, defer = false, profile = null) {
    expectedRevision(revision);
    return this.order(undefined, null, [], id(draftId), start, revision, profile, defer);
  },
};
