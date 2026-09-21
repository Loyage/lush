/**
 * 极简 DOM stub：只实现 `src/ui/web/assets/app.js` 用到的那部分浏览器 API，
 * 让「页面自己变新」和「批量合并」的前端逻辑能在 bun test 里真的跑一遍，而不是只靠读代码。
 * 不是通用 DOM：选择器只支持 tag / .class / [attr="value"] 的组合，够用即可。
 */
class StubNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.textContent = '';
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.listeners = {};
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.title = '';
    this.scrollTop = 0;
    this._classes = new Set();
    this.classList = {
      add: (...names) => { for (const name of names) if (name) this._classes.add(name); },
      remove: (...names) => { for (const name of names) this._classes.delete(name); },
      contains: name => this._classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !this._classes.has(name) : Boolean(force);
        if (on) this._classes.add(name); else this._classes.delete(name);
        return on;
      },
    };
  }
  get className() { return [...this._classes].join(' '); }
  set className(value) { this._classes = new Set(String(value ?? '').split(/\s+/).filter(Boolean)); }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'class') this.className = value;
    else if (name.startsWith('data-')) this.dataset[dataKey(name)] = String(value);
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  append(...nodes) {
    for (const node of nodes) {
      if (node === null || node === undefined || node === false) continue;
      const child = typeof node === 'string' ? textNode(node) : node;
      child.parentNode = this;
      this.children.push(child);
    }
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }
  insertBefore(node, reference) {
    // 与浏览器一致：把节点从原位置摘下来再插到 reference 之前，否则同一父节点下换位
    // 会把自己复制成两个（syncChildren 重排列表时就会踩到）。
    if (node.parentNode) {
      const old = node.parentNode.children.indexOf(node);
      if (old >= 0) node.parentNode.children.splice(old, 1);
    }
    const at = reference ? this.children.indexOf(reference) : -1;
    node.parentNode = this;
    if (at < 0) this.children.push(node); else this.children.splice(at, 0, node);
    return node;
  }
  remove() {
    if (!this.parentNode) return;
    const at = this.parentNode.children.indexOf(this);
    if (at >= 0) this.parentNode.children.splice(at, 1);
    this.parentNode = null;
  }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  querySelector(selector) { return walk(this).find(node => matches(node, selector)) || null; }
  querySelectorAll(selector) { return walk(this).filter(node => matches(node, selector)); }
}
function textNode(value) { const node = new StubNode('#text'); node.textContent = String(value); return node; }
const dataKey = name => name.slice(5).replace(/-([a-z])/g, (_m, char) => char.toUpperCase());
function walk(node, out = []) { for (const child of node.children) { out.push(child); walk(child, out); } return out; }
function matches(node, selector) {
  const attr = /\[([^=\]]+)="([^"]*)"\]/.exec(selector);
  const cls = /\.([\w-]+)/.exec(selector);
  const tag = selector.replace(/\[[^\]]*\]/g, '').replace(/\.[\w-]+/g, '');
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  if (cls && !node._classes.has(cls[1])) return false;
  if (attr) {
    const [, name, value] = attr;
    const actual = name.startsWith('data-') ? node.dataset[dataKey(name)] : node.attributes[name];
    if (String(actual) !== value) return false;
  }
  return true;
}

/** 递归找第一个 textContent 等于（或包含）某个文本的元素，用来「点」按钮。 */
export function findByText(root, text) {
  return walk(root).find(node => node.tagName !== '#TEXT' && (node.textContent === text || node.textContent.includes(text))) || null;
}
export function allByTag(root, tag) { return walk(root).filter(node => node.tagName === tag.toUpperCase()); }
/** 子树里所有叶子的文本拼起来：stub 的容器没有聚合 textContent，断言时用它代替。 */
export function deepText(root) { return walk(root).map(node => node.textContent).join(' '); }

export function installDom({ fetch: fetchImpl } = {}) {
  const byId = new Map();
  const listeners = {};
  const intervals = [];
  const location = { hash: '', pathname: '/' };
  // 浏览器里 pushState / replaceState 都会改地址栏；stub 只关心 hash，两个都实现。区别只在
  // 「后退能不能回到概览」这条浏览器行为上，所以另外记一个压栈次数让测试能断言。
  let pushed = 0;
  const setUrl = url => { const at = String(url).indexOf('#'); location.hash = at >= 0 ? String(url).slice(at) : ''; };
  let selectionText = '';
  const window = {
    history: { replaceState: (_state, _title, url) => setUrl(url), pushState: (_state, _title, url) => { pushed += 1; setUrl(url); } },
    open: () => null,
    getSelection: () => ({ isCollapsed: !selectionText, toString: () => selectionText }),
  };
  const store = new Map();
  const localStorage = { getItem: key => (store.has(key) ? store.get(key) : null), setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key) };
  const confirms = [], prompts = [];
  let promptReply = '';
  const document = {
    createElement: tag => new StubNode(tag),
    createTextNode: textNode,
    getElementById: id => { if (!byId.has(id)) byId.set(id, new StubNode(id === 'input-form' ? 'form' : 'div')); return byId.get(id); },
    activeElement: null,
  };
  const saved = new Map();
  const assign = (name, value) => {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  };
  assign('document', document);
  assign('window', window);
  assign('location', location);
  assign('localStorage', localStorage);
  assign('confirm', message => { confirms.push(String(message)); return true; });
  assign('prompt', message => { prompts.push(String(message)); return promptReply; });
  assign('fetch', fetchImpl);
  assign('addEventListener', (type, handler) => { (listeners[type] ||= []).push(handler); });
  assign('removeEventListener', (type, handler) => { const at = (listeners[type] || []).indexOf(handler); if (at >= 0) listeners[type].splice(at, 1); });
  assign('setInterval', (handler, ms) => { intervals.push({ handler, ms }); return intervals.length; });
  return {
    document, window, location, listeners, intervals, byId, confirms, prompts,
    pushed: () => pushed,
    setPrompt: value => { promptReply = String(value); },
    setSelection: value => { selectionText = String(value); },
    node: id => document.getElementById(id),
    fire: async (type, event = {}) => { for (const handler of listeners[type] || []) await handler(event); },
    intervalFor: ms => intervals.find(entry => entry.ms === ms)?.handler,
    restore() {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  };
}
