import fs from 'node:fs';
import path from 'node:path';
import { check, TERMINAL } from '../types.js';
import { buildForest, parentOf, childrenOf, ancestorsOf, descendantsOf, chainOf, rootOf, pruneHidden } from '../genealogy.js';
import { slugify } from '../naming.js';
import { sessionFiles } from '../transcript.js';

/** 分支谱系一次最多画这么多节点；超过就截断并在结果里说明（只读视图不该拖垮 daemon）。 */
export const BRANCH_NODE_LIMIT = 500;

/**
 * 只用只读 git 拿三件事实：本地分支顶端、当前检出分支、每个分支检在哪个 worktree。
 * 不 checkout、不 merge、不改 ref、不写 store，所以 `project.stopping === true` 时也能安全跑。
 * 非 git 项目不抛错：store 里的谱系记录本身就是有意义的历史，只是没有「现在还在不在」这一半信息。
 */
async function gitState(workspaces, project) {
  const empty = { git: false, error: null, current_branch: null, refs: new Map(), worktrees: new Map() };
  try {
    await workspaces.git(project, 'rev-parse', '--git-dir');
  } catch (error) {
    return { ...empty, error: `not a git repository: ${error.message}` };
  }
  try {
    let current_branch = null;
    try { current_branch = await workspaces.git(project, 'symbolic-ref', '--short', 'HEAD'); } catch { /* detached HEAD */ }
    // 一次 for-each-ref 拿全部分支顶端，避免每条分支各跑一次 rev-parse。
    const refs = new Map();
    for (const line of (await workspaces.git(project, 'for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads')).split('\n')) {
      const at = line.indexOf(' ');
      if (at > 0) refs.set(line.slice(0, at), line.slice(at + 1).trim());
    }
    // 分支检在哪个目录：`worktree list --porcelain` 是唯一权威来源，不靠路径拼接去猜。
    const worktrees = new Map();
    for (const block of (await workspaces.git(project, 'worktree', 'list', '--porcelain')).split(/\n\n+/)) {
      const path = /^worktree (.*)$/m.exec(block)?.[1] ?? null;
      const branch = /^branch refs\/heads\/(.*)$/m.exec(block)?.[1] ?? null;
      if (path && branch) worktrees.set(branch, path);
    }
    return { git: true, error: null, current_branch, refs, worktrees };
  } catch (error) {
    return { ...empty, git: true, error: error.message };
  }
}

/** 分支谱系：显式记录下来的「branch 从哪条 branch 创建」。不是 commit graph，也不是 AP 树。 */
export default {
  /** store 里的记录 ∪ 现在真实存在的本地分支，合成一个节点表；再交给纯逻辑拼森林。 */
  branchNodes(state) {
    const owners = new Map(this.store.all("SELECT id,branch FROM aps WHERE ap_kind IN ('main','owner') AND branch IS NOT NULL")
      .map(ap => [ap.branch, ap.id]));
    // A legacy branch row remains immutable; the explicit new owner is a current-view overlay.
    const rows = this.store.branches().map(row => owners.has(row.branch) ? { ...row, ap_id: owners.get(row.branch) } : row);
    // AP 可能已经被 clear 清空：谱系记录留着，AP 那一半信息就显示成「已清空」而不是消失。
    const apIds = new Set([...rows.map(row => row.ap_id), ...owners.values()].filter(id => id !== null));
    const aps = new Map([...apIds].map(id => [id,
      this.store.get('SELECT id, role, name, goal FROM aps WHERE id=?', id) ?? null]));
    const nodes = [];
    const seen = new Set();
    const push = (row, tracked) => {
      if (seen.has(row.branch)) return;
      seen.add(row.branch);
      const present = state.git ? state.refs.has(row.branch) : null;
      const ap = row.ap_id === null ? null : aps.get(row.ap_id) ?? null;
      const worktree = row.worktree ?? (state.git ? state.worktrees.get(row.branch) ?? null : null);
      nodes.push({
        branch: row.branch,
        parent: row.parent ?? null,
        parent_relation: row.parent_relation ?? null,
        created_from_commit: row.created_from_commit ?? null,
        ap_id: row.ap_id ?? null,
        ap_role: ap?.role ?? null,
        ap_name: ap?.name ?? null,
        ap_goal: ap ? String(ap.goal).slice(0, 120) : null,
        worktree, worktree_exists: worktree ? fs.existsSync(worktree) : null,
        created_at: row.created_at ?? null,
        tracked, status: row.status ?? null,
        present, head_commit: present === true ? state.refs.get(row.branch) : null,
        current: row.branch === state.current_branch,
        deleted: present === false,
      });
    };
    for (const row of rows) push(row, true);
    if (state.git) for (const name of state.refs.keys()) push({ branch: name, ap_id: owners.get(name) ?? null }, false);
    // 只被 parent 指针提到、自己既没记录也没 ref 的名字：也补一个节点，子分支不会从树上掉下去。
    // git 事实照旧现算（present=false），不替 git 编一个「还在」。
    for (const name of new Set(nodes.map(node => node.parent).filter(name => name && !seen.has(name)))) push({ branch: name }, false);
    return nodes;
  },

  /** branch.tree：谱系森林 + git 现状。默认把「有 ref 但没有记录」的分支也画出来（标 untracked）。
   *  归档的分支不再占分支树（它们是记录：`branch show` / 事件 / AP 详情里查），但不能连带藏掉它们的后代：
   *  把后代接到最近的非归档祖先上。 */
  async branchTree() {
    const state = await gitState(this.workspaces, this.config.project);
    const nodes = pruneHidden(this.branchNodes(state), node => node.status === 'archived');
    const limited = nodes.slice(0, BRANCH_NODE_LIMIT);
    return {
      generated_at: new Date().toISOString(), git: state.git, error: state.error,
      current_branch: state.current_branch, truncated: nodes.length > limited.length,
      count: nodes.length, roots: buildForest(limited),
    };
  },

  /**
   * 用户从分支图批准 direct child -> parent。唯一允许的落地方式是 fast-forward。
   * expected 传入时交付内容由这个固定 commit 决定：Candidate 接受走的就是这条路，
   * 分支在读到 tip 之后又前进也不会把未审阅的提交一起带上目标分支。
   */
  async approveBranchMerge(branch, expected = null, options = {}) {
    const name = String(branch ?? '').trim();
    check(name.length > 0 && name.length <= 512, 'branch name must be non-empty text');
    if (options.internal !== true) this.assertBranchWritable(name, 'merge it into its parent');
    const record = this.store.branch(name);
    check(record && record.parent && record.parent_relation === 'recorded', `${name} has no recorded direct parent`);
    check(!this.store.get("SELECT id FROM aps WHERE branch=? AND ap_kind IN ('main','owner','say','child')", name),
      'new AP branch cannot use legacy branch.merge');
    if (record.ap_id !== null) {
      const ap = this.store.get('SELECT * FROM aps WHERE id=?', record.ap_id);
      check(!ap?.ap_kind, 'new AP branches require parent confirmation or fixed-commit main approval; legacy branch.merge is unavailable');
      check(!ap || ap.status === 'completed', `branch AP #${record.ap_id} is not completed`);
    }
    const outcome = await this.workspaces.mergeBranch(name, expected);
    if (!outcome.merged && !outcome.already_integrated) return outcome;
    // 合并把父分支推进了，原先卡在「相关 AP 未完成 / 子分支未收拢」的预约可能已可启动。
    this.scheduleShowcaseSweep();
    const ap = record.ap_id === null ? null : this.store.get('SELECT * FROM aps WHERE id=?', record.ap_id);
    if (ap && ['pending','review','conflict','merging'].includes(ap.integration)) {
      this.store.transaction(() => {
        this.store.update(ap.id, { integration: 'merged', integration_error: null });
        this.store.event(ap.id, 'merged', { commit: outcome.landed ?? outcome.child_head, parent: outcome.parent,
          via: 'branch.graph', already_integrated: outcome.already_integrated === true });
      });
      await this.reconcileIntegrated(outcome.parent, ap.id);
    } else {
      const input = this.store.get('SELECT ap_id FROM inputs WHERE anchor_branch=?', name);
      if (input?.ap_id) this.store.event(input.ap_id, 'branch.merged', { branch: name, parent: outcome.parent,
        commit: outcome.landed ?? outcome.child_head, already_integrated: outcome.already_integrated === true });
    }
    return outcome;
  },

  /**
   * 分歧不在父分支上 no-ff：创建一个以 child 顶端为基线的 merger 分支，让 agent 把冻结的 parent commit
   * 合进来并测试。它完成后先 ff 回 child，再由用户把 child ff 到 parent，始终逐层沿直接谱系收敛。
   */
  async syncBranch(branch, options = {}) {
    const name = String(branch ?? '').trim();
    check(name.length > 0 && name.length <= 512, 'branch name must be non-empty text');
    check(!this.store.get("SELECT id FROM aps WHERE branch=? AND ap_kind IN ('main','owner','say','child')", name),
      'new AP branch cannot use legacy branch.sync');
    const state = await this.workspaces.branchState(name);
    check(state.status === 'diverged', `${name} is ${state.status}; branch sync is only needed after divergence`);
    check(state.blockers.length === 0, `sync ${name} is blocked by unfinished child work: ${state.blockers.join(', ')}`);
    const existing = this.store.get(`SELECT * FROM aps WHERE role='merger' AND resolves_ap_id IS NULL
      AND target_branch=? AND (status NOT IN ('completed','failed','cancelled') OR integration IN ('pending','review')) ORDER BY id DESC LIMIT 1`, name);
    // 已有的子侧 merger 就是这场解分歧本身：幂等地把它还回去，不再当「又发一次写操作」。
    if (existing) return { status: 'existing', ap: existing, branch: name, parent: state.parent };
    // 要新开一场解分歧才算写操作：冻结中的分支拒绝，一键合并自己走 internal 绕过。
    if (options.internal !== true) this.assertBranchWritable(name, 'sync it with its parent');
    const owner = this.store.branch(name);
    const ownerAP = owner?.ap_id === null ? null : this.store.get('SELECT input_id FROM aps WHERE id=?', owner.ap_id);
    const input = ownerAP?.input_id ?? this.store.get('SELECT id FROM inputs WHERE anchor_branch=?', name)?.id ?? null;
    const goal = `让子分支 ${name} 跟上它的直接父分支 ${state.parent}。\n`
      + `你的 worktree 从子分支提交 ${state.child_head} 创建。请执行 git merge ${state.parent_head}，`
      + `如有冲突，在子分支侧保留双方意图并解决；提交 merge commit，运行相关测试。不要 rebase、不要改父分支。`;
    const ap = this.store.transaction(() => {
      const created = this.store.create({ parent_id: null, input_id: input, role: 'merger', goal,
        name: `sync-${slugify(String(state.parent).split('/').at(-1), 28) || 'parent'}` });
      this.store.update(created.id, { base_commit: state.child_head, target_branch: name });
      this.store.event(created.id, 'branch.sync.requested', { child: name, parent: state.parent,
        child_commit: state.child_head, parent_commit: state.parent_head });
      return this.store.ap(created.id);
    });
    this.kick();
    return { status: 'queued', ap, branch: name, parent: state.parent,
      child_commit: state.child_head, parent_commit: state.parent_head };
  },

  /**
   * 归档一子树分支：删掉子树里每一条的 worktree 与本地 ref，但 AP 行、分支记录与 pi 会话文件都留着。
   * 传进来的那条是子树根：AP 分支是从输入锚点长出来的，只删一半会留下一批「父分支已不在」的后代，
   * 所以归档一条就是归档它整棵子树；已经归档／回收过的后代直接跳过。
   * 所有安全门在动 Git 之前同步跑完，任一不满足就抛错且无副作用；通过后由 Git 边界两遍执行（先检查、再删）。
   */
  /**
   * G-01：一条分支（及它的子树）当前真正的使用者。AP 不一定拥有 branch 字段——输入锚点由它的
   * planner 与尚未建分支的 queued worker 使用，verifier / candidate verifier 站在被检验对象的检出里。
   * 归档前用统一口径把「谁还在用这些 worktree / ref」问清楚，而不是只查 aps.branch。
   */
  branchResourceUsers(targets) {
    const names = [...new Set(targets)];
    const users = new Set();
    if (!names.length) return [...users];
    const placeholders = names.map(() => '?').join(',');
    for (const row of this.store.all(`SELECT id FROM aps WHERE branch IN (${placeholders})`, ...names)) users.add(row.id);
    for (const input of this.store.all(`SELECT id, ap_id FROM inputs WHERE anchor_branch IN (${placeholders})`, ...names)) {
      if (input.ap_id !== null && input.ap_id !== undefined) users.add(input.ap_id);
      // Only roles whose worktree is the input anchor actually hold it; coordinators/research run in the project root.
      for (const row of this.store.all(`SELECT id FROM aps WHERE input_id=?
        AND (role IN ('planner','worker','merger') OR ap_kind='say')`, input.id)) users.add(row.id);
    }
    // 检验别的 AP 或候选：被检验对象落在这些分支上时，verifier 的检出/对照都在用它们。
    for (const row of this.store.all(`SELECT id, verifies_ap_id, review_candidate_id FROM aps
      WHERE verifies_ap_id IS NOT NULL OR review_candidate_id IS NOT NULL`)) {
      if (row.verifies_ap_id) {
        const verified = this.store.get('SELECT branch FROM aps WHERE id=?', row.verifies_ap_id);
        if (verified && names.includes(verified.branch)) users.add(row.id);
      }
      if (row.review_candidate_id) {
        const candidate = this.store.get('SELECT branch FROM review_candidates WHERE id=?', row.review_candidate_id);
        if (candidate && names.includes(candidate.branch)) users.add(row.id);
      }
    }
    // 还把这条分支当作目标 / 对照的工作（merger、verifier）。
    for (const row of this.store.all(`SELECT id FROM aps WHERE target_branch IN (${placeholders})
      AND status NOT IN ('completed','failed','cancelled')`, ...names)) users.add(row.id);
    return [...users];
  },

  async archiveBranch(branch, { discard_worktree = false } = {}) {
    const name = String(branch ?? '').trim();
    check(name.length > 0 && name.length <= 512, 'branch name must be non-empty text');
    const record = this.store.branch(name);
    check(record, `${name} is not a registered branch; run 'lush branch import' first`);
    check(record.status !== 'archived' && record.status !== 'deleted', `branch ${name} is already ${record.status}`);
    // 已经归档／回收过的分支不再归档一次（记录已是终态），但也不拦着其余的。
    const targets = [name, ...descendantsOf(this.store.branches(), name)]
      .filter(target => this.store.branch(target)?.status === 'active');
    for (const target of targets) {
      const frozen = this.branchFreeze(target);
      // 允许用户显式归档一条已结束但未落地的解分歧分支：这是释放它留下的冻结的唯一清理动作。
      const own = frozen?.kind === 'resolution' && this.store.branch(target)?.ap_id === frozen.ap_id;
      const repair = own ? this.store.ap(frozen.ap_id) : null;
      if (!(own && TERMINAL.has(repair.status))) this.assertBranchWritable(target, 'archive it');
    }
    // 已发出未集成的请求：源分支就是那次交付本身，归档它会让父分支的交付锁永远没有落地对象。
    const requested = this.store.all(`SELECT t.id,t.branch,t.reservation FROM aps t
      WHERE t.ap_kind='say' AND t.reservation IS NOT NULL AND t.branch IN (${targets.map(() => '?').join(',')})`, ...targets)
      .filter(row => { try { const value = JSON.parse(row.reservation); return value?.kind === 'merge' && value.status === 'requested'; } catch { return false; } });
    check(requested.length === 0,
      `branch ${requested[0]?.branch} still has an outstanding merge request from say #${requested[0]?.id}; integrate or withdraw it before archiving`);
    const state = await gitState(this.workspaces, this.config.project);
    check(!targets.includes(state.current_branch), `cannot archive the branch currently checked out: ${state.current_branch}`);
    // 整棵子树上的 AP 都必须已终态：归档把这条分支的工作收起来，活还没完的状态不该被藏掉。
    const placeholders = targets.map(() => '?').join(',');
    const unfinished = this.store.all(`SELECT id, status FROM aps WHERE branch IN (${placeholders})
      AND status NOT IN ('completed','failed','cancelled') ORDER BY id`, ...targets);
    // Showcase APs have no aps.branch: their source branch lives in immutable JSON metadata. They still use
    // detached worktrees, so an active invocation must block archive and terminal ones must be reclaimed with it.
    const showcases = this.store.all(`SELECT * FROM aps WHERE role='showcase'
      AND json_extract(showcase,'$.branch') IN (${placeholders}) ORDER BY id`, ...targets);
    unfinished.push(...showcases.filter(ap => !TERMINAL.has(ap.status) || this.running.has(ap.id)));
    // G-01: branchless users (input-anchor planners, queued workers, verifiers) and terminal APs whose
    // invocation is still unwinding also hold the worktrees; archiving them would delete a live checkout.
    const users = new Set(this.branchResourceUsers(targets));
    for (const id of users) {
      const ap = this.store.get('SELECT id, status FROM aps WHERE id=?', id);
      if (ap && (!TERMINAL.has(ap.status) || this.running.has(ap.id))
        && !unfinished.some(row => row.id === ap.id)) unfinished.push(ap);
    }
    const cleaning = [...this.workspaces.busy].filter(id => users.has(id));
    check(cleaning.length === 0, `branch ${name} is being cleaned up (ap #${cleaning[0]})`);
    check(unfinished.length === 0, `branch ${name} still has unfinished aps: ${unfinished.map(ap => `#${ap.id}`).join(', ')}`);
    const showcaseCleanup = showcases.map(ap => ({ id: ap.id, status: ap.status,
      worktrees: [ap.workspace, ap.baseline_workspace].filter(dir => dir && fs.existsSync(dir)).length }));
    const outcomes = await this.workspaces.archiveBranches(targets, { discard_worktree, showcases });
    const tips = new Map(outcomes.map(outcome => [outcome.branch, outcome.tip]));
    // 目录已经删了，aps.workspace 不能再指着一个不存在的路径；branch 字段是历史，必须留着。
    const archived = this.store.all(`SELECT id, status, branch FROM aps WHERE branch IN (${placeholders}) ORDER BY id`, ...targets);
    // pi 会话文件在 <home>/sessions 下，不随 worktree 消失；把位置写进事件，将来 AP 行被 clear 掉也能查回。
    const sessions = [];
    const sessionsByBranch = new Map(targets.map(target => [target, []]));
    for (const ap of archived) {
      const files = sessionFiles(this.config, ap.id).map(file => path.join(this.config.home, 'sessions', file));
      sessions.push(...files);
      sessionsByBranch.get(ap.branch)?.push(...files);
    }
    this.store.transaction(() => {
      for (const ap of archived) {
        this.store.update(ap.id, { workspace: null });
        this.store.event(ap.id, 'branch.archived', { branch: ap.branch, tip: tips.get(ap.branch) ?? null, ap_id: ap.id });
      }
      // 每条被归档的分支各留一条事件（含会话文件位置）：这条分支的原始记录就算以后被 clear 掉也查得回。
      for (const target of targets) {
        // 归档即取消这条分支的效果展示预约；unreserveShowcase 自己写 showcase.unreserved。
        this.unreserveShowcase(target);
        const own = archived.filter(ap => ap.branch === target);
        const owner = own.some(ap => ap.id === this.store.branch(target)?.ap_id) ? this.store.branch(target).ap_id : own[0]?.id ?? null;
        this.store.event(owner, 'branch.archived', { branch: target, tip: tips.get(target) ?? null, sessions: sessionsByBranch.get(target) ?? [] });
      }
    });
    const root = outcomes.find(outcome => outcome.branch === name) ?? outcomes[0] ?? {};
    // 顶层 worktree / ref / tip / discarded 描述的是子树根（调用方问的那条）；整棵子树看 branches。
    this.kick(); // 被冻结的 queued Agent 可以在归档释放冻结后重新准入。
    return { branch: name, archived: true, count: outcomes.length, branches: outcomes,
      worktree: root.worktree ?? 'absent', ref: root.ref ?? 'absent', tip: root.tip ?? null, discarded: root.discarded === true,
      aps: archived.map(ap => ({ id: ap.id, status: ap.status })), sessions,
      showcases: showcaseCleanup, showcase_worktrees: showcaseCleanup.reduce((sum, ap) => sum + ap.worktrees, 0) };
  },

  /**
   * 用户从分支图让子分支跟上父分支（只允许 fast-forward）。它不改任何 AP 的 integration：
   * 只是把父分支已有的提交带进子分支，让下一次向上交付重新变成可 fast-forward。
   */
  async catchupBranch(branch, options = {}) {
    const name = String(branch ?? '').trim();
    check(name.length > 0 && name.length <= 512, 'branch name must be non-empty text');
    if (options.internal !== true) this.assertBranchWritable(name, 'catch it up with its parent');
    check(!this.store.get("SELECT id FROM aps WHERE branch=? AND ap_kind IN ('main','owner','say','child')", name),
      'new AP branch cannot use legacy branch.catchup');
    const record = this.store.branch(name);
    check(record && record.parent && record.parent_relation === 'recorded', `${name} has no recorded direct parent`);
    const outcome = await this.workspaces.catchupBranch(name);
    // 事件挂在「这条分支属于谁」上：有 AP 记在 AP 上，否则记在输入锚点的规划 AP 上（与 branch.merged 同口径）。
    const owner = record.ap_id === null ? null : this.store.get('SELECT id FROM aps WHERE id=?', record.ap_id);
    const host = owner?.id ?? this.store.get('SELECT ap_id FROM inputs WHERE anchor_branch=?', name)?.ap_id ?? null;
    if (host !== null) this.store.event(host, 'branch.caught_up', { branch: name, parent: outcome.parent,
      from: outcome.from, to: outcome.to, already_integrated: outcome.already_integrated === true });
    // 跟上父分支后，子分支上的预约可能重新变得可展示。
    this.scheduleShowcaseSweep();
    return outcome;
  },

  /** branch.show：一条分支的 parent / fork commit / AP / worktree，加上祖先链与后代。 */
  async branchShow(name) {
    const state = await gitState(this.workspaces, this.config.project);
    let branch = String(name ?? '').trim();
    check(branch.length > 0 && branch.length <= 512, 'branch name must be non-empty text');
    // 便利：允许用 ap id 查——分支名形如 lush/<hash>/<id>-<name>，手打太长。
    if (/^\d+$/.test(branch)) {
      const ap = this.store.ap(Number(branch));
      check(ap.branch, `AP #${ap.id} has no branch`);
      branch = ap.branch;
    }
    const nodes = this.branchNodes(state);
    const node = nodes.find(row => row.branch === branch);
    check(node, `branch ${branch} is neither recorded nor a local branch; 'lush branch import' registers existing branches`);
    return {
      ...node, parent: parentOf(nodes, branch), root: rootOf(nodes, branch),
      ancestors: ancestorsOf(nodes, branch), chain: chainOf(nodes, branch),
      children: childrenOf(nodes, branch), descendants: descendantsOf(nodes, branch),
    };
  },

  /**
   * branch.import：把现有本地分支登记成记录，让旧项目也能在树上看到全貌。
   * 只记两件**事实**——这条分支存在、它现在检在哪个 worktree；parent 一个字都不猜（记为 unknown）。
   */
  async branchImport() {
    const state = await gitState(this.workspaces, this.config.project);
    check(state.git, state.error ?? 'branch import needs a git repository');
    const known = new Set(this.store.branches().map(row => row.branch));
    const added = [];
    this.store.transaction(() => {
      for (const name of [...state.refs.keys()].sort()) {
        if (known.has(name)) continue;
        this.store.recordBranch({ branch: name, worktree: state.worktrees.get(name) ?? null });
        added.push(name);
      }
    });
    return { imported: added.length, branches: added, local: state.refs.size, recorded: known.size };
  },

  /**
   * 一句话摘要：给一条已登记分支写 / 更新人写的简述，分支图上的标题优先用它（没有时才回落派生）。
   * 只动 `branches.summary` 这一列，不碰 status / deleted_at / ref / worktree，也不改任何 AP。
   * 摘要内容（长度、空白归一）由 store.setBranchSummary 校验；分支没登记就报错，不自动补建记录。
   * 事件挂在「这条分支属于谁」上：有 AP 记在 AP 上，否则记在输入锚点的规划 AP 上（与 branch.caught_up 同口径）。
   */
  setBranchSummary(branch, summary) {
    const name = String(branch ?? '').trim();
    check(name.length > 0 && name.length <= 512, 'branch name must be non-empty text');
    const record = this.store.branch(name);
    check(record, `${name} is not a registered branch; run 'lush branch import' first`);
    const updated = this.store.setBranchSummary(name, summary);
    const host = record.ap_id ?? this.store.get('SELECT ap_id FROM inputs WHERE anchor_branch=?', name)?.ap_id ?? null;
    this.store.event(host, 'branch.summary', { branch: name, summary: updated.summary });
    return updated;
  },
};
