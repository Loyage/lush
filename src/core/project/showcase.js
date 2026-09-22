import fs from 'node:fs';
import path from 'node:path';
import { check, TERMINAL, bounded } from '../types.js';
import { startPreview } from '../preview.js';

const previewView = entry => entry ? { status: entry.status, url: entry.status === 'running' ? entry.url : null,
  command: entry.command, log_path: entry.log_path, error: entry.error } : { status: 'stopped', url: null };

export default {
  async startShowcase(branch, baseline = null) {
    check(!this.stopping, 'daemon is stopping');
    // Pin and deduplicate in the same serialized Git interval. Source worktrees are never modified.
    const task = await this.workspaces.exclusive(async () => {
      const snapshot = await this.workspaces.showcaseSnapshot(branch, baseline);
      check(!this.stopping, 'daemon is stopping');
      const active = this.store.get(`SELECT id FROM tasks WHERE role='showcase' AND json_extract(showcase,'$.branch')=?
        AND status NOT IN ('completed','failed','cancelled') LIMIT 1`, branch);
      check(!active, `showcase #${active?.id} is still active`);
      check(this.store.activeTasks().length < 1000, 'too many active tasks');
      const input = this.store.get('SELECT id FROM inputs WHERE anchor_branch=? ORDER BY id DESC LIMIT 1', branch);
      return this.store.transaction(() => {
        const created = this.store.create({ role: 'showcase', input_id: input?.id ?? null, name: 'showcase', showcase: snapshot,
          goal: `效果展示：${branch}\n分析固定提交 ${snapshot.commit} 相对 ${snapshot.baseline_commit} 的修改，设计最直观的展示方案并实际执行，交付展示页和适合的可运行预览。展示不是验收通过，不自动合并。` });
        this.store.event(created.id, 'showcase.requested', snapshot);
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
