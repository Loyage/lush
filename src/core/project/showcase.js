import fs from 'node:fs';
import path from 'node:path';
import { check, TERMINAL, bounded } from '../types.js';
import { startPreview } from '../preview.js';

const previewView = entry => entry ? { status: entry.status, url: entry.status === 'running' ? entry.url : null,
  command: entry.command, log_path: entry.log_path, error: entry.error } : { status: 'stopped', url: null };

export default {
  async showcaseEligibility(branch, baseline = null, excludeAPId = null, ownerSayId = null) {
    const history = this.store.all(`SELECT id,status,showcase FROM aps WHERE role='showcase'
      AND json_extract(showcase,'$.branch')=? ORDER BY id DESC`, branch);
    const latest_ap_id = history[0]?.id ?? null;
    try {
      check(!this.stopping, 'daemon is stopping');
      const active = history.find(ap => ap.id !== excludeAPId && (!TERMINAL.has(ap.status) || this.running.has(ap.id)));
      check(!active, `showcase #${active?.id} is still active`);
      const record = this.store.branch(branch);
      check(record?.parent && record.created_from_commit, '效果展示仅开放给已登记且有明确父分支和基线的分支');
      const subtree = new Set([branch]);
      const records = this.store.branches();
      for (const name of subtree) for (const child of records) {
        if (child.parent === name && !['archived', 'deleted'].includes(child.status)) subtree.add(child.branch);
      }
      const inputs = new Set(this.store.all('SELECT id,anchor_branch FROM inputs').filter(input => subtree.has(input.anchor_branch)).map(input => input.id));
      const assertStable = () => {
        const owners = new Set(records.filter(row => subtree.has(row.branch)).map(row => row.ap_id).filter(Boolean));
        const related = this.store.all('SELECT id,parent_id,input_id,role,status,branch,target_branch,integration,plan_gate,ap_kind FROM aps');
        for (const ap of related) if (subtree.has(ap.branch) || inputs.has(ap.input_id)) owners.add(ap.id);
        // Queued descendants may not yet have a branch. Recompute after asynchronous Git reads too.
        let changed = true;
        while (changed) {
          changed = false;
          for (const ap of related) if (owners.has(ap.parent_id) && !owners.has(ap.id)) { owners.add(ap.id); changed = true; }
        }
        for (const ap of related) {
          if (['showcase', 'explainer'].includes(ap.role)) continue;
          if (!owners.has(ap.id) && !subtree.has(ap.target_branch)) continue;
          // The sole reserved say owner is deliberately development-done but not terminal:
          // it must remain alive while its new showcase child runs. Legacy callers pass no ownerSayId.
          if (ap.id === ownerSayId && ap.branch === branch && ap.status === 'waiting'
            && !this.running.has(ap.id) && !this.workspaces.busy.has(ap.id)) {
            const reserved = this.store.ap(ap.id).reservation;
            if (ap.role === 'agent' && ap.ap_kind === 'say' && reserved) {
              const value = JSON.parse(reserved);
              if (value.kind === 'showcase' && ['pending','preparing'].includes(value.status)) continue;
            }
          }
          check(ap.role === 'verifier' ? TERMINAL.has(ap.status) : ap.status === 'completed',
            `相关 AP #${ap.id} 尚未成功完成，分支暂不稳定`);
          check(!this.running.has(ap.id) && !this.workspaces.busy.has(ap.id), `相关 AP #${ap.id} 仍在收尾`);
          check(!['merging', 'conflict'].includes(ap.integration) && ap.plan_gate !== 'proposed', `相关 AP #${ap.id} 仍有待处理的规划或合并`);
        }
        for (const id of inputs) check(!this.store.get("SELECT id FROM ap_specs WHERE input_id=? AND status='pending' LIMIT 1", id), '输入仍有未编排的开发计划');
        for (const name of subtree) {
          const blockers = this.workspaces.branchAPBlockers(name).filter(item => !(name === branch && item === `ap:#${ownerSayId}`));
          check(blockers.length === 0, '分支仍有待完成的关联 AP');
        }
      };
      assertStable();
      const snapshot = await this.workspaces.showcaseSnapshot(branch, baseline);
      for (const name of subtree) {
        if (name === branch) continue;
        const head = await this.workspaces.git(this.config.project, 'rev-parse', '--verify', `refs/heads/${name}^{commit}`);
        check(await this.workspaces.isAncestor(this.config.project, head, snapshot.commit), `子分支 ${name} 尚未收拢`);
      }
      if (subtree.size > 1) await this.workspaces.showcaseCleanBranches([...subtree]);
      for (const ap of history) {
        if (ap.status !== 'completed') continue;
        const previous = JSON.parse(ap.showcase);
        const tree = previous.tree ?? await this.workspaces.showcaseTree(previous.commit);
        check(tree !== snapshot.tree, `相同代码已成功展示 #${ap.id}，代码内容变化后才可再次展示`);
      }
      check(await this.workspaces.git(this.config.project, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`) === snapshot.commit,
        '分支提交已变化，请刷新后重试');
      assertStable(); // No async gap between the final DB check and admission.
      check(!this.stopping, 'daemon is stopping');
      return { allowed: true, reason: null, latest_ap_id, snapshot };
    } catch (error) {
      return { allowed: false, reason: error.message, latest_ap_id };
    }
  },

  /** 已解析的分支预约记录（损坏 / 缺失时为 null）。 */
  showcaseReservation(branch) {
    const raw = this.store.branch(branch)?.showcase_reservation;
    if (!raw) return null;
    try { const value = JSON.parse(raw); return value && typeof value === 'object' ? value : null; } catch { return null; }
  },

  /** 预约事件挂到哪个 AP 上：优先分支原属 AP，否则输入锚点的规划 AP（与 branch.merged 同口径）。 */
  showcaseEventHost(branch) {
    const owner = this.store.branch(branch)?.ap_id ?? null;
    if (owner !== null && this.store.get('SELECT id FROM aps WHERE id=?', owner)) return owner;
    return this.store.get('SELECT ap_id FROM inputs WHERE anchor_branch=? ORDER BY id DESC LIMIT 1', branch)?.ap_id ?? null;
  },

  /**
   * 预约的静态可预约面：只看 store，不跑 Git。真实的准入（ref、脏工作区、代码树去重等）留给
   * showcaseEligibility 在启动前复核，所以这里只回答「是否值得先记下预约」。
   */
  showcaseReservable(branch) {
    if (typeof branch !== 'string' || branch.length === 0 || branch.length > 512) return { allowed: false, reason: 'invalid showcase branch' };
    const record = this.store.branch(branch);
    if (!record) return { allowed: false, reason: '效果展示仅开放给已登记且有明确父分支和基线的分支' };
    if (record.status !== 'active') return { allowed: false, reason: '已归档或删除的分支不能预约效果展示' };
    if (!record.parent || record.parent_relation !== 'recorded' || !record.created_from_commit) {
      return { allowed: false, reason: '效果展示仅开放给已登记且有明确父分支和基线的分支' };
    }
    if (['main', 'master'].includes(branch)) return { allowed: false, reason: '主干分支不开放效果展示' };
    const history = this.store.all(`SELECT id,status FROM aps WHERE role='showcase'
      AND json_extract(showcase,'$.branch')=? ORDER BY id DESC`, branch);
    const active = history.find(ap => !TERMINAL.has(ap.status) || this.running.has(ap.id));
    if (active) return { allowed: false, reason: `showcase #${active.id} is still active` };
    return { allowed: true, reason: null };
  },

  /**
   * 预约展示的第一阶段快照：只固定「现在」这条分支的提交，供展示 Agent 提前理解代码与准备方案。
   * 不做完整准入（允许暂无文件改动、允许相关 AP 仍在跑），最终提交与准入留给 showcaseEligibility 在信号时复核。
   */
  async showcasePreparation(branch) {
    check(typeof branch === 'string' && branch.length > 0 && branch.length <= 512, 'invalid showcase branch');
    const record = this.store.branch(branch);
    check(record?.parent && record.parent_relation === 'recorded' && record.created_from_commit,
      '效果展示仅开放给已登记且有明确父分支和基线的分支');
    check(record.status === 'active', '已归档或删除的分支不能预约效果展示');
    check(!['main', 'master'].includes(branch), '主干分支不开放效果展示');
    const project = this.config.project;
    await this.workspaces.git(project, 'check-ref-format', `refs/heads/${branch}`);
    await this.workspaces.git(project, 'show-ref', '--verify', `refs/heads/${branch}`);
    const commit = await this.workspaces.git(project, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`);
    return { version: 1, branch, commit, tree: await this.workspaces.showcaseTree(commit),
      baseline_branch: record.parent, baseline_commit: record.created_from_commit };
  },

  /**
   * 预约一条分支的效果展示。重复预约幂等（已有 pending 预约就直接返回，不报错、不重复写事件）。
   * 写入后若当前就已通过完整准入，立即转入 startShowcase；否则挂起，由 sweep 在触发点重扫。
   */
  async reserveShowcase(branch) {
    check(typeof branch === 'string' && branch.length > 0 && branch.length <= 512, 'invalid showcase branch');
    const existing = this.showcaseReservation(branch);
    if (existing?.status === 'pending') return { branch, reserved: true, ap_id: null, reason: null };
    const reservable = this.showcaseReservable(branch);
    check(reservable.allowed, reservable.reason);
    const reservation = { version: 1, created_at: new Date().toISOString(), status: 'pending' };
    this.store.setBranchShowcaseReservation(branch, reservation);
    this.store.event(this.showcaseEventHost(branch), 'showcase.reserved', { branch, created_at: reservation.created_at });
    const eligibility = await this.showcaseEligibility(branch);
    if (!eligibility.allowed) {
      this.scheduleShowcaseSweep();
      return { branch, reserved: true, ap_id: null, reason: eligibility.reason };
    }
    try {
      const ap = await this.startShowcase(branch);
      return { branch, reserved: true, ap_id: ap.id, reason: null };
    } catch (error) {
      // 与初审之间的竞态（准入变化等）：保留预约，交给下一次触发重扫。
      this.scheduleShowcaseSweep();
      return { branch, reserved: true, ap_id: null, reason: error.message };
    }
  },

  /** 清除预约并留一条 `showcase.unreserved` 事件；没有预约时幂等空操作。 */
  unreserveShowcase(branch) {
    check(typeof branch === 'string' && branch.length > 0 && branch.length <= 512, 'invalid showcase branch');
    if (!this.store.branch(branch)) return { branch, reserved: false };
    if (!this.showcaseReservation(branch)) return { branch, reserved: false };
    this.store.setBranchShowcaseReservation(branch, null);
    this.store.event(this.showcaseEventHost(branch), 'showcase.unreserved', { branch });
    return { branch, reserved: false };
  },

  /**
   * 单飞调度一次预约重扫：已有 sweep 在跑就只记一个「再来一次」，跑完再补一轮。
   * 不挂在 pump 的每次调用上——只有明确的触发点（结算、预约、恢复、归档、合并/跟上）才调度。
   */
  scheduleShowcaseSweep() {
    // No new showcase work is started in the core API. Preserve old reservations on disk.
  },

  /** 遍历全部 pending 预约：通过完整准入的清除预约并启动展示，其余保持 pending（阻塞原因由 graph 现算）。 */
  async sweepShowcaseReservations() {
    const started = [], pending = [];
    if (this.stopping) return { started, pending };
    for (const { branch } of this.store.branchShowcaseReservations()) {
      if (this.stopping) break;
      if (!this.showcaseReservation(branch)) continue; // 已被手动启动或取消
      const eligibility = await this.showcaseEligibility(branch);
      if (!eligibility.allowed) { pending.push({ branch, reason: eligibility.reason }); continue; }
      try {
        const ap = await this.startShowcase(branch);
        started.push({ branch, ap_id: ap.id });
      } catch (error) {
        pending.push({ branch, reason: error.message });
      }
    }
    return { started, pending };
  },

  async retryShowcase(apId) {
    const ap = await this.workspaces.exclusive(async () => {
      const current = this.store.ap(apId);
      check(current.ap_kind !== 'showcase', 'a reserved say showcase cannot be retried under its ended parent; submit a new say');
      check(['failed', 'cancelled'].includes(current.status), 'only failed/cancelled aps can be retried');
      check(!this.running.has(apId) && !this.workspaces.busy.has(apId), 'showcase is still stopping; retry shortly');
      check(!this.workspaces.previewActive(apId), 'preview is still stopping; retry shortly');
      const frozen = JSON.parse(current.showcase);
      const eligibility = await this.showcaseEligibility(frozen.branch, null, apId);
      check(eligibility.allowed, eligibility.reason);
      check(eligibility.snapshot.tree === (frozen.tree ?? await this.workspaces.showcaseTree(frozen.commit)),
        '分支代码已变化，请从分支详情启动新展示，而不是重试旧版本');
      this.store.update(apId, { status: 'queued', error: null, result: null, calls: 0 });
      this.store.event(apId, 'retry', {});
      return this.store.ap(apId);
    });
    this.kick();
    return ap;
  },

  async startShowcase(branch, baseline = null) {
    check(!this.stopping, 'daemon is stopping');
    // Pin and deduplicate in the same serialized Git interval. Source worktrees are never modified.
    const ap = await this.workspaces.exclusive(async () => {
      check(typeof branch === 'string' && branch.length > 0 && branch.length <= 512, 'invalid showcase branch');
      const eligibility = await this.showcaseEligibility(branch, baseline);
      check(eligibility.allowed, eligibility.reason);
      const { snapshot } = eligibility;
      check(this.store.activeAPs().length < 1000, 'too many active aps');
      const input = this.store.get('SELECT id FROM inputs WHERE anchor_branch=? ORDER BY id DESC LIMIT 1', branch);
      const reservation = this.showcaseReservation(branch);
      return this.store.transaction(() => {
        const created = this.store.create({ role: 'showcase', input_id: input?.id ?? null, name: 'showcase', showcase: snapshot,
          goal: `效果展示：${branch}\n分析固定提交 ${snapshot.commit} 相对 ${snapshot.baseline_commit} 的修改，设计最直观的展示方案并实际执行，交付展示页和适合的可运行预览。展示不是验收通过，不自动合并。` });
        if (reservation?.status === 'pending') this.store.setBranchShowcaseReservation(branch, null);
        this.store.event(created.id, 'showcase.requested', snapshot);
        // 预约触发的展示：预约已消费，另留一条事件串起原始预约时间。
        if (reservation?.status === 'pending') this.store.event(created.id, 'showcase.reservation_started', { branch, created_at: reservation.created_at });
        return created;
      });
    });
    this.kick();
    return this.inspect(ap.id);
  },

  showcases(branch = null) {
    check(branch === null || (typeof branch === 'string' && branch.length <= 512), 'invalid showcase branch');
    return bounded(this.store.all(`SELECT id,status,showcase,updated_at FROM aps WHERE role='showcase'
      ${branch === null ? '' : "AND json_extract(showcase,'$.branch')=?"} ORDER BY id DESC LIMIT 50`, ...(branch === null ? [] : [branch]))
      .map(ap => ({ id: ap.id, status: ap.status, updated_at: ap.updated_at, ...JSON.parse(ap.showcase),
        has_report: this.hasReport(ap.id), preview: this.previewStarting.has(ap.id) ? { status: 'starting', url: null } : previewView(this.previews.get(ap.id)) })), 100000);
  },

  showcaseContext(ap) {
    check(ap.role === 'showcase' && ap.showcase, 'AP is not a showcase');
    return { ...JSON.parse(ap.showcase), workspace: ap.workspace, baseline_workspace: ap.baseline_workspace,
      report_path: this.reportPath(ap.id), directory: path.dirname(this.reportPath(ap.id)),
      has_report: this.hasReport(ap.id), preview: this.previewStarting.has(ap.id) ? { status: 'starting', url: null } : previewView(this.previews.get(ap.id)) };
  },

  prepareShowcaseReport(ap, runId) {
    const file = this.reportPath(ap.id);
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true });
    check(fs.realpathSync(directory) === directory, 'showcase directory cannot be a symlink');
    // A retry/wake must deliver its own report; preserve, but never silently reuse, an older attempt.
    if (fs.existsSync(file)) fs.renameSync(file, path.join(directory, `report-before-run-${runId}.html`));
  },

  showcaseReport(ap) {
    const file = this.reportPath(ap.id);
    check(fs.existsSync(file), 'showcase must deliver report.html; explain any unavailable demonstrations in the report');
    const stat = fs.lstatSync(file);
    check(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 8 * 1024 * 1024,
      'showcase report must be a non-empty regular HTML file no larger than 8 MiB');
    check(fs.realpathSync(file) === file, 'showcase report cannot use symlink directories');
    return { schema_version: 1, ...JSON.parse(ap.showcase), report: file,
      preview: previewView(this.previews.get(ap.id)), verification: 'not_performed' };
  },

  async startShowcasePreview(apId, command, urlPath = '/') {
    const ap = this.store.ap(apId);
    check(ap.role === 'showcase' && ap.status === 'running' && !this.stopping, 'only a running showcase can start a preview');
    check(ap.workspace && fs.existsSync(ap.workspace), 'showcase checkout is unavailable');
    check(!this.previewStarting.has(ap.id) && !['running','starting','stopping'].includes(this.previews.get(ap.id)?.status), 'stop the existing preview first');
    check(this.previewStarting.size + [...this.previews.values()].filter(entry => ['running','stopping'].includes(entry.status)).length < 8,
      'at most 8 previews may run; stop one first');
    const run = this.running.get(ap.id);
    check(run && !run.parked && !run.controller.signal.aborted, 'showcase invocation is no longer active');
    const controller = new AbortController();
    const abort = () => controller.abort();
    run.controller.signal.addEventListener('abort', abort, { once: true });
    this.previewStarting.set(ap.id, controller);
    this.store.event(ap.id, 'showcase.preview_starting', {});
    try {
      controller.promise = startPreview({ cwd: ap.workspace, command, urlPath, directory: path.dirname(this.reportPath(ap.id)), signal: controller.signal,
        onChange: value => {
          if (!this.store.get('SELECT id FROM aps WHERE id=?', ap.id)) return;
          // Keep only the read model, not closed child handles and their log buffers.
          this.previews.set(ap.id, { ...previewView(value), stop: async () => {} });
          this.store.event(ap.id, 'showcase.preview_stopped', { status: value.status, error: value.error });
          this.store.touch(ap.id);
        } });
      const entry = await controller.promise;
      this.previews.set(ap.id, entry);
      if (this.stopping || controller.signal.aborted || run.parked || this.running.get(ap.id) !== run || TERMINAL.has(this.store.ap(ap.id).status)) {
        await entry.stop();
        check(false, 'showcase stopped while starting preview');
      }
      this.store.event(ap.id, 'showcase.preview_started', previewView(entry));
      this.store.touch(ap.id);
      return previewView(entry);
    } finally {
      run.controller.signal.removeEventListener('abort', abort);
      this.previewStarting.delete(ap.id);
      this.store.touch(ap.id);
    }
  },

  async stopShowcasePreview(apId) {
    check(this.store.ap(apId).role === 'showcase', 'AP is not a showcase');
    const starting = this.previewStarting.get(apId);
    starting?.abort();
    if (starting?.promise) await starting.promise.catch(() => {});
    const entry = this.previews.get(apId);
    if (entry) await entry.stop();
    return { id: apId, preview: previewView(entry) };
  },
};
