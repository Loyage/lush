import { check, id, text, TERMINAL } from '../types.js';
import fs from 'node:fs';
import { readInputRule, saveInputRule, snapshotPath } from '../ap-input-rule.js';

function storedReservation(raw) {
  if (raw === null) return null;
  let value;
  try { value = JSON.parse(raw); }
  catch { throw new Error('reservation state is invalid; inspect AP before changing it'); }
  check(value && typeof value === 'object' && !Array.isArray(value) && value.version === 1
    && ['merge','showcase'].includes(value.kind) && typeof value.status === 'string',
  'reservation state is invalid; inspect AP before changing it');
  return value;
}

/** 请求失效的唯一诊断文案：三个触发点（父分支自己提交 / 集成 / 批准）说同一句话，才不会被去重成多条事件。 */
function assertQuietResolutionParent(project, parent) {
  check(!project.running.has(parent.id) && !['running', 'queued'].includes(parent.status),
    `父 AP #${parent.id} 尚未到安全点；等待当前 Agent 调用结束后再冻结并派解分歧 AP`);
}

function parentMovedReason(branch, parentHead, commit) {
  return `父分支 ${branch} 在本请求发出后被推进到 ${String(parentHead).slice(0, 12)}，`
    + `固定提交 ${String(commit).slice(0, 12)} 已不能快进：撤销这个请求（AP、分支与提交保留），`
    + `或先把该固定提交合入 ${branch} 再确认集成。`;
}

/** New ap-owned input path. Legacy input.submit and draft.commit remain readable and executable. */
export default {
  /** Bootstrap only when the project's local main ref already exists; never create or guess a ref. */
  async bootstrapMain() {
    try { await this.workspaces.git(this.config.project, 'show-ref', '--verify', 'refs/heads/main'); }
    catch { return null; }
    return this.ensureMainAP();
  },

  /** A stable logical root; no provider invocation is started merely by creating it. */
  async ensureMainAP() {
    const existing = this.store.all("SELECT * FROM aps WHERE ap_kind='main' AND branch='main' ORDER BY id");
    check(existing.length <= 1, 'main branch has more than one owning AP');
    if (existing.length) return existing[0];
    let commit = null;
    try {
      await this.workspaces.git(this.config.project, 'show-ref', '--verify', 'refs/heads/main');
      commit = await this.workspaces.git(this.config.project, 'rev-parse', '--verify', 'refs/heads/main^{commit}');
    } catch { /* no local main ref */ }
    check(commit, 'the new say protocol needs a local main branch; no branch was created automatically');
    return this.store.transaction(() => {
      const root = this.store.create({ role: 'agent', goal: '管理 main 分支及子 AP 合并请求', name: 'main', ap_kind: 'main' });
      this.store.update(root.id, { status: 'waiting', branch: 'main', base_commit: commit, head_commit: commit });
      this.store.event(root.id, 'main.bound', { branch: 'main', commit });
      return this.store.ap(root.id);
    });
  },

  /** User-confirmed ownership for an existing local branch. Do not rewrite a legacy ap/branch row. */
  async bindBranch(branch, commit) {
    text(branch, 'branch');
    check(branch.length <= 512 && branch !== 'main', 'bind a non-main local branch; main has its own root');
    check(typeof commit === 'string' && /^[0-9a-f]{40,64}$/.test(commit), 'bind needs the exact local branch HEAD commit');
    this.assertBranchWritable(branch, 'bind it to a new AP');
    return this.workspaces.exclusive(async () => {
      const actual = await this.workspaces.git(this.config.project, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`)
        .catch(() => { throw new Error(`local branch ${branch} does not exist`); });
      check(actual === commit, `branch ${branch} moved; confirm its current HEAD before binding`);
      const old = this.store.branch(branch);
      check(!old || !['deleted','archived'].includes(old.status), `branch ${branch} has a deleted/archived historical record; inspect before binding`);
      const unfinished = this.store.get(`SELECT t.id FROM aps t LEFT JOIN inputs i ON i.id=t.input_id
        WHERE t.ap_kind IS NULL AND t.status NOT IN ('completed','failed','cancelled')
          AND (t.branch=? OR t.target_branch=? OR i.anchor_branch=?) LIMIT 1`, branch, branch, branch);
      check(!unfinished, `branch ${branch} still has an active old AP #${unfinished?.id}; finish it before binding`);
      return this.store.transaction(() => {
        const owners = this.store.all("SELECT id FROM aps WHERE branch=? AND ap_kind IN ('main','owner','say')", branch);
        check(owners.length === 0, `branch ${branch} already has a new AP owner`);
        const owner = this.store.create({ role: 'agent', name: 'branch-owner', goal: `管理显式绑定的分支 ${branch}`,
          ap_kind: 'owner' });
        this.store.update(owner.id, { status: 'waiting', branch, base_commit: commit, head_commit: commit });
        if (!old) this.store.recordBranch({ branch, created_from_commit: commit, ap_id: owner.id });
        this.store.event(owner.id, 'branch.bound', { branch, commit, previous_ap_id: old?.ap_id ?? null });
        return this.store.ap(owner.id);
      });
    });
  },

  /**
   * 用户专属：在 main/owner 下开一个**只读分析子 AP**，回答针对这条分支当前状态的问题。
   * 不建分支、不占地板：工具不限，但机制上拿不到任何分支（分离检出），所以既改不了 ref 也交付不了代码；
   * 回答成为该 AP 的 result，并在结算时留一条信息 notice。
   */
  async analyze(apId, question) {
    const parent = this.store.ap(id(apId));
    check(['main','owner'].includes(parent.ap_kind), 'only a branch owner AP analyzes its branch on demand');
    text(question, 'question');
    check(question.length <= 4000, 'analysis question exceeds 4000 characters');
    check(!TERMINAL.has(parent.status), 'branch owner has ended; bind the branch again first');
    return this.workspaces.exclusive(async () => {
      const branch = parent.branch;
      check(branch, `AP #${parent.id} owns no branch to analyze`);
      const commit = await this.workspaces.git(this.config.project, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`)
        .catch(() => { throw new Error(`local branch ${branch} does not exist; nothing to analyze`); });
      const created = this.store.transaction(() => {
        const owner = this.store.ap(parent.id);
        check(!TERMINAL.has(owner.status) && owner.branch === branch, 'branch owner changed while starting analysis');
        check(this.store.activeAPs().length < 1000, 'too many active aps');
        const ap = this.store.create({ parent_id: owner.id, input_id: null, role: 'agent', ap_kind: 'analysis',
          goal: question });
        this.store.update(ap.id, { target_branch: branch, base_commit: commit });
        this.store.event(ap.id, 'ap.analyze_requested', { parent_id: owner.id, branch, commit });
        return ap;
      });
      this.kick();
      return { status: 'queued', ap: this.progressView(created), branch, commit };
    });
  },

  /**
   * 用户专属：把一个**没有代码改动**的 say 标记为「已解决」。它与「取消 AP 树」区分开：
   * 前者表示这次输入只是想了解/确认、你已经没有别的需求；后者是因为别的原因放弃正在进行的工作。
   * 只有分支没有新提交、工作区干净、没有正在调用的 Agent，且没有发出的合并请求或进行中的展示交付时才允许；
   * 有提交的 say 请走「请求合并」交付，或直接「取消 AP 树」。结算后照常落一条完成提醒。
   */
  async resolveAP(apId) {
    const target = id(apId);
    const ap = this.store.ap(target);
    check(ap.ap_kind === 'say', 'only a new say AP can be marked resolved');
    check(!TERMINAL.has(ap.status), 'AP already ended; retry it or send a new input');
    check(!this.running.has(ap.id), 'Agent 正在调用，等本轮安全结束后再标记已解决');
    const reservation = storedReservation(ap.reservation);
    check(reservation?.kind !== 'merge' || reservation.status !== 'requested',
      '这条 say 已经有发出的合并请求；请先批准或撤销请求，再标记已解决');
    check(reservation?.kind !== 'showcase',
      '这条 say 预约了展示交付；请先撤销展示预约，再标记已解决');
    check(!ap.head_commit || !ap.base_commit || ap.head_commit === ap.base_commit,
      '这条 say 已经有提交；请用「请求合并」交付，或用「取消 AP 树」放弃');
    return this.workspaces.exclusive(async () => {
      // 清理工作区并复核 AP 分支与顶端提交；有未提交改动或换过分支会在这里拒绝。
      await this.workspaces.finish(ap);
      const current = this.store.ap(ap.id);
      check(current.head_commit === current.base_commit,
        '这条 say 已经有提交；请用「请求合并」交付，或用「取消 AP 树」放弃');
      return this.finish(current.id, 'completed', current.result, null, { resolvedByUser: true });
    });
  },

  /** Persistent, mutually exclusive user intention; not a merge/showcase authorization. */
  async reserveAP(apId, kind) {
    check(kind === 'merge' || kind === 'showcase', 'reservation kind must be merge or showcase');
    if (kind === 'showcase') return this.bookShowcase(apId);
    // 展示交付后原 say 已终结，但「看完后仍需在分支图批准合并」这条路还缺一张固定提交的合并请求。
    // 这类终态 say 不能再等一个 pending 预约，直接补发 requested；若它之前撤销过请求（reservation 为空），
    // 同样允许重新请求，不必复活 AP。
    const settledSay = this.store.ap(id(apId));
    if (settledSay.ap_kind === 'say' && settledSay.status === 'completed') {
      const settledReservation = storedReservation(settledSay.reservation);
      if (settledReservation === null
        || (settledReservation.kind === 'showcase' && settledReservation.status === 'completed')) {
        return this.requestSettledShowcaseMerge(apId);
      }
    }
    const accepted = this.store.transaction(() => {
      const ap = this.store.ap(id(apId));
      check(ap.ap_kind === 'say', 'only new say APs support delivery reservations');
      check(!TERMINAL.has(ap.status), 'cannot reserve an ended say AP');
      const previous = storedReservation(ap.reservation);
      check(!previous || (previous.version === 1 && previous.status === 'pending' && ['merge','showcase'].includes(previous.kind)),
        'reservation state needs inspection before changing it');
      check(!previous || previous.kind === kind, `AP #${ap.id} already reserves ${previous?.kind}; unreserve it before choosing ${kind}`);
      if (previous) return { ap_id: ap.id, reservation: previous, changed: false };
      const reservation = { version: 1, kind, status: 'pending', created_at: new Date().toISOString() };
      this.store.update(ap.id, { reservation: JSON.stringify(reservation) });
      this.store.event(ap.id, 'ap.reserved', { reservation });
      return { ap_id: ap.id, reservation, changed: true };
    });
    try {
      const current = storedReservation(this.store.ap(accepted.ap_id).reservation);
      // 已发出的请求没有 pending 可推进：重查它现在是否仍可落地、已被包含，还是已经失效。
      if (current?.status === 'requested') await this.recheckRequestedMerge(accepted.ap_id);
      else await this.settleReservedMerge(accepted.ap_id);
    } catch (error) { this.noteReservationBlocked(accepted.ap_id, error.message); }
    return { ...accepted, reservation: storedReservation(this.store.ap(accepted.ap_id).reservation) };
  },

  /** 阻塞诊断：pending 是“还没能满足”，requested 是“已发出的请求失效了”。两种情况都只记录上次检查的快照。 */
  noteReservationBlocked(apId, reason, code = null) {
    this.store.transaction(() => {
      const ap = this.store.ap(apId);
      const reservation = storedReservation(ap.reservation);
      if (!['merge','showcase'].includes(reservation?.kind) || !['pending','preparing','requested'].includes(reservation.status)) return;
      const blocked_reason = String(reason).slice(0, 1000);
      if (reservation.blocked_reason === blocked_reason && (reservation.blocked_code ?? null) === code) return;
      const { blocked_code: _previousCode, ...rest } = reservation;
      this.store.update(ap.id, { reservation: JSON.stringify({ ...rest, blocked_reason,
        ...(code ? { blocked_code: code } : {}) }) });
      this.store.event(ap.id, 'ap.reservation_blocked', { reason: blocked_reason, code });
    });
  },

  /** 清掉过期的诊断：请求重新可以快进时，旧原因不能留着误导用户。 */
  clearReservationBlocked(apId) {
    this.store.transaction(() => {
      const ap = this.store.ap(id(apId));
      const reservation = storedReservation(ap.reservation);
      if (!reservation || (!reservation.blocked_reason && !reservation.blocked_code)) return;
      const { blocked_reason: previous, blocked_code: code, ...clean } = reservation;
      this.store.update(ap.id, { reservation: JSON.stringify(clean) });
      this.store.event(ap.id, 'ap.reservation_rechecked', { previous_reason: previous ?? null, code: code ?? null });
    });
  },

  /**
   * 已发出请求的只读复查：请求发出后 Git 会变（父分支被推进、外部人动过源分支），而 pending 的复查
   * 不覆盖这种状态。重启恢复与集成/批准失败都走这里，把结果如实写进 reservation 诊断。
   */
  async recheckRequestedMerge(apId) {
    const ap = this.store.ap(id(apId));
    const reservation = storedReservation(ap.reservation);
    if (ap.ap_kind !== 'say' || reservation?.kind !== 'merge' || reservation.status !== 'requested') return null;
    const parent = this.store.ap(ap.parent_id);
    const commit = reservation.commit;
    const state = await this.workspaces.branchState(ap.branch).catch(() => null);
    if (!state?.parent_head || state.child_head !== commit) {
      this.noteReservationBlocked(ap.id,
        `源分支 ${ap.branch} 的顶端已是 ${String(state?.child_head ?? '缺失').slice(0, 12)}，不再是请求里固定的提交 ${String(commit).slice(0, 12)}；`
        + '先检查现场，必要时撤销这个请求。', 'source_moved');
      return 'source_moved';
    }
    if (await this.workspaces.isAncestor(this.config.project, commit, state.parent_head)) {
      this.noteReservationBlocked(ap.id,
        `固定提交 ${String(commit).slice(0, 12)} 已经在 ${parent.branch} 里：让直接父 Agent 确认（父为 say），`
        + '或你按固定值批准（父为 main/owner），两种方式都是幂等关闭。', 'contained');
      return 'contained';
    }
    if (!(await this.workspaces.isAncestor(this.config.project, state.parent_head, commit))) {
      this.noteReservationBlocked(ap.id, parentMovedReason(parent.branch, state.parent_head, commit), 'parent_moved');
      return 'parent_moved';
    }
    this.clearReservationBlocked(ap.id);
    return 'landable';
  },

  /** 父分支自己提交后，复查挂在它上面的请求：不能快进的请求如实记成 parent_moved，而不是继续显示“等待集成”。
   *  返回仍处于失效状态的请求 id（没有就返回 null）；重复调用只刷新一次诊断（同因同码不重写事件）。 */
  async noteBranchAdvance(apId) {
    const ap = this.store.ap(apId);
    if (!ap.branch) return null;
    const lock = this.branchFreeze(ap.branch);
    if (!lock || lock.kind !== 'delivery' || lock.ap_id === ap.id || !lock.commit) return null;
    const head = ap.head_commit;
    if (!head) return null;
    if (await this.workspaces.isAncestor(this.config.project, lock.commit, head)) return null;
    this.noteReservationBlocked(lock.ap_id, parentMovedReason(ap.branch, head, lock.commit), 'parent_moved');
    return lock.ap_id;
  },

  /**
   * A user starts source-side conflict work, not a merge approval. 活动 say 的独立子 AP 完成后由 say Agent
   * 确认集成；已经终结的 say（展示交付后）没有可唤醒的 Agent，改用不挂在它子树下的独立 AP，结算后由
   * runtime 把产物推进回 say 分支并重新发合并请求。
   */
  async resolveSayDivergence(apId) {
    return this.workspaces.exclusive(async () => {
      const ap = this.store.ap(id(apId));
      const reservation = storedReservation(ap.reservation);
      check(ap.ap_kind === 'say' && reservation?.kind === 'merge' && reservation.status === 'pending',
        'only a pending say merge reservation can resolve parent divergence');
      const terminal = TERMINAL.has(ap.status);
      const previous = this.store.get(`SELECT t.* FROM aps t JOIN events e ON e.ap_id=t.id
        LEFT JOIN branches b ON b.branch=t.branch
        WHERE ${terminal ? 't.resolves_ap_id' : 't.parent_id'}=? AND e.type='ap.divergence_resolution_requested'
          AND (t.status NOT IN ('completed','failed','cancelled')
            OR (t.integration!='merged' AND b.status='active'))
        ORDER BY t.id DESC LIMIT 1`, ap.id);
      if (previous) return TERMINAL.has(previous.status)
        ? { status: 'needs_review', ap: this.progressView(previous),
          reason: terminal
            ? `解分歧子 AP #${previous.id} ${previous.status} 且尚未集成；先检查现场。若需重新派 AP，须显式归档 ${previous.branch}（保留 AP 和会话，脏工作区需用户另行确认丢弃）。`
            : `解分歧子 AP #${previous.id} ${previous.status} 且尚未集成；先检查现场。完成的结果可由 say Agent 确认固定提交；若需重新派 AP，须显式归档 ${previous.branch}（保留 AP 和会话，脏工作区需用户另行确认丢弃）。` }
        : { status: 'existing', ap: this.progressView(previous) };
      if (!terminal) {
        const reason = this.reservationWaitReason(ap);
        check(!reason, reason || 'say must be idle before resolving divergence');
      }
      this.assertBranchWritable(ap.branch, 'resolve its parent divergence');
      await this.workspaces.finish(ap);
      const source = this.store.ap(ap.id);
      const parent = this.store.ap(source.parent_id);
      check(['main','owner','say'].includes(parent.ap_kind) && !TERMINAL.has(parent.status),
        'the directly bound parent is no longer active');
      assertQuietResolutionParent(this, parent);
      const state = await this.workspaces.branchState(source.branch);
      check(state.parent === parent.branch && state.child_head === source.head_commit,
        'say branch moved during divergence check; inspect its current HEAD');
      check(state.status === 'diverged', `source is ${state.status}; resolve_divergence only applies to a diverged branch`);
      const blockers = state.blockers.filter(item => item !== `ap:#${source.id}`);
      check(blockers.length === 0, `unintegrated child branches block divergence resolution: ${blockers.join(', ')}; inspect failed or rejected child work and explicitly archive only the unwanted child branch before retrying`);
      const goal = `在独立子 AP 工作区解决 say #${source.id} 与直接父分支 ${parent.branch} 的分歧。\n`
        + `基线是固定源提交 ${state.child_head}。请将固定父提交 ${state.parent_head} 合入本工作区（不要合入会移动的分支名）；`
        + `如有冲突，保留双方意图并解决，运行相关测试，再提交结果。只改自己的子 AP 分支，`
        + `不可修改 say 分支或父分支；`
        + (terminal
          ? `完成后由 runtime 检查产物含两端固定提交，把它快进推进回 say 分支，再重新发出固定提交的合并请求。`
          : `完成后由 runtime 检查产物含两端固定提交、推进 say 分支，再发固定合并请求；原 say Agent 在冻结期间不调用。`);
      const created = this.store.transaction(() => {
        const live = this.store.ap(source.id);
        const currentReservation = storedReservation(live.reservation);
        check(currentReservation?.kind === 'merge' && currentReservation.status === 'pending'
          && live.status === (terminal ? 'completed' : 'waiting')
          && live.head_commit === state.child_head && live.parent_id === parent.id,
          'say reservation changed while starting divergence work');
        assertQuietResolutionParent(this, this.store.ap(parent.id));
        check(this.store.activeAPs().length < 1000, 'too many active aps');
        const child = this.store.create({ parent_id: terminal ? parent.id : live.id, input_id: live.input_id,
          role: 'agent', ap_kind: 'child', name: `resolve-${live.id}`, goal,
          ...(terminal ? { resolves_ap_id: live.id } : {}) });
        this.store.update(child.id, { base_commit: state.child_head, target_branch: live.branch });
        this.store.event(child.id, 'ap.divergence_resolution_requested', { source_ap_id: live.id,
          source_commit: state.child_head, parent_ap_id: parent.id, parent_branch: parent.branch,
          parent_commit: state.parent_head });
        this.store.update(live.id, { reservation: JSON.stringify({ ...currentReservation,
          blocked_reason: terminal
            ? `等待独立解分歧子 AP #${child.id} 完成后由 runtime 推进 say 分支并重新发合并请求`
            : `等待解分歧子 AP #${child.id} 完成并由 say Agent 确认集成`,
          blocked_code: 'resolving', resolution_child_id: child.id }) });
        this.store.event(live.id, 'ap.divergence_resolution_started', { child_id: child.id,
          source_commit: state.child_head, parent_commit: state.parent_head });
        return child;
      });
      this.kick();
      return { status: 'queued', ap: this.progressView(created), source_commit: state.child_head,
        parent_commit: state.parent_head };
    });
  },

  /**
   * 新式解分歧统一由 runtime 收尾：验证两端固定 tip，先把源分支快进到解分歧产物。
   * say 重新固定合并请求，child 继续把源 child ff-only 收入父分支；不唤醒被冻结的 Agent 去写父分支。
   * 中途 Git 已快进而库尚未结算时从固定提交核对后补记，不重放 Agent 工作。
   */
  async finalizeTerminalDivergence(resolutionId) {
    const resolution = this.store.ap(id(resolutionId));
    if (!resolution || resolution.status !== 'completed' || !resolution.head_commit) return null;
    const requestEvent = this.store.get("SELECT data FROM events WHERE ap_id=? AND type='ap.divergence_resolution_requested' ORDER BY id DESC LIMIT 1", resolution.id);
    if (!requestEvent) return null;
    const fixed = JSON.parse(requestEvent.data);
    if (fixed.orchestrated === true) return null; // 编排 driver 自己收尾
    const say = this.store.ap(fixed.source_ap_id);
    if (!say || !['say','child'].includes(say.ap_kind)) return null;
    if (say.ap_kind === 'child') {
      if (say.status !== 'completed' || say.integration === 'merged') return null;
    } else {
      if (!['waiting','completed'].includes(say.status)) return null;
      const reservation = storedReservation(say.reservation);
      if (reservation?.kind !== 'merge' || reservation.status !== 'pending'
        || reservation.blocked_code !== 'resolving' || reservation.resolution_child_id !== resolution.id) return null;
    }
    return this.workspaces.exclusive(async () => {
      const liveResolution = this.store.ap(resolution.id);
      const liveSay = this.store.ap(say.id);
      const current = liveSay.ap_kind === 'say' ? storedReservation(liveSay.reservation) : null;
      if (liveResolution.status !== 'completed' || !liveResolution.head_commit) return null;
      if (liveSay.ap_kind === 'child') {
        if (liveSay.status !== 'completed' || liveSay.integration === 'merged') return null;
      } else if (!['waiting','completed'].includes(liveSay.status)
        || current?.resolution_child_id !== liveResolution.id || current.blocked_code !== 'resolving') return null;
      check(fixed.source_ap_id === liveSay.id, 'terminal divergence resolution targets the wrong say');
      check(await this.workspaces.isAncestor(this.config.project, fixed.source_commit, liveResolution.head_commit)
        && await this.workspaces.isAncestor(this.config.project, fixed.parent_commit, liveResolution.head_commit),
        'terminal divergence resolution must contain both frozen commits before it can be finalized');
      const state = await this.workspaces.branchState(liveSay.branch);
      const advanced = state.child_head === liveResolution.head_commit;
      check(state.parent === liveSay.target_branch
        && (state.child_head === fixed.source_commit || advanced)
        && (state.parent_head === fixed.parent_commit
          || (liveSay.ap_kind === 'child' && advanced && state.parent_head === liveResolution.head_commit)),
        'source or parent branch moved before divergence resolution was finalized; inspect the branch');
      if (!advanced) await this.workspaces.fastForwardBranchUnsafe(liveSay.branch, liveResolution.head_commit);
      if (liveSay.head_commit !== liveResolution.head_commit) this.store.transaction(() => {
        this.store.update(liveSay.id, { head_commit: liveResolution.head_commit, integration: 'pending',
          integration_error: null });
        this.store.event(liveSay.id, 'ap.divergence_resolved', { resolution: liveResolution.id,
          commit: liveResolution.head_commit, source_commit: fixed.source_commit, parent_commit: fixed.parent_commit });
      });
      if (liveSay.ap_kind === 'child') {
        const owner = this.store.ap(liveSay.parent_id);
        check(!this.running.has(owner.id) && !['running','queued'].includes(owner.status),
          '父 Agent 尚未到安全点，不能落地解分歧结果');
        if (state.parent_head === fixed.parent_commit) await this.workspaces.mergeBranchUnsafe(
          liveSay.branch, liveResolution.head_commit, fixed.parent_commit);
        this.store.transaction(() => {
          this.store.update(liveResolution.id, { integration: 'merged', integration_error: null });
          this.store.event(liveResolution.id, 'resolution.merged', { commit: liveResolution.head_commit,
            source_ap_id: liveSay.id, source_commit: fixed.source_commit, parent_commit: fixed.parent_commit });
          this.store.update(liveSay.id, { integration: 'merged', integration_error: null });
          this.store.event(liveSay.id, 'ap.divergence_integrated', { resolution: liveResolution.id,
            commit: liveResolution.head_commit, parent_commit: fixed.parent_commit });
        });
        this.kick();
        return this.store.ap(liveSay.id);
      }
      if (liveResolution.integration !== 'merged') this.store.transaction(() => {
        this.store.update(liveResolution.id, { integration: 'merged', integration_error: null });
        this.store.event(liveResolution.id, 'resolution.merged', { commit: liveResolution.head_commit,
          source_ap_id: liveSay.id, source_commit: fixed.source_commit, parent_commit: fixed.parent_commit });
      });
      if (liveSay.status === 'waiting') {
        // 活动 say 的 Agent 不在被冻结的父分支上重新执行；runtime 校验并结算固定请求。
        return this.finish(liveSay.id, 'completed', liveSay.result, null, {
          mergeRequest: { commit: liveResolution.head_commit, baseline: fixed.parent_commit, parent_id: liveSay.parent_id },
        });
      }
      return this.requestSettledShowcaseMergeUnsafe(liveSay.id).catch(error => {
        this.noteReservationBlocked(liveSay.id, error.message);
        return null;
      });
    });
  },

  /** 解分歧子 AP 结算后调度一次收尾；失败只记事件并保留冻结/现场供检查。 */
  scheduleTerminalDivergenceFinalize(resolutionId) {
    if (this.stopping) return;
    queueMicrotask(() => this.finalizeTerminalDivergence(resolutionId).catch(error => {
      this.store.event(resolutionId, 'resolution.finalize_failed', { error: error.message });
      console.error(`terminal divergence finalize #${resolutionId}: ${error.stack || error}`);
    }));
  },

  /** 终态 say 的独立解分歧子 AP 失败/取消：把预约落回可分派的 diverged 状态，保留失败现场。 */
  noteTerminalDivergenceFailure(resolution, status, error) {
    const say = this.store.ap(resolution.resolves_ap_id);
    if (!say || say.ap_kind !== 'say' || !['waiting','completed'].includes(say.status)) return false;
    const reservation = storedReservation(say.reservation);
    if (reservation?.kind !== 'merge' || reservation.status !== 'pending'
      || reservation.resolution_child_id !== resolution.id) return false;
    this.store.update(say.id, { reservation: JSON.stringify({ ...reservation,
      blocked_reason: `解分歧子 AP #${resolution.id} ${status}${error ? `：${error}` : ''}；检查现场后显式归档旧分支再重新派。`,
      blocked_code: 'diverged' }) });
    this.store.event(say.id, 'ap.divergence_resolution_failed', { resolution: resolution.id, status, error: error ?? null });
    return true;
  },

  /** A running direct parent Agent absorbs a diverged completed child commit into its own branch history.
   *  The child branch is never rewritten and the parent branch never takes a merge commit: a new AP contains
   *  both frozen tips and is landed by the same ap.integrate confirmation, which then closes the source child. */
  async resolveChildDivergence(parentId, childId) {
    return this.workspaces.exclusive(async () => {
      const parent = this.store.ap(id(parentId)), child = this.store.ap(id(childId));
      check(['say','child'].includes(parent.ap_kind), 'only a new AP agent can repair its own child branch');
      check(child.ap_kind === 'child' && child.parent_id === parent.id, 'a parent can only repair its own direct child');
      const previous = this.store.get(`SELECT t.* FROM aps t JOIN events e ON e.ap_id=t.id
        LEFT JOIN branches b ON b.branch=t.branch
        WHERE t.parent_id=? AND e.type='ap.divergence_resolution_requested'
          AND json_extract(e.data,'$.source_ap_id')=?
          AND (t.status NOT IN ('completed','failed','cancelled')
            OR (t.integration!='merged' AND b.status='active'))
        ORDER BY t.id DESC LIMIT 1`, parent.id, child.id);
      if (previous) return TERMINAL.has(previous.status)
        ? { status: 'needs_review', ap: this.progressView(previous),
          reason: `解分歧子 AP #${previous.id} 已结束且尚未集成；先检查现场。若需重做，由用户显式归档 ${previous.branch} 后再调用本接口（不会重放上一次 Agent）。` }
        : { status: 'existing', ap: this.progressView(previous) };
      check(child.status === 'completed' && child.integration !== 'merged',
        'only a completed child whose work is not integrated yet can be repaired');
      // 交付锁：父分支上还有未集成的 say 请求时，先集成或撤销它，再分派新的分支工作。
      const lock = this.branchFreeze(parent.branch);
      check(!lock, lock ? `branch ${parent.branch} is frozen: ${lock.reason}; integrate or withdraw that request first` : '');
      // 此入口由正在运行的父 Agent 调用：先固定请求并阻止新的写入，等它本轮安全结束后才准许解分歧子 AP 开始。
      await this.workspaces.finish(child);
      const live = this.store.ap(child.id);
      const state = await this.workspaces.branchState(live.branch);
      check(state.parent === parent.branch && state.child_head === live.head_commit,
        'child branch moved after its completed commit; inspect it before repairing');
      check(state.status === 'diverged', `child is ${state.status}; repair only applies to a diverged child`);
      check(state.blockers.length === 0, `unintegrated descendants block repairing this child: ${state.blockers.join(', ')}`);
      const goal = `在独立子 AP 工作区解决子 AP #${live.id} 与直接父分支 ${parent.branch} 的分歧。\n`
        + `基线是固定子提交 ${state.child_head}。请将固定父提交 ${state.parent_head} 合入本工作区（不要合入会移动的分支名）；`
        + `如有冲突，保留双方意图并解决，运行相关测试，再提交结果。只改自己的子 AP 分支，`
        + `不可修改 #${live.id} 或 ${parent.branch}；完成后由 runtime 核对两端固定提交，依次快进 #${live.id} 与 #${parent.id} 的分支。`;
      const created = this.store.transaction(() => {
        const current = this.store.ap(live.id), owner = this.store.ap(parent.id);
        check(owner.status === 'running' && current.status === 'completed' && current.integration !== 'merged'
          && current.head_commit === state.child_head && current.parent_id === owner.id,
        'child or parent changed while starting divergence repair');
        check(this.store.activeAPs().length < 1000, 'too many active aps');
        const repair = this.store.create({ parent_id: owner.id, input_id: owner.input_id, role: 'agent',
          ap_kind: 'child', name: `resolve-${current.id}`, goal });
        this.store.update(repair.id, { base_commit: state.child_head, target_branch: owner.branch });
        this.store.event(repair.id, 'ap.divergence_resolution_requested', { source_ap_id: current.id,
          source_commit: state.child_head, parent_ap_id: owner.id, parent_branch: owner.branch,
          parent_commit: state.parent_head });
        this.store.event(current.id, 'ap.divergence_resolution_started', { child_id: repair.id,
          source_commit: state.child_head, parent_commit: state.parent_head });
        return repair;
      });
      this.requestPreempt(parent.id, '解分歧已冻结父子分支，等待本轮安全结束');
      this.kick();
      return { status: 'queued', ap: this.progressView(created), source_commit: state.child_head,
        parent_commit: state.parent_head };
    });
  },

  /** An observable execution barrier, not a Git verdict. A retry never skips a running invocation or unread signal. */
  reservationWaitReason(ap) {
    if (this.running.has(ap.id) || ap.status === 'running') return 'Agent 正在调用或收尾，等待本轮安全结束';
    if (ap.status === 'queued') return 'AP 等待下一轮 Agent 调用完成';
    if (ap.status === 'awaiting' || this.questionPending(ap.id)) return 'AP 正在等待用户答复';
    if (ap.status !== 'waiting') return `AP 尚未静息（${ap.status}）`;
    const reservation = storedReservation(ap.reservation);
    const child = this.store.children(ap.id).find(row => !TERMINAL.has(row.status)
      && !(reservation?.kind === 'showcase' && reservation.status === 'preparing' && row.id === reservation.child_id));
    if (child) return `等待子 AP #${child.id} 结算`;
    if (this.hasActionableMessages(ap.id)) return '还有未处理的消息或子 AP 信号，需先交给 Agent';
    return null;
  },

  /** A request is not approval: pin both tips, settle atomically with the parent signal, never touch parent Git. */
  async settleReservedMerge(apId) {
    const ready = () => {
      const ap = this.store.ap(apId);
      const reservation = storedReservation(ap.reservation);
      if (ap.ap_kind !== 'say' || reservation?.kind !== 'merge' || reservation.status !== 'pending'
        || reservation.blocked_code === 'resolving') return null;
      const reason = this.reservationWaitReason(ap);
      if (reason) { this.noteReservationBlocked(ap.id, reason); return null; }
      return ap;
    };
    if (!ready()) return false;
    return this.workspaces.exclusive(async () => {
      let ap = ready();
      if (!ap) return false;
      await this.workspaces.finish(ap); // clean worktree, exact branch, immutable committed tip
      ap = ready();
      if (!ap) return false;
      if (ap.head_commit === ap.base_commit) {
        this.noteReservationBlocked(ap.id, 'no committed source changes yet');
        return false;
      }
      const parent = this.store.ap(ap.parent_id);
      check(['main','owner','say'].includes(parent.ap_kind) && !TERMINAL.has(parent.status),
        'merge request needs a live directly bound parent AP');
      // 基线一旦固定，父分支就不能再被别的交付推进：同时只允许一个未集成的请求。
      const lock = this.branchFreeze(parent.branch);
      if (lock && lock.ap_id !== ap.id) {
        this.noteReservationBlocked(ap.id, `父分支 ${parent.branch} 已被 ${lock.reason}；先集成或撤销那个请求`, 'parent_locked');
        return false;
      }
      const state = await this.workspaces.branchState(ap.branch);
      check(state.parent === parent.branch && state.child_head === ap.head_commit,
        'say branch moved while preparing its fixed merge request');
      if (state.status === 'diverged') {
        const blockers = state.blockers.filter(item => item !== `ap:#${ap.id}`);
        const detail = blockers.length ? `; unintegrated child branches: ${blockers.join(', ')}. Inspect the child work before explicitly archiving unwanted branches` : '';
        this.noteReservationBlocked(ap.id, `cannot request a merge from a diverged branch; resolve it first${detail}`, 'diverged');
        return false;
      }
      check(state.status === 'fast_forward', `cannot request a merge from a ${state.status} branch; resolve it first`);
      const blockers = state.blockers.filter(item => item !== `ap:#${ap.id}`);
      check(blockers.length === 0, `unintegrated child branches block merge request: ${blockers.join(', ')}`);
      ap = ready();
      if (!ap || ap.head_commit !== state.child_head) return false;
      this.finish(ap.id, 'completed', ap.result, null, {
        mergeRequest: { commit: state.child_head, baseline: state.parent_head, parent_id: parent.id },
      });
      return true;
    });
  },

  /**
   * 展示交付后原 say 已经终结，但交付流程还差一步：用户仍需要一张固定提交的合并请求才能在分支图批准。
   * `merge` 预约的 pending 阶段依赖 say 静息等待，终态 AP 永远等不到，所以这里直接固定源 tip 与父基线、
   * 在事务里写一次 requested 并给父 AP 发 `merge.requested` 信号；不改动已经终结的生命周期。
   * 父子分歧时不抛错，而是留一条 pending/diverged 预约，用户可派独立解分歧子 AP 吸收固定的父提交。
   */
  requestSettledShowcaseMerge(apId) {
    return this.workspaces.exclusive(() => this.requestSettledShowcaseMergeUnsafe(apId));
  },

  /** 调用方必须已持有 Git 串行锁；终态 say 的展示/解分歧流程共用。 */
  async requestSettledShowcaseMergeUnsafe(apId) {
    const current = this.store.ap(id(apId));
    const reservation = storedReservation(current.reservation);
    const pendingResolution = reservation?.kind === 'merge' && reservation.status === 'pending';
    check(current.ap_kind === 'say' && current.status === 'completed'
      && (reservation === null || (reservation.kind === 'showcase' && reservation.status === 'completed')
        || pendingResolution),
    'only a completed say whose showcase settled can request a merge after settlement');
    check(current.integration !== 'merged', 'this say is already integrated into its parent');
    const parent = this.store.ap(current.parent_id);
    check(['main','owner','say'].includes(parent.ap_kind) && !TERMINAL.has(parent.status),
      'merge request needs a live directly bound parent AP');
    // 交付锁与普通合并请求同源：同一父分支同时只允许一个未集成的请求。
    const lock = this.branchFreeze(parent.branch);
    check(!lock || lock.ap_id === current.id,
      lock ? `父分支 ${parent.branch} 已被 ${lock.reason}；先集成或撤销那个请求` : '');
    await this.workspaces.finish(current); // 清理工作区并复核 AP 分支仍是自己的分支
    let ap = this.store.ap(current.id);
    check(ap.head_commit && ap.base_commit && ap.head_commit !== ap.base_commit,
      'no committed source changes to request a merge for');
    const state = await this.workspaces.branchState(ap.branch);
    check(state.parent === parent.branch && state.child_head === ap.head_commit,
      'say branch moved while preparing its fixed merge request');
    const blockers = state.blockers.filter(item => item !== `ap:#${ap.id}`);
    if (state.status === 'diverged') {
      // 分歧不是失败：固定成 pending/diverged，让用户在源侧派独立解分歧子 AP。子分支未收拢也一并说清。
      const detail = blockers.length ? `；先收拢未集成子分支：${blockers.join(', ')}` : '';
      const blocked = { version: 1, kind: 'merge', status: 'pending', created_at: new Date().toISOString(),
        blocked_reason: `分支与直接父分支已分歧；先派独立解分歧子 AP 吸收固定的父提交，再重新发合并请求${detail}。`,
        blocked_code: 'diverged' };
      this.store.transaction(() => {
        const live = this.store.ap(ap.id);
        check(live.status === 'completed' && live.head_commit === state.child_head,
          'say changed while preparing its fixed merge request');
        this.store.update(ap.id, { reservation: JSON.stringify(blocked) });
        this.store.event(ap.id, 'ap.reservation_blocked', { reason: blocked.blocked_reason, code: 'diverged' });
      });
      return { ap_id: ap.id, reservation: storedReservation(this.store.ap(ap.id).reservation), changed: true };
    }
    check(blockers.length === 0, `unintegrated child branches block merge request: ${blockers.join(', ')}`);
    check(state.status === 'fast_forward', `cannot request a merge from a ${state.status} branch; resolve it first`);
    ap = this.store.ap(current.id);
    check(ap.head_commit === state.child_head, 'say branch moved while preparing its fixed merge request');
    return this.pinSettledMergeRequest(ap, parent, state.child_head, state.parent_head);
  },

  /** 终态 say 固定源提交与父基线、发一次 requested 并通知父 AP；调用方必须已持有 Git 串行锁。 */
  pinSettledMergeRequest(ap, parent, commit, baseline) {
    const requested = { version: 1, kind: 'merge', status: 'requested', created_at: new Date().toISOString(),
      commit, baseline, parent_id: parent.id, requested_at: new Date().toISOString() };
    const key = `merge:${ap.id}:${commit}`;
    const payload = { branch: ap.branch, commit, baseline };
    const body = JSON.stringify({ version: 1, signal: 'merge.requested', key, source_ap_id: ap.id,
      target_ap_id: parent.id, payload });
    this.store.transaction(() => {
      const live = this.store.ap(ap.id);
      check(live.status === 'completed' && live.head_commit === commit,
        'say changed while preparing its fixed merge request');
      const row = this.store.signal(parent.id, ap.id, 'merge.requested', key, body);
      this.store.event(ap.id, 'ap.merge_requested', { ...payload, parent_id: parent.id, message_id: row.id });
      if (row.inserted) this.store.event(parent.id, 'ap.signal', { message_id: row.id,
        source_ap_id: ap.id, signal: 'merge.requested', key });
      this.store.update(ap.id, { reservation: JSON.stringify(requested) });
    });
    return { ap_id: ap.id, reservation: storedReservation(this.store.ap(ap.id).reservation), changed: true };
  },

  /**
   * 用户专属：say AP 预约效果展示。点击即创建展示子 AP 并进入准备阶段；say 真正完成且满足展示准入后，
   * 由 signalReservedShowcase 发信号让它按最终提交交付。重复调用幂等，也不会重复建子 AP。
   */
  async bookShowcase(apId) {
    const target = id(apId);
    const current = this.store.ap(target);
    check(current.ap_kind === 'say', 'only new say APs support delivery reservations');
    check(!TERMINAL.has(current.status), 'cannot reserve an ended say AP');
    const previous = storedReservation(current.reservation);
    check(!previous || previous.kind === 'showcase',
      `AP #${current.id} already reserves ${previous?.kind}; unreserve it before choosing showcase`);
    if (previous) {
      // 幂等复查：条件已满足就补发一次信号，否则保留 preparation 状态。
      // 必须放在 exclusive 之外，否则会与 signalReservedShowcase 自己的串行锁死锁。
      if (previous.status === 'preparing' && current.status === 'waiting') await this.signalReservedShowcase(target);
      return { ap_id: target, reservation: storedReservation(this.store.ap(target).reservation), changed: false,
        child_id: previous.child_id ?? null };
    }
    const created = await this.workspaces.exclusive(async () => {
      const ap = this.store.ap(target);
      check(ap.ap_kind === 'say' && ap.reservation === null && !TERMINAL.has(ap.status),
        'say changed while booking showcase');
      const prep = await this.showcasePreparation(ap.branch);
      return this.store.transaction(() => {
        const live = this.store.ap(target);
        check(live.ap_kind === 'say' && live.reservation === null && !TERMINAL.has(live.status),
          'say changed while booking showcase');
        check(this.store.activeAPs().length < 1000, 'too many active aps');
        const reservation = { version: 1, kind: 'showcase', status: 'preparing',
          created_at: new Date().toISOString(), child_id: null, prep_commit: prep.commit };
        const child = this.store.create({ parent_id: live.id, input_id: live.input_id, role: 'showcase',
          name: 'showcase', ap_kind: 'showcase', showcase: { ...prep, phase: 'preparing' },
          goal: `效果展示：${live.branch}\n先做准备（理解改动、设计展示方案）；收到原 say 工作完成的信号后，再按最终固定提交交付自包含展示页与可运行预览。展示不是验收，也不自动合并。` });
        this.store.update(live.id, { reservation: JSON.stringify({ ...reservation, child_id: child.id }) });
        this.store.event(child.id, 'showcase.booked', { branch: live.branch, commit: prep.commit,
          baseline: prep.baseline_commit, phase: 'preparing' });
        this.store.event(live.id, 'ap.showcase_booked', { child_id: child.id, commit: prep.commit });
        return child;
      });
    });
    this.kick();
    return { ap_id: target, reservation: storedReservation(this.store.ap(target).reservation), changed: true,
      child_id: created.id };
  },

  /**
   * 展示预约的第二阶段：say 真正完成（静息）且分支满足展示准入时，把既有展示子 AP 从 prep 提交重新固定到
   * 最终提交并唤醒它继续交付。say 仍保持非终态，等展示子 AP 结算后才终结。
   */
  async signalReservedShowcase(apId) {
    return this.workspaces.exclusive(async () => {
      const ap = this.store.ap(id(apId));
      const reservation = storedReservation(ap.reservation);
      if (ap.ap_kind !== 'say' || reservation?.kind !== 'showcase' || reservation.status !== 'preparing') return false;
      const child = this.store.ap(reservation.child_id);
      if (!child || child.role !== 'showcase' || child.ap_kind !== 'showcase' || child.parent_id !== ap.id) {
        this.noteReservationBlocked(ap.id, '展示预约的子 AP 丢失或身份变化，请撤销后重新预约', 'missing_child');
        return false;
      }
      if (this.running.has(child.id) || child.status === 'queued' || child.status === 'running') return false;
      if (TERMINAL.has(child.status)) {
        this.noteReservationBlocked(ap.id, `展示子 AP #${child.id} 已 ${child.status}，撤销后重新预约`, 'child_ended');
        return false;
      }
      const reason = this.reservationWaitReason(ap);
      if (reason) { this.noteReservationBlocked(ap.id, reason); return false; }
      const eligibility = await this.showcaseEligibility(ap.branch, null, child.id, ap.id);
      if (!eligibility.allowed) { this.noteReservationBlocked(ap.id, eligibility.reason); return false; }
      const snapshot = eligibility.snapshot;
      await this.workspaces.showcaseRepin(child, JSON.parse(child.showcase), snapshot);
      this.store.transaction(() => {
        const current = storedReservation(this.store.ap(ap.id).reservation);
        check(current?.kind === 'showcase' && current.status === 'preparing' && current.child_id === child.id,
          'showcase reservation changed during signal');
        const { blocked_reason: _reason, blocked_code: _code, ...clean } = current;
        this.store.setShowcase(child.id, { ...snapshot, phase: 'final' });
        this.store.update(child.id, { base_commit: snapshot.commit, head_commit: snapshot.commit, baseline_commit: snapshot.baseline_commit });
        this.store.update(ap.id, { head_commit: snapshot.commit,
          integration: snapshot.commit === ap.base_commit ? 'none' : 'pending',
          reservation: JSON.stringify({ ...clean, status: 'started', commit: snapshot.commit,
            baseline: snapshot.baseline_commit, started_at: new Date().toISOString() }) });
        this.store.event(child.id, 'showcase.signaled', { commit: snapshot.commit, baseline: snapshot.baseline_commit });
        this.store.event(ap.id, 'ap.showcase_started', { child_id: child.id, commit: snapshot.commit,
          baseline: snapshot.baseline_commit });
      });
      this.wake(child.id);
      return child;
    });
  },

  /** Reserve a dedicated, detached showcase child; the say AP remains nonterminal until that child settles. */
  async startReservedShowcase(apId) {
    const ready = (diagnose = true) => {
      const ap = this.store.ap(apId);
      const reservation = storedReservation(ap.reservation);
      if (this.stopping || ap.ap_kind !== 'say' || reservation?.kind !== 'showcase' || reservation.status !== 'pending') return null;
      const reason = this.reservationWaitReason(ap);
      if (reason) { if (diagnose) this.noteReservationBlocked(ap.id, reason); return null; }
      return ap;
    };
    if (!ready()) return false;
    return this.workspaces.exclusive(async () => {
      const ap = ready();
      if (!ap) return false;
      const eligibility = await this.showcaseEligibility(ap.branch, null, null, ap.id);
      if (!eligibility.allowed) { this.noteReservationBlocked(ap.id, eligibility.reason); return false; }
      const { snapshot } = eligibility;
      if (!ready()) return false;
      const child = this.store.transaction(() => {
        const current = ready(false);
        check(current && current.id === ap.id, 'showcase reservation changed during admission');
        check(this.store.activeAPs().length < 1000, 'too many active aps');
        const reservation = storedReservation(current.reservation);
        const created = this.store.create({ parent_id: current.id, input_id: current.input_id, role: 'showcase',
          name: 'showcase', ap_kind: 'showcase', showcase: snapshot,
          goal: `效果展示：${current.branch}\n分析固定提交 ${snapshot.commit} 相对 ${snapshot.baseline_commit} 的修改，交付展示页和可运行预览。展示不是验收，也不自动合并。` });
        const { blocked_reason: _reason, ...cleanReservation } = reservation;
        this.store.update(current.id, { head_commit: snapshot.commit,
          integration: snapshot.commit === current.base_commit ? 'none' : 'pending',
          reservation: JSON.stringify({ ...cleanReservation, status: 'started', child_id: created.id,
            commit: snapshot.commit, baseline: snapshot.baseline_commit, started_at: new Date().toISOString() }) });
        this.store.event(created.id, 'showcase.requested', snapshot);
        this.store.event(current.id, 'ap.showcase_started', { child_id: created.id, commit: snapshot.commit,
          baseline: snapshot.baseline_commit });
        return created;
      });
      this.kick();
      return child;
    });
  },

  /** Child settled first; then close the original say AP without conflating showcase with Git integration. */
  settleReservedShowcase(apId) {
    const ap = this.store.ap(apId);
    const reservation = storedReservation(ap.reservation);
    // `started` 是正常交付阶段；`preparing` 只在准备子 AP 失败/取消时走到这里，同样要收束原 say。
    if (ap.ap_kind !== 'say' || reservation?.kind !== 'showcase'
      || !['preparing','started'].includes(reservation.status) || TERMINAL.has(ap.status)) return ap;
    const child = this.store.ap(reservation.child_id);
    if (!TERMINAL.has(child.status)) return ap;
    check(child.parent_id === ap.id && child.ap_kind === 'showcase' && child.role === 'showcase',
      'reserved showcase child identity changed; inspect before settlement');
    const status = child.status === 'completed' ? 'completed' : child.status === 'cancelled' ? 'cancelled' : 'failed';
    return this.finish(ap.id, status, child.result, child.error, { showcaseSettlement: child.id });
  },

  unreserveAP(apId) {
    let prepChild = null;
    const result = this.store.transaction(() => {
      const ap = this.store.ap(id(apId));
      check(ap.ap_kind === 'say', 'only new say APs support delivery reservations');
      if (ap.reservation === null) return { ap_id: ap.id, reservation: null, changed: false };
      const previous = storedReservation(ap.reservation);
      if (previous.blocked_code === 'resolving' && previous.resolution_child_id) {
        const resolution = this.store.ap(previous.resolution_child_id);
        check(TERMINAL.has(resolution.status) && (resolution.integration === 'merged'
          || !resolution.branch || this.store.branch(resolution.branch)?.status === 'archived'),
        `解分歧 AP #${resolution.id} 仍占用冻结；先等待它落地，或取消并显式归档其分支`);
      }
      // 已发出但尚未集成的合并请求可以撤销：否则父分支会被一个不再成立的请求一直冻住。
      // 展示预约在准备阶段仍可撤销：随之取消那个还没交付任何东西的 prep 子 AP。
      const withdrawable = previous.version === 1 && (['pending','preparing'].includes(previous.status)
        || (previous.kind === 'merge' && previous.status === 'requested'));
      check(withdrawable, 'started reservation cannot be withdrawn; inspect AP');
      this.store.update(ap.id, { reservation: null });
      if (previous.kind === 'showcase' && previous.status === 'preparing' && previous.child_id) prepChild = previous.child_id;
      this.store.event(ap.id, previous.status === 'requested' ? 'ap.request_withdrawn' : 'ap.unreserved', { reservation: previous,
        ...(previous.status === 'requested' ? { commit: previous.commit ?? null, baseline: previous.baseline ?? null,
          note: 'withdrawn without integration; the work stays on its branch' } : {}) });
      return { ap_id: ap.id, reservation: null, changed: true,
        withdrawn: previous.status === 'requested' ? previous : null };
    });
    if (prepChild !== null) {
      const child = this.store.ap(prepChild);
      if (child && !TERMINAL.has(child.status)) this.cancel(child.id, '展示预约已撤销，准备中的展示已取消');
    }
    return result;
  },

  /** A human approves precisely the previously requested source commit and parent baseline. */
  async approveReservedMerge(apId, commit, baseline) {
    check(typeof commit === 'string' && /^[0-9a-f]{40,64}$/.test(commit), 'approve the exact requested commit');
    check(typeof baseline === 'string' && /^[0-9a-f]{40,64}$/.test(baseline), 'approve the exact parent baseline');
    return this.workspaces.exclusive(async () => {
      const ap = this.store.ap(id(apId));
      const reservation = storedReservation(ap.reservation);
      check(ap.ap_kind === 'say' && ap.status === 'completed' && reservation?.kind === 'merge'
        && ['requested','integrated'].includes(reservation.status), 'no completed merge request for this say AP');
      check(reservation.commit === commit && reservation.baseline === baseline,
        'approval does not match the frozen request commit and parent baseline');
      const parent = this.store.ap(ap.parent_id);
      check(['main','owner'].includes(parent.ap_kind) && reservation.parent_id === parent.id,
        'only a direct main/owner AP merge request can be approved by a user');
      const lock = this.branchFreeze(parent.branch);
      check(!lock || (lock.kind === 'delivery' && lock.ap_id === ap.id),
        lock ? `branch ${parent.branch} is frozen: ${lock.reason}; cannot approve another delivery` : '');
      const state = await this.workspaces.branchState(ap.branch);
      check(state.parent === parent.branch && state.child_head === commit, 'requested source branch moved; review it again');
      // 固定提交已经在父分支里（用户手工合入、或另一个请求把它带了进去）：批准退化成幂等记账，不再要求旧基线。
      const contained = state.parent_head
        ? await this.workspaces.isAncestor(this.config.project, commit, state.parent_head) : false;
      if (!contained) {
        if (state.parent_head && !(await this.workspaces.isAncestor(this.config.project, state.parent_head, commit)))
          this.noteReservationBlocked(ap.id, parentMovedReason(parent.branch, state.parent_head, commit), 'parent_moved');
        check(state.parent_head === baseline || state.parent_head === commit,
          'parent branch moved since the request; the old approval cannot advance it');
      }
      if (reservation.status === 'integrated') {
        check(state.parent_head === commit, 'recorded integration no longer matches parent branch');
        return { ap: this.store.ap(ap.id), parent: this.store.ap(parent.id), already_integrated: true };
      }
      this.store.event(ap.id, 'ap.merge_approved', { commit, baseline, parent_id: parent.id });
      const outcome = await this.workspaces.mergeBranchUnsafe(ap.branch, commit, state.parent_head);
      check(outcome.merged || outcome.already_integrated, 'approval requires a clean fast-forward');
      this.store.transaction(() => {
        const current = storedReservation(this.store.ap(ap.id).reservation);
        check(current?.status === 'requested' && current.commit === commit, 'request changed during approval');
        const { blocked_reason: _blocked, blocked_code: _blockedCode, ...cleanCurrent } = current;
        this.store.update(ap.id, { integration: 'merged', integration_error: null,
          reservation: JSON.stringify({ ...cleanCurrent, status: 'integrated', integrated_at: new Date().toISOString() }) });
        this.store.update(parent.id, { head_commit: commit });
        this.store.event(ap.id, 'ap.merge_integrated', { commit, baseline, parent_id: parent.id,
          already_integrated: outcome.already_integrated === true });
      });
      return { ap: this.store.ap(ap.id), parent: this.store.ap(parent.id), merge: outcome };
    });
  },

  /** A live parent Agent confirms one pinned child commit; only ff-only child→direct-parent is allowed. */
  async integrateChild(parentId, childId, commit) {
    const parent = this.store.ap(id(parentId)), child = this.store.ap(id(childId));
    const delivery = child.ap_kind === 'say' ? storedReservation(child.reservation) : null;
    check(['say','child'].includes(parent.ap_kind) && child.parent_id === parent.id
      && (child.ap_kind === 'child' || (delivery?.kind === 'merge' && delivery.status === 'requested')),
      'only a direct child or requested say AP of a new AP can be integrated');
    check(parent.status === 'running', 'parent Agent must be running to confirm child integration');
    check(child.status === 'completed', 'child must complete before integration');
    check(child.branch && child.target_branch === parent.branch, 'child branch has no matching parent');
    check(typeof commit === 'string' && /^[0-9a-f]{40,64}$/.test(commit) && commit === child.head_commit
      && (!delivery || delivery.commit === commit),
      'confirm the completed child’s fixed head_commit, not a moving branch');
    // 交付锁：父分支上还有别的未集成请求时，只有那个请求自己的集成能写这条分支。
    const lock = this.branchFreeze(parent.branch);
    check(!lock || (lock.kind === 'delivery' && lock.ap_id === child.id),
      lock ? `branch ${parent.branch} is frozen: ${lock.reason}; cannot integrate another AP` : '');
    return this.workspaces.exclusive(async () => {
      const state = await this.workspaces.branchState(child.branch);
      check(state.parent === parent.branch && state.child_head === commit,
        'child branch moved after its completed commit; inspect it before integrating');
      // 父分支在本请求期间自己前进了：如实记成失效，而不是等最后一句“不能快进”。
      if (delivery && state.parent_head && !(await this.workspaces.isAncestor(this.config.project, commit, state.parent_head))
        && !(await this.workspaces.isAncestor(this.config.project, state.parent_head, commit)))
        this.noteReservationBlocked(child.id, parentMovedReason(parent.branch, state.parent_head, commit), 'parent_moved');
      const resolution = this.store.get("SELECT data FROM events WHERE ap_id=? AND type='ap.divergence_resolution_requested' ORDER BY id DESC LIMIT 1", child.id);
      let repaired = null;
      if (resolution) {
        const fixed = JSON.parse(resolution.data);
        check(fixed.source_commit === child.base_commit,
          'divergence resolution child has a mismatched frozen base commit');
        if (fixed.source_ap_id === parent.id) {
          // say 自身分歧：被修复的就是这个父 AP 的交付。
          check(parent.ap_kind === 'say', 'a say-only divergence resolution cannot be integrated here');
        } else {
          const source = this.store.ap(fixed.source_ap_id);
          check(source.parent_id === parent.id && source.ap_kind === 'child' && source.status === 'completed'
            && source.integration !== 'merged' && fixed.source_commit === source.head_commit,
          'divergence resolution must repair a completed direct child of this parent');
          repaired = source;
        }
        check(await this.workspaces.isAncestor(this.config.project, fixed.source_commit, commit)
          && await this.workspaces.isAncestor(this.config.project, fixed.parent_commit, commit),
        'resolution child must contain both frozen source and parent commits before integration');
      }
      check(this.store.ap(parent.id).status === 'running', 'parent Agent stopped before integration');
      this.store.event(parent.id, 'child.integration_requested', { child: child.id, commit, baseline: state.parent_head });
      const outcome = await this.workspaces.mergeBranchUnsafe(child.branch, commit);
      check(outcome.merged || outcome.already_integrated, 'child integration needs a clean fast-forward');
      this.store.transaction(() => {
        const { blocked_reason: _blocked, blocked_code: _blockedCode, ...cleanDelivery } = delivery ?? {};
        this.store.update(child.id, { integration: 'merged', integration_error: null,
          ...(delivery ? { reservation: JSON.stringify({ ...cleanDelivery, status: 'integrated', integrated_at: new Date().toISOString() }) } : {}) });
        this.store.update(parent.id, { head_commit: outcome.landed ?? commit });
        this.store.event(parent.id, 'child.integrated', { child: child.id, commit,
          baseline: state.parent_head, already_integrated: outcome.already_integrated === true });
        // 解分歧子 AP 落地后，它修复的那个已完子 AP 也一并结算：两者都在父分支里了。
        if (repaired) {
          this.store.update(repaired.id, { integration: 'merged', integration_error: null });
          this.store.event(repaired.id, 'child.integrated_via_resolution', { resolution: child.id, commit,
            source_commit: repaired.head_commit, parent_id: parent.id });
        }
      });
      return { child: this.store.ap(child.id), parent: this.store.ap(parent.id), merge: outcome };
    });
  },

  /** Every new say is one Input and one branch-owning AP, regardless of whether it writes code. */
  say(content = undefined, branch = null, references = [], draftId = null) {
    return this.write('send this say', () => this.sendSay(content, branch, references, draftId));
  },

  /** The body of say(); runs under the clear gate so an anchor created before a clear cannot commit after its purge. */
  async sendSay(content = undefined, branch = null, references = [], draftId = null) {
    let draft = null, draftReferences = null;
    if (draftId !== null && draftId !== undefined) {
      check(content === undefined && references.length === 0, 'draft_id cannot be combined with content or references');
      draft = this.store.draft(id(draftId));
      check(draft.input_id === null, `draft ${draft.id} was already submitted as input ${draft.input_id}`);
      draftReferences = this.store.draftReferences(draft.id);
      content = draft.content;
      references = draftReferences;
    }
    text(content, 'input');
    const normalized = this.normalizeReferences(references);
    if (branch !== null && branch !== undefined) text(branch, 'branch');
    const target = branch ?? await this.workspaces.git(this.config.project, 'symbolic-ref', '--short', 'HEAD')
      .catch(() => { throw new Error('select a local parent branch before sending from detached HEAD'); });
    this.assertBranchWritable(target, 'create a new ap on it');
    if (target === 'main') await this.ensureMainAP();
    const owner = this.store.all("SELECT * FROM aps WHERE branch=? AND ap_kind IN ('main','owner','say') ORDER BY id", target);
    check(owner.length === 1, `branch ${target} needs exactly one explicitly bound AP before say`);
    const parent = owner[0];
    check(!TERMINAL.has(parent.status), `parent AP #${parent.id} has ended; select an active parent AP`);
    check(parent.ap_kind !== 'say' || storedReservation(parent.reservation)?.status !== 'started',
      'parent say AP is presenting its frozen commit; select another bound branch');
    // anchorInput always passes the chosen ref, never the possibly changed process HEAD.
    const { inputId, anchor } = await this.anchorInput(target);
    let ruleAPId = null;
    try {
      const rule = await readInputRule(this.workspaces, this.config.project, anchor.commit);
      // Git was asynchronous: a clear may have started while the anchor was being created.
      this.assertWritable('send this say');
      const result = this.store.transaction(() => {
        const current = this.store.ap(parent.id);
        check(!TERMINAL.has(current.status) && current.branch === target, 'parent AP changed while creating the worktree');
        if (draft) {
          const live = this.store.draft(draft.id);
          check(live.input_id === null && live.content === draft.content
            && JSON.stringify(this.store.draftReferences(draft.id)) === JSON.stringify(draftReferences),
            `draft ${draft.id} changed while being submitted; retry with its latest contents`);
        }
        this.store.run(`INSERT INTO inputs(id,content,anchor_branch,anchor_commit,anchor_workspace,anchor_target_branch)
          VALUES (?,?,?,?,?,?)`, inputId, content, anchor.branch, anchor.commit, anchor.workspace, anchor.target);
        this.store.setInputReferences(inputId, normalized.map(reference => ({ segment: 1, reference })));
        const ap = this.store.create({ parent_id: parent.id, input_id: inputId, role: 'agent', goal: content,
          name: `say-${inputId}`, ap_kind: 'say' });
        this.store.update(ap.id, { branch: anchor.branch, workspace: anchor.workspace,
          base_commit: anchor.commit, target_branch: target });
        if (rule !== null) {
          ruleAPId = ap.id;
          saveInputRule(this.config.home, ap.id, rule);
          this.store.event(ap.id, 'ap.input_rule_frozen', { source: '.lush-ap/input.mjs', commit: anchor.commit });
        }
        this.store.run('UPDATE inputs SET ap_id=? WHERE id=?', ap.id, inputId);
        const attached = this.store.run('UPDATE branches SET ap_id=? WHERE branch=? AND ap_id IS NULL', ap.id, anchor.branch);
        check(attached.changes === 1, 'input branch already belongs to another AP');
        if (draft) {
          this.store.run('UPDATE drafts SET input_id=? WHERE id=?', inputId, draft.id);
          this.store.event(ap.id, 'input.draft', { draft_ids: [draft.id] });
        }
        this.store.event(ap.id, 'input.anchor', { input_id: inputId, branch: anchor.branch, commit: anchor.commit,
          target_branch: target, workspace: anchor.workspace, dirty_source: anchor.dirty_source });
        return { id: inputId, content, references: normalized, ap: this.store.ap(ap.id), anchor,
          ...(draft ? { draft: draft.id } : {}) };
      });
      this.kick();
      return result;
    } catch (error) {
      if (ruleAPId !== null) fs.rmSync(snapshotPath(this.config.home, ruleAPId), { force: true });
      await this.workspaces.releaseAnchor(anchor)
        .catch(failure => console.error(`say ${inputId}: anchor cleanup failed: ${failure.message}`));
      throw error;
    }
  },
};
