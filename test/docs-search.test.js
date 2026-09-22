import { test, expect } from 'bun:test';
import { normalizeDocsQuery, searchDocs } from '../src/ui/web/assets/docs-search.js';

const INDEX = [
  { id: 'guide', title: '行动任务流程', group: '总览', path: 'docs/task-flow.md', headings: '用户验收', body: '用户最终接受固定 commit。', code: 'lush candidate accept 2', diagram: '' },
  { id: 'api', title: '接口参考', group: '接口参考', path: 'docs/reference/api.md', headings: 'Candidate 命令', body: '接受候选版本。', code: 'lush candidate accept ID', diagram: '' },
  { id: 'diagram', title: '其它架构', group: '架构', path: 'docs/other.md', headings: '', body: '别的内容', code: '', diagram: 'candidate accept' },
];

test('document search handles Chinese substrings and English multi-term AND queries', () => {
  expect(searchDocs(INDEX, '用户验收').map(row => row.id)).toEqual(['guide']);
  const code = searchDocs(INDEX, 'candidate accept');
  expect(code.map(row => row.id)).toEqual(['api', 'guide', 'diagram']);
  expect(code[0].snippet).toContain('candidate accept');
  expect(searchDocs(INDEX, 'candidate missing')).toEqual([]);
});

test('document search ranks title and code above Mermaid-only matches and limits results', () => {
  const results = searchDocs(INDEX, 'accept', 2);
  expect(results).toHaveLength(2);
  expect(results.map(row => row.id)).not.toContain('diagram');
  expect(results[0].score).toBeGreaterThan(results.at(-1).score - 1);
  expect(normalizeDocsQuery('  ＣＡＮＤＩＤＡＴＥ   Accept ')).toBe('candidate accept');
});
