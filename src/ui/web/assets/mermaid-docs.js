// Mermaid 只属于受控的文档视图：首次遇到 mermaid fence 时才加载本地固定版本，
// Agent 输出继续由 markdown.js 当普通代码渲染。任何加载/解析失败都回退到可复制的源码。

const MERMAID_SRC = '/mermaid.min.js';
const MAX_DIAGRAMS = 24;
const MAX_SOURCE_LENGTH = 30000;
let loading = null;
let renderBatch = 0;
let renderQueue = Promise.resolve();
const sources = new WeakMap();

function mermaidGlobal(doc) {
  return doc.defaultView?.mermaid || globalThis.mermaid || null;
}

function loadMermaid(doc) {
  const ready = mermaidGlobal(doc);
  if (ready) return Promise.resolve(ready);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const script = doc.createElement('script');
    script.setAttribute('src', MERMAID_SRC);
    script.setAttribute('data-lush-mermaid', 'true');
    script.onload = () => {
      const api = mermaidGlobal(doc);
      if (api) resolve(api);
      else reject(new Error('Mermaid loaded without a browser API'));
    };
    script.onerror = () => reject(new Error('Unable to load Mermaid'));
    doc.head.append(script);
  });
  return loading;
}

function svgImage(doc, source) {
  const BlobType = doc.defaultView?.Blob || globalThis.Blob;
  const URLType = doc.defaultView?.URL || globalThis.URL;
  if (!BlobType || typeof URLType?.createObjectURL !== 'function') throw new Error('SVG image API is unavailable');
  const url = URLType.createObjectURL(new BlobType([source], { type: 'image/svg+xml' }));
  const image = doc.createElement('img');
  image.setAttribute('src', url);
  image.setAttribute('alt', '');
  image.setAttribute('class', 'md-mermaid-image');
  const viewBox = /\bviewBox="[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)"/.exec(source);
  if (viewBox) image.setAttribute('width', String(Math.min(1800, Math.max(640, Math.ceil(Number(viewBox[1]))))));
  return { image, url };
}

/** 文档换页前释放这篇正文创建的 blob URL。 */
export function clearMermaidDiagrams(root) {
  const URLType = root?.ownerDocument?.defaultView?.URL || globalThis.URL;
  for (const node of root?.querySelectorAll?.('[data-mermaid-url]') || []) {
    const url = node.getAttribute('data-mermaid-url');
    if (url) URLType?.revokeObjectURL?.(url);
    node.removeAttribute?.('data-mermaid-url');
  }
}

function fallback(node, source, message) {
  const doc = node.ownerDocument || globalThis.document;
  const label = doc.createElement('span');
  label.setAttribute('class', 'md-lang');
  label.append(doc.createTextNode(message || 'mermaid'));
  const pre = doc.createElement('pre'), code = doc.createElement('code');
  code.setAttribute('class', 'language-mermaid');
  code.append(doc.createTextNode(source)); pre.append(code);
  node.setAttribute('class', 'md-code md-mermaid-fallback');
  node.setAttribute('data-mermaid-state', 'fallback');
  node.removeAttribute('role'); node.removeAttribute('aria-label');
  node.replaceChildren(label, pre);
}

/** 实际渲染由下方队列串行调用：Mermaid 配置是全局的，主题切换不能与上一轮交错。 */
async function renderNow(root) {
  const doc = root?.ownerDocument || globalThis.document;
  const nodes = [...(root?.querySelectorAll?.('.md-mermaid[data-mermaid-state="pending"]') || [])];
  if (!nodes.length) return 0;
  const accepted = nodes.slice(0, MAX_DIAGRAMS);
  for (const node of nodes.slice(MAX_DIAGRAMS)) fallback(node, node.textContent, 'mermaid · 图表数量超限');

  let mermaid;
  try { mermaid = await loadMermaid(doc); }
  catch (error) {
    for (const node of accepted) fallback(node, node.textContent, `mermaid · ${error.message}`);
    return 0;
  }

  const dark = doc.documentElement?.dataset?.theme === 'dark';
  const themeVariables = dark ? {
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif', fontSize: '14px',
    background: '#101917', primaryColor: '#173b32', primaryTextColor: '#e8f7f1', primaryBorderColor: '#65b995',
    secondaryColor: '#202d39', secondaryTextColor: '#edf4ff', secondaryBorderColor: '#7f9fbe',
    tertiaryColor: '#332d45', tertiaryTextColor: '#f4efff', tertiaryBorderColor: '#a99ac8',
    lineColor: '#88a59a', textColor: '#e8f1ed', mainBkg: '#173b32', nodeBorder: '#65b995',
    clusterBkg: '#14211e', clusterBorder: '#38584e', edgeLabelBackground: '#14211e',
    actorBkg: '#173b32', actorBorder: '#65b995', actorTextColor: '#e8f7f1', signalColor: '#a7c5b9', signalTextColor: '#e8f1ed',
    labelBoxBkgColor: '#202d39', labelBoxBorderColor: '#7f9fbe', labelTextColor: '#edf4ff', noteBkgColor: '#332d45', noteTextColor: '#f4efff', noteBorderColor: '#a99ac8',
  } : {
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif', fontSize: '14px',
    background: '#fbfdfc', primaryColor: '#e8f6ef', primaryTextColor: '#17382d', primaryBorderColor: '#58a884',
    secondaryColor: '#edf3f8', secondaryTextColor: '#24384a', secondaryBorderColor: '#82a2bd',
    tertiaryColor: '#f3eff9', tertiaryTextColor: '#403653', tertiaryBorderColor: '#a99ac5',
    lineColor: '#66877b', textColor: '#20342d', mainBkg: '#e8f6ef', nodeBorder: '#58a884',
    clusterBkg: '#f5faf7', clusterBorder: '#bdd8cc', edgeLabelBackground: '#fbfdfc',
    actorBkg: '#e8f6ef', actorBorder: '#58a884', actorTextColor: '#17382d', signalColor: '#58766b', signalTextColor: '#20342d',
    labelBoxBkgColor: '#edf3f8', labelBoxBorderColor: '#82a2bd', labelTextColor: '#24384a', noteBkgColor: '#f3eff9', noteTextColor: '#403653', noteBorderColor: '#a99ac5',
  };
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    theme: 'base',
    themeVariables,
    themeCSS: `
      .node rect, .cluster rect, rect.actor, .labelBox, .note, .statediagram-state rect { rx: 12px; ry: 12px; }
      .node rect, .node polygon, .node circle, .cluster rect { filter: drop-shadow(0 2px 3px ${dark ? 'rgba(0,0,0,.28)' : 'rgba(36,76,61,.12)'}); }
      .edgeLabel rect { rx: 6px; ry: 6px; opacity: .96; }
      .flowchart-link, .messageLine0, .messageLine1 { stroke-linecap: round; stroke-linejoin: round; }
    `,
    flowchart: { htmlLabels: false, curve: 'basis', padding: 22, nodeSpacing: 38, rankSpacing: 54 },
    sequence: { actorMargin: 64, messageMargin: 34, noteMargin: 14 },
  });

  // mermaid.run() 的自动 id 基于时间；同一轮里多张图可能得到相同的 svg / marker id，浏览器会把
  // 不同图的节点、箭头和样式串在一起。这里显式给 render() 唯一 id。Mermaid SVG 又依赖内联
  // style，而主页面 CSP 刻意禁止 inline style；所以把 strict 模式生成的 SVG 放进隔离的 blob 图片，
  // 而不是直接注入页面 DOM。图片中的脚本不会执行，样式也不需要放宽整个应用的 style-src。
  const batch = ++renderBatch;
  let rendered = 0;
  for (const [index, node] of accepted.entries()) {
    const source = node.textContent;
    sources.set(node, source);
    if (source.length > MAX_SOURCE_LENGTH) { fallback(node, source, 'mermaid · 源码过长'); continue; }
    try {
      await mermaid.parse(source);
      const result = await mermaid.render(`lush-mermaid-${batch}-${index + 1}`, source);
      const { image, url } = svgImage(doc, result.svg);
      node.replaceChildren(image);
      node.setAttribute('data-mermaid-url', url);
      node.setAttribute('data-mermaid-state', 'rendered');
      rendered++;
    } catch (error) {
      fallback(node, source, `mermaid · ${error?.message || '渲染失败'}`);
    }
  }
  return rendered;
}

/** 渲染 root 内待处理的图；返回实际成功渲染的数量。 */
export function renderMermaidDiagrams(root) {
  const next = renderQueue.then(() => renderNow(root), () => renderNow(root));
  renderQueue = next.catch(() => 0);
  return next;
}

/** 深浅主题变化后，用保留的 Mermaid 源码重新生成当前正文里的 blob 图片。 */
export function refreshMermaidDiagrams(root) {
  const rendered = [...(root?.querySelectorAll?.('.md-mermaid[data-mermaid-state="rendered"]') || [])];
  if (!rendered.length) return Promise.resolve(0);
  clearMermaidDiagrams(root);
  for (const node of rendered) {
    const source = sources.get(node);
    if (!source) continue;
    node.setAttribute('data-mermaid-state', 'pending');
    node.replaceChildren((node.ownerDocument || globalThis.document).createTextNode(source));
  }
  return renderMermaidDiagrams(root);
}
