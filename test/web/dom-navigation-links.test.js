import { afterAll, expect, test } from 'bun:test';
import { installDom } from '../dom-stub.js';
import { renderDocsIndex, renderDoc } from '../../src/ui/web/assets/render-docs.js';
import { hookHelpLink } from '../../src/ui/web/assets/render-hooks.js';
import { dashboardNavigation } from '../../src/ui/web/assets/dashboard-widget-aggregate-render.js';
import { renderMarkdown } from '../../src/ui/web/assets/markdown.js';
import { linkWorkerNumbers } from '../../src/ui/web/assets/worker-links.js';

const dom = installDom();
afterAll(() => dom.restore());

test('document navigation opts into shared chrome without changing labels or callback routes', async () => {
  const opened = [];
  renderDocsIndex([{ id: 'readme', title: '使用说明', group: '总览', path: 'README.md' }], id => opened.push(id));
  const open = dom.node('detail').querySelector('.doc-row').querySelector('button');
  expect(open.classList.contains('nav-link')).toBe(true);
  expect(open.textContent).toBe('使用说明');
  await open.onclick();
  expect(opened).toEqual(['readme']);
  renderDoc({ title: '使用说明', path: 'README.md', markdown: '# 使用说明\n\n[正文链接](https://example.com)' }, href => href, id => opened.push(id));
  const back = dom.node('detail').querySelector('.doc-back');
  expect(back.classList.contains('nav-link')).toBe(true);
  expect(back.classList.contains('nav-back')).toBe(true);
  await back.onclick();
  expect(opened).toEqual(['readme', null]);
  expect(dom.node('detail').querySelector('.doc-body').querySelector('a').classList.contains('nav-link')).toBe(false);
});

test('help navigation remains a native new-tab anchor, not an Agent action', () => {
  const link = hookHelpLink();
  expect(link.tagName).toBe('A');
  expect(link.classList.contains('nav-link')).toBe(true);
  expect(link.href).toBe('/#doc-docs-hooks');
  expect(link.target).toBe('_blank');
  expect(link.rel).toBe('noopener');
  expect(link.textContent).toBe('使用帮助');
  expect(link.onclick).toBeFalsy();
  expect(link.classList.contains('agent-call')).toBe(false);
});

test('dashboard UI shortcuts share navigation chrome and preserve project identity and new-tab semantics', () => {
  const nav = dashboardNavigation([
    { scope: 'global', target: 'docs' },
    { scope: 'project', project_id: '0123456789abcdef', target: 'workers' },
  ]);
  const links = nav.querySelectorAll('a');
  expect(links).toHaveLength(2);
  for (const link of links) {
    expect(link.classList.contains('nav-link')).toBe(true);
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener');
  }
  expect(links[0].href).toBe('/#docs');
  expect(links[1].href).toBe('/p/0123456789abcdef/#workers');
});

test('automatic Worker references and Markdown prose never acquire UI navigation chrome', () => {
  const prose = renderMarkdown('[正文链接](https://example.com) 与 W283、D12', document);
  linkWorkerNumbers(prose);
  const links = prose.querySelectorAll('a');
  expect(prose.querySelector('.worker-link')).toBeTruthy();
  expect(prose.querySelector('.record-link')).toBeTruthy();
  expect(links.every(link => !link.classList.contains('nav-link'))).toBe(true);
});
