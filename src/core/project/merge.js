import { check, id } from '../types.js';
import { mergeOrder } from '../merge-batch.js';

/** 批准合并、批量合并、冲突收口与合并阶梯。 */
export default {
  /**
   * 用户明确批准合并。干净合并一键完成；**内容冲突是正常结局**：它变成一个专用任务加一条待决问题。
   * 冲突未解决期间同一目标分支上的合并被冻结：解冲突的产物要靠 --ff-only 原样落地，
   * main 一旦被别的合并推走，agent 测过的那棵树就不再是要落地的树。
   */
  async approveMerge(taskId) {
    const task = this.store.task(taskId);
    // 这条冲突不算冻结自己的三种情况：冲突就是我自己（重试）；我就是它现在的解冲突任务；它为当前这次落地服务。
    const frozen = this.store.conflictsOn(task.target_branch).filter(row => row.id !== task.id
      && row.resolves_task_id !== task.id && task.resolves_task_id !== row.id);
    const blocker = frozen[0];
    check(!blocker, blocker
      ? `merging into ${task.target_branch} is frozen by the unresolved conflict on #${blocker.id}; answer its notice, cancel its resolution task, or retry that merge first`
      : '');
    const result = await this.workspaces.merge(task.id);
    if (!result.conflict) {
      const resolvedTaskId = result.task.resolves_task_id;
      // 解冲突任务落地 = 原任务的提交也进了目标分支：两个任务一起收尾，冻结随之消失。
      if (resolvedTaskId) this.settleResolution(result.task);
      return { ...result.task, merge: resolvedTaskId ? { status: 'resolved', resolved_task_id: resolvedTaskId } : { status: 'merged' } };
    }
    return this.openResolution(result.task.id, result.conflict);
  },

  /**
   * 批量合并：用户一次选中多个任务，运行时按依赖顺序逐个走**同一个** approveMerge，
   * 不绕过它的任何门槛（资格、code 上游、冲突冻结），也绝不并行写主树。
   * 遇到第一个冲突或硬失败就停下：后续条目标 skipped，避免在未知现场上继续合并。
   * 顺序只看「本次选中集合内」的依赖边（code 与 order 都算先后），并列者按 id 升序——逻辑在 mergeOrder。
   */
  async approveMergeMany(ids) {
    check(Array.isArray(ids), 'ids must be an array of task ids');
    check(ids.length > 0, 'batch merge needs at least one task id');
    const unique = [...new Set(ids.map(value => id(value)))];
    check(unique.length <= 50, 'at most 50 tasks per batch merge');
    const ordered = mergeOrder(unique, this.store.edgesOf(unique));
    const merges = [];
    let stopped = null;
    const integrationOf = taskId => this.store.get('SELECT integration FROM tasks WHERE id=?', taskId)?.integration ?? 'none';
    for (const taskId of ordered) {
      if (stopped) {
        merges.push({ id: taskId, status: 'skipped', integration: integrationOf(taskId),
          error: `batch stopped at #${stopped.id}: ${stopped.reason}` });
        continue;
      }
      try {
        const result = await this.approveMerge(taskId);
        if (result.merge?.status === 'conflict') {
          const files = result.merge.files ?? [];
          stopped = { id: taskId, reason: `merge conflict on ${files.length ? files.join(', ') : 'unknown files'}` };
          merges.push({ id: taskId, status: 'conflict', integration: result.integration,
            resolution_task_id: result.merge.resolution_task_id, error: stopped.reason });
        } else {
          merges.push({ id: taskId, status: 'merged', integration: result.integration });
        }
      } catch (error) {
        stopped = { id: taskId, reason: error.message };
        merges.push({ id: taskId, status: 'failed', integration: integrationOf(taskId), error: error.message });
      }
    }
    return { merges, merged: merges.filter(row => row.status === 'merged').length, stopped };
  },

  /**
   * 内容冲突的收口：主树已经 abort 回合并前的干净状态，现在把「怎么并」变成一次用户决定。
   * 解冲突任务不在原任务的子树里（终态任务不允许有活动后代），用 resolves_task_id 关联；
   * 它的 worktree 以目标分支顶端为基线，agent 把那次审阅过的提交并进来解冲突，产物是一个合并提交，
   * 所以批准时能 --ff-only 落地：审阅过的树就是落地的树，不会再有第二轮冲突。
   * 任务先预置成 awaiting（不占并发槽、不烧 token），答复那条 notice 才开工，忽略则整件事撤销。
   */
  openResolution(taskId, conflict) {
    const task = this.store.task(taskId);
    check(['pending', 'review'].includes(task.integration), `#${task.id} is not waiting for a merge`);
    const active = this.store.activeResolver(task.id);
    check(!active, `resolution task #${active?.id} is still running; wait for it or cancel it before asking for another round`);
    const stale = this.store.unlandedResolver(task.id);
    const goal = `解决 #${task.id} 合并到 ${task.target_branch} 的冲突。\n`
      + `你的 worktree 以 ${task.target_branch} 的顶端为基线；把 #${task.id} 已审阅的提交 ${task.head_commit ?? task.branch}（分支 ${task.branch}）并进来，\n`
      + `解决下面这些冲突，提交这次 merge，然后跑能重复的测试证明并完的结果可用。只解决冲突，不要顺手重构或改与冲突无关的行为。\n`
      + `冲突文件：\n${conflict.files.map(file => `  ${file}`).join('\n')}\n\ngit：\n${conflict.output}`;
    const resolution = this.store.transaction(() => {
      const created = this.store.create({ parent_id: null, input_id: task.input_id, role: 'merger', goal,
        name: `resolve-${task.id}`, resolves_task_id: task.id });
      // 上一轮完成了却没落地（比如 main 前进导致 --ff-only 失败）：重试就是明确抛弃那一轮，
      // 但分支与 worktree 一律不删，只把它标成 superseded，让用户在可回收和可追溯之间自己选。
      if (stale) {
        this.store.update(stale.id, { integration: 'superseded' });
        this.store.event(stale.id, 'resolution.superseded', { by: created.id });
      }
      this.store.update(task.id, { integration: 'conflict', integration_error: conflict.output });
      this.store.event(task.id, 'merge.conflict', { resolution: created.id, target_branch: task.target_branch,
        commit: task.head_commit, files: conflict.files });
      return this.store.update(created.id, { status: 'awaiting', target_branch: task.target_branch });
    });
    const notice = this.notice(resolution.id, `#${task.id} 合并到 ${task.target_branch} 冲突：要开一个解冲突任务吗？`, [
      `冲突文件：\n${conflict.files.map(file => `  ${file}`).join('\n')}`,
      `git 的输出：\n${conflict.output}`,
      `${task.target_branch} 已经 abort 回合并前的干净状态，没有留下中间态。`,
      `答复任意内容：批准解冲突任务 #${resolution.id} 开工。它在自己的 worktree 里（基线＝${task.target_branch} 顶端）把 #${task.id} 已审阅的提交并进来、解冲突、跑测试，完成后由你决定要不要落地。`,
      `解冲突任务落地时用 --ff-only：落地的树就是它测过的那棵树，不会再冲突一次。`,
      `忽略这条问题：撤销 #${resolution.id}，#${task.id} 回到「待合并」。`,
      `在冲突解决之前，同一目标分支 ${task.target_branch} 上的其它合并会被冻结，防止 main 前进让解冲突的结果失效。`,
    ].join('\n\n'));
    return { ...task, integration: 'conflict', merge: { status: 'conflict', files: conflict.files,
      resolution_task_id: resolution.id, notice_id: notice.id, superseded_task_id: stale?.id ?? null } };
  },

  /** 解冲突任务落地：原任务的提交已经在目标分支里，两个任务一起标成已合并。 */
  settleResolution(resolution) {
    const target = this.store.task(resolution.resolves_task_id);
    if (target.integration === 'merged') return target;
    this.store.transaction(() => {
      this.store.update(target.id, { integration: 'merged', integration_error: null });
      this.store.event(target.id, 'merge.resolved', { via: resolution.id, commit: resolution.head_commit });
    });
    return this.store.task(target.id);
  },

  /** 解冲突任务的上下文：并谁、并到哪、冲突在哪几个文件。 */
  mergeConflictContext(task) {
    const target = this.store.task(task.resolves_task_id);
    const event = this.store.get("SELECT data FROM events WHERE task_id=? AND type='merge.conflict' ORDER BY id", target.id);
    return {
      conflicted_task: { id: target.id, goal: target.goal, name: target.name, result: target.result },
      branch: target.branch, commit: target.head_commit, target_branch: target.target_branch,
      files: event ? JSON.parse(event.data).files ?? [] : [],
    };
  },

  /**
   * 合并阶梯：未合并分支之间的依赖，以及"谁已经含了谁的提交"。
   * code 边是下游 worktree 的基线，runtime 要求上游先进目标分支才允许合下游；
   * order 边只要求上游终态，所以下游可以先合——那时它是否已经把上游带进来，只能问 git。
   * merge-base 的答案只取决于两个不可变 commit，所以缓存是准确的，不是过期近似。
   */
  async ladder() {
    const rows = this.store.all(`SELECT id, role, substr(goal,1,200) AS goal, branch, target_branch, head_commit, integration
      FROM tasks WHERE integration IN ('pending','review','conflict') ORDER BY id LIMIT 50`);
    const pendingIds = new Set(rows.map(row => row.id));
    const nodes = new Map(rows.map(row => [row.id, { id: row.id, role: row.role, goal: row.goal, branch: row.branch,
      target_branch: row.target_branch, integration: row.integration, deps: [], covered_by: [] }]));
    const head = new Map(this.store.all('SELECT id, branch, head_commit, integration FROM tasks').map(row => [row.id, row]));
    const edges = this.store.edgesOf([...pendingIds]);
    for (const id of pendingIds) {
      const node = nodes.get(id);
      for (const edge of edges.filter(row => row.task_id === id)) {
        const upstream = head.get(edge.depends_on) ?? {};
        // code 边＝下游 worktree 以它为基线，所以下游分支一定含上游提交；
        // order 边只保证顺序，含不含提交只能问 git。
        const contains = edge.kind === 'code' ? true : await this.containsCommit(upstream.head_commit, head.get(id)?.head_commit);
        node.deps.push({ id: edge.depends_on, kind: edge.kind, branch: upstream.branch ?? null,
          merged: upstream.integration === 'merged', pending: pendingIds.has(edge.depends_on), contains });
        // 只有 order 上游"可能已被带进来"：code 上游本来就必须先合，把它标成被覆盖会和 runtime 的守卫自相矛盾。
        if (edge.kind === 'order' && pendingIds.has(edge.depends_on) && contains) nodes.get(edge.depends_on).covered_by.push(id);
      }
    }
    for (const node of nodes.values()) node.covered_by = [...new Set(node.covered_by)];
    // 合并顺序只看 code 边：层级 = 必须先合的上游在它前面。order 边不改变顺序。
    const level = new Map();
    const depth = (taskId, seen = new Set()) => {
      if (level.has(taskId)) return level.get(taskId);
      if (seen.has(taskId)) return 0;
      seen.add(taskId);
      const codes = (nodes.get(taskId)?.deps ?? []).filter(dep => dep.kind === 'code' && dep.pending).map(dep => dep.id);
      const value = codes.length ? 1 + Math.max(...codes.map(dep => depth(dep, seen))) : 0;
      level.set(taskId, value); return value;
    };
    for (const id of pendingIds) depth(id);
    const pending = this.store.get("SELECT count(*) AS count FROM tasks WHERE integration IN ('pending','review')").count;
    return { target_branch: rows[0]?.target_branch ?? null, truncated: pending > rows.length,
      nodes: [...nodes.values()].map(node => ({ ...node, level: level.get(node.id) })) };
  },

  /** git merge-base --is-ancestor 的答案只取决于两个不可变 commit，缓存下来，轮询就不必反复跑 git。 */
  async containsCommit(upstream, downstream) {
    if (!upstream || !downstream || upstream === downstream) return false;
    const key = `${upstream}..${downstream}`;
    if (!this.ancestry.has(key)) this.ancestry.set(key, await this.workspaces.isAncestor(this.config.project, upstream, downstream));
    return this.ancestry.get(key);
  }
};
