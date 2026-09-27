import { check, id, layerOf } from '../../core/types.js';

/** aps 表的读写与生命周期字段。 */
export const aps = {
  ap(apId) {
    const ap = this.get('SELECT * FROM aps WHERE id=?', id(apId));
    check(ap, `AP ${apId} not found`);
    return ap;
  },
  aps() { return this.all('SELECT * FROM aps ORDER BY id'); },
  /** layer 省略时给全部 AP（内部用）；'work' 是 AP 树/AP 链的读模型，'intent' 是 planner + scheduler。 */
  summaries(layer = null) {
    return this.all(`SELECT id,parent_id,input_id,role,substr(goal,1,200) AS goal,status,integration,layer,updated_at,
      agent_wakes,agent_last_seen_at,verifies_ap_id,resolves_ap_id,review_candidate_id,progress_plan,ap_kind,reservation FROM aps${layer ? ' WHERE layer=?' : ''} ORDER BY id`,
      ...(layer ? [layer] : []));
  },
  /**
   * 快速路由输入集合：planner 上带 `input.route` 事件（前缀命中、未调用规划模型）的 input id。
   * AP 读模型按 `input_id` 命中它来标「快速路由」，不新增表 / 列，也不改历史数据。
   */
  routedInputIds() {
    return new Set(this.all(`SELECT inputs.id AS id FROM inputs JOIN events ON events.ap_id=inputs.ap_id
      WHERE events.type='input.route'`).map(row => row.id));
  },
  /** Bounded AP pages; all includes planning/control roles without changing stored layers. */
  summaryPage({ active = false, before = null, limit = 50, scope = 'work' } = {}) {
    check(['work', 'all'].includes(scope), 'invalid AP scope');
    const where = ['layer=?']; const params = [];
    if (active) where.push("status IN ('queued','running','waiting','awaiting')");
    else where.push("status IN ('completed','failed','cancelled')");
    if (before !== null) { where.push('id<?'); params.push(before); }
    const index = active ? 'aps_layer_status' : 'aps_layer_id_status';
    // 每层先用已有索引取有界页，再归并；避免跨 layer 的全历史排序。
    const layers = scope === 'all' ? ['work', 'intent'] : ['work'];
    return layers.flatMap(layer => this.all(`SELECT id,parent_id,input_id,role,substr(goal,1,200) AS goal,status,integration,layer,updated_at,
      agent_wakes,agent_last_seen_at,verifies_ap_id,resolves_ap_id,review_candidate_id,progress_plan,ap_kind,reservation FROM aps INDEXED BY ${index}
      WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`, layer, ...params, limit))
      .sort((a, b) => b.id - a.id).slice(0, limit);
  },
  /** APs the scheduler may still touch: a clear has to wait for all of them. */
  activeAPs() {
    return this.all("SELECT id,status FROM aps WHERE status NOT IN ('completed','failed','cancelled') ORDER BY id");
  },
  /**
   * Project-level reset: drops every ap-scoped row plus the input audit trail.
   * Only Project#clear calls this, and only after proving no AP is active, no
   * invocation is still unwinding, and every ended AP has been through the
   * worktree/branch reclamation gates. Whatever those gates kept stays on disk,
   * which is why nextAPId() is pinned first: the retained names must stay unambiguous.
   */
  purge() {
    const counts = {};
    return this.transaction(() => {
      this.setAPIdHigh(Math.max(this.apIdHigh(), this.get('SELECT COALESCE(MAX(id),0) AS value FROM aps').value));
      // 锚点的分支名与目录名带着 input id，所以输入 id 也钉住：清空之后的输入继续往大走。
      this.setInputIdHigh(Math.max(this.inputIdHigh(), this.get('SELECT COALESCE(MAX(id),0) AS value FROM inputs').value));
      // Children of aps/inputs go first; foreign keys are on, so the order is not decorative.
      for (const table of ['artifacts','agent_runs','review_candidates','ap_specs','messages','notices','ap_deps','events','aps','draft_references','input_references','drafts','inputs']) {
        counts[table] = this.get(`SELECT count(*) AS value FROM ${table}`).value;
        this.run(`DELETE FROM ${table}`);
      }
      return counts;
    });
  },
  /**
   * 集合外的行还用外键指着这些 AP 吗（verifier / resolver / 验收候选）。删除前必须先问一遍：
   * aps.parent_id 与 ap_specs.planner_ap_id 是「跟着一起删」的关系，这三个方向不是——
   * 引用方自己会活下来，所以外键会拦住删除。返回人话，直接进错误信息。
   */
  referringAPs(apIds) {
    const ids = apIds.map(value => id(value));
    const marks = ids.map(() => '?').join(',');
    return [
      ...this.all(`SELECT id FROM aps WHERE verifies_ap_id IN (${marks})`, ...ids).map(row => `verifier #${row.id}`),
      ...this.all(`SELECT id FROM aps WHERE resolves_ap_id IN (${marks})`, ...ids).map(row => `resolver #${row.id}`),
      ...this.all(`SELECT id FROM review_candidates WHERE report_ap_id IN (${marks})`, ...ids).map(row => `candidate #${row.id}`),
    ];
  },
  /**
   * 定向删除一组 AP 行：删掉它们自己与 AP 级的子行，集合外一行都不动。
   * 这是除 purge 之外唯一一条删 aps 的路径，调用方（Project#deleteAP）必须已经证明：全部终态、
   * 没有 invocation 还在收尾、磁盘状态已经按 cleanup 的安全门回收完——这里只再断言一次外键引用。
   * 各表的收尾口径：子行（artifacts / agent_runs / messages / notices / events / ap_deps）跟着删，
   * 其中 messages 连「被删 AP 发给别人的」也删（那条消息讲的就是这条 AP）；ap_specs 只有
   * planner_ap_id 有外键，所以只删这批 planner 写的条目。branches.ap_id / inputs.ap_id /
   * ap_specs.ap_id / batch_id 刻意没有外键，保持原样：id 不复用，历史指针不会指错，
   * 读模型按「已清空」处理（见 project/branches.js 与 project/inputs.js 的派生口径）。
   * id 与 purge 一样先钉住 meta.ap_id_high：删过的 id 永不复用。
   */
  deleteAPs(apIds) {
    const ids = [...new Set(apIds.map(value => id(value)))];
    check(ids.length > 0, 'deleteAPs needs at least one AP id');
    const marks = ids.map(() => '?').join(',');
    return this.transaction(() => {
      const referrers = this.referringAPs(ids);
      check(referrers.length === 0, `still referenced by ${referrers.join(', ')}`);
      this.setAPIdHigh(Math.max(this.apIdHigh(), ...ids));
      // 顺序照 purge：先删子行，再删 aps。args 按 where 里的占位符个数传，两条 IN 的用同一份 id 写两遍。
      const drop = (table, where, args = ids) => {
        const rows = this.get(`SELECT count(*) AS value FROM ${table} WHERE ${where}`, ...args).value;
        this.run(`DELETE FROM ${table} WHERE ${where}`, ...args);
        return rows;
      };
      const twice = [...ids, ...ids];
      const counts = { aps: ids.length };
      counts.artifacts = drop('artifacts', `ap_id IN (${marks})`);
      counts.agent_runs = drop('agent_runs', `ap_id IN (${marks})`);
      counts.messages = drop('messages', `ap_id IN (${marks}) OR sender_id IN (${marks})`, twice);
      counts.notices = drop('notices', `ap_id IN (${marks})`);
      counts.events = drop('events', `ap_id IN (${marks})`);
      counts.ap_deps = drop('ap_deps', `ap_id IN (${marks}) OR depends_on IN (${marks})`, twice);
      counts.ap_specs = drop('ap_specs', `planner_ap_id IN (${marks})`);
      this.run(`DELETE FROM aps WHERE id IN (${marks})`, ...ids);
      return counts;
    });
  },
  /** Credentials exist only while their invocation runs; Project#actor is the only reader. */
  armAgent(apId, hash) { this.run('UPDATE aps SET agent_token_hash=? WHERE id=?', hash, apId); },
  /** Last authenticated agent contact; deliberately does not touch updated_at, so it never reorders the tree. */
  touchAgent(apId) { this.run("UPDATE aps SET agent_last_seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", apId); },
  agentByToken(hash) { return this.get('SELECT * FROM aps WHERE agent_token_hash=?', hash); },
  children(apId) { return this.all('SELECT * FROM aps WHERE parent_id=? ORDER BY id', apId); },
  /** Bump the visible timestamp without touching status; used when a verification starts or settles. */
  touch(apId) { this.run("UPDATE aps SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", apId); },
  update(apId, patch) {
    const allowed = ['status','result','error','calls','agent_wakes','workspace','branch','base_commit','head_commit','integration','target_branch','integration_error','baseline_workspace','baseline_commit','plan_gate','review_candidate_id','retry_profile','reservation'];
    check(Object.keys(patch).every(key => allowed.includes(key)), 'invalid AP patch');
    this.run(`UPDATE aps SET ${Object.keys(patch).map(key => `${key}=?`).join(',')}, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`, ...Object.values(patch), apId);
    return this.ap(apId);
  },
  /** Agent 计划是 AP 附属元数据；Project 层负责校验与保留同 key 的完成态。 */
  setProgressPlan(apId, value) {
    this.run("UPDATE aps SET progress_plan=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", JSON.stringify(value), apId);
    return this.ap(apId);
  },
  /** 展示快照在准备/最终阶段之间重新固定；只由展示预约的 Project 层调用。 */
  setShowcase(apId, value) {
    this.run("UPDATE aps SET showcase=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", value === null ? null : JSON.stringify(value), apId);
    return this.ap(apId);
  },
  /** name is the AP's own short slug; it is written once at spawn and never edited, so a worktree keeps its name. */
  create({ parent_id = null, input_id, role, goal, name = null, verifies_ap_id = null, resolves_ap_id = null, review_candidate_id = null, showcase = null, ap_kind = null }) {
    const apId = this.nextAPId();
    const layer = layerOf(role);
    this.run('INSERT INTO aps(id,parent_id,input_id,role,goal,name,verifies_ap_id,resolves_ap_id,review_candidate_id,layer,showcase,ap_kind) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      apId, parent_id, input_id, role, goal, name, verifies_ap_id, resolves_ap_id, review_candidate_id, layer, showcase ? JSON.stringify(showcase) : null, ap_kind);
    const ap = this.ap(apId);
    this.event(ap.id, 'created', { parent_id, role, goal, name, verifies_ap_id, resolves_ap_id, review_candidate_id, layer });
    return ap;
  },
};
