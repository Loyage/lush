import { el, button } from './dom.js';
import { field, note, helped, finite, time } from './connection-view-common.js';

const DEVICE_FAILURE_REASONS = {
  network: '项目后台无法连接 OpenAI，请检查后台机器的网络或代理。',
  timeout: 'OpenAI 请求超过 8 秒未完成，请稍后重试或检查后台网络。',
  unsupported: 'OpenAI 未开放设备码接口，请显式使用备用回调登录。',
  unauthorized: 'OpenAI 拒绝了设备码请求，请检查账号是否允许 Codex 设备码登录，或使用备用方式。',
  rate_limited: 'OpenAI 限制了请求频率，请稍后重试。',
  invalid_response: '设备码响应格式不兼容或超过安全限制，请使用备用登录并报告此分类。',
  auth_changed: '连接配置或登录会话已更换，请重新发起登录。',
  auth_locked: '凭证正在被更新，请稍后重试。',
  login_expired: '本次登录已过期或被取消，请重新发起。',
  stopped: '项目后台已停止或本次请求被取消。',
  unsupported_platform: '后台平台无法安全托管凭证。',
  unknown: '后台未能确认失败类型；请检查连接配置和私有文件权限。',
};
function deviceFailureReason(error) {
  const match = /^Codex device login failed \(([a-z_]+)\)$/.exec(error?.message || '');
  if (match && Object.hasOwn(DEVICE_FAILURE_REASONS, match[1])) return `（${match[1]}）${DEVICE_FAILURE_REASONS[match[1]]}`;
  if (error?.message === 'device_login_clock') return '浏览器判断设备码已过期，请核对浏览器与后台机器的系统时间。';
  if (error?.message === 'device_login_invalid_response') return DEVICE_FAILURE_REASONS.invalid_response;
  if (error?.message === 'method not allowed from Web UI' || error?.message === 'unknown method: agent.connections.device.start')
    return '当前 Host 或项目后台不支持设备码接口，请更新并分别重启两者。';
  if (['Failed to fetch','NetworkError when attempting to fetch resource.'].includes(error?.message))
    return '浏览器无法连接 Lush 服务，请检查连接后重试。';
  return '未取得可识别的错误分类，请重试或使用备用回调登录。';
}

/** Short-lived authentication state; no credential is retained in public drafts. */
export function createConnectionLogin({ node, editorHost, editor, current, post, load, autoRefresh, message, invalidateList, selectConnection, back, now, setTimer, clearTimer }) {
  let deviceSession = null, loginSequence = 0;
  const loginVisible = () => {
    if (!current()) return false;
    for (let parent = node; parent; parent = parent.parentNode) if (parent.hidden) return false;
    return true;
  };
  const cancelDevice = login => post('agent.connections.device.cancel', { id: login.id, login_id: login.login_id }).catch(() => {});
  function stopDevice(cancel = true) {
    const session = deviceSession; if (!session) return;
    deviceSession = null; clearTimer(session.timer); session.observer?.disconnect();
    globalThis.removeEventListener?.('pagehide', session.leave);
    session.code.value = ''; session.login.user_code = '';
    session.copy.disabled = true;
    if (cancel) {
      session.feedback.textContent = '本次自动登录检查已停止；如需继续，请重新发起登录。';
      void cancelDevice(session.login);
    }
  }
  function invalidateLogin() { ++loginSequence; stopDevice(); }
  async function beginDeviceLogin(connection) {
    if (!loginVisible()) return;
    selectConnection(connection.id); editor.close(); invalidateLogin(); invalidateList();
    const revision = editor.revision(), loginStamp = loginSequence;
    message('正在获取 Codex 设备码…');
    let login;
    try {
      login = await post('agent.connections.device.start', { id: connection.id });
      if (!loginVisible() || revision !== editor.revision() || loginStamp !== loginSequence) { if (login?.id === connection.id && login.login_id) void cancelDevice(login); return; }
      if (login.id !== connection.id || typeof login.login_id !== 'string' || !login.login_id || login.login_id.length > 128
        || login.verification_uri !== 'https://auth.openai.com/codex/device'
        || typeof login.user_code !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(login.user_code)
        || !finite(login.interval_seconds) || login.interval_seconds < 1 || login.interval_seconds > 900
        || !Number.isFinite(Date.parse(login.expires_at))) throw new Error('device_login_invalid_response');
      if (Date.parse(login.expires_at) <= now()) throw new Error('device_login_clock');
    } catch (error) {
      if (login?.id === connection.id && login.login_id) void cancelDevice(login);
      if (loginVisible() && revision === editor.revision() && loginStamp === loginSequence)
        message(`无法获取设备码：${deviceFailureReason(error)} 未改变已有凭证。`, true);
      return;
    }
    editor.showLogin(connection.id, 'Codex 设备码登录');
    const form = el('div', undefined, 'agent-connection-form'), link = el('a', '打开 OpenAI 设备码授权页面', 'nav-link');
    link.href = login.verification_uri; link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.setAttribute('data-help', '在 OpenAI 官方页面输入下方设备码，完成本人发起的授权；Lush 会自动确认，不需要粘贴回调 URL。');
    note(form, `登录连接：${connection.label} · 设备码到期：${time(login.expires_at)}`); form.append(link);
    const code = field(form, '设备码（在官方页面输入）', 'user_code', 'text', login.user_code);
    code.readOnly = true; code.className = 'agent-device-code'; code.autocomplete = 'off'; code.setAttribute('spellcheck', 'false');
    note(form, '仅授权自己发起的设备码，不要分享。若服务商要求，请在 ChatGPT 安全设置中启用 Codex 设备码登录。');
    note(form, '无需回调端口或粘贴 URL；离开此页将停止检查，不在后台继续登录。外部 Pi 登录保持不变，不调用 Agent 或模型。');
    const loginFeedback = el('p', '等待你在官方页面授权，完成后将自动保存…', 'hint agent-device-feedback'); loginFeedback.setAttribute('role', 'status');
    const session = { login, code, feedback: loginFeedback, deadline: Math.min(Date.parse(login.expires_at), now() + 15 * 60000),
      copy: null, timer: null, observer: null, leave: () => stopDevice() }; deviceSession = session;
    const active = () => deviceSession === session && loginStamp === loginSequence && loginVisible();
    const end = value => {
      if (deviceSession !== session) return;
      const visible = active(); stopDevice();
      if (visible) { loginFeedback.textContent = value; loginFeedback.setAttribute('role', 'alert'); }
    };
    const schedule = seconds => {
      if (!active()) { stopDevice(); return; }
      const remaining = Math.min(Date.parse(login.expires_at), session.deadline) - now();
      if (remaining <= 0) { end('设备码已过期，请重新发起登录。'); return; }
      session.timer = setTimer(poll, Math.min(seconds * 1000, remaining));
    };
    async function poll() {
      if (!active()) { if (deviceSession === session) stopDevice(); return; }
      if (Math.min(Date.parse(login.expires_at), session.deadline) <= now()) { end('设备码已过期，请重新发起登录。'); return; }
      try {
        const result = await post('agent.connections.device.poll', { id: login.id, login_id: login.login_id });
        if (!active()) { if (deviceSession === session) stopDevice(); return; }
        if (result?.id !== login.id || result.login_id !== login.login_id) throw new Error('invalid device response');
        if (result.status === 'complete' && result.connection?.id === login.id) {
          stopDevice(false); editor.close(); editorHost.replaceChildren(); back(); const completedStamp = loginSequence;
          await load(true);
          const refreshed = await autoRefresh(login.id);
          if (current() && completedStamp === loginSequence) message(refreshed === false ? '设备码登录已保存；自动查询失败或未知（非零余额）。' : '设备码登录已保存，外部客户端登录未改动。');
          return;
        }
        if (result.status !== 'pending' || !finite(result.interval_seconds) || result.interval_seconds < 1 || result.interval_seconds > 900
          || !Number.isFinite(Date.parse(result.expires_at)) || Date.parse(result.expires_at) > Date.parse(login.expires_at)) throw new Error('invalid device response');
        login.expires_at = result.expires_at;
        loginFeedback.textContent = `等待授权；每 ${result.interval_seconds} 秒检查一次，服务限流时会延长间隔。`;
        schedule(result.interval_seconds);
      } catch (error) { end(`登录检查未完成：${deviceFailureReason(error)} 请重新登录或显式使用备用回调方式。已有凭证不变。`); }
    }
    const actions = el('div', undefined, 'agent-connection-actions');
    const copyHost = helped('复制设备码', async () => {
      if (!active()) return;
      try {
        if (!globalThis.navigator?.clipboard?.writeText) throw new Error('clipboard unavailable');
        await globalThis.navigator.clipboard.writeText(code.value);
        if (active()) loginFeedback.textContent = '设备码已复制；请在官方页面授权，Lush 将自动确认。';
      } catch { if (active()) { code.focus(); code.select?.(); loginFeedback.textContent = '无法自动复制；请手动选中上方设备码复制。'; } }
    }, '仅复制当前短期设备码到系统剪贴板，不保存到浏览器；请只在 OpenAI 官方页面输入，不分享。');
    session.copy = copyHost.children[0];
    actions.append(copyHost, helped('取消登录', () => { if (active()) { stopDevice(); editor.close(); back(); message('设备码登录已取消；已有凭证不变。'); } }, '停止自动检查并取消本次设备码登录，不删除已有账号凭证。'));
    note(form, '登录成功后会自动联网查询此连接的余额 / 套餐，不调用模型；查询失败不撤销登录成功。');
    editorHost.replaceChildren(form, loginFeedback, actions); code.focus();
    globalThis.addEventListener?.('pagehide', session.leave);
    if (typeof globalThis.MutationObserver === 'function') {
      session.observer = new globalThis.MutationObserver(() => { if (!loginVisible()) stopDevice(); });
      session.observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
    }
    message('设备码已获取；请在 OpenAI 官方页面输入短码，授权后自动完成。');
    schedule(login.interval_seconds);
  }
  async function beginLogin(connection) {
    if (!current()) return;
    selectConnection(connection.id); editor.close(); invalidateLogin(); invalidateList(); const revision = editor.revision(), loginStamp = loginSequence; message('正在创建独立 OAuth 登录请求…');
    let login;
    try {
      login = await post('agent.connections.login.start', { id: connection.id }); if (!current() || revision !== editor.revision() || loginStamp !== loginSequence) return;
      const url = new URL(login.url), callback = new URL(login.redirect_uri);
      if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com' || url.pathname !== '/oauth/authorize' || url.username || url.password || url.hash || login.id !== connection.id
        || !['localhost', '127.0.0.1'].includes(callback.hostname) || callback.pathname !== '/auth/callback' || !['http:', 'https:'].includes(callback.protocol)
        || !login.login_id || !Number.isFinite(Date.parse(login.expires_at)) || Date.parse(login.expires_at) <= Date.now()) throw new Error('invalid OAuth response');
    } catch { if (revision === editor.revision() && loginStamp === loginSequence) message('无法创建安全登录请求，请重试；未改变已有凭证。', true); return; }
    editor.showLogin(connection.id, 'Codex 独立账号登录');
    const form = el('div', undefined, 'agent-connection-form'), link = el('a', '打开 Codex 授权页面', 'nav-link');
    link.href = login.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.setAttribute('data-help', '在 OpenAI 官方授权页登录；授权后复制浏览器地址栏的回调 URL，返回本页完成登录。不会调用 Agent。');
    note(form, `登录连接：${connection.label} · 请求到期：${time(login.expires_at)}`);
    note(form, '运行中的临时认证不携带 refresh token；长调用期间 access token 过期可能失败，下次 invocation 再由 Lush 协调刷新。');
    form.append(link); note(form, '授权后复制浏览器地址栏中的完整回调 URL。首版采用手动粘贴，回调页可能无法打开；远端 SSH 无需开放额外回调端口。');
    const callback = field(form, '授权回调 URL（仅提交，不回显）', 'redirect_url', 'password');
    callback.autocomplete = 'off'; callback.maxLength = 16384; callback.setAttribute('spellcheck', 'false');
    const loginFeedback = el('p', undefined, 'hint'); loginFeedback.setAttribute('role', 'status');
    const actions = el('div', undefined, 'agent-connection-actions'); let finishing = false;
    actions.append(helped('完成登录', async () => {
      if (!current() || finishing) return;
      const redirect_url = callback.value.trim(); callback.value = '';
      if (!redirect_url) { loginFeedback.textContent = '请粘贴完整授权回调 URL。'; return; }
      try { const value = new URL(redirect_url), expected = new URL(login.redirect_uri);
        if (value.origin !== expected.origin || value.pathname !== expected.pathname) throw new Error('wrong callback');
      } catch { loginFeedback.textContent = '回调地址不匹配；请复制本次授权后的完整地址，输入已清空。'; return; }
      finishing = true; invalidateList(); const finishRevision = editor.revision(); loginFeedback.textContent = '正在验证并保存设备登录…';
      try {
        await post('agent.connections.login.finish', { id: connection.id, login_id: login.login_id, redirect_url });
        if (!current() || finishRevision !== editor.revision() || loginStamp !== loginSequence) return;
        editor.close(); editorHost.replaceChildren(); back(); const completedStamp = loginSequence;
        await load(true); const refreshed = await autoRefresh(connection.id);
        if (completedStamp === loginSequence) message(refreshed === false ? '设备登录已保存；自动查询失败或未知（非零余额）。' : '设备登录已保存，外部客户端登录未改动。');
      } catch { if (current() && finishRevision === editor.revision() && loginStamp === loginSequence) { loginFeedback.textContent = '登录未完成；回调输入已清空，请重新发起登录。不会回显授权码或上游错误。'; loginFeedback.setAttribute('role', 'alert'); } }
      finally { finishing = false; }
    }, '仅兑换本次授权码并保存设备 OAuth 凭证；不会修改外部客户端登录，也不会调用模型。'),
    button('取消登录', () => { if (current()) { callback.value = ''; editor.close(); back(); } }, 'ghost'));
    note(form, '登录成功后会自动联网查询此连接的余额 / 套餐，不调用模型；查询失败不撤销登录成功。');
    editorHost.replaceChildren(form, loginFeedback, actions); callback.focus(); message('授权请求已创建；请打开官方授权页面并粘贴回调地址。');
  }
  return { beginDeviceLogin, beginLogin, invalidate: invalidateLogin, activeId: () => deviceSession?.login.id };
}
