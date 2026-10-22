/** On-demand, masked environment editing with per-client/target models and drafts. */
import { block, button, el } from './dom.js';
import { show } from './messages.js';
import { settingsClientFor } from './settings-api.js';
import { scopeSummary, scopeLabel } from './settings-scope.js';
const environmentTargets = new Map();
const environmentModels = new Map();
const environmentDrafts = new Map();
let nextErrorId = 0;

function environmentRows(model, key) {
  if (!environmentDrafts.has(key)) environmentDrafts.set(key, Object.entries(model.values || {}).map(([name, value]) => ({ name, value, visible: false })));
  return environmentDrafts.get(key);
}

export function environmentEditor(settings, repaint, ownsPage) {
  const client = settingsClientFor(settings), selectedTarget = environmentTargets.get(client.key) || 'common', key = `${client.key}:${selectedTarget}`;
  const active = () => ownsPage() && section.isConnected !== false && (environmentTargets.get(client.key) || 'common') === selectedTarget && client.isCurrent();
  const section = block('环境变量'); section.classList.add('agent-env-block');
  const errorBox = el('p', undefined, 'settings-error'); errorBox.hidden = true; errorBox.dataset.envError = ''; errorBox.id = `environment-error-${++nextErrorId}`; errorBox.setAttribute('role', 'alert');
  const report = (message, failed = true) => { if (!active()) return; errorBox.textContent = message; errorBox.hidden = false; errorBox.className = failed ? 'settings-error' : 'settings-note'; errorBox.setAttribute('role', failed ? 'alert' : 'status'); };
  let busy = false;
  const draftStamp = () => JSON.stringify(environmentDrafts.get(key));
  const lock = value => {
    busy = value; target.disabled = value;
    for (const control of section.querySelectorAll('button')) {
      if (control === load || control.classList.contains('agent-env-remove') || control.dataset.envAction) control.disabled = value;
    }
  };
  section.append(el('p', '按需读取并编辑 Agent 子进程环境。值返回浏览器后默认遮罩；公共变量先加载，角色变量随后覆盖。保存会规范化 env 文件并移除原注释与排序。', 'settings-note settings-section-note'));

  const toolbar = el('div', undefined, 'agent-env-toolbar');
  const target = el('select'); target.className = 'agent-env-target'; target.dataset.envTarget = '';
  const targets = [{ id: 'common', label: '公共 · agent.env' }, ...settings.options.roles.filter(item => item.id === 'agent').map(item => ({ id: item.id, label: `${item.label} · ${item.id}.env` }))];
  for (const item of targets) { const option = el('option', item.label); option.value = item.id; target.append(option); }
  target.value = selectedTarget;
  target.addEventListener('change', () => { if (!active() || busy) return; environmentTargets.set(client.key, target.value); repaint(); });
  const model = environmentModels.get(key);
  const load = button(model ? '重新读取' : '读取变量', async () => {
    if (!active() || busy) return;
    const draft = draftStamp(); lock(true); errorBox.hidden = true;
    try {
      const loaded = await client.read(`/api/agent/environment?target=${encodeURIComponent(selectedTarget)}`);
      if (!active()) return;
      environmentModels.set(key, loaded);
      if (draft === draftStamp()) { environmentDrafts.delete(key); repaint(); }
      else report('已读取环境变量；保留读取期间新增的未保存修改。', false);
    } catch (error) { report(`读取环境变量失败：${error.message}；已有草稿保留。`); }
    finally { lock(false); }
  }, 'ghost agent-env-load', { busyLabel: '读取中…' });
  load.type = 'button';
  toolbar.append(target, load); section.append(toolbar, errorBox);

  if (!model) {
    section.append(el('p', '尚未把变量值读入浏览器。点击“读取变量”后可编辑；读取与写入仅允许用户会话，Agent token 无权访问。', 'settings-readonly settings-note agent-env-empty'));
    return section;
  }

  section.append(scopeSummary(model, client.scope));
  const rows = environmentRows(model, key);
  const list = el('div', undefined, 'agent-env-list');
  if (!rows.length) list.append(el('p', '这个文件还没有变量。', 'settings-note agent-env-empty'));
  rows.forEach((entry, index) => {
    const line = el('div', undefined, 'agent-env-row'); line.dataset.envRow = String(index);
    const name = el('input'); name.value = entry.name; name.placeholder = 'VARIABLE_NAME'; name.maxLength = 256;
    name.className = 'agent-env-name'; name.dataset.envName = String(index); name.autocomplete = 'off';
    name.addEventListener('input', () => { entry.name = name.value; name.removeAttribute('aria-invalid'); name.removeAttribute('aria-describedby'); });
    const value = el('input'); value.type = entry.visible ? 'text' : 'password'; value.value = entry.value; value.placeholder = '值';
    value.className = 'agent-env-value'; value.dataset.envValue = String(index); value.autocomplete = 'off';
    value.addEventListener('input', () => { entry.value = value.value; });
    const reveal = button(entry.visible ? '隐藏' : '显示', () => {
      entry.visible = !entry.visible; value.type = entry.visible ? 'text' : 'password'; reveal.textContent = entry.visible ? '隐藏' : '显示';
    }, 'ghost agent-env-reveal', { help: entry.visible ? '重新遮罩这条环境变量的值；不改变保存内容' : '以明文显示这条环境变量的值；不改变保存内容' }); reveal.type = 'button';
    const remove = button('删除', () => { if (!active() || busy) return; rows.splice(index, 1); repaint(); }, 'ghost agent-env-remove',
      { help: '从编辑列表移除这条变量；保存环境变量后才会真正删除' }); remove.type = 'button';
    line.append(name, value, reveal, remove); list.append(line);
  });
  section.append(list);

  const actions = el('div', undefined, 'agent-env-actions');
  const add = button('新增变量', () => { if (!active() || busy) return; rows.push({ name: '', value: '', visible: false }); repaint(); }, 'ghost'); add.type = 'button'; add.dataset.envAction = 'add';
  const save = button('保存环境变量', async () => {
    if (!active() || busy) return;
    const values = {};
    for (const field of section.querySelectorAll('.agent-env-name')) { field.removeAttribute('aria-invalid'); field.removeAttribute('aria-describedby'); }
    const fail = (message, index) => {
      report(message); const field = section.querySelector(`[data-env-name="${index}"]`);
      field?.setAttribute('aria-invalid', 'true'); field?.setAttribute('aria-describedby', errorBox.id);
    };
    for (const [index, entry] of rows.entries()) {
      const name = entry.name.trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) { fail(`第 ${index + 1} 行的变量名无效。`, index); return; }
      if (name.startsWith('LUSH_')) { fail(`${name} 由 Lush 保留，不能在这里覆盖。`, index); return; }
      if (Object.hasOwn(values, name)) { fail(`变量名重复：${name}`, index); return; }
      values[name] = entry.value;
    }
    errorBox.hidden = true; lock(true);
    const savingTarget = selectedTarget, draft = draftStamp();
    try {
      const saved = await client.action('agent.environment.configure', { target: savingTarget, values });
      if (!active()) return;
      environmentModels.set(key, saved);
      show(`${scopeLabel(client.scope)}环境变量已保存；下一次 Agent 调用生效。`);
      if (draft === draftStamp()) { environmentDrafts.delete(key); repaint(); }
      else report('环境变量已保存；保留你随后输入的未保存修改。', false);
    } catch (error) { report(`保存环境变量未完成：${error.message}；草稿保留。`); }
    finally { lock(false); }
  }, 'primary', { busyLabel: '保存中…' }); save.type = 'button'; save.dataset.envAction = 'save';
  actions.append(add, save, el('code', model.file, 'settings-path agent-env-path'));
  section.append(actions);
  return section;
}
