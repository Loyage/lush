/** Device Runner editor: reads never connect; only explicit check contacts the preinstalled Runner. */
import { el } from './dom.js';
import { formDialog } from './dialog.js';
import { settingsClient } from './settings-api.js';
import { runnerSshFields } from './runner-ssh.js';
import { runnerField, runnerButton, runnerDetails, runnerLifetime, closeRunnerDialog, REVOCATION, UNKNOWN_WRITE } from './runner-settings-controls.js';

const DEFAULT_BUDGETS = { max_commands: 1, timeout_ms: 60000, output_bytes: 1048576 };
export function renderRunnerSettings({ ownsPage = () => true, client = settingsClient() } = {}) {
  const life = runnerLifetime(ownsPage), root = el('section', undefined, 'runner-settings settings-tab-panel');
  const feedback = el('p', '', 'runner-feedback'); feedback.setAttribute('role', 'status');
  const body = el('div', undefined, 'runner-list'), tools = el('div', undefined, 'runner-actions');
  let nodes = null, credentials = null, epoch = 0, busy = false, blocked = false, modalContent = null, clearSecrets = () => {};
  const checks = new Map(), errors = new Map(), controls = [];
  const current = life.current;
  const writable = () => current() && nodes && credentials && !busy && !blocked;
  function status(text, error = false) { if (current()) { feedback.textContent = text; feedback.className = `runner-feedback${error ? ' error' : ''}`; } }
  function sync() { for (const { button, write } of controls) button.disable(busy || (write && (!nodes || !credentials || blocked)), blocked ? '写入结果未知或版本已冲突；请先重新读取配置。' : '请等待配置读取或当前操作结束。'); }
  function action(parent, label, fn, help, write = true) {
    const button = runnerButton(label, async () => { if (!current() || busy || (write && !writable())) return; return fn(); }, help);
    controls.push({ button, write }); parent.append(button.host); sync(); return button;
  }
  async function load() {
    if (!current() || busy) return;
    const request = ++epoch; busy = true; sync(); status('正在读取设备节点与凭据状态…');
    try {
      const [next, secrets] = await Promise.all([client.read('/api/runner/nodes'), client.read('/api/runner/credentials')]);
      if (!current() || request !== epoch) return;
      nodes = next; credentials = secrets; blocked = false; render(); status('已读取设备配置；不会连接远端。');
    } catch { if (current() && request === epoch) { blocked = true; status('读取失败；已显示内容不代表最新配置。请显式重新读取。', true); } }
    finally { if (request === epoch) { busy = false; sync(); } }
  }
  async function mutate(method, params, kind = 'nodes') {
    if (!writable()) return false;
    busy = true; ++epoch; sync(); status('正在提交…');
    try {
      const saved = await client.action(method, params);
      if (!current()) return true; // ACK belongs to the old page; never repaint a new page.
      if (kind === 'nodes') nodes = saved; else credentials = saved;
      render(); status('配置已保存（ACK）；不代表远端已停止或现场已回收。重新读取是独立操作。'); return true;
    } catch { if (current()) { blocked = true; status(UNKNOWN_WRITE, true); } return false; }
    finally { busy = false; if (current()) sync(); }
  }
  async function confirm(title, help) {
    const content = el('p', help, 'modal-message'); modalContent = content;
    try { return await formDialog({ title, content, cardClass: 'runner-dialog', confirmLabel: '确认', danger: true, confirmHelp: help }); }
    finally { if (modalContent === content) modalContent = null; }
  }
  async function editNode(node = null) {
    const content = el('div', undefined, 'runner-form');
    const name = runnerField(content, 'name', '节点名称', node?.name); name.maxLength = 80;
    const alias = runnerField(content, 'ssh_alias', 'SSH alias（登记后固定）', node?.ssh_alias); alias.maxLength = 128;
    alias.readOnly = Boolean(node);
    const ssh = node ? null : runnerSshFields(content, alias, { client, current: () => {
      const modal = globalThis.document?.getElementById('modal');
      if (!current() || modalContent !== content || modal?.hidden) return false;
      for (let parent = content.parentNode; parent; parent = parent.parentNode) if (parent === modal) return true;
      return false;
    } });
    const enabled = runnerField(content, 'enabled', '设备启用（不等于项目授权）', node?.enabled ?? true, 'checkbox');
    const advanced = runnerDetails('资源配额（执行时仍受节点限额约束）'), budgets = {};
    for (const [key, label, max] of [['max_commands', '并发命令数', 64], ['timeout_ms', '命令超时（毫秒）', 86400000], ['output_bytes', '输出字节上限', 67108864]]) {
      budgets[key] = runnerField(advanced, key, label, node?.budgets?.[key] ?? DEFAULT_BUDGETS[key], 'number');
      budgets[key].min = '1'; budgets[key].max = String(max); budgets[key].step = '1';
    }
    content.append(advanced, el('p', REVOCATION, 'hint'));
    const error = el('p', '', 'error'); content.append(error); modalContent = content;
    try {
      const dialog = formDialog({ title: node ? '编辑执行节点' : '新增执行节点', content, cardClass: 'runner-dialog', confirmLabel: '保存节点', canConfirm: writable,
        onConfirm: async () => {
          if (!name.value.trim() || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(alias.value)) { error.textContent = '请填写名称与安全的单一 SSH alias。'; return false; }
          const limits = Object.fromEntries(Object.entries(budgets).map(([key, input]) => [key, Number(input.value)]));
          if (Object.entries(budgets).some(([key, input]) => !Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > Number(input.max))) { error.textContent = '资源配额必须是范围内的正整数。'; return false; }
          // This explicit form confirmation includes the disabled-node consequence above.
          const next = { ...(node || {}), name: name.value.trim(), ssh_alias: alias.value, enabled: enabled.checked, budgets: limits };
          const saved = await mutate('runner.nodes.set', { nodes: node ? nodes.nodes.map(row => row.id === node.id ? next : row) : [...nodes.nodes, next], expected_revision: nodes.revision });
          if (!saved && current()) error.textContent = UNKNOWN_WRITE;
          return saved;
        } });
      // A long new-node form should open at its first field, not scroll to the save button.
      if (!node) name.focus?.();
      void ssh?.start();
      await dialog;
    } finally { ssh?.dispose(); if (modalContent === content) modalContent = null; }
  }
  async function editCredentials(node) {
    const content = el('div', undefined, 'runner-form');
    content.append(el('p', '仅本次提交使用密码框；不会显示已有秘密或哈希，也不写入草稿。请使用预先配对的随机控制凭据。留空表示保留。', 'hint'));
    const machine = runnerField(content, 'machine_token', '机器凭据', '', 'password');
    const project = runnerField(content, 'project_id', '配对项目 ID');
    const token = runnerField(content, 'control_token', '项目控制凭据', '', 'password');
    const error = el('p', '', 'error'); content.append(error);
    const clear = () => { machine.value = ''; token.value = ''; }; clearSecrets = clear; modalContent = content;
    try {
      await formDialog({ title: `凭据 · ${node.name}`, content, cardClass: 'runner-dialog', confirmLabel: '提交凭据', canConfirm: writable, onConfirm: async () => {
        if (!machine.value && !token.value) { error.textContent = '请至少填写一种凭据。'; return false; }
        if (Boolean(project.value.trim()) !== Boolean(token.value)) { error.textContent = '项目 ID 与控制凭据必须同时填写。'; return false; }
        const params = { node_id: node.id, expected_revision: credentials.revision };
        if (machine.value) params.machine_token = machine.value;
        if (token.value) { params.project_id = project.value.trim(); params.control_token = token.value; }
        // Clear before the network await too: failure/unknown never keeps secrets for replay.
        clear();
        try {
          const saved = await mutate('runner.credentials.set', params, 'credentials');
          if (!saved && current()) error.textContent = `${UNKNOWN_WRITE} 密码框已清空。`;
          return saved;
        }
        finally { delete params.machine_token; delete params.control_token; clear(); }
      } });
    } finally { clear(); if (clearSecrets === clear) clearSecrets = () => {}; if (modalContent === content) modalContent = null; }
  }
  async function checkNode(node) {
    const content = el('div', undefined, 'runner-form');
    const project = runnerField(content, 'check_project_id', '已配对项目 ID');
    const detail = el('p', '显式认证检查用户预装 Runner；需要机器和该项目的控制凭据。不安装、不启动、不自动保存 pin。', 'hint'); content.append(detail);
    modalContent = content;
    try {
      await formDialog({ title: `检查连接 · ${node.name}`, content, cardClass: 'runner-dialog', confirmLabel: '检查连接', canConfirm: writable, onConfirm: async () => {
        const project_id = project.value.trim(), configured = credentials.nodes.find(row => row.node_id === node.id);
        if (!configured?.machine_configured || !configured.projects.some(row => row.project_id === project_id && row.control_configured)) { detail.textContent = '请先为此节点配置机器凭据与所填项目 ID 的控制凭据。'; return false; }
        busy = true; sync();
        try {
          const result = await client.action('runner.nodes.check', { node_id: node.id, project_id });
          if (current()) { checks.set(node.id, result); errors.delete(node.id); render(); status('显式检查已返回；这是当时的诊断，不代表当前在线，尚未自动保存 pin。'); }
          return true;
        } catch { if (current()) { errors.set(node.id, `最近一次显式检查失败（${new Date().toISOString()}）；连接或身份未确认，请核对配对与配置。`); render(); } return true; }
        finally { busy = false; if (current()) sync(); }
      } });
    } finally { if (modalContent === content) modalContent = null; }
  }
  function render() {
    controls.length = 0; tools.replaceChildren(); body.replaceChildren();
    action(tools, '重新读取配置', load, '', false); action(tools, '新增执行节点', () => editNode());
    for (const node of nodes?.nodes || []) {
      const card = el('article', undefined, 'runner-card'); card.dataset.runnerId = node.id;
      const check = checks.get(node.id), configured = credentials.nodes.find(row => row.node_id === node.id);
      card.append(el('h3', node.name), el('p', `SSH · ${node.enabled ? '设备启用' : '设备禁用'}`),
        el('p', check ? `最近显式检查：${check.checked_at}（仅本页缓存，不代表当前在线）` : '尚无本页显式检查记录', 'hint'));
      if (!node.enabled || !node.expected_runner_id || errors.has(node.id)) card.append(el('p', [!node.enabled && '节点已禁用；不代表已停止或回收。', !node.expected_runner_id && '安装身份尚未固定；检查后须单独确认保存 pin。', errors.get(node.id)].filter(Boolean).join(' '), 'error runner-warning'));
      card.append(el('p', `机器凭据：${configured?.machine_configured ? '已配置' : '未配置'} · 项目控制凭据：${configured?.projects.length || 0} 项`, 'hint'));
      const buttons = el('div', undefined, 'runner-actions');
      action(buttons, '编辑节点', () => editNode(node)); action(buttons, '配置凭据', () => editCredentials(node));
      action(buttons, '检查连接', () => checkNode(node), '显式连接已配对的预装 Runner，读取诊断；不调用模型，不自动固定安装身份。');
      if (check && !node.expected_runner_id) action(buttons, '保存安装身份 pin', async () => {
        if (await confirm('固定此安装身份？', `请核对 runner_id：${check.runner_id}。保存后不可修改或清空，换机须登记新节点。`) && writable())
          await mutate('runner.nodes.set', { nodes: nodes.nodes.map(row => row.id === node.id ? { ...row, expected_runner_id: check.runner_id } : row), expected_revision: nodes.revision });
      }, '将此次显式检查的 runner_id 固定到节点；保存后不可更改。');
      action(buttons, '删除节点', async () => {
        if (await confirm('删除设备节点登记？', REVOCATION) && writable()) await mutate('runner.nodes.set', { nodes: nodes.nodes.filter(row => row.id !== node.id), expected_revision: nodes.revision });
      }, REVOCATION);
      card.append(buttons);
      const diagnostics = runnerDetails('身份、资源与凭据管理');
      diagnostics.append(el('p', `节点 ID：${node.id}`), el('p', `固定 runner_id：${node.expected_runner_id || '未固定'}`),
        el('pre', JSON.stringify({ budgets: node.budgets, ...(check ? { last_explicit_check: check } : {}) }, null, 2)));
      for (const project of configured?.projects || []) {
        const row = el('div', undefined, 'runner-actions'); row.append(el('span', `项目 ${project.project_id}：${project.control_configured ? '已配置' : '未配置'}`));
        action(row, '删除项目凭据', async () => { if (await confirm('删除项目控制凭据？', REVOCATION) && writable()) await mutate('runner.credentials.remove', { node_id: node.id, project_id: project.project_id, expected_revision: credentials.revision }, 'credentials'); }, REVOCATION); diagnostics.append(row);
      }
      action(diagnostics, '删除全部节点凭据', async () => { if (await confirm('删除此节点全部凭据？', REVOCATION) && writable()) await mutate('runner.credentials.remove', { node_id: node.id, expected_revision: credentials.revision }, 'credentials'); }, REVOCATION);
      card.append(diagnostics); body.append(card);
    }
    if (nodes && !nodes.nodes.length) body.append(el('p', '尚未登记执行节点。'));
    sync();
  }
  root.append(el('h2', '执行节点'), el('p', '设备登记不等于项目授权。读取不连接、安装或启动远端；仅支持可信 SSH 节点与用户预装 Runner。', 'hint'), tools, feedback, body);
  render();
  const ownerWindow = globalThis.window;
  const clearOnLeave = () => { clearSecrets(); closeRunnerDialog(modalContent); };
  ownerWindow?.addEventListener?.('pagehide', clearOnLeave);
  const ready = load();
  return { root, ready, reload: load, dispose() {
    life.dispose(); ++epoch; clearOnLeave(); ownerWindow?.removeEventListener?.('pagehide', clearOnLeave);
  } };
}
