// 浏览器端按需加载固定版本的 highlight.js（common 构建，36 种语言，见 highlight-LICENSE.txt）。
// 只有真正出现带语言的代码块时才拉取资源；解析结果用受控的 DOM 构建器落成 span + 文本节点，
// 不把 highlight.js 的 HTML 字符串直接 innerHTML 进页面，保持主页面 CSP 与「不注入 HTML」的约定。
// 加载失败、语言未知或解析出错都静默回退为原始文本，绝不抛错、不阻塞阅读。
const SRC = '/highlight.min.js';
// 单块着色上限：超长正文继续按纯文本展示，避免为一次阅读卡住主线程。
const MAX_CODE = 20000;

let scriptLoad = null;
const pending = [];

const ALIASES = {
  sh: 'bash', shell: 'bash', zsh: 'bash',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  html: 'xml', xhtml: 'xml', svg: 'xml',
  yml: 'yaml', md: 'markdown', py: 'python', rb: 'ruby', rs: 'rust',
  'c++': 'cpp', cs: 'csharp', 'c#': 'csharp', make: 'makefile', mk: 'makefile',
  objc: 'objectivec', pl: 'perl', patch: 'diff', kt: 'kotlin', golang: 'go',
};
// 纯文本与图表不进入高亮：既没有 token，也避免多余加载。
const SKIP = new Set(['', 'text', 'txt', 'plain', 'plaintext', 'none', 'mermaid', 'log']);

/** 归一化语言名；未知语言原样返回，交给 highlight.js 判断是否已注册。 */
export function normalizeLanguage(value) {
  const lang = String(value ?? '').trim().toLowerCase().replace(/^language-/, '');
  if (SKIP.has(lang)) return null;
  return ALIASES[lang] || lang;
}

const EXTENSION_LANGUAGE = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  json: 'json', json5: 'json', py: 'python', sh: 'bash', bash: 'bash', zsh: 'bash',
  css: 'css', scss: 'scss', less: 'less', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
  md: 'markdown', markdown: 'markdown', yml: 'yaml', yaml: 'yaml', ini: 'ini', toml: 'ini',
  sql: 'sql', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin',
  rb: 'ruby', php: 'php', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', hxx: 'cpp',
  lua: 'lua', swift: 'swift', r: 'r', pl: 'perl', pm: 'perl', diff: 'diff', patch: 'diff',
  graphql: 'graphql', gql: 'graphql', wasm: 'wasm', vb: 'vbnet',
};

/** 从文件路径推断语言；只认已知扩展名，推断不出就不着色。 */
export function languageFromPath(value) {
  const match = /\.([A-Za-z0-9+#]+)$/.exec(String(value ?? ''));
  return match ? EXTENSION_LANGUAGE[match[1].toLowerCase()] || null : null;
}

function api(doc) { return doc?.defaultView?.hljs || globalThis.hljs || null; }

/** 测试接缝：清掉模块级的加载状态与待处理队列，避免跨用例污染。 */
export function resetCodeHighlight() { scriptLoad = null; pending.length = 0; }

function load(doc) {
  const ready = api(doc);
  if (ready) return Promise.resolve(ready);
  if (scriptLoad) return scriptLoad;
  const head = doc?.head;
  // 没有可挂载的 <head>（例如纯逻辑测试里的假 doc）就不去拉资源，也绝不缓存失败。
  if (!head || typeof doc.createElement !== 'function') return Promise.resolve(null);
  scriptLoad = new Promise(resolve => {
    const script = doc.createElement('script');
    script.setAttribute('src', SRC);
    script.setAttribute('data-lush-highlight', 'true');
    script.onload = () => resolve(api(doc));
    script.onerror = () => resolve(null);
    head.append(script);
  });
  return scriptLoad;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[name] ?? match;
  });
}

// highlight.js 的输出是受控子集：已转义的文本与 <span class="hljs-...">。只复制 span 与文本，
// class 只保留合法 token；任何意外标签都按字面文本处理，不执行、不注入。
//
// 返回的是「所有顶层节点」的数组，而不是包装元素：浏览器里 Element.children 只含元素节点，
// 若直接搬 .children，token 之间的纯文本会全部丢失，只剩高亮 span，正文含义被彻底改变。
function parseHighlighted(html, doc) {
  const opened = [];   // 当前打开的内层 span；为空表示这段还在顶层
  const top = [];      // 按出现顺序排列的顶层节点，文本节点与 token span 都在内
  const append = node => {
    const parent = opened[opened.length - 1];
    if (parent) parent.append(node); else top.push(node);
  };
  const pushText = text => { if (text) append(doc.createTextNode(decodeEntities(text))); };
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf('<', index);
    if (open < 0) { pushText(html.slice(index)); break; }
    if (open > index) pushText(html.slice(index, open));
    const close = html.indexOf('>', open);
    if (close < 0) { pushText(html.slice(open)); break; }
    const tag = html.slice(open + 1, close);
    if (/^span(\s|$|\/)/i.test(tag)) {
      const classes = /class="([^"]*)"/.exec(tag);
      const span = doc.createElement('span');
      if (classes) span.className = classes[1].split(/\s+/).filter(token => /^[A-Za-z0-9_-]+$/.test(token)).join(' ');
      append(span); opened.push(span);
    } else if (/^\/span\s*$/i.test(tag)) {
      opened.pop();
    } else {
      pushText(html.slice(open, close + 1));
    }
    index = close + 1;
  }
  return top;
}

function apply(hljs, target, text, language) {
  let languageApi = null;
  try { languageApi = hljs.getLanguage?.(language); } catch { languageApi = null; }
  if (!languageApi) return;
  let html;
  try { html = hljs.highlight(text, { language }).value; } catch { return; }
  if (typeof html !== 'string') return;
  const doc = target.ownerDocument || globalThis.document;
  if (!doc?.createElement) return;
  target.replaceChildren(...parseHighlighted(html, doc));
  target.classList?.add('hljs');
}

function flush(instance) {
  for (const item of pending.splice(0)) apply(instance, item.target, item.text, item.language);
}

/** 就地把代码元素着色；未就绪时排队，库加载完成后统一升级。可安全重复调用。 */
export function enhanceCode(target, text, language) {
  const lang = normalizeLanguage(language);
  if (!target || !text || !lang || text.length > MAX_CODE) return;
  const doc = target.ownerDocument || globalThis.document;
  const ready = api(doc);
  if (ready) { apply(ready, target, text, lang); return; }
  pending.push({ target, text, language: lang });
  load(doc).then(instance => { if (instance) flush(instance); else pending.length = 0; });
}
