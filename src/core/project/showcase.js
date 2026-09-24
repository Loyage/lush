import fs from 'node:fs';
import path from 'node:path';
import { check, TERMINAL, bounded } from '../types.js';
import { startPreview } from '../preview.js';

const previewView = entry => entry ? { status: entry.status, url: entry.status === 'running' ? entry.url : null,
  command: entry.command, log_path: entry.log_path, error: entry.error } : { status: 'stopped', url: null };

export default {
  async showcaseEligibility(branch, baseline = null, excludeTaskId = null) {
    const history = this.store.all(`SELECT id,status,showcase FROM tasks WHERE role='showcase'
      AND json_extract(showcase,'$.branch')=? ORDER BY id DESC`, branch);
    const latest_task_id = history[0]?.id ?? null;
    try {
      check(!this.stopping, 'daemon is stopping');
      const active = history.find(task => task.id !== excludeTaskId && (!TERMINAL.has(task.status) || this.running.has(task.id)));
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
        const owners = new Set(records.filter(row => subtree.has(row.branch)).map(row => row.task_id).filter(Boolean));
        const related = this.store.all('SELECT id,parent_id,input_id,role,status,branch,target_branch,integration,plan_gate FROM tasks');
        for (const task of related) if (subtree.has(task.branch) || inputs.has(task.input_id)) owners.add(task.id);
        // Queued descendants may not yet have a branch. Recompute after asynchronous Git reads too.
        let changed = true;
        while (changed) {
          changed = false;
          for (const task of related) if (owners.has(task.parent_id) && !owners.has(task.id)) { owners.add(task.id); changed = true; }
        }
        for (const task of related) {
          if (['showcase', 'explainer'].includes(task.role)) continue;
          if (!owners.has(task.id) && !subtree.has(task.target_branch)) continue;
          check(task.role === 'verifier' ? TERMINAL.has(task.status) : task.status === 'completed',
            `相关任务 #${task.id} 尚未成功完成，分支暂不稳定`);
          check(!this.running.has(task.id) && !this.workspaces.busy.has(task.id), `相关任务 #${task.id} 仍在收尾`);
          check(!['merging', 'conflict'].includes(task.integration) && task.plan_gate !== 'proposed', `相关任务 #${task.id} 仍有待处理的规划或合并`);
        }
        for (const id of inputs) check(!this.store.get("SELECT id FROM task_specs WHERE input_id=? AND status='pending' LIMIT 1", id), '输入仍有未编排的开发计划');
        for (const name of subtree) check(this.workspaces.branchTaskBlockers(name).length === 0, '分支仍有待完成的关联任务');
      };
      assertStable();
      const snapshot = await this.workspaces.showcaseSnapshot(branch, baseline);
      for (const name of subtree) {
        if (name === branch) continue;
        const head = await this.workspaces.git(this.config.project, 'rev-parse', '--verify', `refs/heads/${name}^{commit}`);
        check(await this.workspaces.isAncestor(this.config.project, head, snapshot.commit), `子分支 ${name} 尚未收拢`);
      }
      if (subtree.size > 1) await this.workspaces.showcaseCleanBranches([...subtree]);
      for (const task of history) {
        if (task.status !== 'completed') continue;
        const previous = JSON.parse(task.showcase);
        const tree = previous.tree ?? await this.workspaces.showcaseTree(previous.commit);
        check(tree !== snapshot.tree, `相同代码已成功展示 #${task.id}，代码内容变化后才可再次展示`);
      }
      check(await this.workspaces.git(this.config.project, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`) === snapshot.commit,
        '分支提交已变化，请刷新后重试');
      assertStable(); // No async gap between the final DB check and admission.
      check(!this.stopping, 'daemon is stopping');
      return { allowed: true, reason: null, latest_task_id, snapshot };
    } catch (error) {
      return { allowed: false, reason: error.message, latest_task_id };
    }
  },

  /** 已解析的分支预约记录（损坏 / 缺失时为 null）。 */
  showcaseReservation(branch) {
    const raw = this.store.branch(branch)?.showcase_reservation;
    if (!raw) return null;
    try { const value = JSON.parse(raw); return value && typeof value === 'object' ? value : null; } catch { return null; }
  },

  /** 预约事件挂到哪个 task 上：优先分支原属任务，否则输入锚点的规划任务（与 branch.merged 同口径）。 */
  showcaseEventHost(branch) {
    const owner = this.store.branch(branch)?.task_id ?? null;
    if (owner !== null && this.store.get('SELECT id FROM tasks WHERE id=?', owner)) return owner;
    return this.store.get('SELECT task_id FROM inputs WHERE anchor_branch=? ORDER BY id DESC LIMIT 1', branch)?.task_id ?? null;
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
    const history = this.store.all(`SELECT id,status FROM tasks WHERE role='showcase'
      AND json_extract(showcase,'$.branch')=? ORDER BY id DESC`, branch);
    const active = history.find(task => !TERMINAL.has(task.status) || this.running.has(task.id));
    if (active) return { allowed: false, reason: `showcase #${active.id} is still active` };
    return { allowed: true, reason: null };
  },

  /**
   * 预约一条分支的效果展示。重复预约幂等（已有 pending 预约就直接返回，不报错、不重复写事件）。
   * 写入后若当前就已通过完整准入，立即转入 startShowcase；否则挂起，由 sweep 在触发点重扫。
   */
  async reserveShowcase(branch) {
    check(typeof branch === 'string' && branch.length > 0 && branch.length <= 512, 'invalid showcase branch');
    const existing = this.showcaseReservation(branch);
    if (existing?.status === 'pending') return { branch, reserved: true, task_id: null, reason: null };
    const reservable = this.showcaseReservable(branch);
    check(reservable.allowed, reservable.reason);
    const reservation = { version: 1, created_at: new Date().toISOString(), status: 'pending' };
    this.store.setBranchShowcaseReservation(branch, reservation);
    this.store.event(this.showcaseEventHost(branch), 'showcase.reserved', { branch, created_at: reservation.created_at });
    const eligibility = await this.showcaseEligibility(branch);
    if (!eligibility.allowed) {
      this.scheduleShowcaseSweep();
      return { branch, reserved: true, task_id: null, reason: eligibility.reason };
    }
    try {
      const task = await this.startShowcase(branch);
      return { branch, reserved: true, task_id: task.id, reason: null };
    } catch (error) {
      // 与初审之间的竞态（准入变化等）：保留预约，交给下一次触发重扫。
      this.scheduleShowcaseSweep();
      return { branch, reserved: true, task_id: null, reason: error.message };
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
    if (this.stopping) return;
    if (this.showcaseSweeping) { this.showcaseSweepAgain = true; return; }
    this.showcaseSweeping = true;
    queueMicrotask(() => this.sweepShowcaseReservations()
      .catch(error => {
        this.store.event(null, 'showcase.sweep_failed', { error: error.message });
        console.error(`showcase reservation sweep: ${error.stack || error}`);
      })
      .finally(() => {
        this.showcaseSweeping = false;
        if (this.showcaseSweepAgain) { this.showcaseSweepAgain = false; this.scheduleShowcaseSweep(); }
      }));
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
        const task = await this.startShowcase(branch);
        started.push({ branch, task_id: task.id });
      } catch (error) {
        pending.push({ branch, reason: error.message });
      }
    }
    return { started, pending };
  },

  async retryShowcase(taskId) {
    const task = await this.workspaces.exclusive(async () => {
      const current = this.store.task(taskId);
      check(['failed', 'cancelled'].includes(current.status), 'only failed/cancelled tasks can be retried');
      check(!this.running.has(taskId) && !this.workspaces.busy.has(taskId), 'showcase is still stopping; retry shortly');
      check(!this.workspaces.previewActive(taskId), 'preview is still stopping; retry shortly');
      const frozen = JSON.parse(current.showcase);
      const eligibility = await this.showcaseEligibility(frozen.branch, null, taskId);
      check(eligibility.allowed, eligibility.reason);
      check(eligibility.snapshot.tree === (frozen.tree ?? await this.workspaces.showcaseTree(frozen.commit)),
        '分支代码已变化，请从分支详情启动新展示，而不是重试旧版本');
      this.store.update(taskId, { status: 'queued', error: null, result: null, calls: 0 });
      this.store.event(taskId, 'retry', {});
      return this.store.task(taskId);
    });
    this.kick();
    return task;
  },

  async startShowcase(branch, baseline = null) {
    check(!this.stopping, 'daemon is stopping');
    // Pin and deduplicate in the same serialized Git interval. Source worktrees are never modified.
    const task = await this.workspaces.exclusive(async () => {
      check(typeof branch === 'string' && branch.length > 0 && branch.length <= 512, 'invalid showcase branch');
      const eligibility = await this.showcaseEligibility(branch, baseline);
      check(eligibility.allowed, eligibility.reason);
      const { snapshot } = eligibility;
      check(this.store.activeTasks().length < 1000, 'too many active tasks');
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
    return this.inspect(task.id);
  },

  showcases(branch = null) {
    check(branch === null || (typeof branch === 'string' && branch.length <= 512), 'invalid showcase branch');
    return bounded(this.store.all(`SELECT id,status,showcase,updated_at FROM tasks WHERE role='showcase'
      ${branch === null ? '' : "AND json_extract(showcase,'$.branch')=?"} ORDER BY id DESC LIMIT 50`, ...(branch === null ? [] : [branch]))
      .map(task => ({ id: task.id, status: task.status, updated_at: task.updated_at, ...JSON.parse(task.showcase),
        has_report: this.hasReport(task.id), preview: this.previewStarting.has(task.id) ? { status: 'starting', url: null } : previewView(this.previews.get(task.id)) })), 100000);
  },

  showcaseContext(task) {
    check(task.role === 'showcase' && task.showcase, 'task is not a showcase');
    return { ...JSON.parse(task.showcase), workspace: task.workspace, baseline_workspace: task.baseline_workspace,
      report_path: this.reportPath(task.id), directory: path.dirname(this.reportPath(task.id)),
      has_report: this.hasReport(task.id), preview: this.previewStarting.has(task.id) ? { status: 'starting', url: null } : previewView(this.previews.get(task.id)) };
  },

  prepareShowcaseReport(task, runId) {
    const file = this.reportPath(task.id);
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true });
    check(fs.realpathSync(directory) === directory, 'showcase directory cannot be a symlink');
    // A retry/wake must deliver its own report; preserve, but never silently reuse, an older attempt.
    if (fs.existsSync(file)) fs.renameSync(file, path.join(directory, `report-before-run-${runId}.html`));
  },

  showcaseReport(task) {
    const file = this.reportPath(task.id);
    check(fs.existsSync(file), 'showcase must deliver report.html; explain any unavailable demonstrations in the report');
    const stat = fs.lstatSync(file);
    check(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 8 * 1024 * 1024,
      'showcase report must be a non-empty regular HTML file no larger than 8 MiB');
    check(fs.realpathSync(file) === file, 'showcase report cannot use symlink directories');
    return { schema_version: 1, ...JSON.parse(task.showcase), report: file,
      preview: previewView(this.previews.get(task.id)), verification: 'not_performed' };
  },

  async startShowcasePreview(taskId, command, urlPath = '/') {
    const task = this.store.task(taskId);
    check(task.role === 'showcase' && task.status === 'running' && !this.stopping, 'only a running showcase can start a preview');
    check(task.workspace && fs.existsSync(task.workspace), 'showcase checkout is unavailable');
    check(!this.previewStarting.has(task.id) && !['running','starting','stopping'].includes(this.previews.get(task.id)?.status), 'stop the existing preview first');
    check(this.previewStarting.size + [...this.previews.values()].filter(entry => ['running','stopping'].includes(entry.status)).length < 8,
      'at most 8 previews may run; stop one first');
    const run = this.running.get(task.id);
    check(run && !run.parked && !run.controller.signal.aborted, 'showcase invocation is no longer active');
    const controller = new AbortController();
    const abort = () => controller.abort();
    run.controller.signal.addEventListener('abort', abort, { once: true });
    this.previewStarting.set(task.id, controller);
    this.store.event(task.id, 'showcase.preview_starting', {});
    try {
      controller.promise = startPreview({ cwd: task.workspace, command, urlPath, directory: path.dirname(this.reportPath(task.id)), signal: controller.signal,
        onChange: value => {
          if (!this.store.get('SELECT id FROM tasks WHERE id=?', task.id)) return;
          // Keep only the read model, not closed child handles and their log buffers.
          this.previews.set(task.id, { ...previewView(value), stop: async () => {} });
          this.store.event(task.id, 'showcase.preview_stopped', { status: value.status, error: value.error });
          this.store.touch(task.id);
        } });
      const entry = await controller.promise;
      this.previews.set(task.id, entry);
      if (this.stopping || controller.signal.aborted || run.parked || this.running.get(task.id) !== run || TERMINAL.has(this.store.task(task.id).status)) {
        await entry.stop();
        check(false, 'showcase stopped while starting preview');
      }
      this.store.event(task.id, 'showcase.preview_started', previewView(entry));
      this.store.touch(task.id);
      return previewView(entry);
    } finally {
      run.controller.signal.removeEventListener('abort', abort);
      this.previewStarting.delete(task.id);
      this.store.touch(task.id);
    }
  },

  async stopShowcasePreview(taskId) {
    check(this.store.task(taskId).role === 'showcase', 'task is not a showcase');
    const starting = this.previewStarting.get(taskId);
    starting?.abort();
    if (starting?.promise) await starting.promise.catch(() => {});
    const entry = this.previews.get(taskId);
    if (entry) await entry.stop();
    return { id: taskId, preview: previewView(entry) };
  },
};
