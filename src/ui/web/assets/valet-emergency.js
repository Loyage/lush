import { button, el } from './dom.js';
import { api, action } from './api.js';
import { formDialog } from './dialog.js';
import { refresh as refreshPage } from './navigate.js';
import { ui } from './state.js';
import { workerLabel } from './worker-label.js';

const help = '仅强制终结当前项目仍占位的管家并永久撤销其旧授权；不影响已正常收口或仅等待未来信号的管家。真实在途操作退出后解除历史占位，保留未知结果与历史，不回滚副作用，不停止开发 Worker，不调用 Agent。';
const counts = ['enabled', 'pending_occurrences', 'unstarted_actions', 'unstarted_calls', 'started_receipts', 'unknown_receipts', 'open_decisions', 'live_workers'];
const blockers = { provider_cleanup: '模型进程或退出清理尚未结束', control_owner: '受控操作尚未退出', control_busy: '受控操作仍在执行' };
const number = value => Number.isSafeInteger(value) && value >= 0;
const kindsValid = value => Array.isArray(value) && value.every(kind => Object.hasOwn(blockers, kind));
function validPreview(value) {
  return value?.version === 1 && value.scope === 'current_project' && value.history_preserved === true
    && typeof value.revision === 'string' && value.revision.length > 0
    && ['total', 'affected_total', 'already_isolated_total', 'stopping_total'].every(key => number(value[key]))
    && value.total >= value.affected_total + value.already_isolated_total && value.stopping_total <= value.affected_total
    && counts.every(key => number(value.totals?.[key])) && Array.isArray(value.items) && value.items.length <= 100
    && value.items.length <= value.affected_total && value.items_truncated === (value.items.length < value.affected_total)
    && value.items.every(item => Number.isSafeInteger(item.id) && item.id > 0 && counts.every(key => number(item[key])) && kindsValid(item.blockers));
}
function validResult(value, revision) {
  return value?.version === 1 && value.scope === 'current_project' && value.history_preserved === true
    && value.request_revision === revision && ['stopping', 'isolated'].includes(value.status)
    && ['affected_total', 'isolated_total', 'stopping_total', 'blockers_total'].every(key => number(value[key]))
    && value.affected_total === value.isolated_total + value.stopping_total
    && (value.status === 'isolated') === (value.stopping_total === 0)
    && value.blockers_total <= value.stopping_total
    && Array.isArray(value.blockers) && value.blockers.length <= 100 && value.blockers.length <= value.blockers_total
    && value.blockers_truncated === (value.blockers.length < value.blockers_total)
    && value.blockers.every(item => Number.isSafeInteger(item.id) && item.id > 0 && kindsValid(item.kinds) && item.kinds.length > 0);
}
function summary(preview) {
  const t = preview.totals;
  return `当前项目共 ${preview.total} 个管家；本次影响 ${preview.affected_total} 个，已隔离 ${preview.already_isolated_total} 个，不占位且不受影响 ${preview.total - preview.affected_total - preview.already_isolated_total} 个。启用授权 ${t.enabled} 个，真实在途 ${t.live_workers} 个，未收口事项 ${t.pending_occurrences} 个，未开始操作 ${t.unstarted_actions + t.unstarted_calls} 项，待答问题 ${t.open_decisions} 个，结果未知收据 ${t.unknown_receipts} 项。`;
}
function details(preview) {
  const disclosure = el('details', undefined, 'valet-emergency-details');
  disclosure.append(el('summary', `查看影响明细（${preview.items.length}/${preview.affected_total} 个管家）`));
  disclosure.append(el('p', preview.items_truncated ? '仅展示前 100 个管家；上述汇总及确认范围覆盖全部受影响管家，不受列表分页或筛选限制。' : '确认范围仅覆盖当前项目仍占位的管家，不受列表分页或筛选限制；不占位的管家保持原状。', 'hint'));
  for (const item of preview.items) {
    const text = `${workerLabel(item)}：${item.enabled ? '授权启用' : '授权未启用'}；未开始操作 ${item.unstarted_actions + item.unstarted_calls} 项；待答问题 ${item.open_decisions} 个；执行中收据 ${item.started_receipts} 项；未知收据 ${item.unknown_receipts} 项。${item.blockers.length ? `仍有：${item.blockers.map(kind => blockers[kind]).join('、')}。` : '当前无真实进程／操作占用。'}`;
    disclosure.append(el('p', text));
  }
  return disclosure;
}

/** Project-wide user emergency, independent of the currently loaded historical list. */
export function valetEmergencyControl({ refresh = refreshPage } = {}) {
  const root = el('div', undefined, 'valet-emergency-control');
  const stop = button('强制终结占位管家', () => {}, 'danger', { help });
  const check = button('核对当前急救状态', () => {}, 'ghost', { help: '只读取当前项目管家隔离和在途状态，不重发终结请求，不调用 Agent。' });
  const status = el('div', undefined, 'valet-emergency-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const stopHost = el('span', undefined, 'help-host'); stopHost.append(stop);
  const checkHost = el('span', undefined, 'help-host'); checkHost.append(check); checkHost.hidden = true;
  root.append(stopHost, checkHost, status);
  let busy = false, uncertain = false;
  const identity = () => {
    const owner = globalThis.document, project = location.pathname, boot = ui.workerNumbers, view = ui.view;
    return () => globalThis.document === owner && location.pathname === project && ui.workerNumbers === boot && ui.view === view;
  };
  const sync = () => {
    stop.disabled = busy || uncertain; check.disabled = busy;
    for (const [control, host] of [[stop, stopHost], [check, checkHost]]) {
      if (control.disabled) { host.dataset.help = busy ? '请求正在处理，不会重复提交。' : '终结结果未确认，请先核对当前急救状态，再决定是否重新预检。'; host.setAttribute('tabindex', '0'); }
      else { delete host.dataset.help; host.removeAttribute('tabindex'); }
    }
  };
  const report = (text, error = false) => { status.replaceChildren(el('p', text, error ? 'error' : 'hint')); };
  const read = async () => {
    const preview = await api('/api/management/emergency-preview');
    if (!validPreview(preview)) throw new Error('急救预检读面不完整，请更新服务并刷新；不会尝试终结');
    return preview;
  };
  check.onclick = async () => {
    if (busy) return;
    const current = identity(); busy = true; sync();
    try {
      const preview = await read(); if (!current()) return;
      uncertain = false;
      report(`${summary(preview)}${preview.stopping_total ? `其中 ${preview.stopping_total} 个急救事项仍等待真实退出；后台会自动收口，无须重发终结请求。` : '当前没有等待退出的急救事项；新建管理指令仍以后端实时准入为准。'}历史结果未知不代表已成功。`);
    } catch (error) { if (current()) report(`状态读取失败：${error.message}；本次仅尝试读取，未重发终结请求，可重新读取。`, true); }
    finally { busy = false; sync(); }
  };
  stop.onclick = async () => {
    if (busy || uncertain) return;
    const current = identity(); busy = true; sync();
    try {
      const preview = await read(); if (!current()) return;
      if (!preview.affected_total) { report(`${summary(preview)}没有需要终结的管家；未发送终结请求。`); return; }
      const content = el('div', undefined, 'valet-emergency-form');
      content.append(el('p', summary(preview)), details(preview));
      const outcome = el('p', undefined, 'valet-emergency-outcome'); outcome.setAttribute('role', 'status'); content.append(outcome);
      let attempted = false;
      await formDialog({ title: '强制终结当前项目占位管家？', content, danger: true, cardClass: 'valet-emergency-modal',
        message: '仅处理仍占位的管家，已正常收口或仅等待未来信号的管家保持原状。将永久停用受影响管家的授权及未来信号绑定，撤销未开始操作和待确认请求，强制终止管家模型进程。已发生的副作用不撤销，历史和未知结果保留；只有真实进程与在途操作退出后才解除占位。不停止开发 Worker，不重启服务，不自动创建救援管家。',
        confirmLabel: '确认强制终结并解除占位', cancelLabel: '关闭', confirmHelp: help,
        canConfirm: () => current() && !attempted,
        onConfirm: async () => {
          if (!current() || attempted) return false;
          attempted = true;
          let result;
          try {
            result = await action('management.emergency_stop', { revision: preview.revision, confirm: true }, { refresh: false });
            if (!validResult(result, preview.revision)) throw new Error('服务返回的急救结果不完整');
          } catch (error) {
            uncertain = true;
            if (current()) {
              const text = `终结结果未确认：${error.message}。请关闭后先核对当前急救状态；不会自动重发，重新操作须重新预检并确认。`;
              outcome.textContent = text; report(text, true); checkHost.hidden = false;
            }
            return false;
          }
          if (!current()) return false;
          checkHost.hidden = false;
          if (result.status === 'isolated') report(`本次 ${result.affected_total} 个管家已终结并隔离，历史占位已解除。可重新提交救援管理指令，准入仍按实时状态核验。历史与未知结果保留，已发生的副作用不撤销；未自动调用 Agent。`);
          else {
            report(`终结请求已保存：本次 ${result.isolated_total}/${result.affected_total} 个管家已隔离，${result.stopping_total} 个仍等待真实退出，尚未全部解除占位。后台会自动收口，无须重发终结请求。`);
            for (const item of result.blockers) status.append(el('p', `${workerLabel(item)}：${item.kinds.map(kind => blockers[kind]).join('、')}。`, 'hint'));
            if (result.blockers_truncated) status.append(el('p', `仅展示前 ${result.blockers.length}/${result.blockers_total} 个实际阻塞管家；全部阻塞仍须退出。`, 'hint'));
          }
          try { await refresh(); }
          catch (error) { if (current()) status.append(el('p', `终结请求已成功保存，但列表刷新失败：${error.message}；请手动刷新，不要重发。`, 'error')); }
          return true;
        } });
    } catch (error) { if (current()) report(`预检失败：${error.message}；未发送终结请求。`, true); }
    finally { busy = false; sync(); }
  };
  return root;
}
