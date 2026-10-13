import { projectHref } from './route.js';
import { agentHelp } from './help.js';

const positiveId = value => Number.isSafeInteger(value) && value > 0;
const uuid = value => typeof value === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
const name = row => `${row.name || '未命名项目'}（${row.project || row.id}）`;
export const safeRestartHelp = agentHelp('一次确认后，中断此 Host 已登记且确认时在线的固定项目，最多等待 15 分钟真实安全退出，逐个安全重启全部后台；全部成功才继续本次新暂停的项目，保留原维护暂停，最后重启界面。原个人暂停、待开始、失败、待验收及父子等待关系不变。不启动离线项目；失败或结果未知立即停止，不重试、撤销或强杀。离页停止后续操作；界面重启可能要求重新登录，请先保存输入。');

function maintenance(row) {
  const value = row.summary?.maintenance;
  if (!value || typeof value.paused !== 'boolean' || typeof value.ready_to_restart !== 'boolean'
    || !['running', 'pausing', 'paused'].includes(value.phase)
    || (row.summary.maintenance_paused !== undefined && row.summary.maintenance_paused !== value.paused)) {
    throw new Error(`${name(row)} 缺少有效原暂停字段或维护状态`);
  }
  const empty = value.batch_id === null && value.completion_state === null && value.completion_notice_id === null;
  const batch = uuid(value.batch_id) && ['pending', 'completed', 'cancelled'].includes(value.completion_state)
    && (value.completion_notice_id === null || positiveId(value.completion_notice_id));
  if ((!empty && !batch) || (value.paused && (!batch || value.phase === 'running' || value.completion_state === 'cancelled'))
    || (!value.paused && (value.phase !== 'running' || (!empty && value.completion_state !== 'cancelled')))
    || (value.completion_state === 'completed' && !positiveId(value.completion_notice_id))
    || (value.completion_state === 'pending' && value.completion_notice_id !== null)) {
    throw new Error(`${name(row)} 批次字段缺失、撤销或结果未知`);
  }
  return value;
}
function sources(rows) {
  if (!Array.isArray(rows)) throw new Error('项目状态读面无效');
  const map = new Map();
  for (const row of rows) {
    projectHref(row.id);
    if (map.has(row.id)) throw new Error('项目状态包含重复身份');
    map.set(row.id, row);
  }
  return map;
}

// Browser-owned, invocation-local authorization only. No Host scheduler or persisted recovery.
export async function safeRestartFlow({ request, confirm, checkPage, signal, recover, reload,
  onScope = () => {}, progress = () => {}, now = Date.now,
  schedule = (fn, ms) => setTimeout(fn, ms), unschedule = id => clearTimeout(id), observationTimeout = 15 * 60 * 1000 }) {
  const records = [];
  let stage = '确认', current = null, hostPid = null, hostAttempted = false, hostAccepted = false;
  const check = () => { if (signal.aborted) throw new Error('页面已离开或流程已停止'); checkPage(); };
  // Race the transport as well as aborting it: late responses cannot authorize the next write.
  const bounded = (work, timeout) => new Promise((resolve, reject) => {
    const controller = new AbortController(); let settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true; unschedule(timer); signal.removeEventListener('abort', cancel);
      controller.abort(); error ? reject(error) : resolve(value);
    };
    const cancel = () => finish(new Error('页面已离开或流程已停止'));
    const timer = schedule(() => finish(new Error('等待超时，结果未确认')), timeout);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) { cancel(); return; }
    Promise.resolve().then(() => { check(); return work(controller.signal); }).then(value => finish(null, value), finish);
  });
  const read = (route, timeout = 10000) => bounded(s => request(route, { signal: s }), timeout);
  const write = (route, body = {}) => bounded(s => request(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: s }), 30000);
  const hostCheck = async () => {
    check(); const host = await read('/api/host', 4000); check();
    if (host?.restart_supported !== true || !positiveId(host.pid)) throw new Error('界面宿主不支持安全重启或身份未知');
    if (hostPid !== null && host.pid !== hostPid) throw new Error('界面宿主身份已变化');
    hostPid = host.pid;
  };
  const snapshot = async () => {
    check(); const value = await read('/api/host/projects'); check();
    const map = sources(value?.projects);
    for (const record of records) {
      const source = map.get(record.row.id);
      if (!source || source.project !== record.row.project || source.running !== true || source.error) throw new Error(`${name(record.row)} 来源不可达、已移除或路径变化`);
      const value = maintenance(source), expected = record.batch;
      if (expected) {
        if (value.batch_id !== expected.batch_id || value.paused !== !record.resumed
          || (!record.resumed && value.completion_state === 'cancelled')) throw new Error(`${name(source)} 固定批次或暂停状态已变化`);
        if (record.resumed) {
          if (value.completion_state !== 'cancelled' || value.completion_notice_id !== null) throw new Error(`${name(source)} 继续结果未确认`);
        } else if (expected.completion_notice_id !== null && value.completion_notice_id !== expected.completion_notice_id) {
          throw new Error(`${name(source)} 完成告知身份已变化`);
        }
        // Pin every fresh completion Notice, even while a dynamic blocker is still busy.
        if (!record.resumed && value.completion_state === 'completed') record.batch = { ...value };
      } else if (value.paused !== record.original.paused || value.batch_id !== record.original.batch_id
        || value.completion_state !== record.original.completion_state || value.completion_notice_id !== record.original.completion_notice_id) {
        throw new Error(`${name(source)} 确认时的原暂停状态或批次已变化`);
      }
    }
    return map;
  };
  const ready = (record, map) => {
    if (record.resumed) return true;
    const value = maintenance(map.get(record.row.id));
    return value.paused && value.completion_state === 'completed' && positiveId(value.completion_notice_id) && value.ready_to_restart;
  };
  const requireReady = map => {
    if (!records.every(record => ready(record, map))) throw new Error('固定范围当前不再全部安全中断且可重启');
  };
  const report = error => {
    const list = predicate => records.filter(predicate).map(r => name(r.row)).join('、') || '无';
    return `一键安全重启${error ? '已停止' : '已完成'}。阶段：${stage}${current ? `（${name(current.row)}）` : ''}。`
      + `中断已接受：${list(r => r.interrupted)}；原维护暂停保留：${list(r => r.original.paused)}；后台已重启：${list(r => r.restarted)}；已继续：${list(r => r.resumed)}。`
      + `未执行中断：${list(r => !r.original.paused && !r.interrupted && !(stage === '中断' && r === current))}。`
      + `未执行后台重启：${list(r => !r.restarted && !(stage === '后台重启' && r === current))}；未执行继续：${list(r => !r.original.paused && !r.resumed && !(stage === '继续' && r === current))}。`
      + `界面：${hostAccepted ? '重启请求已接受' : hostAttempted ? '重启失败／结果未确认' : '未执行重启'}。`
      + (error ? `${stage}失败／结果未确认：${error.message}。请核对来源状态，不自动重试、撤销、回滚、恢复或强杀。` : '不保存跨界面重启执行授权。');
  };
  try {
    check();
    const map = sources((await read('/api/host/projects'))?.projects); check();
    for (const row of map.values()) {
      if (row.running !== true || row.error) continue;
      if (typeof row.project !== 'string' || !row.project) throw new Error('项目路径身份缺失');
      const original = { ...maintenance(row) };
      records.push({ row: { ...row }, original, batch: original.paused ? { ...original } : null, interrupted: false, restarted: false, resumed: false });
    }
    onScope(records.map(r => r.row));
    const accepted = await confirm({ title: '一键安全重启？', message: `${safeRestartHelp} 本次包含 ${records.length} 个在线项目后台和当前界面服务；确认后新上线的项目不加入。`,
      detail: records.map(r => `${name(r.row)}${r.original.paused ? ' — 原维护暂停，重启后保持暂停' : ' — 本次暂停，全部后台成功后自动继续'}`).join('\n'),
      confirmLabel: '一键安全重启', confirmHelp: safeRestartHelp, agent: true });
    if (!accepted) return { cancelled: true };
    check(); await hostCheck(); await snapshot();
    stage = '中断';
    for (const record of records) {
      if (record.original.paused) continue;
      current = record; progress(`正在中断 ${name(record.row)}…`);
      await hostCheck(); await snapshot(); check();
      const ack = await write(projectHref(record.row.id, '/api/action'), { method: 'system.interrupt_all', params: {} });
      record.interrupted = true;
      const value = maintenance({ ...record.row, summary: { maintenance: ack } });
      if (!value.paused || value.batch_id === record.original.batch_id) throw new Error('中断请求没有确认新的维护暂停批次');
      // ACK pins the batch, not readiness or the final Notice. Pin completion on a fresh read.
      record.batch = { ...value, completion_notice_id: null }; current = null;
    }
    stage = '等待安全退出'; const deadline = now() + observationTimeout;
    while (records.length) {
      progress('正在等待固定批次真实安全退出与动态可重启；未重启任何服务…');
      if (now() >= deadline) throw new Error('15 分钟有界观测超时');
      const map = await snapshot();
      if (now() >= deadline) throw new Error('15 分钟有界观测超时');
      if (records.every(record => ready(record, map))) break;
      await bounded(s => new Promise(resolve => {
        const timer = schedule(resolve, Math.min(2000, Math.max(1, deadline - now())));
        s.addEventListener('abort', () => unschedule(timer), { once: true });
      }), Math.min(10000, Math.max(1, deadline - now())));
    }
    stage = '后台重启';
    for (const record of records) {
      current = record; progress(`正在安全重启 ${name(record.row)}…`);
      await hostCheck(); requireReady(await snapshot()); check();
      const ack = await write(projectHref(record.row.id, '/api/service/restart'));
      if (ack?.restarted !== true || ack.project !== record.row.project || !positiveId(ack.pid)) throw new Error('后台重启回执无效');
      record.restarted = true; current = null;
      requireReady(await snapshot());
    }
    stage = '继续';
    await hostCheck(); requireReady(await snapshot());
    for (const record of records) {
      if (record.original.paused) continue;
      current = record; progress(`正在继续本次暂停的 ${name(record.row)}…`);
      await hostCheck(); requireReady(await snapshot()); check();
      const ack = await write(projectHref(record.row.id, '/api/action'), { method: 'system.resume_all', params: {} });
      const value = maintenance({ ...record.row, summary: { maintenance: ack } });
      if (value.paused || value.batch_id !== record.batch.batch_id || value.completion_state !== 'cancelled' || value.completion_notice_id !== null) throw new Error('继续回执与固定批次不符');
      record.resumed = true; current = null; await snapshot();
    }
    stage = '界面重启'; await hostCheck(); requireReady(await snapshot()); check();
    progress('全部后台重启与本次继续已确认，正在重启界面服务…');
    hostAttempted = true;
    const ack = await write('/api/host/restart');
    if (ack?.restarting !== true) throw new Error('界面重启回执无效');
    hostAccepted = true;
    // Recovery only observes/reloads; no authorization survives the Host replacement.
    if (await bounded(s => recover(hostPid, { signal: s }), 45000) && !signal.aborted) { check(); reload(); }
    return { message: report(null) };
  } catch (error) { return { error, message: report(error) }; }
}
