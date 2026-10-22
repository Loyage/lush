import { api } from './api.js';
import { WEB_PUSH_PATHS, WEB_PUSH_VERSION } from '../../../shared/web-push-protocol.js';

const TIMEOUT = 8000;
let pendingCheck = null, cached = null, operation = null, generation = 0;
let workerOwner = null, workerPromise = null;
const safeError = message => Object.assign(new Error(message), { pushSafe: true });
const state = (status, local = false) => ({ status, local, subscribed: status === 'subscribed' });

export function pushUnsupportedReason() {
  if (globalThis.isSecureContext === false) return '后台推送需要 HTTPS 或 localhost。';
  if (!globalThis.Notification || !globalThis.navigator?.serviceWorker || !globalThis.PushManager) {
    return '此浏览器不支持后台推送；iPhone／iPad 16.4+ 请先添加到主屏幕，再从主屏幕打开。';
  }
  return '';
}

function deadline(work, message) {
  let timer;
  return Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
    timer = setTimeout(() => reject(safeError(message)), TIMEOUT);
  })]).finally(() => clearTimeout(timer));
}

async function request(path, body) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const value = await api(path, { signal: controller.signal, ...(body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }) });
    if (value?.version !== WEB_PUSH_VERSION) throw safeError('Host 推送协议不兼容，请更新界面服务。');
    return value;
  } catch (error) {
    if (error.pushSafe) throw error;
    throw safeError(error.status === 401 ? '登录已失效，请登录后重新检查后台推送。'
      : '后台推送操作未确认；请重新检查状态，不要自动重复提交。');
  } finally { clearTimeout(timer); }
}

function keyBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{87}$/.test(value)) throw safeError('Host 推送密钥不可用，请检查界面服务。');
  const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
  if (bytes.length !== 65 || bytes[0] !== 4) throw safeError('Host 推送密钥不可用，请检查界面服务。');
  return bytes;
}
function sameKey(subscription, key) {
  const value = subscription.options?.applicationServerKey;
  if (!value) return false;
  const bytes = new Uint8Array(value);
  return bytes.length === key.length && bytes.every((byte, index) => byte === key[index]);
}
function subscriptionKey(subscription) {
  const key = subscription.options?.applicationServerKey;
  return key ? Array.from(new Uint8Array(key)).join(',') : '';
}
async function localSubscription() {
  const workers = globalThis.navigator?.serviceWorker;
  if (!workers?.getRegistration) return null;
  return deadline(async () => {
    const registration = await workers.getRegistration('/');
    return registration?.pushManager ? await registration.pushManager.getSubscription() : null;
  }, '浏览器订阅状态读取超时，请重新检查。');
}

/** No register/subscribe here: startup, refresh and observers may only inspect existing authority. */
export async function checkBackgroundPush({ force = false } = {}) {
  if (pushUnsupportedReason()) return state('unsupported');
  let subscription;
  try { subscription = await localSubscription(); }
  catch { return state('unknown'); }
  if (!subscription) { cached = null; return state(Notification.permission === 'denied' ? 'denied' : 'unsubscribed'); }
  if (Notification.permission !== 'granted') return state('denied', true);
  const keyId = subscriptionKey(subscription), epoch = generation;
  if (!force && cached?.endpoint === subscription.endpoint && cached.key === keyId
    && Date.now() - cached.at < 3000) return cached.value;
  // Native getSubscription() may return a new JS wrapper for the same browser authority.
  if (!force && pendingCheck?.endpoint === subscription.endpoint && pendingCheck.key === keyId) return pendingCheck.promise;
  const promise = (async () => {
    try {
      const config = await request(WEB_PUSH_PATHS.config), key = keyBytes(config.public_key);
      if (!sameKey(subscription, key)) return state('key-changed', true);
      const model = await request(WEB_PUSH_PATHS.status, { endpoint: subscription.endpoint });
      if (typeof model.subscribed !== 'boolean') throw safeError('Host 订阅状态不可用，请重新检查。');
      const latest = await localSubscription();
      if (generation !== epoch || latest?.endpoint !== subscription.endpoint || subscriptionKey(latest) !== keyId) {
        return state('unknown', Boolean(latest));
      }
      const value = state(model.subscribed ? 'subscribed' : 'unregistered', true);
      cached = { endpoint: subscription.endpoint, key: keyId, at: Date.now(), value };
      return value;
    } catch { return state('unknown', true); }
  })();
  const current = pendingCheck = { endpoint: subscription.endpoint, key: keyId, promise };
  try { return await promise; } finally { if (pendingCheck === current) pendingCheck = null; }
}

export async function backgroundPushActive() { return (await checkBackgroundPush()).subscribed; }

function activeWorker(registration) {
  if (registration.active) return Promise.resolve(registration);
  return new Promise((resolve, reject) => {
    const worker = registration.installing || registration.waiting;
    if (!worker) { reject(safeError('通知服务尚未就绪，请重新启用。')); return; }
    const changed = () => {
      if (registration.active || worker.state === 'activated') { cleanup(); resolve(registration); }
      else if (worker.state === 'redundant') { cleanup(); reject(safeError('通知服务更新失败，请重新启用。')); }
    };
    const timer = setTimeout(() => { cleanup(); reject(safeError('通知服务启动超时，请重新启用。')); }, TIMEOUT);
    const cleanup = () => { clearTimeout(timer); worker.removeEventListener('statechange', changed); };
    worker.addEventListener('statechange', changed); changed();
  });
}

/** Root classic worker handles notifications only; it never caches authenticated pages. */
export async function notificationWorker() {
  const workers = globalThis.navigator?.serviceWorker;
  if (!workers?.register || globalThis.isSecureContext === false) throw safeError('此环境无法启动通知服务，请使用 HTTPS。');
  if (workerOwner !== workers) { workerOwner = workers; workerPromise = null; }
  if (!workerPromise) {
    const current = workerPromise = deadline(() => workers.register(WEB_PUSH_PATHS.worker, { scope: '/', updateViaCache: 'none' }),
      '通知服务注册超时，请重新启用。').then(activeWorker).catch(() => {
      throw safeError('通知服务未就绪，请检查 HTTPS、网络和浏览器支持后重试。');
    }).finally(() => { if (workerPromise === current) workerPromise = null; });
  }
  return workerPromise;
}

function mutate(work) {
  if (operation) return Promise.reject(safeError('当前浏览器正在处理推送操作，请稍后重新检查。'));
  cached = null; ++generation;
  const run = globalThis.navigator?.locks?.request
    ? navigator.locks.request('lush.push-subscription', work) : Promise.resolve().then(work);
  const current = operation = run;
  return run.catch(error => { throw error.pushSafe ? error : safeError('浏览器推送操作未确认，请重新检查状态。'); })
    .finally(() => { cached = null; ++generation; if (operation === current) operation = null; });
}

/** Must be called directly by a user gesture: permission starts before the first await/lock. */
export function enableBackgroundPush() {
  const unsupported = pushUnsupportedReason();
  if (unsupported) return Promise.reject(safeError(unsupported));
  if (operation) return Promise.reject(safeError('当前浏览器正在处理推送操作，请稍后重新检查。'));
  let permission;
  try { permission = Notification.permission === 'granted' ? Promise.resolve('granted') : Notification.requestPermission(); }
  catch { return Promise.reject(safeError('浏览器未授权通知，请检查站点权限。')); }
  // Handle a rejected permission promise even if acquiring a cross-tab lock takes longer.
  const granted = Promise.resolve(permission).then(value => value === 'granted', () => false);
  return mutate(async () => {
    if (!await granted) throw safeError('此浏览器通知未获授权；未修改系统通知总开关。');
    const registration = await notificationWorker();
    const config = await request(WEB_PUSH_PATHS.config), key = keyBytes(config.public_key);
    let subscription = await deadline(() => registration.pushManager.getSubscription(), '浏览器订阅读取超时，请重新检查。');
    if (subscription && !sameKey(subscription, key)) {
      await request(WEB_PUSH_PATHS.unsubscribe, { endpoint: subscription.endpoint });
      if (!await deadline(() => subscription.unsubscribe(), '旧订阅撤销超时，请重新检查。')) throw safeError('旧订阅未确认撤销，请重新检查后再启用。');
      subscription = null;
    }
    subscription ||= await deadline(() => registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }),
      '浏览器订阅创建超时，请重新检查；未自动重新提交。');
    if (!sameKey(subscription, key)) throw safeError('浏览器订阅密钥不匹配，请重新检查。');
    const result = await request(WEB_PUSH_PATHS.subscribe, { subscription: subscription.toJSON() });
    if (typeof result.id !== 'string' || !result.id) throw safeError('Host 未确认订阅，请重新检查状态。');
    return state('subscribed', true);
  });
}

export function disableBackgroundPush() {
  return mutate(async () => {
    const subscription = await localSubscription();
    if (!subscription) return state('unsubscribed');
    const result = await request(WEB_PUSH_PATHS.unsubscribe, { endpoint: subscription.endpoint });
    if (result.subscribed !== false) throw safeError('Host 未确认撤销，请重新检查状态。');
    if (!await deadline(() => subscription.unsubscribe(), 'Host 已撤销；浏览器清理超时，请重新检查。')) throw safeError('Host 已撤销；浏览器本地清理未确认，请重新检查。');
    return state('unsubscribed');
  });
}

export function testBackgroundPush() {
  return mutate(async () => {
    const current = await checkBackgroundPush({ force: true });
    if (!current.subscribed) throw safeError('当前浏览器尚未确认后台订阅，请先检查或显式启用。');
    const subscription = await localSubscription();
    if (!subscription) throw safeError('浏览器订阅已失效，请重新检查。');
    const result = await request(WEB_PUSH_PATHS.test, { endpoint: subscription.endpoint });
    if (result.accepted !== true) throw safeError('推送服务未确认接受测试请求，请重新检查。');
    return result;
  });
}
