/** Project-scoped outbound policy editor; credentials live only in current inputs. */
import { block, button, el } from './dom.js';
import { settingsClient, settingsClientFor } from './settings-api.js';
import { scopeSummary, scopeImpact, scopeLabel, clearOverrideButton } from './settings-scope.js';

const states = new Map();
const modes = [['inherit', '继承后台启动环境'], ['direct', '明确直连'], ['proxy', '使用 HTTP(S) 代理']];
function proxyOrigin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
  return url.origin;
}
function projection(value) {
  if (value?.version !== 1 || !modes.some(([mode]) => mode === value.mode)
    || !Array.isArray(value.no_proxy) || value.no_proxy.length > 128
    || !value.no_proxy.every(entry => typeof entry === 'string' && entry.length <= 256 && !/[\x00-\x1f\x7f]/.test(entry))
    || typeof value.has_proxy_auth !== 'boolean') throw new Error();
  return { version: 1, mode: value.mode, proxy_url: value.proxy_url === null ? null : proxyOrigin(value.proxy_url),
    no_proxy: [...value.no_proxy], has_proxy_auth: value.has_proxy_auth,
    configuration_scope: value.configuration_scope };
}
const unsupported = error => /^(?:not found|unknown method: agent\.network(?:\.configure)?|method not allowed from Web UI)$/.test(error?.message || '');
function stateFor(scope) {
  if (!states.has(scope)) {
    if (states.size >= 32) states.delete(states.keys().next().value);
    states.set(scope, { model: null, draft: null, busy: false, generation: 0 });
  }
  return states.get(scope);
}

/** Read only on explicit load. Non-secret drafts survive profile repaint, isolated by route. */
export function renderNetworkSettings({ ownsPage = () => true, scope } = {}) {
  const client = scope ? settingsClient(scope) : settingsClientFor(null), state = stateFor(client.key), section = block('出站网络');
  section.classList.add('agent-network-block');
  const active = () => ownsPage() && client.isCurrent();
  let secretInputs = [];
  function paint(message = '', failed = false) {
    for (const input of secretInputs) input.value = '';
    secretInputs = [];
    const heading = el('div', undefined, 'section-title'); heading.append(el('h2', '出站网络'));
    section.replaceChildren(heading);
    section.append(el('p', `${scopeLabel(client.scope)}执行机器出站代理，覆盖账号登录、令牌刷新、额度查询和后续 Agent 调用；不是模型端点，也不是 Host 入站代理。不修改系统代理、不启动代理软件。`, 'settings-note'),
      el('p', scopeImpact(client.scope), 'settings-note'),
      el('p', '仅后续请求 / Agent 调用生效，在途登录和运行中的调用不变。已有公共、角色或 Worker 环境覆盖仍优先；外部工具是否支持代理需单独验证。', 'settings-note'),
      el('p', '127.0.0.1 指后台执行机器；SSH 远端不能自动使用客户端代理。支持 HTTP / HTTPS 代理（如 Clash HTTP/混合端口），不支持 SOCKS-only；代理失败不会自动改为直连。', 'settings-note'));
    const feedback = el('p', message, failed ? 'settings-error' : 'settings-note'); feedback.setAttribute('role', 'status');
    feedback.dataset.networkFeedback = ''; feedback.hidden = !message;
    const load = button(state.model ? '重新读取网络设置' : '读取网络设置', async () => {
      if (!active() || state.busy) return;
      state.busy = true; const generation = ++state.generation; paint('正在读取网络设置…');
      try {
        const model = projection(await client.read('/api/agent/network'));
        if (!active() || generation !== state.generation) return;
        state.model = model; state.draft = { mode: model.mode, proxy_url: model.proxy_url || '', no_proxy: model.no_proxy.join('\n') };
        state.busy = false; paint();
      } catch (error) {
        if (active() && generation === state.generation) {
          state.busy = false; paint(unsupported(error) ? '当前 Host 或项目后台不支持出站网络设置，请更新并分别重启两者；其他设置仍可使用。' : '无法安全读取网络设置，请重试；未改变已有配置。', true);
        }
      } finally { if (generation === state.generation) state.busy = false; }
    }, 'ghost', { help: '只读取本项目代理的安全配置；重新读取会丢弃网络表单草稿，不读取代理认证，也不联网测试或调用 Agent。' });
    load.type = 'button'; load.disabled = state.busy;
    const loadHost = el('span', undefined, 'help-host'); loadHost.setAttribute('data-help', load.getAttribute('data-help'));
    loadHost.append(load); section.append(loadHost);
    if (!state.model) {
      section.append(el('p', '点击“读取网络设置”后编辑。代理认证仅可写入，已保存的用户名和密码不会返回浏览器。', 'settings-note'), feedback);
      return;
    }
    section.append(scopeSummary(state.model, client.scope));
    if (scope === 'project') section.append(clearOverrideButton('network', async () => {
      const model = projection(await client.read('/api/agent/network')); if (!active()) return;
      state.model = model; state.draft = { mode: model.mode, proxy_url: model.proxy_url || '', no_proxy: model.no_proxy.join('\n') }; paint('已清除项目网络覆盖，继承设备默认。');
    }, { ownsPage: active, onCleared: () => { state.model = null; state.draft = null; state.busy = false; state.generation++; } }));
    const draft = state.draft;
    const form = el('div', undefined, 'agent-form-grid');
    function field(label, key, type = 'text', value = '') {
      const wrap = el('label', undefined, 'agent-field'); wrap.append(el('span', label, 'agent-field-label'));
      const input = el(type === 'textarea' ? 'textarea' : 'input');
      if (type !== 'textarea') input.type = type;
      input.value = value; input.dataset.networkField = key; input.autocomplete = 'off';
      input.disabled = state.busy; wrap.append(input); form.append(wrap); return input;
    }
    const modeWrap = el('label', undefined, 'agent-field'), mode = el('select'); modeWrap.append(el('span', '连接方式', 'agent-field-label')); mode.dataset.networkField = 'mode';
    for (const [id, label] of modes) { const option = el('option', label); option.value = id; mode.append(option); }
    mode.value = draft.mode; mode.disabled = state.busy;
    mode.onchange = () => { if (!active() || state.busy) return; draft.mode = mode.value; paint(); };
    modeWrap.append(mode); form.append(modeWrap);
    let username = null, password = null, auth = null;
    if (draft.mode === 'proxy') {
      const url = field('代理地址（不含用户名 / 密码）', 'proxy_url', 'url', draft.proxy_url); url.placeholder = 'http://127.0.0.1:7897'; url.maxLength = 2048;
      url.oninput = () => { draft.proxy_url = url.value; };
      const bypass = field('绕过代理的主机（每行或逗号分隔）', 'no_proxy', 'textarea', draft.no_proxy); bypass.maxLength = 32768;
      bypass.oninput = () => { draft.no_proxy = bypass.value; };
      form.append(el('p', '回环始终直连。规则可用主机名、域名后缀、可选端口、IP 或 *；不支持 URL 或路径。* 会使全部请求绕过代理。', 'settings-note'));
      const authWrap = el('label', undefined, 'agent-field'); authWrap.append(el('span', '代理认证', 'agent-field-label')); auth = el('select'); auth.dataset.networkField = 'auth'; auth.disabled = state.busy;
      for (const [id, label] of [['keep', state.model.has_proxy_auth ? '保留已保存认证（仅同地址）' : '不添加认证'], ['set', '写入 / 替换认证'], ['clear', '清除已保存认证']]) {
        const option = el('option', label); option.value = id; auth.append(option);
      }
      auth.value = 'keep'; authWrap.append(auth); form.append(authWrap);
      username = field('代理用户名（仅写入）', 'username'); password = field('代理密码（仅写入）', 'password', 'password');
      secretInputs = [username, password];
      username.maxLength = 1024; password.maxLength = 4096;
      username.disabled = true; password.disabled = true;
      auth.onchange = () => {
        username.value = ''; password.value = '';
        username.disabled = state.busy || auth.value !== 'set'; password.disabled = username.disabled;
      };
      form.append(el('p', state.model.has_proxy_auth ? '已保存代理认证，内容不可读取。省略认证只在相同代理地址保留，更换地址会清除；提交后输入清空，失败时需重新填写。' : '尚未保存代理认证。认证输入不会回填或保存在浏览器；提交后立即清空。', 'settings-note'));
    } else {
      form.append(el('p', draft.mode === 'inherit' ? '使用 daemon 启动环境中的代理和 NO_PROXY；Agent 仍可使用既有环境覆盖。此处不读取或显示启动环境中的秘密。' : '后台请求明确绕开启动环境的代理；Agent 的显式环境覆盖仍可改变后续子进程的网络。', 'settings-note'));
    }
    const save = button('保存网络设置', async () => {
      if (!active() || state.busy) return;
      const enteredAuth = auth?.value === 'set' ? { username: username.value, password: password.value } : auth?.value === 'clear' ? null : undefined;
      if (username) username.value = '';
      if (password) password.value = '';
      const config = { version: 1, mode: draft.mode, proxy_url: null, no_proxy: [] };
      if (draft.mode === 'proxy') {
        try { config.proxy_url = proxyOrigin(draft.proxy_url.trim()); }
        catch { feedback.textContent = '代理地址必须是无认证、查询或路径的 HTTP(S) 地址；认证请填写下方独立输入。'; feedback.hidden = false; feedback.className = 'settings-error'; return; }
        config.no_proxy = draft.no_proxy.split(/[,\r\n]+/).map(value => value.trim()).filter(Boolean);
        if (enteredAuth !== undefined) config.proxy_auth = enteredAuth;
      }
      state.busy = true; const generation = ++state.generation; paint('正在保存网络设置…');
      try {
        // No global action refresh: only this panel changes, preserving other settings drafts.
        const model = projection(await client.action('agent.network.configure', { config }));
        if (!active() || generation !== state.generation) return;
        state.model = model; state.draft = { mode: model.mode, proxy_url: model.proxy_url || '', no_proxy: model.no_proxy.join('\n') };
        state.busy = false; paint('网络设置已保存；后续请求 / Agent 调用生效。已有账号凭证和运行中的调用未改变。');
      } catch (error) {
        if (active() && generation === state.generation) {
          state.busy = false; paint(unsupported(error) ? '当前 Host 或项目后台不支持保存出站网络设置，请更新并分别重启两者。' : '无法确认网络设置保存结果，请重新读取核对，检查地址、绕过规则或私有文件权限后重试；认证输入已清空。', true);
        }
      } finally { if (generation === state.generation) state.busy = false; }
    }, 'primary'); save.type = 'button'; save.disabled = state.busy;
    section.append(form, save, feedback);
  }
  section.clearSecrets = () => { for (const input of secretInputs) input.value = ''; };
  section.resume = () => { if (active()) paint(); };
  paint(); return section;
}
