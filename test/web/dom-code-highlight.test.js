import { test, expect } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { enhanceCode, languageFromPath, normalizeLanguage, resetCodeHighlight } from '../../src/ui/web/assets/code-highlight.js';
import { renderMarkdown } from '../../src/ui/web/assets/markdown.js';
import { transcriptBody } from '../../src/ui/web/assets/transcript-body.js';

const fakeHljs = (value = '<span class="hljs-keyword">const</span> x = 1;') => ({
  getLanguage: language => (['javascript', 'bash'].includes(language) ? {} : null),
  highlight: () => ({ value }),
});

function withHljs(api, run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'hljs');
  Object.defineProperty(globalThis, 'hljs', { value: api, configurable: true, writable: true });
  try { return run(); }
  finally {
    if (previous) Object.defineProperty(globalThis, 'hljs', previous); else delete globalThis.hljs;
    resetCodeHighlight();
  }
}

test('enhanceCode 用受控 DOM 落成 token，保留文本且不注入脚本或属性', () => {
  const dom = installDom();
  try {
    withHljs(fakeHljs('<span class="hljs-keyword">const</span> <span class="hljs-string">&lt;script&gt;evil()&lt;/script&gt;</span>'), () => {
      const code = dom.document.createElement('code');
      code.append(dom.document.createTextNode('const x'));
      enhanceCode(code, 'const x', 'javascript');
      expect(deepText(code.querySelector('.hljs-keyword'))).toBe('const');
      expect(code.classList.contains('hljs')).toBe(true);
      expect(deepText(code)).toContain('<script>evil()</script>');
      expect(code.querySelector('script')).toBeNull();
    });
  } finally { dom.restore(); }
});

test('未知语言与非法 class 都不着色成危险属性，加载失败保持原文', () => {
  const dom = installDom();
  try {
    withHljs({ getLanguage: () => null, highlight: () => ({ value: '<span class="x" onmouseover="evil()">bad</span>' }) }, () => {
      const code = dom.document.createElement('code');
      code.append(dom.document.createTextNode('plain'));
      enhanceCode(code, 'plain', 'javascript');
      expect(deepText(code)).toBe('plain');
      const other = dom.document.createElement('code');
      other.append(dom.document.createTextNode('text'));
      enhanceCode(other, 'text', 'brainfuck');
      expect(deepText(other)).toBe('text');
    });
  } finally { dom.restore(); }
});

test('按需加载：脚本未就绪时排队，onload 后统一升级', async () => {
  const dom = installDom();
  dom.document.head = dom.document.createElement('head');
  try {
    const code = dom.document.createElement('code');
    code.append(dom.document.createTextNode('const x'));
    enhanceCode(code, 'const x', 'javascript');
    expect(code.querySelector('.hljs-keyword')).toBeNull();
    const script = dom.document.head.children.find(node => node.tagName === 'SCRIPT');
    expect(script).toBeTruthy();
    expect(script.getAttribute('src')).toBe('/highlight.min.js');
    Object.defineProperty(globalThis, 'hljs', { value: fakeHljs(), configurable: true, writable: true });
    script.onload();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(deepText(code.querySelector('.hljs-keyword'))).toBe('const');
  } finally { delete globalThis.hljs; resetCodeHighlight(); dom.restore(); }
});

test('markdown 代码块与工具命令都按语言着色，纯文本终端模式不着色', () => {
  const dom = installDom();
  try {
    withHljs(fakeHljs(), () => {
      const md = renderMarkdown('```javascript\nconst x = 1;\n```', dom.document);
      expect(deepText(md.querySelector('.hljs-keyword'))).toBe('const');
      const rich = transcriptBody({ kind: 'tool', body: JSON.stringify({ command: 'bun test' }) });
      expect(deepText(rich.querySelector('.hljs-keyword'))).toBe('const');
      const plain = transcriptBody({ kind: 'tool', body: JSON.stringify({ command: 'bun test' }) }, { plain: true });
      expect(plain.querySelector('.hljs-keyword')).toBeNull();
      expect(plain.querySelector('.terminal-text').textContent).toContain('bun test');
    });
  } finally { dom.restore(); }
});

test('语言归一化与按路径推断只认已知语言', () => {
  expect(normalizeLanguage('sh')).toBe('bash');
  expect(normalizeLanguage('Language-JS')).toBe('javascript');
  expect(normalizeLanguage('plaintext')).toBeNull();
  expect(normalizeLanguage('')).toBeNull();
  expect(languageFromPath('src/a/b.ts')).toBe('typescript');
  expect(languageFromPath('README.md')).toBe('markdown');
  expect(languageFromPath('Makefile')).toBeNull();
});

test('与真实 highlight.js 资源集成：common 构建的输出能落成受控 DOM', async () => {
  const dom = installDom();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'hljs');
  try {
    const source = await Bun.file(new URL('../../src/ui/web/assets/highlight.min.js', import.meta.url)).text();
    const hljs = new Function(`${source}\nreturn hljs;`)();
    Object.defineProperty(globalThis, 'hljs', { value: hljs, configurable: true, writable: true });
    const md = renderMarkdown('```javascript\nconst x = 1; // c\nfunction f(a){ return a + 2; }\n```', dom.document);
    const code = md.querySelector('code');
    expect(code.classList.contains('hljs')).toBe(true);
    expect(deepText(code.querySelector('.hljs-keyword'))).toBe('const');
    // token 只重排文本节点，原文一个字符都不能丢。
    const flat = node => (node.tagName === '#TEXT' ? node.textContent : node.children.map(flat).join(''));
    expect(flat(code)).toBe('const x = 1; // c\nfunction f(a){ return a + 2; }');
    expect(code.querySelector('script')).toBeNull();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'hljs', previous); else delete globalThis.hljs;
    resetCodeHighlight(); dom.restore();
  }
});
