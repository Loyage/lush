import { test, expect } from 'bun:test';
import { refreshMermaidDiagrams, renderMermaidDiagrams } from '../src/ui/web/assets/mermaid-docs.js';

test('documentation Mermaid uses the local API in strict mode', async () => {
  const calls = { initialize: null, ids: [] };
  const mermaid = {
    initialize(config) { calls.initialize = config; },
    async parse() {},
    async render(id, source) { calls.ids.push(id); return { svg: `<svg viewBox="0 0 1200 400" data-source="${source.length}"></svg>` }; },
  };
  const makeNode = source => {
    const attrs = new Map([['data-mermaid-state', 'pending']]);
    return {
      attrs, textContent: source,
      setAttribute(name, value) { attrs.set(name, String(value)); },
      replaceChildren(...children) { this.children = children; },
    };
  };
  const nodes = [makeNode('flowchart LR\n  A --> B'), makeNode('stateDiagram-v2\n  A --> B')];
  class Blob { constructor(parts, options) { this.parts = parts; this.type = options.type; } }
  let blobId = 0;
  const revoked = [];
  const URL = { createObjectURL: blob => `blob:test-${++blobId}-${blob.type}`, revokeObjectURL: url => revoked.push(url) };
  const doc = {
    defaultView: { mermaid, Blob, URL },
    documentElement: { dataset: { theme: 'dark' } },
    createElement(tagName) {
      const attrs = new Map();
      return { tagName, attrs, setAttribute(name, value) { attrs.set(name, String(value)); } };
    },
    createTextNode(textContent) { return { textContent }; },
  };
  for (const node of nodes) {
    node.ownerDocument = doc;
    node.getAttribute = name => node.attrs.get(name) || null;
    node.removeAttribute = name => node.attrs.delete(name);
  }
  const root = {
    ownerDocument: doc,
    querySelectorAll(selector) {
      if (selector === '[data-mermaid-url]') return nodes.filter(node => node.attrs.has('data-mermaid-url'));
      expect(selector).toContain('data-mermaid-state');
      const state = selector.includes('"rendered"') ? 'rendered' : 'pending';
      return nodes.filter(node => node.attrs.get('data-mermaid-state') === state);
    },
  };

  expect(await renderMermaidDiagrams(root)).toBe(2);
  expect(calls.initialize).toMatchObject({
    startOnLoad: false, securityLevel: 'strict', htmlLabels: false, theme: 'base',
    flowchart: { htmlLabels: false, curve: 'basis' },
    themeVariables: { primaryColor: '#173b32', primaryBorderColor: '#65b995' },
  });
  expect(calls.initialize.themeCSS).toContain('rx: 12px');
  expect(new Set(calls.ids).size).toBe(2);
  expect(calls.ids.every(id => /^lush-mermaid-\d+-\d+$/.test(id))).toBe(true);
  expect(nodes.map(node => node.attrs.get('data-mermaid-state'))).toEqual(['rendered', 'rendered']);
  expect(nodes.every(node => node.children?.[0]?.tagName === 'img')).toBe(true);
  expect(nodes.every(node => node.children[0].attrs.get('src').startsWith('blob:test-'))).toBe(true);
  expect(nodes.map(node => node.children[0].attrs.get('width'))).toEqual(['1200', '1200']);

  doc.documentElement.dataset.theme = 'light';
  expect(await refreshMermaidDiagrams(root)).toBe(2);
  expect(calls.initialize.theme).toBe('base');
  expect(calls.initialize.themeVariables.primaryColor).toBe('#e8f6ef');
  expect(revoked).toHaveLength(2);
  expect(new Set(calls.ids).size).toBe(4);
});
