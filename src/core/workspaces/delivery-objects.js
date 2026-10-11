import { check } from '../types.js';

export const convergenceOID = value => typeof value === 'string' && /^[0-9a-f]{40,64}$/.test(value);

async function collectObjects(stream) {
  const decoder = new TextDecoder(), conflicts = [];
  let tree = null, current = '';
  const consume = text => {
    const fields = text.split('\0');
    for (let i = 0; i < fields.length; i++) {
      current = (current + fields[i]).slice(0, 512);
      if (i !== fields.length - 1) {
        if (tree === null) tree = current;
        else if (current && conflicts.length < 100) conflicts.push(current);
        current = '';
      }
    }
  };
  for await (const chunk of stream) consume(decoder.decode(chunk, { stream: true }));
  consume(decoder.decode());
  return { tree, conflicts };
}

async function discard(stream) { for await (const chunk of stream) { /* no raw diagnostics retained */ } }

/** Immutable objects only. merge-tree respects multiple real bases when no explicit equivalent base is supplied. */
export const methods = {
  async mergeConvergenceObjects({ base = null, left, right, message, parents = null }) {
    check(convergenceOID(left) && convergenceOID(right) && (base === null || convergenceOID(base)), 'convergence requires fixed commits');
    check(typeof message === 'string' && message.trim() && message.length <= 65536, 'convergence requires a bounded commit message');
    const requestedParents = parents ?? [left, right];
    check(Array.isArray(requestedParents) && requestedParents.length > 0 && requestedParents.length <= 2
      && requestedParents.every(convergenceOID), 'invalid convergence object parents');
    const project = this.config.project;
    for (const commit of new Set([left, right, base, ...requestedParents].filter(Boolean))) {
      check(await this.git(project, 'rev-parse', '--verify', `${commit}^{commit}`) === commit, 'convergence input is not the exact commit');
    }
    const proc = Bun.spawn(['git', '-C', project, '-c', 'core.hooksPath=/dev/null', 'merge-tree', '--write-tree',
      '--name-only', '-z', '--no-messages', ...(base ? [`--merge-base=${base}`] : []), left, right], {
      stdout: 'pipe', stderr: 'pipe', env: { ...this.config.env, GIT_TERMINAL_PROMPT: '0' },
    });
    const [{ tree, conflicts }, , code] = await Promise.all([collectObjects(proc.stdout), discard(proc.stderr), proc.exited]);
    check((code === 0 || code === 1) && convergenceOID(tree), 'Git cannot compute the fixed convergence objects; check Git capability and inputs');
    const conflict = code === 1;
    // Even conflict seeds preserve both inputs. No ours/theirs fallback and no real checkout/index mutation.
    const actualParents = [...new Set(conflict ? [left, right] : requestedParents)];
    const commit = await this.git(project, '-c', 'user.name=Lush', '-c', 'user.email=lush@localhost',
      'commit-tree', tree, ...actualParents.flatMap(parent => ['-p', parent]), '-m', message);
    check(convergenceOID(commit), 'Git did not create a convergence object');
    return Object.freeze({ conflict, tree, commit, base, left, right,
      conflicts: Object.freeze(conflicts) });
  },
};
