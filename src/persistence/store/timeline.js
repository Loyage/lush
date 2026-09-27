/** 时间轴原料：AP、生命周期事件与子 AP 存活区间。 */
export const timeline = {
  /** 时间轴原料：最近 limit 个 AP，按 id 升序（画图从左到右）。 */
  timelineAPs(limit) {
    return this.all(`SELECT id,parent_id,input_id,role,name,status,integration,created_at,updated_at
      FROM (SELECT * FROM aps WHERE layer='work' ORDER BY id DESC LIMIT ?) ORDER BY id`, limit);
  },
  /** 这些 AP 的生命周期事件：invocation.started→invocation.completed 就是"真的在跑"的区间。 */
  lifecycleEvents(apIds) {
    if (!apIds.length) return [];
    const holes = apIds.map(() => '?').join(',');
    return this.all(`SELECT ap_id, type, created_at FROM events
      WHERE ap_id IN (${holes}) AND type IN ('invocation.started','invocation.completed','completed','failed','cancelled')
      ORDER BY ap_id, id`, ...apIds);
  },
  /** 这些 AP 的子 AP 存活区间：父 AP 停着不动时，可能是在等子 AP，而不是在等槽。 */
  childSpans(apIds) {
    if (!apIds.length) return [];
    const holes = apIds.map(() => '?').join(',');
    return this.all(`SELECT parent_id, id, created_at,
        (SELECT MAX(e.created_at) FROM events e WHERE e.ap_id=aps.id AND e.type IN ('completed','failed','cancelled')) AS terminal_at
      FROM aps WHERE parent_id IN (${holes}) ORDER BY id`, ...apIds);
  },
};
