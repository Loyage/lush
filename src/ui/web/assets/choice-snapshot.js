import { api } from './api.js';
import { button, el } from './dom.js';
import { absolute } from './format.js';
import { agentHelp } from './help.js';
import { detail } from './navigate.js';
import { projectBase } from './route.js';
import { questionnairePanel } from './render-questionnaire.js';
import { ui } from './state.js';
import { workerLabel } from './worker-label.js';

const IMPACT = '从选择前的代码与上下文另开独立 Worker／分支。原答案与成果保留，原路线不会自动暂停，不会回滚 main 或撤回已合并成果。';
const CREATE_HELP = agentHelp('用这份快照和新的整份问卷答案创建独立 Worker；保留原路线，不撤回已合并成果。');
const settled = notice => notice.kind === 'questionnaire' && ['answered', 'dismissed'].includes(notice.status);
const projectIdentity = () => `${projectBase()}:${ui.lastSnapshot?.status?.project || location.pathname}`;

// randomUUID is secure-context-only in some browsers; getRandomValues also works on a remote HTTP Host.
function requestId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  if (!globalThis.crypto?.getRandomValues) throw new Error('浏览器不能生成重选请求标识，请使用支持 Web Crypto 的浏览器');
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const value = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

/** Keep request identity across redraws and reloads, not just inside a click handler. */
function previousOperation(key) {
  let value = ui.choiceRechooseRequests.get(key);
  if (!value) {
    try { value = JSON.parse(sessionStorage.getItem(key)); } catch { /* unavailable */ }
    if (value?.version !== 1 || typeof value.draft_id !== 'string' || !Array.isArray(value.requests)
      || !value.requests.every(item => typeof item?.signature === 'string' && typeof item.request_id === 'string')
      || (value.receipt && (!Number.isSafeInteger(value.receipt.id) || value.receipt.id <= 0))) return null;
    ui.choiceRechooseRequests.set(key, value);
  }
  return value;
}
function operation(key) {
  return previousOperation(key) || { version: 1, draft_id: requestId(), requests: [], receipt: null };
}
function saveOperation(key, value) {
  ui.choiceRechooseRequests.set(key, value);
  try { sessionStorage.setItem(key, JSON.stringify({ ...value, pending: undefined })); return true; }
  catch { return false; } // Keep memory identity, but do not promise reload recovery when storage is blocked.
}

/** Same historical replay and opt-in restore control in Notice history and Worker decisions. */
export function settledDecision(notice, { rechoose = true } = {}) {
  const root = el('div', undefined, 'settled-decision');
  root.append(questionnairePanel(notice));
  if (rechoose && settled(notice)) root.append(choiceSnapshotPanel(notice));
  return root;
}

/** Read only until the new questionnaire's final confirmation; never rewrites the source Notice. */
export function choiceSnapshotPanel(notice) {
  const root = el('section', undefined, 'choice-snapshot decision-summary');
  if (!settled(notice)) return root;
  const identity = projectIdentity();
  const ownsProject = () => identity === projectIdentity() && !ui.deletedWorkerIds.has(notice.task_id);
  const ownsPage = () => {
    const view = ui.view, records = ui.noticeRecords, selected = records?.selected;
    return () => ownsProject() && ui.view === view && root.isConnected !== false
      && (ui.indexOpen !== 'notices' || (ui.noticeRecords === records && records?.selected === selected));
  };
  const status = el('div'), editor = el('div'), storageWarning = el('p', undefined, 'hint');
  const persist = (key, value) => {
    if (!saveOperation(key, value)) storageWarning.textContent = '浏览器未能持久保存重选请求；当前页面内可安全重试。请勿刷新或关闭此页，否则可能丢失请求标识并重复创建路线。';
  };
  let loading = false, snapshot = null;
  const operationKey = value => `lush.rechoose:${identity}:${notice.id}:${notice.created_at}:${value.revision}:${notice.body}`;
  const canCreate = value => value?.status === 'ready' && value.can_rechoose === true && value.blockers.length === 0;
  const load = async () => {
    if (loading || !ownsProject()) return;
    loading = true;
    const current = ownsPage();
    status.replaceChildren(el('p', '正在读取选择快照…', 'hint'));
    try {
      const result = await api(`/api/notice/${notice.id}/snapshot`);
      if (!current()) return;
      if (result?.notice_id !== notice.id || !['pending', 'ready', 'unavailable'].includes(result.status)
        || typeof result.revision !== 'string' || !Array.isArray(result.blockers) || !Array.isArray(result.limitations)) {
        throw new Error('快照读面不兼容，请更新 Web 与 daemon 后重试');
      }
      snapshot = result;
      paintSnapshot();
    } catch (error) {
      if (current()) status.replaceChildren(el('p', `选择快照读取失败：${error.message}`, 'error'),
        button('重试读取快照', load, 'ghost', { help: '重新读取保存状态，不创建 Worker，也不调用 Agent。' }));
    } finally { loading = false; }
  };
  function paintSnapshot() {
    const labels = { pending: '快照保存中', ready: '选择快照已保存', unavailable: '此选择点不可恢复' };
    status.replaceChildren(el('h4', labels[snapshot.status]));
    if (snapshot.reason) status.append(el('p', snapshot.reason, 'hint'));
    if (snapshot.created_at) status.append(el('p', `保存时间：${absolute(snapshot.created_at)}`, 'hint'));
    if (snapshot.commit) status.append(el('p', `代码快照：${snapshot.commit}`, 'hint'));
    if (snapshot.context_mode) status.append(el('p', `上下文：${snapshot.context_mode}`, 'hint'));
    for (const reason of snapshot.blockers) status.append(el('p', `当前不能重选：${reason}`, 'hint'));
    for (const limit of snapshot.limitations) status.append(el('p', limit, 'hint'));
    status.append(el('p', IMPACT, 'hint'));
    const start = button('重新选择', () => begin(), 'ghost', { help: '打开一份独立的新选择草稿；只有最后确认才会创建 Worker，原答案不改变。' });
    start.disabled = !canCreate(snapshot);
    const host = el('span', undefined, 'help-host');
    host.setAttribute('data-help', start.disabled ? snapshot.blockers.join('；') || snapshot.reason || '尚无可恢复的选择快照。' : start.getAttribute('data-help'));
    host.append(start);
    const controls = el('div', undefined, 'actions');
    controls.append(host, button('刷新快照状态', load, 'ghost', { help: '只重新读取当前快照可用性与创建条件，不改写已保存快照，不调用 Agent。' }));
    status.append(controls);
    if (snapshot.status === 'ready') {
      const key = operationKey(snapshot), previous = previousOperation(key);
      if (previous?.receipt) showReceipt(key, previous);
      else if (previous?.requests.length) status.append(button('继续上次重选', () => begin(true), 'ghost',
        { help: '恢复上次选择草稿与请求标识；可原样重试以确认是否已创建，不因当前创建条件变化而丢失请求。' }));
    }
  }
  function begin(resume = false) {
    if (!ownsProject() || snapshot?.status !== 'ready') return;
    const pinned = snapshot, key = operationKey(pinned), previous = previousOperation(key);
    if (!canCreate(pinned) && !(resume && previous?.requests.length)) return;
    const op = previous || operation(key);
    persist(key, op);
    if (op.receipt) { showReceipt(key, op); return; }
    editor.replaceChildren(el('h4', '新路线的选择'), el('p', IMPACT, 'hint'));
    if (!canCreate(pinned)) editor.append(el('p', '当前不能新建路线；只能原样重试上次提交，以确认是否已经创建。', 'hint'));
    const form = questionnairePanel({ ...notice, status: 'open' }, {
      draftScope: `rechoose:${pinned.revision}:${op.draft_id}`,
      allowDismiss: false,
      reviewMessage: `尚未创建新 Worker。确认后使用选择前快照和以下新答案继续开发。${IMPACT}`,
      submitLabel: '确认新选择并创建 Worker', submitHelp: CREATE_HELP,
      failureMessage: error => `未确认创建成功：${error.message}。选择和请求标识已保留，原样重试不会重复创建；修改答案再提交会另开一次请求，之前的请求可能已经成功。`,
      settle: async answer => {
        if (!ownsProject()) throw new Error('项目已切换或原 Worker 已删除，请回到原项目查看');
        const current = ownsPage();
        const signature = JSON.stringify(answer);
        let request = op.requests.find(item => item.signature === signature);
        if (!request) {
          if (!canCreate(pinned)) throw new Error('当前创建条件不满足；请保留上次答案重试，或刷新快照状态后再修改选择');
          request = { signature, request_id: requestId() }; op.requests.push(request); persist(key, op);
        }
        // Multiple renderings of this same draft share a single in-flight operation.
        if (op.pending && op.pending.signature !== signature) throw new Error('上一次提交仍在处理中，请先等待结果');
        if (!op.pending) {
          const promise = api('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ method: 'notice.rechoose', params: { id: notice.id, answer,
              revision: pinned.revision, request_id: request.request_id } }) });
          op.pending = { signature, promise };
        }
        let result;
        try { result = await op.pending.promise; }
        finally { op.pending = null; }
        if (result?.notice_id !== notice.id || !Number.isSafeInteger(result.task?.id) || result.task.id <= 0) {
          throw new Error('未收到有效的新 Worker 回执，请原样重试以确认结果');
        }
        op.receipt = { id: result.task.id, worker_number: result.task.worker_number ?? null };
        persist(key, op);
        if (!current()) return; // Persist acknowledgement without stealing navigation from a later page.
        ui.detailDirty = false;
        showReceipt(key, op);
        try { await detail(op.receipt.id); }
        catch { editor.append(el('p', '新 Worker 已创建，但详情未能打开；可用上方链接重试查看。', 'hint')); }
      },
    });
    editor.append(form);
  }
  function showReceipt(key, op) {
    const againHelp = '开始另一份独立选择草稿；最后确认会创建另一条新路线，不覆盖已有路线。';
    const again = button('再次从此处重选', () => {
      if (!ownsProject() || !canCreate(snapshot)) return;
      const fresh = { version: 1, draft_id: requestId(), requests: [], receipt: null };
      persist(key, fresh); begin();
    }, 'ghost', { help: againHelp });
    again.disabled = !canCreate(snapshot);
    const host = el('span', undefined, 'help-host');
    host.setAttribute('data-help', again.disabled ? snapshot?.blockers.join('；') || snapshot?.reason || '当前不能创建另一条路线。' : againHelp);
    host.append(again);
    editor.replaceChildren(el('p', `已创建新路线 Worker ${workerLabel(op.receipt)}，原选择记录未改变。`, 'hint'),
      button('打开新 Worker', () => { if (ownsProject()) return detail(op.receipt.id); }, 'ghost',
        { help: '只查看已创建的新路线，不再创建 Worker 或调用 Agent。' }), host);
  }
  root.append(el('h4', '选择点快照'), button('查看快照与重选', load, 'ghost',
    { help: '读取这份历史问卷的快照状态；查看不调用 Agent，也不改变原选择。' }), status, storageWarning, editor);
  return root;
}
