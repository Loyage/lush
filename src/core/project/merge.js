import { check, id } from '../types.js';
import { mergeOrder } from '../merge-batch.js';

/** 批准合并、按目标分支批量交付、冲突收口与交付队列。 */
export default {
  /**
   * 用户明确批准合并。干净合并一键完成；**内容冲突是正常结局**：它变成一个专用任务加一条待决问题。
   * 冲突未解决期间同一目标分支上的合并被冻结：解冲突的产物要靠 --ff-only 原样落地，
   * main 一旦被别的合并推走，agent 测过的那棵树就不再是要落地的树。
   */
  async approveMerge(taskId) {
    const task = this.store.task(taskId);
    // 原 worker 是稳定的交付身份：resolver 已完成且仍可快进时，单任务入口也自动落地 resolver。
    // 若目标分支已经前进则不映射，继续走原任务重试语义：旧 resolver 会被标为 superseded，再开新一轮。
    if (task.integration === 'conflict' && !task.resolves_task_id) {
      const active = this.store.activeResolver(task.id);
      check(!active, `resolution task #${active?.id} is still active; finish or cancel it before retrying merge #${task.id}`);
      const ready = this.store.unlandedResolver(task.id);
      if (ready) {
        const source = this.store.task(ready.id);
        const canFastForward = source.status === 'completed' && ['pending','review'].includes(source.integration)
          && source.head_commit && source.target_branch
          && await this.workspaces.isAncestor(this.config.project, `refs/heads/${source.target_branch}`, source.head_commit);
        if (canFastForward) return this.approveMerge(source.id);
      }
    }
    // 这条冲突不算冻结自己的三种情况：冲突就是我自己（重试）；我就是它现在的解冲突任务；它为当前这次落地服务。
    const frozen = this.store.conflictsOn(task.target_branch).filter(row => row.id !== task.id
      && row.resolves_task_id !== task.id && task.resolves_task_id !== row.id);
    const blocker = frozen[0];
    check(!blocker, blocker
      ? `merging into ${task.target_branch} is frozen by the unresolved conflict on #${blocker.id}; answer its notice, cancel its resolution task, or retry that merge first`
      : '');
    const result = await this.workspaces.merge(task.id);
    if (result.diverged) {
      const sync = await this.syncBranch(result.task.branch);
      return { ...result.task, merge: { status: 'diverged', parent: result.diverged.parent,
        child: result.diverged.child, sync_task_id: sync.task.id } };
    }
    if (!result.conflict) {
      const resolvedTaskId = result.task.resolves_task_id;
      // 解冲突任务落地 = 原任务的提交也进了目标分支：两个任务一起收尾，冻结随之消失。
      if (resolvedTaskId) this.settleResolution(result.task);
      // 某个分支可能把另一个待交付提交一起带进目标分支。数据库必须跟 Git 事实收敛，
      // 否则 UI 会永远留下一个实际上已经落地的“待合并”幽灵项。
      const included = await this.reconcileIntegrated(result.task.target_branch, result.task.id);
      const merge = resolvedTaskId ? { status: 'resolved', resolved_task_id: resolvedTaskId } : { status: 'merged' };
      if (included.length) merge.included_task_ids = included;
      return { ...result.task, merge };
    }
    return this.openResolution(result.task.id, result.conflict);
  },

  /**
   * 批量交付：先把稳定的原任务映射到真正来源（普通 worker 或完成的 resolver），并预检同一目标分支；
   * 然后只按 code 基线顺序逐个走同一个 approveMerge。order 只约束执行，不参与交付排序。
   * 遇到第一个运行期冲突或硬失败就停下：后续条目标 skipped，避免在未知现场上继续合并。
   */
  async approveMergeMany(ids) {
    check(Array.isArray(ids), 'ids must be an array of task ids');
    check(ids.length > 0, 'batch merge needs at least one task id');
    const requested = [...new Set(ids.map(value => id(value)))];
    check(requested.length <= 50, 'at most 50 tasks per batch merge');

    // 批量入口接收稳定的“原任务 id”。若它已有完成但未落地的 resolver，真正应落地的是
    // resolver 的分支，而不是按较小的原任务 id 先重试并作废已有成果。
    const entries = [];
    const seenSources = new Set();
    for (const requestedId of requested) {
      const original = this.store.task(requestedId);
      let source = original;
      if (original.integration === 'conflict' && !original.resolves_task_id) {
        const active = this.store.activeResolver(original.id);
        check(!active, `resolution task #${active?.id} is still active; finish or cancel it before batch merging #${original.id}`);
        const ready = this.store.unlandedResolver(original.id);
        if (ready) source = this.store.task(ready.id);
      }
      check(source.status === 'completed' && ['pending','review','conflict'].includes(source.integration),
        `#${source.id} is not a completed merge candidate`);
      if (seenSources.has(source.id)) continue;
      seenSources.add(source.id);
      entries.push({ id: requestedId, source_id: source.id, target_branch: source.target_branch });
    }
    const targets = [...new Set(entries.map(entry => entry.target_branch))];
    check(targets.length === 1, `batch merge must target one branch; selected: ${targets.join(', ')}`);
    await this.workspaces.preflightMerge(entries.map(entry => this.store.task(entry.source_id)));

    // 在动主树之前检查集合外的 code 上游。集合内上游由拓扑顺序保证；order 只约束执行，
    // 不再偷偷改变交付顺序。
    const stableIds = entries.map(entry => entry.id);
    const selected = new Set(stableIds);
    for (const entry of entries) {
      // 依赖属于稳定的原任务；即使该项实际通过 resolver 落地，下游仍依赖那个原任务。
      for (const edge of this.store.deps(entry.id).filter(edge => edge.kind === 'code')) {
        if (selected.has(edge.depends_on)) continue;
        const upstream = this.store.task(edge.depends_on);
        check(upstream.head_commit && await this.workspaces.isAncestor(this.config.project, upstream.head_commit, `refs/heads/${entry.target_branch}`),
          `batch preflight: code dependency #${upstream.id} is not merged into ${entry.target_branch}; include it or merge it first`);
      }
    }
    const orderedIds = mergeOrder(stableIds, this.store.edgesOf(stableIds));
    const byId = new Map(entries.map(entry => [entry.id, entry]));
    const ordered = orderedIds.map(taskId => byId.get(taskId));
    const merges = [];
    let stopped = null;
    const integrationOf = taskId => this.store.get('SELECT integration FROM tasks WHERE id=?', taskId)?.integration ?? 'none';
    for (const entry of ordered) {
      const taskId = entry.source_id;
      const identity = { id: entry.id, ...(taskId === entry.id ? {} : { source_task_id: taskId }) };
      if (stopped) {
        merges.push({ ...identity, status: 'skipped', integration: integrationOf(taskId),
          error: `batch stopped at #${stopped.id}: ${stopped.reason}` });
        continue;
      }
      try {
        // 前一项可能已经把这个提交一起带进目标分支，并由 reconcileIntegrated 收口。
        if (integrationOf(taskId) === 'merged') {
          merges.push({ ...identity, status: 'merged', integration: 'merged', included: true });
          continue;
        }
        const result = await this.approveMerge(taskId);
        if (result.merge?.status === 'conflict') {
          const files = result.merge.files ?? [];
          stopped = { id: entry.id, reason: `merge conflict on ${files.length ? files.join(', ') : 'unknown files'}` };
          merges.push({ ...identity, status: 'conflict', integration: result.integration,
            resolution_task_id: result.merge.resolution_task_id, error: stopped.reason });
        } else if (result.merge?.status === 'diverged') {
          stopped = { id: entry.id, reason: `branch diverged from ${result.merge.parent}; sync task #${result.merge.sync_task_id} created` };
          merges.push({ ...identity, status: 'diverged', integration: result.integration,
            sync_task_id: result.merge.sync_task_id, error: stopped.reason });
        } else {
          merges.push({ ...identity, status: 'merged', integration: result.integration,
            included_task_ids: result.merge?.included_task_ids ?? [] });
        }
      } catch (error) {
        stopped = { id: entry.id, reason: error.message };
        merges.push({ ...identity, status: 'failed', integration: integrationOf(taskId), error: error.message });
      }
    }
    return { target_branch: targets[0], merges, merged: merges.filter(row => row.status === 'merged').length, stopped };
  },

  /** 成功落地后让“已被一并带入”的普通 worker 与 Git 事实收敛；resolver 仍由 settleResolution 专门结算。 */
  async reconcileIntegrated(targetBranch, viaTaskId) {
    if (!targetBranch) return [];
    const candidates = this.store.all(`SELECT id,head_commit FROM tasks
      WHERE target_branch=? AND resolves_task_id IS NULL AND integration IN ('pending','review') AND head_commit IS NOT NULL ORDER BY id`, targetBranch);
    const included = [];
    for (const candidate of candidates) {
      if (candidate.id === viaTaskId) continue;
      if (!await this.workspaces.isAncestor(this.config.project, candidate.head_commit, `refs/heads/${targetBranch}`)) continue;
      this.store.transaction(() => {
        this.store.update(candidate.id, { integration: 'merged', integration_error: null });
        this.store.event(candidate.id, 'merge.included', { via: viaTaskId, commit: candidate.head_commit, target_branch: targetBranch });
      });
      included.push(candidate.id);
    }
    return included;
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
   * 交付队列：兼容 nodes 保留分支依赖图，groups 则按目标分支给出稳定原任务、当前来源、阶段与 blockers。
   * code 边是下游 worktree 的基线，必须先落地上游；order 只要求执行时上游终态，不参与交付排序。
   * 两个不可变 commit 的包含关系可以缓存；目标分支是否已含 code 上游必须实时询问 Git。
   */
  async ladder() {
    const rows = this.store.all(`SELECT id, input_id, role, status, agent_wakes, resolves_task_id, substr(goal,1,200) AS goal,
      branch, target_branch, head_commit, integration
      FROM tasks WHERE resolves_task_id IS NULL AND integration IN ('pending','review','conflict') ORDER BY id LIMIT 50`);
    const pendingIds = new Set(rows.map(row => row.id));
    const nodes = new Map(rows.map(row => [row.id, { id: row.id, role: row.role, goal: row.goal, branch: row.branch,
      target_branch: row.target_branch, integration: row.integration, deps: [], covered_by: [] }]));
    const edges = this.store.edgesOf([...pendingIds]);
    const upstreamIds = [...new Set(edges.map(edge => edge.depends_on))];
    const related = pendingIds.size ? this.store.all(`SELECT id,input_id,role,status,agent_wakes,resolves_task_id,branch,target_branch,head_commit,integration
      FROM tasks WHERE (resolves_task_id IN (${[...pendingIds].map(() => '?').join(',')})
        AND (status NOT IN ('completed','failed','cancelled') OR (status='completed' AND integration IN ('pending','review'))))${upstreamIds.length
        ? ` OR id IN (${upstreamIds.map(() => '?').join(',')})` : ''} ORDER BY id`, ...pendingIds, ...upstreamIds) : [];
    // The delivery queue needs only its bounded pending rows, their resolver attempts and direct dependency heads.
    const allTasks = [...new Map([...rows, ...related].map(task => [task.id, task])).values()];
    const head = new Map(allTasks.map(row => [row.id, row]));
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
    const legacyNodes = [...nodes.values()].map(node => ({ ...node, level: level.get(node.id) }));

    // 交付队列以“原始变更任务”为稳定身份；resolver 只是它当前的落地来源，不再与原任务并列成两个候选。
    // 这层完全从现有 task/关联边派生，不引入新的持久化实体。
    let currentBranch = null;
    try { currentBranch = await this.workspaces.git(this.config.project, 'symbolic-ref', '--short', 'HEAD'); } catch { /* 非 Git 项目 */ }
    const conflictRows = rows.filter(task => task.integration === 'conflict');
    const attemptsByTarget = new Map();
    for (const task of related.filter(task => task.resolves_task_id !== null)) {
      if (!attemptsByTarget.has(task.resolves_task_id)) attemptsByTarget.set(task.resolves_task_id, []);
      attemptsByTarget.get(task.resolves_task_id).push(task);
    }
    for (const attempts of attemptsByTarget.values()) attempts.sort((a, b) => b.id - a.id);
    const items = [];
    for (const row of rows.filter(task => !task.resolves_task_id)) {
      const attempts = attemptsByTarget.get(row.id) ?? [];
      const active = attempts.find(task => !['completed','failed','cancelled'].includes(task.status)) ?? null;
      const readyResolution = attempts.find(task => task.status === 'completed' && ['pending','review'].includes(task.integration)) ?? null;
      const source = readyResolution ?? row;
      let phase = row.integration === 'review' ? 'review_required' : 'awaiting_review';
      if (row.integration === 'conflict') {
        if (readyResolution) {
          const canFastForward = readyResolution.head_commit && readyResolution.target_branch
            ? await this.workspaces.isAncestor(this.config.project, `refs/heads/${readyResolution.target_branch}`, readyResolution.head_commit) : false;
          phase = canFastForward ? 'resolution_ready' : 'resolution_stale';
        } else if (active) phase = active.status === 'awaiting' && active.agent_wakes === 0 ? 'conflict_decision' : 'resolving';
        else phase = 'conflict_decision';
      }
      const blockers = [];
      // 新输入按 direct-parent 从叶子向根交付；任务还有未收拢 child，或它与 parent 已分歧时，
      // 交付队列不能沿用旧的“上游先落地”提示。具体收敛动作在分支图上完成。
      if (source.input_id && source.branch && !readyResolution) {
        try {
          const branchState = await this.workspaces.branchState(source.branch);
          if (branchState.blockers.length) blockers.push({ code: 'branch_children',
            message: `先收拢直接子分支/任务：${branchState.blockers.join('、')}` });
          if (branchState.status === 'diverged') blockers.push({ code: 'branch_diverged',
            message: `与直接父分支 ${branchState.parent} 已分歧；请到分支图在子侧同步` });
          if (branchState.status === 'missing') blockers.push({ code: 'branch_missing', message: '子分支或直接父分支不存在' });
        } catch (error) { blockers.push({ code: 'branch_invalid', message: error.message }); }
      }
      if (phase === 'conflict_decision') blockers.push({ code: 'conflict_decision', task_id: active?.id ?? null,
        message: active ? `决定是否启动解冲突任务 #${active.id}` : '需要重新发起解冲突' });
      if (phase === 'resolving') blockers.push({ code: 'resolution_active', task_id: active.id,
        message: `解冲突任务 #${active.id} 正在处理` });
      if (phase === 'resolution_stale') blockers.push({ code: 'resolution_stale', task_id: readyResolution.id,
        message: `目标分支已前进；废弃解冲突结果 #${readyResolution.id} 后重新处理` });
      const foreign = conflictRows.find(conflict => conflict.target_branch === source.target_branch
        && conflict.id !== row.id && conflict.id !== source.resolves_task_id && conflict.resolves_task_id !== source.id);
      if (foreign) blockers.push({ code: 'frozen', task_id: foreign.id, message: `#${foreign.id} 的冲突冻结了 ${source.target_branch}` });
      // resolver 的基线已经是目标分支并含原提交；普通 code 栈仍必须先落地上游。
      if (!readyResolution) for (const dep of nodes.get(row.id)?.deps?.filter(edge => edge.kind === 'code') ?? []) {
        const upstream = head.get(dep.id);
        const landed = upstream?.head_commit && source.target_branch
          ? await this.workspaces.isAncestor(this.config.project, upstream.head_commit, `refs/heads/${source.target_branch}`) : false;
        if (!landed) blockers.push({ code: 'code_upstream', task_id: dep.id, message: `先把基线任务 #${dep.id} 落地` });
      }
      items.push({ id: row.id, source_task_id: source.id, role: row.role, goal: row.goal,
        branch: source.branch, target_branch: source.target_branch, integration: row.integration, source_integration: source.integration,
        phase, ready: blockers.length === 0 && ['awaiting_review','review_required','resolution_ready'].includes(phase), blockers,
        resolver: active ?? readyResolution, deps: nodes.get(row.id)?.deps ?? [], covered_by: nodes.get(row.id)?.covered_by ?? [],
        level: level.get(row.id) ?? 0 });
    }
    // code_upstream 是“单项现在不能合”，但若同一批把完整上游栈一起选中，运行时可以按拓扑依次落地。
    // selectable 与 ready 分开，避免为了表达 blocker 而把整条变更栈永远禁选。
    const itemById = new Map(items.map(item => [item.id, item]));
    const canSelect = (item, seen = new Set()) => {
      if (!item || seen.has(item.id) || !['awaiting_review','review_required','resolution_ready'].includes(item.phase)) return false;
      if (item.blockers.some(blocker => blocker.code !== 'code_upstream')) return false;
      seen.add(item.id);
      return item.blockers.filter(blocker => blocker.code === 'code_upstream')
        .every(blocker => {
          const upstream = itemById.get(blocker.task_id);
          return upstream?.target_branch === item.target_branch && canSelect(upstream, new Set(seen));
        });
    };
    for (const item of items) item.selectable = canSelect(item);

    const grouped = new Map();
    for (const item of items) {
      const target = item.target_branch ?? '(未知目标分支)';
      if (!grouped.has(target)) grouped.set(target, []);
      grouped.get(target).push(item);
    }
    const groups = [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([target_branch, groupItems]) => ({
      target_branch, current: target_branch === currentBranch, items: groupItems,
      ready: groupItems.filter(item => item.ready).length,
      selectable: groupItems.filter(item => item.selectable).length,
    }));
    const last = rows.at(-1)?.id ?? null;
    const truncated = rows.length === 50 && Boolean(this.store.get(`SELECT id FROM tasks
      WHERE resolves_task_id IS NULL AND integration IN ('pending','review','conflict') AND id>? ORDER BY id LIMIT 1`, last));
    return { target_branch: rows[0]?.target_branch ?? null, current_branch: currentBranch, truncated,
      nodes: legacyNodes, groups };
  },

  /** git merge-base --is-ancestor 的答案只取决于两个不可变 commit，缓存下来，轮询就不必反复跑 git。 */
  async containsCommit(upstream, downstream) {
    if (!upstream || !downstream || upstream === downstream) return false;
    const key = `${upstream}..${downstream}`;
    if (!this.ancestry.has(key)) this.ancestry.set(key, await this.workspaces.isAncestor(this.config.project, upstream, downstream));
    return this.ancestry.get(key);
  }
};
