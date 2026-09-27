/** AP 树读模型（intent 层提上来当根）。 */
export default {
  tree(apId = null) {
    // AP 树只画 work 层：planner / scheduler 属于意图（见 inputs()），它们的 work 子 AP 直接顶上来当根。
    const raw = this.store.summaries('work');
    const intentParents = new Set(this.store.summaries('intent').map(ap => ap.id));
    const originalParent = new Map(raw.map(ap => [ap.id, ap.parent_id]));
    const aps = this.decorate(raw.map(ap => (ap.parent_id !== null && intentParents.has(ap.parent_id))
      ? { ...ap, parent_id: null } : ap));
    const rows = new Map(aps.map(ap => [ap.id, { ...ap, children: [] }]));
    const roots = [];
    for (const row of rows.values()) {
      // verifier 与 merger 都不是子 AP（终态 AP 不能有活动后代），但界面上挂在它们服务的 AP 下面。
      const parent = row.parent_id ?? row.verifies_ap_id ?? row.resolves_ap_id;
      if (parent !== null && parent !== undefined && rows.has(parent)) rows.get(parent).children.push(row); else roots.push(row);
    }
    if (apId !== null) {
      const target = this.store.ap(apId);
      if (rows.has(target.id)) return rows.get(target.id);
      // 按 id 看 planner / scheduler：它自己不进树，但把它这一批 work 子 AP 挂上来，展开就有内容。
      return { ...this.decorate([target])[0], children: [...rows.values()].filter(row => originalParent.get(row.id) === target.id) };
    }
    return roots;
  }
};
