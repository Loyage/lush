import { api, projectApi } from './api.js';
import { el, button } from './dom.js';
import { ui } from './state.js';

// Only share simultaneous reads, never turn an old policy into current authorization.
const documents = new WeakMap();
function readConfiguration(owner, base, boot) {
  let reads = documents.get(owner);
  if (!reads) documents.set(owner, reads = new Map());
  if (reads.get(base)?.boot !== boot) {
    const entry = { boot };
    const pending = Promise.all([api(`${base}/api/runner/nodes`), api(`${base}/api/runner/project`)]).then(([nodes, policy]) => {
      if (!Array.isArray(nodes?.nodes) || !Array.isArray(policy?.allowed_node_ids) || typeof policy.default_node_id !== 'string') throw new Error('执行环境读面不兼容');
      return { nodes: nodes.nodes, policy };
    }).finally(() => { if (reads.get(base) === entry) reads.delete(base); });
    entry.promise = pending; reads.set(base, entry);
  }
  return reads.get(base).promise;
}

export const runnerChoiceParams = value => value === undefined ? {} : { runner_node_id: value };
export const runnerChoiceText = value => value === undefined
  ? '执行环境：项目默认（实际创建时解析；暂存与等待条件不会固定当前默认）'
  : `执行环境：${value === 'local' ? '本机（显式指定）' : value}（已指定，不自动回退）`;

/** An omitted choice stays omitted. Reading configuration never checks/connects a Runner. */
export function createRunnerChoice({ value, onChange = () => {}, ownsPage = () => true,
  base = projectApi('/api/').replace(/\/api\/$/, ''), online = () => true } = {}) {
  const owner = document, boot = ui.workerNumbers;
  const node = el('div', undefined, 'runner-input-choice');
  const row = el('div', undefined, 'runner-choice-row');
  const summary = el('span', undefined, 'runner-choice-summary');
  const body = el('div', undefined, 'runner-choice-options'); body.hidden = true;
  const diagnostic = el('p', undefined, 'runner-choice-diagnostic'); diagnostic.setAttribute('role', 'status');
  const options = el('div', undefined, 'runner-choice-list');
  const note = el('p', '省略选择时，实际创建 Worker 才解析项目默认。配置预览不证明在线；读取不会连接远端。', 'hint');
  let configuration = null, error = '', pending = null, busy = false, active = true, revision = 0, disposed = false;
  const current = () => !disposed && owner === globalThis.document && ui.workerNumbers === boot && ownsPage() && active;
  const toggle = button('更改执行环境', () => {
    if (!current() || busy) return;
    body.hidden = !body.hidden; toggle.setAttribute('aria-expanded', String(!body.hidden));
    if (!body.hidden) return load();
  }, 'ghost', { help: '展开本条新工作指令的执行环境选项；不修改项目默认，不连接节点或调用 Agent。' });
  toggle.setAttribute('aria-expanded', 'false');
  const toggleHost = el('span', undefined, 'help-host'); toggleHost.append(toggle);
  const reload = button('刷新配置预览', () => load(), 'ghost');
  const reloadHost = el('span', undefined, 'help-host'); reloadHost.append(reload);
  row.append(summary, toggleHost); body.append(note, options, reloadHost); node.append(row, diagnostic, body);
  function describe(id) {
    if (id === 'local') return { name: '本机', reason: '' };
    const item = configuration?.nodes.find(item => item.id === id);
    return { name: item?.name || id, reason: !configuration ? '配置尚未核验' : !item ? '节点已删除或未登记'
      : !configuration.policy.allowed_node_ids.includes(id) ? '项目未授权（或授权已撤销）' : !item.enabled ? '设备节点已禁用' : '' };
  }
  function paint() {
    summary.textContent = runnerChoiceText(value);
    if (configuration) {
      const selected = describe(value ?? configuration.policy.default_node_id);
      summary.textContent = value === undefined ? `执行环境：项目默认 · 当前预览 ${selected.name}（实际创建时解析）` : `执行环境：${selected.name}（显式指定）`;
    }
    const selected = configuration ? describe(value ?? configuration.policy.default_node_id) : null;
    diagnostic.textContent = error || (!online() ? '项目当前不可达；原文和选择保留，不自动改投本机。' : selected?.reason
      ? `${selected.reason}；创建将明确失败，选择保留，不自动回退。` : pending ? '正在读取配置预览…' : '');
    diagnostic.hidden = !diagnostic.textContent;
    toggle.disabled = busy; toggleHost.setAttribute('data-help', busy ? '正在保存或提交，请稍候。' : toggle.getAttribute('data-help'));
    reload.disabled = busy || Boolean(pending) || !online(); reloadHost.setAttribute('data-help', !online() ? '项目不可达；不会启动后台。' : '只读配置预览，不连接远端。');
    const entries = [{ id: undefined, name: '沿用项目默认（实际创建时解析）', reason: '' },
      { id: 'local', name: '本机（显式指定）', reason: '' }];
    for (const item of configuration?.nodes || []) entries.push({ id: item.id, name: `${item.name} · SSH`, reason: describe(item.id).reason });
    if (value !== undefined && value !== 'local' && !entries.some(entry => entry.id === value)) entries.push({ id: value, name: value, reason: describe(value).reason });
    const focused = [...options.querySelectorAll('button')].find(control => control === document.activeElement)?.dataset.runnerNode;
    options.replaceChildren(...entries.map(entry => {
      const chosen = value === entry.id;
      const control = button(`${entry.name}${entry.reason ? ` · ${entry.reason}` : ''}`, () => {
        if (!current() || busy || entry.reason) return;
        value = entry.id; revision++; paint(); onChange(value);
      }, 'runner-choice-option');
      control.setAttribute('aria-pressed', String(chosen)); control.dataset.runnerNode = entry.id ?? 'default';
      control.disabled = busy || Boolean(entry.reason);
      const host = el('span', undefined, 'help-host'); host.append(control);
      if (control.disabled) { host.setAttribute('data-help', entry.reason || '正在保存或提交，请稍候。'); host.tabIndex = 0; }
      return host;
    }));
    if (focused !== undefined) options.querySelector(`[data-runner-node="${focused}"]`)?.focus();
  }
  function load() {
    if (!current() || !online()) { paint(); return Promise.resolve(); }
    if (pending) return pending;
    error = '';
    pending = readConfiguration(owner, base, boot).then(result => {
      if (current() && online()) { configuration = result; error = ''; }
    }).catch(failure => { if (current()) { configuration = null; error = `执行环境读取失败：${failure.message}；原选择保留，请显式刷新，不自动回退。`; } })
      .finally(() => { pending = null; if (current()) paint(); });
    paint(); return pending;
  }
  paint();
  return { node, load, value: () => value, revision: () => revision,
    setValue(next) { value = next; revision++; paint(); },
    setBusy(next) { busy = next; paint(); },
    setActive(next) { active = next; node.hidden = !next; },
    sync: paint, dispose() { disposed = true; } };
}
